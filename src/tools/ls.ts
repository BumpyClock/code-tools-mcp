// ABOUTME: Lists directory entries within the workspace (non-recursive).
// ABOUTME: Applies ignore rules and basic safety blocks for sensitive paths.

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { toolResultShape } from "../types/tool-result.js";
import { matchCustomIgnore } from "../utils/ignore.js";
import {
	getPathPolicyBlockReason,
	resolvePathAccess,
} from "../utils/path-policy.js";
import { toPosixPath } from "../utils/workspace.js";

export const lsShape = {
	dir_path: z
		.string()
		.describe(
			"Absolute path to directory, or workspace-relative path to directory.",
		),
	no_ignore: z
		.boolean()
		.optional()
		.describe("If true, do not respect gitignore filtering for this path."),
	respect_git_ignore: z
		.boolean()
		.optional()
		.describe("If false, do not respect gitignore filtering for this path."),
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
	max_entries: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Optional maximum number of entries to include in the response."),
};
export const lsInput = z.object(lsShape);
export type LsInput = z.infer<typeof lsInput>;

export const lsOutputShape = toolResultShape;

export async function lsTool(input: LsInput) {
	const access = await resolvePathAccess(input.dir_path, {
		action: "list",
		filtering: input,
	});
	if (!access.ok) {
		return {
			llmContent: access.llmContent,
			error: access.error,
		};
	}
	const { absPath: abs, root, policy } = access;

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
		const blocked = getPathPolicyBlockReason(relPosix, policy);
		if (blocked === "sensitive") continue;
		if (blocked === "ignored") {
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

	const maxEntries = input.max_entries;
	const visibleEntries =
		typeof maxEntries === "number" ? entries.slice(0, maxEntries) : entries;
	const hiddenCount = entries.length - visibleEntries.length;

	const directoryContent = visibleEntries
		.map((entry) => `${entry.isDirectory ? "[DIR] " : ""}${entry.name}`)
		.filter(Boolean);

	const lines = [`dir=${abs}`, ...directoryContent];
	if (gitIgnoredCount > 0) {
		lines.push(`ignored=${gitIgnoredCount}`);
	}
	if (hiddenCount > 0) {
		lines.push(`truncated=${hiddenCount}`);
	}

	return {
		llmContent: lines.join("\n"),
	};
}
