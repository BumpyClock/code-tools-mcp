import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	getWorkspaceRoot,
	resolveWithinWorkspace,
} from "../utils/workspace.js";

export const globShape = {
	pattern: z.string().describe("Glob pattern, e.g. **/*.ts"),
	path: z
		.string()
		.optional()
		.describe("Directory to search within; if omitted, search workspace root."),
	case_sensitive: z
		.boolean()
		.optional()
		.describe("Match case sensitively (default false)."),
	respect_git_ignore: z
		.boolean()
		.optional()
		.describe("Respect .gitignore (default true)."),
};
export const globInput = z.object(globShape);
export type GlobInput = z.infer<typeof globInput>;

// Output schema for structured content returned by this tool
export const globOutputShape = {
	files: z.array(z.string()),
	summary: z.string(),
	gitIgnoredCount: z.number().optional(),
	error: z.string().optional(),
};

export async function globTool(input: GlobInput) {
	const root = getWorkspaceRoot();
	const baseDir = input.path
		? resolveWithinWorkspace(
				path.isAbsolute(input.path) ? input.path : path.join(root, input.path),
			)
		: root;
	const ig = await buildIgnoreFilter({
		respectGitIgnore: input.respect_git_ignore ?? true,
	});

	// Use objectMode for better performance - no extra fs.stat calls
	const entries = await fg(input.pattern, {
		cwd: baseDir,
		dot: true,
		caseSensitiveMatch: input.case_sensitive ?? false,
		onlyFiles: true,
		absolute: true,
		followSymbolicLinks: false,
		objectMode: true, // Use objectMode to get entries with stats
	});

	// Filter by ignore rules relative to workspace root
	const filtered = [] as Array<{ full: string; mtimeMs: number; name: string }>;
	let gitIgnoredCount = 0;

	for (const entry of entries) {
		const rel = path.relative(root, entry.path).split(path.sep).join("/");
		if (ig.ignores(rel)) {
			gitIgnoredCount++;
			continue;
		}
		filtered.push({
			full: entry.path,
			mtimeMs: entry.stats?.mtimeMs || 0,
			name: path.basename(entry.path),
		});
	}

	if (filtered.length === 0) {
		const baseDirRel = path.relative(root, baseDir) || ".";
		const ignoreNote =
			gitIgnoredCount > 0
				? ` (${gitIgnoredCount} files ignored by .gitignore)`
				: "";
		return {
			content: [
				{
					type: "text" as const,
					text: `No files found matching "${input.pattern}" in ${baseDirRel}${ignoreNote}`,
				},
			],
			structuredContent: {
				files: [],
				summary: "No files found.",
				gitIgnoredCount: gitIgnoredCount > 0 ? gitIgnoredCount : undefined,
			},
		};
	}

	// Two-tier sorting: recent files (< 24h) newest-first, then older files alphabetically
	const now = Date.now();
	const dayMs = 24 * 60 * 60 * 1000;

	const recent = filtered.filter((f) => now - f.mtimeMs < dayMs);
	const older = filtered.filter((f) => now - f.mtimeMs >= dayMs);

	// Sort recent by modification time (newest first)
	recent.sort((a, b) => b.mtimeMs - a.mtimeMs);

	// Sort older alphabetically by filename
	older.sort((a, b) => a.name.localeCompare(b.name));

	// Combine: recent files first, then older files
	const sorted = [...recent, ...older];

	const files = sorted.map((f) => f.full);
	const text = files.join("\n");
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: {
			files,
			summary: `Found ${files.length} matching file(s).`,
		},
	};
}
