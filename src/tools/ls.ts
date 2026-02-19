// ABOUTME: Lists directory entries within the workspace (non-recursive).
// ABOUTME: Applies ignore rules and basic safety blocks for sensitive paths.

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { toolResultShape } from "../types/tool-result.js";
import { buildIgnoreFilter, matchCustomIgnore } from "../utils/ignore.js";
import {
	isSensitivePath,
	resolveWithinWorkspace,
	toPosixPath,
} from "../utils/workspace.js";

export const lsShape = {
	dir_path: z
		.string()
		.describe(
			"Absolute path to directory, or workspace-relative path to directory.",
		),
	ignore: z
		.array(z.string())
		.optional()
		.describe("Optional glob patterns to ignore (name matching)."),
	file_filtering_options: z
		.object({
			respect_git_ignore: z.boolean().optional(),
			respect_gemini_ignore: z.boolean().optional(),
		})
		.optional(),
};
export const lsInput = z.object(lsShape);
export type LsInput = z.infer<typeof lsInput>;

export const lsOutputShape = toolResultShape;

function normalizeDirPath(input: string): { absPath: string; root: string } {
	return resolveWithinWorkspace(input);
}

export async function lsTool(input: LsInput) {
	let abs: string;
	let root: string;
	try {
		({ absPath: abs, root } = normalizeDirPath(input.dir_path));
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
		};
	}

	const relDirPosix = toPosixPath(path.relative(root, abs) || ".");
	if (isSensitivePath(relDirPosix)) {
		const msg = `Refusing to list sensitive path: ${relDirPosix}`;
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.SENSITIVE_PATH },
		};
	}

	const st = await fs.stat(abs).catch(() => null);
	if (!st) {
		const msg = `Error: Directory not found or inaccessible: ${abs}`;
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.FILE_NOT_FOUND },
		};
	}
	if (!st.isDirectory()) {
		const msg = `Error: Path is not a directory: ${abs}`;
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.PATH_IS_NOT_A_DIRECTORY },
		};
	}

	const respectGit = input.file_filtering_options?.respect_git_ignore ?? true;
	const ig = await buildIgnoreFilter({ respectGitIgnore: respectGit }, root);

	let gitIgnoredCount = 0;
	const entries: Array<{
		name: string;
		path: string;
		isDirectory: boolean;
		size: number;
		modifiedTime: Date;
	}> = [];

	let names: string[];
	try {
		names = await fs.readdir(abs);
	} catch (error) {
		const msg = `Error listing directory: ${error instanceof Error ? error.message : String(error)}`;
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.LS_EXECUTION_ERROR },
		};
	}

	for (const name of names) {
		const full = path.join(abs, name);
		const relToRoot = path.relative(root, full);
		const relPosix = toPosixPath(relToRoot);
		if (isSensitivePath(relPosix)) continue;
		if (ig.ignores(relPosix)) {
			gitIgnoredCount += 1;
			continue;
		}
		if (matchCustomIgnore(name, input.ignore)) continue;

		try {
			const stats = await fs.stat(full);
			const isDirectory = stats.isDirectory();
			entries.push({
				name,
				path: full,
				isDirectory,
				size: isDirectory ? 0 : stats.size,
				modifiedTime: stats.mtime,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.warn(`[ls] Failed to stat ${full}: ${errorMsg}`);
		}
	}

	entries.sort((a, b) => {
		if (a.isDirectory && !b.isDirectory) return -1;
		if (!a.isDirectory && b.isDirectory) return 1;
		return a.name.localeCompare(b.name);
	});

	const directoryContent = entries
		.map((entry) => `${entry.isDirectory ? "[DIR] " : ""}${entry.name}`)
		.join("\n");

	let resultMessage = `Directory listing for ${abs}:\n${directoryContent}`;
	if (gitIgnoredCount > 0) {
		resultMessage += `\n\n(${gitIgnoredCount} ignored)`;
	}

	return {
		llmContent: resultMessage,
	};
}
