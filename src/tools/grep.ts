// ABOUTME: Searches text or regex patterns across workspace files in JS.
// ABOUTME: Applies ignore rules, avoids binaries, and caps match counts.

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { isText } from "istextorbinary";
import { z } from "zod";
import { ErrorCode } from "../types/error-codes.js";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	getWorkspaceRoot,
	isSensitivePath,
	resolveWithinWorkspace,
	toPosixPath,
} from "../utils/workspace.js";

const DEFAULT_EXCLUDES = ["**/{node_modules,.git,dist,build,out}/**"];
const DEFAULT_CONCURRENCY = 8;

export const grepShape = {
	pattern: z.string().describe("Pattern to search for (plain text)."),
	path: z
		.string()
		.optional()
		.describe("Optional directory/file path (absolute or workspace-relative)."),
	include: z
		.string()
		.optional()
		.describe("Optional glob filter, e.g. **/*.{ts,tsx,js,jsx}"),
	exclude: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe("Optional glob to exclude, e.g. **/dist/**"),
	regex: z
		.boolean()
		.optional()
		.describe("Treat pattern as a regular expression (default false)."),
	ignore_case: z
		.boolean()
		.optional()
		.describe("Case-insensitive search (default true)."),
	match_whole_word: z
		.boolean()
		.optional()
		.describe("Match whole words only (word boundaries)."),
	context_lines_before: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Number of context lines before each match (-B)."),
	context_lines_after: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Number of context lines after each match (-A)."),
	context_lines: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Number of context lines before/after each match (-C)."),
	output_mode: z
		.enum(["full", "files_only", "count"])
		.optional()
		.describe("Output mode: full match objects, files only, or count."),
	max_matches: z
		.number()
		.optional()
		.describe("Maximum number of matches to return (default 2000)."),
	useDefaultExcludes: z
		.boolean()
		.optional()
		.describe(
			"Apply default excludes (node_modules, dist, .git, etc.). Default true.",
		),
};
export const grepInput = z.object(grepShape);
export type GrepInput = z.infer<typeof grepInput>;

// Output schema for structured content returned by this tool
export const grepOutputShape = {
	matches: z
		.array(
			z.object({
				filePath: z.string(),
				absoluteFilePath: z.string().optional(),
				lineNumber: z.number(),
				line: z.string(),
				contextBefore: z
					.array(z.object({ lineNumber: z.number(), line: z.string() }))
					.optional(),
				contextAfter: z
					.array(z.object({ lineNumber: z.number(), line: z.string() }))
					.optional(),
			}),
		)
		.optional(),
	files: z.array(z.string()).optional(),
	count: z.number().optional(),
	summary: z.string().optional(),
	truncated: z.boolean().optional(),
	maxMatches: z.number().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
};

