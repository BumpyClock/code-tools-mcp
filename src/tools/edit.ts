// ABOUTME: Replaces text within a file using exact literal matching.
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

export const editShape = {
	file_path: z
		.string()
		.describe(
			"The path to the file to modify (absolute or workspace-relative).",
		),
	instruction: z
		.string()
		.optional()
		.describe("A clear, semantic instruction for the code change."),
	old_string: z.string().describe("The exact literal text to replace."),
	new_string: z
		.string()
		.describe("The exact literal text to replace old_string with."),
	expected_replacements: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Number of replacements expected."),
	modified_by_user: z.boolean().optional(),
	ai_proposed_content: z.string().optional(),
};
export const editInput = z.object(editShape);
export type EditInput = z.infer<typeof editInput>;

export const editOutputShape = toolResultShape;

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
		patch.hunks.forEach((hunk) => {
			hunk.lines.forEach((line) => {
				if (line.startsWith("+")) {
					addedLines++;
					addedChars += line.length - 1;
				} else if (line.startsWith("-")) {
					removedLines++;
					removedChars += line.length - 1;
				}
			});
		});
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

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	return haystack.split(needle).length - 1;
}

function applyReplacement(
	currentContent: string | null,
	oldString: string,
	newString: string,
	isNewFile: boolean,
): { newContent: string; occurrences: number } {
	if (isNewFile) {
		return { newContent: newString, occurrences: 1 };
	}
	if (currentContent === null) {
		return { newContent: "", occurrences: 0 };
	}
	if (oldString === "") {
		return { newContent: currentContent, occurrences: 0 };
	}
	const occurrences = countOccurrences(currentContent, oldString);
	const newContent = currentContent.split(oldString).join(newString);
	return { newContent, occurrences };
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n");
}

function restoreLineEndings(text: string, newline: "\n" | "\r\n"): string {
	if (newline === "\n") return text;
	return text.replace(/\n/g, "\r\n");
}

async function ensureParentDir(filePath: string) {
	const dirName = path.dirname(filePath);
	await fs.mkdir(dirName, { recursive: true });
}

export async function editTool(input: EditInput) {
	const {
		file_path,
		old_string,
		new_string,
		expected_replacements,
		modified_by_user,
		ai_proposed_content,
	} = input;

	let abs: string;
	let root: string;
	try {
		({ absPath: abs, root } = resolveWithinWorkspace(file_path));
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			llmContent: msg,
			returnDisplay: "Error: Path not in workspace.",
			error: { message: msg, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
		};
	}

	const relPosix = relativizePosix(abs, root);
	if (isSensitivePath(relPosix)) {
		const msg = `Refusing to edit sensitive path: ${relPosix}`;
		return {
			llmContent: msg,
			returnDisplay: "Error: Path not in workspace.",
			error: { message: msg, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
		};
	}

	let current: string | null = null;
	let exists = false;
	let originalLineEnding: "\n" | "\r\n" = "\n";
	try {
		const raw = await fs.readFile(abs, "utf8");
		originalLineEnding = raw.includes("\r\n") ? "\r\n" : "\n";
		current = normalizeLineEndings(raw);
		exists = true;
	} catch {
		exists = false;
	}

	const isNewFile = !exists;
	if (isNewFile && old_string !== "") {
		const msg = `Error: No occurrence of old_string found in ${abs}`;
		return {
			llmContent: msg,
			returnDisplay: `Error: ${msg}`,
			error: { message: msg, type: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND },
		};
	}

	const { newContent, occurrences } = applyReplacement(
		current,
		old_string,
		new_string,
		isNewFile,
	);

	if (!isNewFile) {
		if (occurrences === 0) {
			const msg = `Error: No occurrence of old_string found in ${abs}`;
			return {
				llmContent: msg,
				returnDisplay: `Error: ${msg}`,
				error: { message: msg, type: ToolErrorType.EDIT_NO_OCCURRENCE_FOUND },
			};
		}
		if (
			expected_replacements !== undefined &&
			occurrences !== expected_replacements
		) {
			const msg = `Error: Expected ${expected_replacements} occurrences but found ${occurrences} in ${abs}`;
			return {
				llmContent: msg,
				returnDisplay: `Error: ${msg}`,
				error: {
					message: msg,
					type: ToolErrorType.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
				},
			};
		}
	}

	if (!isNewFile && current === newContent) {
		const msg = "No changes to apply: old_string and new_string are identical.";
		return {
			llmContent: msg,
			returnDisplay: "Error: No changes.",
			error: { message: msg, type: ToolErrorType.EDIT_NO_CHANGE },
		};
	}

	const normalizedNew = restoreLineEndings(newContent, originalLineEnding);
	try {
		await ensureParentDir(abs);
		await fs.writeFile(abs, normalizedNew, "utf8");
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return {
			llmContent: `Error executing edit: ${errorMsg}`,
			returnDisplay: `Error writing file: ${errorMsg}`,
			error: { message: errorMsg, type: ToolErrorType.FILE_WRITE_FAILURE },
		};
	}

	const fileName = path.basename(abs);
	const fileDiff = Diff.createPatch(
		fileName,
		current ?? "",
		newContent,
		"Current",
		"Proposed",
		{ context: 3, ignoreWhitespace: false },
	);
	const diffStat = getDiffStat(
		fileName,
		current ?? "",
		ai_proposed_content ?? newContent,
		newContent,
	);
	const displayResult = {
		fileDiff,
		fileName,
		filePath: abs,
		originalContent: current,
		newContent,
		diffStat,
		isNewFile,
	};

	const llmSuccessMessageParts = [
		isNewFile
			? `Created new file: ${abs} with provided content.`
			: `Successfully modified file: ${abs} (${occurrences} replacements).`,
	];
	if (modified_by_user) {
		llmSuccessMessageParts.push(
			`User modified the \`new_string\` content to be: ${new_string}.`,
		);
	}

	return {
		llmContent: llmSuccessMessageParts.join(" "),
		returnDisplay: displayResult,
	};
}
