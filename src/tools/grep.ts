// ABOUTME: Searches text or regex patterns across workspace files in JS.
// ABOUTME: Applies ignore rules, avoids binaries, and caps match counts.

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { isText } from "istextorbinary";
import { z } from "zod";
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
			}),
		)
		.optional(),
	summary: z.string().optional(),
	truncated: z.boolean().optional(),
	maxMatches: z.number().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
};

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
				structuredContent: { error: "OUTSIDE_WORKSPACE", message: msg },
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
				structuredContent: { error: "PATH_NOT_FOUND", message: msg },
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
	}> = [];

	const maxMatches = input.max_matches ?? 2000;
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
	if (input.regex) {
		try {
			rx = new RegExp(input.pattern, ignoreCase ? "i" : undefined);
		} catch (e: unknown) {
			const msg = `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`;
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: { error: "INVALID_REGEX", message: msg },
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

			if (rx) {
				for (let i = 0; i < lines.length; i++) {
					if (stop || signal?.aborted) return;
					if (!rx.test(lines[i])) continue;
					if (matches.length >= maxMatches) {
						truncated = true;
						stop = true;
						return;
					}
					matches.push({
						filePath: relToRoot,
						absoluteFilePath: file,
						lineNumber: i + 1,
						line: lines[i],
					});
					if (matches.length >= maxMatches) {
						truncated = true;
						stop = true;
						return;
					}
				}
				return;
			}

			const needle = ignoreCase ? input.pattern.toLowerCase() : input.pattern;
			for (let i = 0; i < lines.length; i++) {
				if (stop || signal?.aborted) return;
				const hay = ignoreCase ? lines[i].toLowerCase() : lines[i];
				if (!hay.includes(needle)) continue;
				if (matches.length >= maxMatches) {
					truncated = true;
					stop = true;
					return;
				}
				matches.push({
					filePath: relToRoot,
					absoluteFilePath: file,
					lineNumber: i + 1,
					line: lines[i],
				});
				if (matches.length >= maxMatches) {
					truncated = true;
					stop = true;
					return;
				}
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

	if (matches.length === 0) {
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
				matches: [],
				summary: "No matches found.",
				truncated: false,
			},
		};
	}

	// Group matches by file for better readability
	const matchesByFile = new Map<
		string,
		Array<{ lineNumber: number; line: string }>
	>();
	for (const match of matches) {
		if (!matchesByFile.has(match.filePath)) {
			matchesByFile.set(match.filePath, []);
		}
		matchesByFile
			.get(match.filePath)
			?.push({ lineNumber: match.lineNumber, line: match.line });
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
			textParts.push(`  ${match.lineNumber}: ${match.line}`);
		}
	}
	const textOut = textParts.join("\n");

	const summary = truncated
		? `Found ${matches.length} matches (limited to ${maxMatches}).`
		: `Found ${matches.length} match${matches.length === 1 ? "" : "es"}.`;

	return {
		content: [{ type: "text" as const, text: textOut }],
		structuredContent: {
			matches,
			summary,
			truncated,
			maxMatches: truncated ? maxMatches : undefined,
		},
	};
}
