// ABOUTME: Writes a file within the workspace with a preview-first workflow.
// ABOUTME: Enforces workspace containment, ignore rules, and basic safety blocks.

import fs from "node:fs/promises";
import path from "node:path";
import * as Diff from "diff";
import { z } from "zod";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	isSensitivePath,
	relativize,
	relativizePosix,
	resolveWithinWorkspace,
} from "../utils/workspace.js";

export const writeFileShape = {
	file_path: z
		.string()
		.describe(
			"Absolute path within the workspace, or a path relative to workspace root.",
		),
	content: z.string().describe("Proposed full file content."),
	// Parity-inspired options
	apply: z
		.boolean()
		.default(false)
		.describe("If false (default), return a diff preview without writing."),
	overwrite: z
		.boolean()
		.default(true)
		.describe("Allow overwriting existing files."),
	allow_ignored: z
		.boolean()
		.optional()
		.describe(
			"Optional: allow writing files ignored by .gitignore (default false).",
		),
	modified_by_user: z.boolean().optional(),
	ai_proposed_content: z.string().optional(),
};
export const writeFileInput = z.object(writeFileShape);
export type WriteFileInput = z.infer<typeof writeFileInput>;

// Output schema for structured content returned by this tool
export const writeFileOutputShape = {
	path: z.string().optional(),
	relativePath: z.string().optional(),
	applied: z.boolean().optional(),
	diff: z.string().optional(),
	summary: z.string().optional(),
	linesAdded: z.number().optional(),
	linesRemoved: z.number().optional(),
	modifiedByUser: z.boolean().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
};

async function readIfExists(
	abs: string,
): Promise<{ exists: boolean; content: string }> {
	try {
		const buf = await fs.readFile(abs, "utf8");
		return { exists: true, content: buf };
	} catch (_e) {
		return { exists: false, content: "" };
	}
}

function unifiedDiff(filename: string, oldStr: string, newStr: string) {
	return Diff.createPatch(filename, oldStr, newStr, "Current", "Proposed");
}

function getDiffStats(
	oldStr: string,
	newStr: string,
): { added: number; removed: number } {
	const changes = Diff.diffLines(oldStr, newStr);
	let added = 0;
	let removed = 0;

	for (const change of changes) {
		if (change.added) {
			added += change.count || 0;
		} else if (change.removed) {
			removed += change.count || 0;
		}
	}

	return { added, removed };
}

function mapFileSystemError(error: unknown): { message: string; code: string } {
	const err = error as NodeJS.ErrnoException | undefined;
	if (err?.code === "EACCES") {
		return {
			message: "Permission denied: cannot write to file",
			code: "PERMISSION_DENIED",
		};
	} else if (err?.code === "ENOSPC") {
		return { message: "No space left on device", code: "DISK_FULL" };
	} else if (err?.code === "EISDIR") {
		return {
			message: "Cannot write to directory: path is a directory",
			code: "IS_DIRECTORY",
		};
	} else if (err?.code === "ENOTDIR") {
		return {
			message: "Parent path is not a directory",
			code: "PARENT_NOT_DIRECTORY",
		};
	}
	return {
		message: err?.message ?? "Write operation failed",
		code: "WRITE_FAILED",
	};
}

export async function writeFileTool(input: WriteFileInput) {
	const {
		file_path,
		content,
		apply,
		overwrite,
		modified_by_user,
		allow_ignored,
	} = input;

	// Workspace validation with friendlier error
	let abs: string;
	try {
		abs = resolveWithinWorkspace(file_path);
	} catch (_e) {
		const msg = `Cannot write outside workspace: ${file_path}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				error: "OUTSIDE_WORKSPACE",
				message: msg,
			},
		};
	}

	const relPosix = relativizePosix(abs);
	if (isSensitivePath(relPosix)) {
		const msg = `Refusing to write sensitive path: ${relPosix}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				error: "SENSITIVE_PATH",
				message: msg,
				path: abs,
				relativePath: relPosix,
			},
		};
	}

	// Respect .gitignore unless allow_ignored is true.
	if (!allow_ignored) {
		const ig = await buildIgnoreFilter({ respectGitIgnore: true });
		if (ig.ignores(relPosix)) {
			const msg = `Refusing to write ignored file: ${relPosix}`;
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: {
					error: "FILE_IGNORED",
					message: msg,
					path: abs,
					relativePath: relPosix,
				},
			};
		}
	}

	const { exists, content: current } = await readIfExists(abs);
	if (exists === true && overwrite === false) {
		return {
			content: [
				{
					type: "text" as const,
					text: `File exists and overwrite=false: ${abs}`,
				},
			],
			structuredContent: { error: "OVERWRITE_DISABLED" },
		};
	}

	const fileName = path.basename(abs);
	const diff = unifiedDiff(fileName, current, content);
	const rel = relativize(abs);

	// Calculate diff statistics
	const stats = getDiffStats(current, content);
	const isNewFile = !exists;

	// Create summary
	const summary = isNewFile
		? "Creating new file"
		: `Modifying file: +${stats.added} -${stats.removed} lines`;

	// Add note if modified by user
	const userNote = modified_by_user ? " (user-modified content)" : "";

	if (!apply) {
		const previewText = `Diff preview for ${rel} (no changes written)${userNote}. To apply, call write_file with apply: true.\n\n${diff}`;
		return {
			content: [{ type: "text" as const, text: previewText }],
			structuredContent: {
				path: abs,
				relativePath: relPosix,
				applied: false,
				diff,
				summary: `${summary} (preview)`,
				linesAdded: stats.added,
				linesRemoved: stats.removed,
				modifiedByUser: modified_by_user,
			},
		};
	}

	try {
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, content, "utf8");
	} catch (error) {
		const errorInfo = mapFileSystemError(error);
		return {
			content: [
				{
					type: "text" as const,
					text: `Failed to write file: ${errorInfo.message}`,
				},
			],
			structuredContent: { error: errorInfo.code, message: errorInfo.message },
		};
	}

	const resultText = `Wrote ${rel}${userNote}.\n\n${diff}`;
	return {
		content: [{ type: "text" as const, text: resultText }],
		structuredContent: {
			path: abs,
			relativePath: relPosix,
			applied: true,
			diff,
			summary: `${summary} (applied)`,
			linesAdded: stats.added,
			linesRemoved: stats.removed,
			modifiedByUser: modified_by_user,
		},
	};
}
