// ABOUTME: Reads a single file from the workspace with size and paging limits.
// ABOUTME: Supports text and selected binary types with base64 encoding.

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { isText } from "istextorbinary";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { toolResultShape } from "../types/tool-result.js";
import {
	getMimeType,
	isSupportedBinary,
	MAX_BINARY_BYTES,
	mapBinaryPart,
} from "../utils/file-content.js";
import { resolvePathAccess } from "../utils/path-policy.js";

const MAX_FULL_READ_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const DEFAULT_PAGED_LINE_LIMIT = 2000;

export const readFileShape = {
	file_path: z
		.string()
		.describe("The path to the file to read (absolute or workspace-relative)."),
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

function buildTruncatedMessage(
	content: string,
	start: number,
	end: number,
	total: number,
	nextOffset: number,
): string {
	return `TRUNCATED ${start}-${end}/${total}; next_offset=${nextOffset}\n${content}`;
}

export async function readFileTool(input: ReadFileInput) {
	const {
		file_path,
		no_ignore,
		respect_git_ignore,
		file_filtering_options,
		offset,
		limit,
	} = input;
	const access = await resolvePathAccess(file_path, {
		action: "read",
		filtering: { no_ignore, respect_git_ignore, file_filtering_options },
	});
	if (!access.ok) {
		return {
			llmContent: access.llmContent,
			error: access.error,
		};
	}
	const abs = access.absPath;

	const st = await fs.stat(abs).catch(() => null);
	if (!st || !st.isFile()) {
		const msg = `File not found or not a file: ${abs}`;
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.FILE_NOT_FOUND },
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
				error: { message: msg, type: ToolErrorType.FILE_TOO_LARGE },
			};
		}
		const buf = await fs.readFile(abs);
		const part = mapBinaryPart(mimeType, buf.toString("base64"));
		return {
			llmContent: [part],
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
		return {
			llmContent: text,
		};
	}

	const stream = createReadStream(abs, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

	const collected: string[] = [];
	let lineCount = 0;
	const startLine = lineOffset + 1;
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
	}

	const content = collected.join("\n");
	const endLine = lineOffset + collected.length;
	if (truncated) {
		const nextOffset = lineOffset + collected.length;
		const totalLines = lineCount;
		return {
			llmContent: buildTruncatedMessage(
				content,
				startLine,
				endLine,
				totalLines,
				nextOffset,
			),
		};
	}

	return {
		llmContent: content,
	};
}
