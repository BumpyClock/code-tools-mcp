// ABOUTME: Finds files matching a glob pattern inside the workspace.
// ABOUTME: Applies ignore rules and returns stable, sortable file lists.

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	getWorkspaceRoot,
	isSensitivePath,
	resolveWithinWorkspace,
	toPosixPath,
} from "../utils/workspace.js";

export const globShape = {
	pattern: z.string().describe("Glob pattern, e.g. **/*.ts"),
	path: z
		.string()
		.optional()
		.describe(
			"Directory to search within (absolute or workspace-relative); defaults to workspace root.",
		),
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
	relativeFiles: z.array(z.string()).optional(),
	summary: z.string(),
	gitIgnoredCount: z.number().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
};

export async function globTool(input: GlobInput) {
	const root = getWorkspaceRoot();
	let baseDir = root;
	if (input.path) {
		try {
			baseDir = resolveWithinWorkspace(
				path.isAbsolute(input.path) ? input.path : path.join(root, input.path),
			);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: {
					files: [],
					relativeFiles: [],
					summary: "Invalid path.",
					error: "OUTSIDE_WORKSPACE",
					message: msg,
				},
			};
		}
	}

	const baseDirRelPosix = toPosixPath(path.relative(root, baseDir) || ".");
	if (isSensitivePath(baseDirRelPosix)) {
		const msg = `Refusing to glob in sensitive path: ${baseDirRelPosix}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				files: [],
				relativeFiles: [],
				summary: "Refused sensitive path.",
				error: "SENSITIVE_PATH",
				message: msg,
			},
		};
	}

	const st = await fs.stat(baseDir).catch(() => null);
	if (!st) {
		const msg = `Path not found: ${baseDir}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				files: [],
				relativeFiles: [],
				summary: "Path not found.",
				error: "PATH_NOT_FOUND",
				message: msg,
			},
		};
	}
	if (!st.isDirectory()) {
		const msg = `Path is not a directory: ${baseDirRelPosix}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				files: [],
				relativeFiles: [],
				summary: "Path is not a directory.",
				error: "PATH_IS_NOT_A_DIRECTORY",
				message: msg,
			},
		};
	}

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
		const rel = toPosixPath(path.relative(root, entry.path));
		if (isSensitivePath(rel)) {
			gitIgnoredCount++;
			continue;
		}
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
	const relativeFiles = sorted.map((f) =>
		toPosixPath(path.relative(root, f.full)),
	);
	const text = files.join("\n");
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: {
			files,
			relativeFiles,
			summary: `Found ${files.length} matching file(s).`,
		},
	};
}
