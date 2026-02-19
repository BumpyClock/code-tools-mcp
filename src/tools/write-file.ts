// ABOUTME: Writes a file within the workspace.
// ABOUTME: Returns a success/error message for the write operation.

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { toolResultShape } from "../types/tool-result.js";
import { resolvePathAccess } from "../utils/path-policy.js";

export const writeFileShape = {
	file_path: z
		.string()
		.describe(
			"The path to the file to write to (absolute or workspace-relative).",
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
	content: z.string().describe("The content to write to the file."),
};
export const writeFileInput = z.object(writeFileShape);
export type WriteFileInput = z.infer<typeof writeFileInput>;

export const writeFileOutputShape = toolResultShape;

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
	const {
		file_path,
		no_ignore,
		respect_git_ignore,
		file_filtering_options,
		content,
	} = input;
	const access = await resolvePathAccess(file_path, {
		action: "write",
		filtering: { no_ignore, respect_git_ignore, file_filtering_options },
	});
	if (!access.ok) {
		return {
			llmContent: access.llmContent,
			error: access.error,
		};
	}
	const abs = access.absPath;

	const { exists } = await readIfExists(abs);
	const isNewFile = !exists;

	try {
		await ensureParentDir(abs);
		await fs.writeFile(abs, content, "utf8");
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		return {
			llmContent: `Error writing to file: ${errorMsg}`,
			error: { message: errorMsg, type: ToolErrorType.FILE_WRITE_FAILURE },
		};
	}

	const successMessage = isNewFile
		? `Successfully created and wrote to new file: ${abs}.`
		: `Successfully overwrote file: ${abs}.`;

	return { llmContent: successMessage };
}
