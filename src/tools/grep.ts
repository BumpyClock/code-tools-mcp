import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { isText } from "istextorbinary";
import { z } from "zod";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	getWorkspaceRoot,
	resolveWithinWorkspace,
} from "../utils/workspace.js";

export const grepShape = {
	pattern: z.string().describe("Pattern to search for (plain text)."),
	path: z
		.string()
		.optional()
		.describe("Optional directory path relative to workspace."),
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
};
export const grepInput = z.object(grepShape);
export type GrepInput = z.infer<typeof grepInput>;

// Output schema for structured content returned by this tool
export const grepOutputShape = {
	matches: z.array(
		z.object({
			filePath: z.string(),
			lineNumber: z.number(),
			line: z.string(),
		}),
	),
	summary: z.string(),
	truncated: z.boolean(),
	maxMatches: z.number().optional(),
	error: z.string().optional(),
};

export async function grepTool(input: GrepInput, signal?: AbortSignal) {
	const root = getWorkspaceRoot();
	const baseDir = input.path
		? resolveWithinWorkspace(path.resolve(root, input.path))
		: root;
	const ig = await buildIgnoreFilter();
	const include = input.include ?? "**/*";

	// Handle exclude as string or array
	const excludePatterns = input.exclude
		? Array.isArray(input.exclude)
			? input.exclude
			: [input.exclude]
		: undefined;

	const files = await fg(include, {
		cwd: baseDir,
		absolute: true,
		dot: true,
		ignore: excludePatterns,
	});
	const matches: Array<{ filePath: string; lineNumber: number; line: string }> =
		[];

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

	outer: for (const file of files) {
		if (signal?.aborted) break;
		const relToRoot = path.relative(root, file).split(path.sep).join("/");
		if (ig.ignores(relToRoot)) continue;
		try {
			const st = await fs.stat(file);
			if (!st.isFile()) continue;
			if (st.size > 1024 * 1024) continue; // 1MB cap per file
			const buf = await fs.readFile(file);
			if (!isText(null, buf)) continue; // skip binaries
			const text = buf.toString("utf8");
			const lines = text.split(/\r?\n/);
			if (rx) {
				for (let i = 0; i < lines.length; i++) {
					if (rx.test(lines[i])) {
						matches.push({
							filePath: path.relative(root, file),
							lineNumber: i + 1,
							line: lines[i],
						});
						if (matches.length >= maxMatches) {
							truncated = true;
							break outer;
						}
					}
				}
			} else {
				const needle = ignoreCase ? input.pattern.toLowerCase() : input.pattern;
				for (let i = 0; i < lines.length; i++) {
					const hay = ignoreCase ? lines[i].toLowerCase() : lines[i];
					if (hay.includes(needle)) {
						matches.push({
							filePath: path.relative(root, file),
							lineNumber: i + 1,
							line: lines[i],
						});
						if (matches.length >= maxMatches) {
							truncated = true;
							break outer;
						}
					}
				}
			}
		} catch {}
	}

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

	// Build grouped text output
	const textParts: string[] = [];
	for (const [filePath, fileMatches] of matchesByFile) {
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
