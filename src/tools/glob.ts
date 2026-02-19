// ABOUTME: Finds files matching a glob pattern inside the workspace.
// ABOUTME: Applies ignore rules and returns stable, sortable file lists.

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { toolResultShape } from "../types/tool-result.js";
import {
	getPathPolicyBlockReason,
	getPolicyContextForRoot,
	resolvePathAccess,
	resolveRespectGitIgnore,
} from "../utils/path-policy.js";
import { getWorkspaceRoots, toPosixPath } from "../utils/workspace.js";

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
	no_ignore: z
		.boolean()
		.optional()
		.describe("If true, do not respect ignore files."),
	file_filtering_options: z
		.object({
			respect_git_ignore: z.boolean().optional(),
			respect_gemini_ignore: z.boolean().optional(),
		})
		.optional(),
	respect_git_ignore: z
		.boolean()
		.optional()
		.describe("Optional: respect .gitignore patterns (default true)."),
	respect_gemini_ignore: z
		.boolean()
		.optional()
		.describe("Optional: respect .geminiignore patterns (default true)."),
	max_results: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Optional maximum number of matching file paths to return."),
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
	let respectGit = resolveRespectGitIgnore(input);

	let searchTargets: Array<{ dir: string; root: string }> = [];
	const policyByRoot = new Map<
		string,
		Awaited<ReturnType<typeof getPolicyContextForRoot>>
	>();
	if (input.dir_path) {
		const access = await resolvePathAccess(input.dir_path, {
			action: "glob",
			filtering: input,
		});
		if (!access.ok) {
			return { llmContent: access.llmContent, error: access.error };
		}
		searchTargets = [{ dir: access.absPath, root: access.root }];
		policyByRoot.set(access.root, access.policy);
		respectGit = access.policy.respectGitIgnore;
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
				error: {
					message: `Search path does not exist ${target.dir}`,
					type: ToolErrorType.SEARCH_PATH_NOT_FOUND,
				},
			};
		}
		if (!st.isDirectory()) {
			return {
				llmContent: `Search path is not a directory: ${target.dir}`,
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
		let policy = policyByRoot.get(target.root);
		if (!policy) {
			policy = await getPolicyContextForRoot(target.root, respectGit);
			policyByRoot.set(target.root, policy);
		}
		for (const entry of entries) {
			const rel = toPosixPath(path.relative(target.root, entry.path));
			const blocked = getPathPolicyBlockReason(rel, policy);
			if (blocked) {
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
		};
	}

	const now = Date.now();
	const sortedEntries = sortFileEntries(allEntries, now);
	const maxResults = input.max_results;
	const visibleEntries =
		typeof maxResults === "number"
			? sortedEntries.slice(0, maxResults)
			: sortedEntries;
	const hiddenCount = sortedEntries.length - visibleEntries.length;
	const sortedAbsolutePaths = visibleEntries.map((entry) => entry.path);
	const fileListDescription = sortedAbsolutePaths.join("\n");
	const fileCount = sortedEntries.length;

	let resultMessage = `Found ${fileCount} file(s) matching "${input.pattern}"`;
	if (searchTargets.length === 1) {
		resultMessage += ` within ${searchTargets[0].dir}`;
	} else {
		resultMessage += ` across ${searchTargets.length} workspace directories`;
	}
	if (ignoredCount > 0) {
		resultMessage += ` (${ignoredCount} additional files were ignored)`;
	}
	if (hiddenCount > 0) {
		resultMessage += ` (truncated by ${hiddenCount})`;
	}
	resultMessage += `, sorted by modification time (newest first):\n${fileListDescription}`;

	return {
		llmContent: resultMessage,
	};
}