function escapeRegExp(pattern: string): string {
	return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveContextCounts(input: GrepInput): {
	before: number;
	after: number;
} {
	const c = input.context_lines ?? 0;
	const before = input.context_lines_before ?? c;
	const after = input.context_lines_after ?? c;
	return { before, after };
}

export async function grepTool(input: GrepInput, signal?: AbortSignal) {
	const root = getWorkspaceRoot();
	let baseDir = root;
	let fileOnly: string | null = null;
	if (input.path) {
		let resolved: string;
		try {
			resolved = resolveWithinWorkspace(path.resolve(root, input.path));
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: { error: ErrorCode.OUTSIDE_WORKSPACE, message: msg },
			};
		}
		const st = await fs.stat(resolved).catch(() => null);
		if (st?.isFile()) {
			fileOnly = resolved;
			baseDir = path.dirname(resolved);
		} else if (st?.isDirectory()) {
			baseDir = resolved;
		} else {
			const msg = `Path not found: ${resolved}`;
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: { error: ErrorCode.NOT_FOUND, message: msg },
			};
		}
	}

	const ig = await buildIgnoreFilter();
	const include = input.include ?? "**/*";

	// Handle exclude as string or array
	const excludePatterns = input.exclude
		? Array.isArray(input.exclude)
			? input.exclude
			: [input.exclude]
		: undefined;

	const combinedExcludes = [
		...(input.useDefaultExcludes === false ? [] : DEFAULT_EXCLUDES),
		...(excludePatterns ?? []),
	];

	const files = fileOnly
		? [fileOnly]
		: await fg(include, {
				cwd: baseDir,
				absolute: true,
				onlyFiles: true,
				dot: true,
				followSymbolicLinks: false,
				ignore: combinedExcludes,
			});
	const matches: Array<{
		filePath: string;
		absoluteFilePath?: string;
		lineNumber: number;
		line: string;
		contextBefore?: Array<{ lineNumber: number; line: string }>;
		contextAfter?: Array<{ lineNumber: number; line: string }>;
	}> = [];

	const maxMatches = input.max_matches ?? 2000;
	const outputMode = input.output_mode ?? "full";
	const { before: ctxBefore, after: ctxAfter } = resolveContextCounts(input);
	const includeContext =
		outputMode === "full" && (ctxBefore > 0 || ctxAfter > 0);
	const matchedFiles = new Set<string>();
	let matchCount = 0;
	let truncated = false;

	// Smart-case: if ignore_case is undefined and pattern has uppercase letters, make it case-sensitive
	let ignoreCase: boolean;
	if (input.ignore_case === undefined) {
		// Smart case: case-sensitive if pattern contains uppercase letters
		ignoreCase = input.pattern === input.pattern.toLowerCase();
	} else {
		ignoreCase = input.ignore_case !== false;
	}

	let rx: RegExp | null = null;
	if (input.regex || input.match_whole_word) {
		try {
			const base = input.regex ? input.pattern : escapeRegExp(input.pattern);
			const wrapped = input.match_whole_word ? `\\b(?:${base})\\b` : base;
			rx = new RegExp(wrapped, ignoreCase ? "i" : undefined);
		} catch (e: unknown) {
			const msg = `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`;
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: { error: ErrorCode.INVALID_REGEX, message: msg },
			};
		}
	}

	let stop = false;
	let nextFileIndex = 0;

	const processFile = async (file: string) => {
		if (stop || signal?.aborted) return;
		const relToRoot = toPosixPath(path.relative(root, file));
		if (isSensitivePath(relToRoot)) return;
		if (ig.ignores(relToRoot)) return;

		try {
			const st = await fs.stat(file);
			if (!st.isFile()) return;
			if (st.size > 1024 * 1024) return; // 1MB cap per file
			const buf = await fs.readFile(file);
			if (!isText(null, buf)) return; // skip binaries

			const text = buf.toString("utf8");
			const lines = text.split(/\r?\n/);

			const pushMatch = (lineIndex: number) => {
				if (stop || signal?.aborted) return;
				if (matchCount >= maxMatches) {
					truncated = true;
					stop = true;
					return;
				}

				matchCount += 1;
				matchedFiles.add(relToRoot);

				if (outputMode === "full") {
					const match = {
						filePath: relToRoot,
						absoluteFilePath: file,
						lineNumber: lineIndex + 1,
						line: lines[lineIndex],
					} as (typeof matches)[number];

					if (includeContext) {
						if (ctxBefore > 0) {
							const start = Math.max(0, lineIndex - ctxBefore);
							if (start < lineIndex) {
								match.contextBefore = lines
									.slice(start, lineIndex)
									.map((line, offset) => ({
										lineNumber: start + offset + 1,
										line,
									}));
							}
						}
						if (ctxAfter > 0) {
							const endExclusive = Math.min(
								lines.length,
								lineIndex + 1 + ctxAfter,
							);
							if (lineIndex + 1 < endExclusive) {
								match.contextAfter = lines
									.slice(lineIndex + 1, endExclusive)
									.map((line, offset) => ({
										lineNumber: lineIndex + 2 + offset,
										line,
									}));
							}
						}
					}

					matches.push(match);
				}

				if (matchCount >= maxMatches) {
					truncated = true;
					stop = true;
				}
			};

			if (rx) {
				for (let i = 0; i < lines.length; i++) {
					if (stop || signal?.aborted) return;
					if (!rx.test(lines[i])) continue;
					pushMatch(i);
					if (stop) return;
				}
				return;
			}

			const needle = ignoreCase ? input.pattern.toLowerCase() : input.pattern;
			for (let i = 0; i < lines.length; i++) {
				if (stop || signal?.aborted) return;
				const hay = ignoreCase ? lines[i].toLowerCase() : lines[i];
				if (!hay.includes(needle)) continue;
				pushMatch(i);
				if (stop) return;
			}
		} catch {}
	};

	const workerCount = Math.min(DEFAULT_CONCURRENCY, files.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (!stop && !signal?.aborted) {
			const idx = nextFileIndex++;
			if (idx >= files.length) return;
			await processFile(files[idx]);
		}
	});

	await Promise.all(workers);

	if (matchCount === 0) {
		const where = path.relative(root, baseDir) || ".";
		const filter = input.include ? ` (filter: "${input.include}")` : "";
		return {
			content: [
				{
					type: "text" as const,
					text: `No matches for "${input.pattern}" in ${where}${filter}.`,
				},
			],
			structuredContent: {
				matches: outputMode === "full" ? [] : undefined,
				files: outputMode === "files_only" ? [] : undefined,
				count: outputMode !== "full" ? 0 : undefined,
				summary: "No matches found.",
				truncated: false,
			},
		};
	}

	if (outputMode === "count") {
		const summary = truncated
			? `Found ${matchCount} matches (limited to ${maxMatches}).`
			: `Found ${matchCount} match${matchCount === 1 ? "" : "es"}.`;
		return {
			content: [{ type: "text" as const, text: summary }],
			structuredContent: {
				count: matchCount,
				summary,
				truncated,
				maxMatches: truncated ? maxMatches : undefined,
			},
		};
	}

	if (outputMode === "files_only") {
		const files = Array.from(matchedFiles).sort((a, b) => a.localeCompare(b));
		const summary = truncated
			? `Found ${files.length} file(s) with matches (limited to ${maxMatches} matches).`
			: `Found ${files.length} file(s) with matches.`;
		return {
			content: [{ type: "text" as const, text: files.join("\n") }],
			structuredContent: {
				files,
				count: matchCount,
				summary,
				truncated,
				maxMatches: truncated ? maxMatches : undefined,
			},
		};
	}

	// Group matches by file for better readability
	const matchesByFile = new Map<string, Array<(typeof matches)[number]>>();
	for (const match of matches) {
		if (!matchesByFile.has(match.filePath)) {
			matchesByFile.set(match.filePath, []);
		}
		matchesByFile.get(match.filePath)?.push(match);
	}
	for (const arr of matchesByFile.values())
		arr.sort((a, b) => a.lineNumber - b.lineNumber);

	// Build grouped text output
	const textParts: string[] = [];
	const sortedFiles = Array.from(matchesByFile.keys()).sort((a, b) =>
		a.localeCompare(b),
	);
	for (const filePath of sortedFiles) {
		const fileMatches = matchesByFile.get(filePath) ?? [];
		textParts.push(`${filePath}:`);
		for (const match of fileMatches) {
			if (match.contextBefore?.length) {
				for (const c of match.contextBefore)
					textParts.push(`  ${c.lineNumber}: ${c.line}`);
			}
			textParts.push(`  ${match.lineNumber}: ${match.line}`);
			if (match.contextAfter?.length) {
				for (const c of match.contextAfter)
					textParts.push(`  ${c.lineNumber}: ${c.line}`);
			}
		}
	}
	const textOut = textParts.join("\n");

	const summary = truncated
		? `Found ${matchCount} matches (limited to ${maxMatches}).`
		: `Found ${matchCount} match${matchCount === 1 ? "" : "es"}.`;

	return {
		content: [{ type: "text" as const, text: textOut }],
		structuredContent: {
			matches,
			count: matchCount,
			summary,
			truncated,
			maxMatches: truncated ? maxMatches : undefined,
		},
	};
}
