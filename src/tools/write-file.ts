// ABOUTME: Writes a file within the workspace.
// ABOUTME: Returns a success/error message for the write operation.

import fs from "node:fs/promises";
import path from "node:path";
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
	const { file_path, content } = input;

	let abs: string;
	let root: string;
	try {
		({ absPath: abs, root } = resolveWithinWorkspace(file_path));
	} catch (_e: unknown) {
		const msg = `Path not in workspace: ${file_path}`;
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
		};
	}

	const relPosix = relativizePosix(abs, root);
	if (isSensitivePath(relPosix)) {
		const msg = `Refusing to write sensitive path: ${relPosix}`;
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.SENSITIVE_PATH },
		};
	}

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
