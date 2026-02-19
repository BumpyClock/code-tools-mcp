// ABOUTME: Replaces text within a file using exact literal matching.
// ABOUTME: Returns a success/error message for the replacement operation.

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { toolResultShape } from "../types/tool-result.js";
import { resolvePathAccess } from "../utils/path-policy.js";

export const editShape = {
	file_path: z
		.string()
		.describe(
			"The path to the file to modify (absolute or workspace-relative).",
		),
	no_ignore: z
		.boolean()
		.optional()
		.describe("If true, do not respect gitignore filtering for this path."),
	respect_git_ignore: z
		.boolean()
		.optional()
		.describe("If false, do not respect gitignore filtering for this path."),
	file_filtering_options: z
		.object({
			respect_git_ignore: z.boolean().optional(),
			respect_gemini_ignore: z.boolean().optional(),
		})
		.optional(),
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
};
export const editInput = z.object(editShape);
export type EditInput = z.infer<typeof editInput>;

export const editOutputShape = toolResultShape;

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
		throw new Error(
			"Invariant violation: currentContent is null for an existing file.",
		);
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
		no_ignore,
		respect_git_ignore,
		file_filtering_options,
		old_string,
		new_string,
		expected_replacements,
	} = input;
	const access = await resolvePathAccess(file_path, {
		action: "edit",
		filtering: { no_ignore, respect_git_ignore, file_filtering_options },
	});
	if (!access.ok) {
		return {
			llmContent: access.llmContent,
			error: access.error,
		};
	}
	const abs = access.absPath;

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
			error: { message: errorMsg, type: ToolErrorType.FILE_WRITE_FAILURE },
		};
	}

	const successMessage = isNewFile
		? `Created new file: ${abs} with provided content.`
		: `Successfully modified file: ${abs} (${occurrences} replacements).`;

	return { llmContent: successMessage };
}
