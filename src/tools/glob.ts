// ABOUTME: Finds files matching a glob pattern inside the workspace.
// ABOUTME: Applies ignore rules and returns stable, sortable file lists.

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { toolResultShape } from "../types/tool-result.js";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	getWorkspaceRoots,
	isSensitivePath,
	resolveWithinWorkspace,
	toPosixPath,
} from "../utils/workspace.js";

export const globShape = {
	pattern: z.string().describe("Glob pattern to match against."),
	dir_path: z
		.string()
		.optional()
		.describe(
			"Optional absolute path to directory to search within. If omitted, searches all workspace directories.",
		),
	case_sensitive: z
		.boolean()
		.optional()
		.describe("Optional: case-sensitive matching (default false)."),
	respect_git_ignore: z
		.boolean()
		.optional()
		.describe("Optional: respect .gitignore patterns (default true)."),
	respect_gemini_ignore: z
		.boolean()
		.optional()
		.describe("Optional: respect .geminiignore patterns (default true)."),
};
export const globInput = z.object(globShape);
export type GlobInput = z.infer<typeof globInput>;

export const globOutputShape = toolResultShape;

const DEFAULT_EXCLUDES = ["**/{node_modules,.git,dist,build,out}/**"];

interface GlobPath {
	path: string;
	mtimeMs?: number;
}

function sortFileEntries(
	entries: GlobPath[],
	nowTimestamp: number,
): GlobPath[] {
	const oneDayInMs = 24 * 60 * 60 * 1000;
	const sorted = [...entries];
	sorted.sort((a, b) => {
		const mtimeA = a.mtimeMs ?? 0;
		const mtimeB = b.mtimeMs ?? 0;
		const aIsRecent = nowTimestamp - mtimeA < oneDayInMs;
		const bIsRecent = nowTimestamp - mtimeB < oneDayInMs;
		if (aIsRecent && bIsRecent) return mtimeB - mtimeA;
		if (aIsRecent) return -1;
		if (bIsRecent) return 1;
		return a.path.localeCompare(b.path);
	});
	return sorted;
}

async function gatherEntries(
	searchDir: string,
	pattern: string,
	caseSensitive: boolean,
): Promise<GlobPath[]> {
	const paths = await fg(pattern, {
		cwd: searchDir,
		onlyFiles: true,
		caseSensitiveMatch: caseSensitive,
		dot: true,
		absolute: true,
		followSymbolicLinks: false,
		ignore: DEFAULT_EXCLUDES,
	});

	const entries: GlobPath[] = [];
	for (const entry of paths) {
		const stats = await fs.stat(entry).catch(() => null);
		entries.push({ path: entry, mtimeMs: stats?.mtimeMs ?? 0 });
	}
	return entries;
}

export async function globTool(input: GlobInput, _signal?: AbortSignal) {
	const caseSensitive = input.case_sensitive ?? false;
	const respectGit = input.respect_git_ignore ?? true;

	let searchTargets: Array<{ dir: string; root: string }> = [];
	if (input.dir_path) {
		try {
			const resolved = resolveWithinWorkspace(input.dir_path);
			searchTargets = [{ dir: resolved.absPath, root: resolved.root }];
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				llmContent: msg,
				returnDisplay: "Path not in workspace.",
				error: { message: msg, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
			};
		}
	} else {
		searchTargets = getWorkspaceRoots().map((root) => ({ dir: root, root }));
	}

	const allEntries: GlobPath[] = [];
	let ignoredCount = 0;

	for (const target of searchTargets) {
		const st = await fs.stat(target.dir).catch(() => null);
		if (!st) {
			return {
				llmContent: `Search path does not exist ${target.dir}`,
				returnDisplay: "Path not found.",
				error: {
					message: `Search path does not exist ${target.dir}`,
					type: ToolErrorType.SEARCH_PATH_NOT_FOUND,
				},
			};
		}
		if (!st.isDirectory()) {
			return {
				llmContent: `Search path is not a directory: ${target.dir}`,
				returnDisplay: "Path is not a directory.",
				error: {
					message: `Search path is not a directory: ${target.dir}`,
					type: ToolErrorType.SEARCH_PATH_NOT_A_DIRECTORY,
				},
			};
		}

		const entries = await gatherEntries(
			target.dir,
			input.pattern,
			caseSensitive,
		);
		if (!respectGit) {
			allEntries.push(...entries);
			continue;
		}
		const ig = await buildIgnoreFilter({ respectGitIgnore: true }, target.root);
		for (const entry of entries) {
			const rel = toPosixPath(path.relative(target.root, entry.path));
			if (isSensitivePath(rel)) {
				ignoredCount += 1;
				continue;
			}
			if (ig.ignores(rel)) {
				ignoredCount += 1;
				continue;
			}
			allEntries.push(entry);
		}
	}

	if (allEntries.length === 0) {
		let message = `No files found matching pattern "${input.pattern}"`;
		if (searchTargets.length === 1) {
			message += ` within ${searchTargets[0].dir}`;
		} else {
			message += ` within ${searchTargets.length} workspace directories`;
		}
		if (ignoredCount > 0) {
			message += ` (${ignoredCount} files were ignored)`;
		}
		return {
			llmContent: message,
			returnDisplay: "No files found",
		};
	}

	const now = Date.now();
	const sortedEntries = sortFileEntries(allEntries, now);
	const sortedAbsolutePaths = sortedEntries.map((entry) => entry.path);
	const fileListDescription = sortedAbsolutePaths.join("\n");
	const fileCount = sortedAbsolutePaths.length;

	let resultMessage = `Found ${fileCount} file(s) matching "${input.pattern}"`;
	if (searchTargets.length === 1) {
		resultMessage += ` within ${searchTargets[0].dir}`;
	} else {
		resultMessage += ` across ${searchTargets.length} workspace directories`;
	}
	if (ignoredCount > 0) {
		resultMessage += ` (${ignoredCount} additional files were ignored)`;
	}
	resultMessage += `, sorted by modification time (newest first):\n${fileListDescription}`;

	return {
		llmContent: resultMessage,
		returnDisplay: `Found ${fileCount} matching file(s)`,
	};
}
