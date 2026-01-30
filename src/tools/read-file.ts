// ABOUTME: Reads a single file from the workspace with size and paging limits.
// ABOUTME: Supports text and selected binary types with base64 encoding.

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { isText } from "istextorbinary";
import mime from "mime-types";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { type ToolContent, toolResultShape } from "../types/tool-result.js";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	isSensitivePath,
	relativizePosix,
	resolveWithinWorkspace,
} from "../utils/workspace.js";

const MAX_FULL_READ_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 5 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const DEFAULT_PAGED_LINE_LIMIT = 2000;

const IMAGE_EXTS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".bmp",
]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".aiff", ".aac", ".ogg", ".flac"]);
const PDF_EXTS = new Set([".pdf"]);

export const readFileShape = {
	file_path: z
		.string()
		.describe("The path to the file to read (absolute or workspace-relative)."),
	offset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Optional: starting line (0-based)."),
	limit: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Optional: number of lines to return."),
};
export const readFileInput = z.object(readFileShape);
export type ReadFileInput = z.infer<typeof readFileInput>;

export const readFileOutputShape = toolResultShape;

async function sniffIsText(abs: string, size: number): Promise<boolean> {
	const fh = await fs.open(abs, "r");
	try {
		const len = Math.min(SNIFF_BYTES, size);
		const buf = Buffer.alloc(len);
		const { bytesRead } = await fh.read(buf, 0, len, 0);
		return Boolean(isText(null, buf.subarray(0, bytesRead)));
	} finally {
		await fh.close();
	}
}

function getMimeType(abs: string): string {
	const ext = path.extname(abs).toLowerCase();
	if (ext === ".ts" || ext === ".tsx") return "text/typescript";
	return (mime.lookup(abs) || "text/plain").toString();
}

function isSupportedBinary(ext: string): boolean {
	return IMAGE_EXTS.has(ext) || AUDIO_EXTS.has(ext) || PDF_EXTS.has(ext);
}

function mapBinaryPart(mimeType: string, data: string): ToolContent {
	if (mimeType.startsWith("image/")) {
		return { type: "image", data, mimeType };
	}
	return { type: "resource", data, mimeType };
}

function buildTruncatedMessage(
	content: string,
	start: number,
	end: number,
	total: number,
	nextOffset: number,
): string {
	return `IMPORTANT: The file content has been truncated.\nStatus: Showing lines ${start}-${end} of ${total} total lines.\nAction: To read more of the file, you can use the 'offset' and 'limit' parameters in a subsequent 'read_file' call. For example, to read the next section of the file, use offset: ${nextOffset}.\n\n--- FILE CONTENT (truncated) ---\n${content}`;
}

export async function readFileTool(input: ReadFileInput) {
	const { file_path, offset, limit } = input;
	let abs: string;
	let root: string;
	try {
		({ absPath: abs, root } = resolveWithinWorkspace(file_path));
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			llmContent: msg,
			returnDisplay: "Path not in workspace.",
			error: { message: msg, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
		};
	}

	const relPosix = relativizePosix(abs, root);
	if (isSensitivePath(relPosix)) {
		const msg = `Refusing to read sensitive path: ${relPosix}`;
		return {
			llmContent: msg,
			returnDisplay: "Refused sensitive path.",
			error: { message: msg, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
		};
	}

	const st = await fs.stat(abs).catch(() => null);
	if (!st || !st.isFile()) {
		const msg = `File not found or not a file: ${abs}`;
		return {
			llmContent: msg,
			returnDisplay: "File not found.",
			error: { message: msg, type: ToolErrorType.FILE_NOT_FOUND },
		};
	}

	const ig = await buildIgnoreFilter({ respectGitIgnore: true }, root);
	if (ig.ignores(relPosix)) {
		const msg = `File path '${abs}' is ignored by configured ignore patterns.`;
		return {
			llmContent: msg,
			returnDisplay: "Path ignored.",
			error: { message: msg, type: ToolErrorType.INVALID_TOOL_PARAMS },
		};
	}

	const ext = path.extname(abs).toLowerCase();
	const mimeType = getMimeType(abs);
	const isBinaryByExt = isSupportedBinary(ext);

	if (isBinaryByExt) {
		if (st.size > MAX_BINARY_BYTES) {
			const msg = `File too large to read: ${abs}`;
			return {
				llmContent: msg,
				returnDisplay: "File too large.",
				error: { message: msg, type: ToolErrorType.FILE_TOO_LARGE },
			};
		}
		const buf = await fs.readFile(abs);
		const part = mapBinaryPart(mimeType, buf.toString("base64"));
		return {
			llmContent: [part],
			returnDisplay: `Read file ${abs}.`,
		};
	}

	const allowFullRead = st.size <= MAX_FULL_READ_BYTES;
	let fullBuf: Buffer | undefined;
	let isTextFile = false;
	if (allowFullRead) {
		fullBuf = await fs.readFile(abs);
		isTextFile = Boolean(isText(null, fullBuf));
	} else {
		isTextFile = await sniffIsText(abs, st.size);
	}

	if (!isTextFile) {
		const msg = `File is binary or unsupported: ${abs}`;
		return {
			llmContent: msg,
			returnDisplay: "Unsupported file type.",
			error: { message: msg, type: ToolErrorType.READ_CONTENT_FAILURE },
		};
	}

	const lineOffset = offset ?? 0;
	let lineLimit = limit;
	if (!lineLimit && !allowFullRead) {
		lineLimit = DEFAULT_PAGED_LINE_LIMIT;
	}

	if (allowFullRead && lineLimit === undefined && offset === undefined) {
		const text = fullBuf ? fullBuf.toString("utf8") : "";
		const rendered = text;
		return {
			llmContent: rendered,
			returnDisplay: "Read file.",
		};
	}

	const stream = createReadStream(abs, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

	const collected: string[] = [];
	let lineCount = 0;
	const startLine = lineOffset + 1;
	let endLine = lineOffset;
	let truncated = false;

	for await (const line of rl) {
		const currentLine = lineCount;
		lineCount += 1;
		if (currentLine < lineOffset) continue;
		if (lineLimit !== undefined && collected.length >= lineLimit) {
			truncated = true;
			continue;
		}
		collected.push(line);
		endLine = lineOffset + collected.length;
	}

	const content = collected.join("\n");
	if (truncated) {
		const nextOffset = lineOffset + collected.length;
		return {
			llmContent: buildTruncatedMessage(
				content,
				startLine,
				endLine,
				lineCount,
				nextOffset,
			),
			returnDisplay: "Read file (truncated).",
		};
	}

	return {
		llmContent: content,
		returnDisplay: "Read file.",
	};
}
