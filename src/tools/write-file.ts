// ABOUTME: Writes a file within the workspace.
// ABOUTME: Returns a diff-like display object in Gemini CLI style.

import fs from "node:fs/promises";
import path from "node:path";
import * as Diff from "diff";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { toolResultShape } from "../types/tool-result.js";
import {
	isSensitivePath,
	relativizePosix,
	resolveWithinWorkspace,
} from "../utils/workspace.js";

export const writeFileShape = {
	file_path: z
		.string()
		.describe(
			"The path to the file to write to (absolute or workspace-relative).",
		),
	content: z.string().describe("The content to write to the file."),
	modified_by_user: z.boolean().optional(),
	ai_proposed_content: z.string().optional(),
};
export const writeFileInput = z.object(writeFileShape);
export type WriteFileInput = z.infer<typeof writeFileInput>;

export const writeFileOutputShape = toolResultShape;

interface DiffStat {
	model_added_lines: number;
	model_removed_lines: number;
	model_added_chars: number;
	model_removed_chars: number;
	user_added_lines: number;
	user_removed_lines: number;
	user_added_chars: number;
	user_removed_chars: number;
}

function getDiffStat(
	fileName: string,
	oldStr: string,
	aiStr: string,
	userStr: string,
): DiffStat {
	const getStats = (patch: Diff.StructuredPatch) => {
		let addedLines = 0;
		let removedLines = 0;
		let addedChars = 0;
		let removedChars = 0;
		for (const hunk of patch.hunks) {
			for (const line of hunk.lines) {
				if (line.startsWith("+")) {
					addedLines++;
					addedChars += line.length - 1;
				} else if (line.startsWith("-")) {
					removedLines++;
					removedChars += line.length - 1;
				}
			}
		}
		return { addedLines, removedLines, addedChars, removedChars };
	};

	const modelPatch = Diff.structuredPatch(
		fileName,
		fileName,
		oldStr,
		aiStr,
		"Current",
		"Proposed",
		{ context: 3, ignoreWhitespace: false },
	);
	const modelStats = getStats(modelPatch);

	const userPatch = Diff.structuredPatch(
		fileName,
		fileName,
		aiStr,
		userStr,
		"Proposed",
		"User",
		{ context: 3, ignoreWhitespace: false },
	);
	const userStats = getStats(userPatch);

	return {
		model_added_lines: modelStats.addedLines,
		model_removed_lines: modelStats.removedLines,
		model_added_chars: modelStats.addedChars,
		model_removed_chars: modelStats.removedChars,
		user_added_lines: userStats.addedLines,
		user_removed_lines: userStats.removedLines,
		user_added_chars: userStats.addedChars,
		user_removed_chars: userStats.removedChars,
	};
}

async function readIfExists(
	abs: string,
): Promise<{ exists: boolean; content: string }> {
	try {
		const buf = await fs.readFile(abs, "utf8");
		return { exists: true, content: buf };
	} catch {
		return { exists: false, content: "" };
	}
}

async function ensureParentDir(filePath: string) {
	const dirName = path.dirname(filePath);
	await fs.mkdir(dirName, { recursive: true });
}

export async function writeFileTool(input: WriteFileInput) {
	const { file_path, content, modified_by_user, ai_proposed_content } = input;

	let abs: string;
	let root: string;
	try {
		({ absPath: abs, root } = resolveWithinWorkspace(file_path));
	} catch (_e: unknown) {
		const msg = `Path not in workspace: ${file_path}`;
		return {
			llmContent: msg,
			returnDisplay: msg,
			error: { message: msg, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
		};
	}

	const relPosix = relativizePosix(abs, root);
	if (isSensitivePath(relPosix)) {
		const msg = `Refusing to write sensitive path: ${relPosix}`;
		return {
			llmContent: msg,
			returnDisplay: msg,
			error: { message: msg, type: ToolErrorType.SENSITIVE_PATH },
		};
	}

	const { exists, content: originalContent } = await readIfExists(abs);
	const isNewFile = !exists;

	try {
		await ensureParentDir(abs);
		await fs.writeFile(abs, content, "utf8");
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return {
			llmContent: `Error writing to file: ${errorMsg}`,
			returnDisplay: `Error writing to file: ${errorMsg}`,
			error: { message: errorMsg, type: ToolErrorType.FILE_WRITE_FAILURE },
		};
	}

	const fileName = path.basename(abs);
	const fileDiff = Diff.createPatch(
		fileName,
		originalContent,
		content,
		"Original",
		"Written",
		{ context: 3, ignoreWhitespace: false },
	);
	const diffStat = getDiffStat(
		fileName,
		originalContent,
		ai_proposed_content ?? content,
		content,
	);
	const displayResult = {
		fileDiff,
		fileName,
		filePath: abs,
		originalContent,
		newContent: content,
		diffStat,
		isNewFile,
	};

	const llmSuccessMessageParts = [
		isNewFile
			? `Successfully created and wrote to new file: ${abs}.`
			: `Successfully overwrote file: ${abs}.`,
	];
	if (modified_by_user) {
		const lineCount = content.split(/\r?\n/).length;
		const charCount = content.length;
		const previewLimit = 200;
		const rawPreview = content.slice(0, previewLimit);
		const preview = rawPreview.replace(/\r?\n/g, "\\n");
		const suffix = content.length > previewLimit ? "..." : "";
		llmSuccessMessageParts.push(
			`User modified the \`content\` (chars: ${charCount}, lines: ${lineCount}). Preview: ${preview}${suffix}`,
		);
	}

	return {
		llmContent: llmSuccessMessageParts.join(" "),
		returnDisplay: displayResult,
	};
}
