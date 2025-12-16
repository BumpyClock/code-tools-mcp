// ABOUTME: Reads a single file from the workspace with size and paging limits.
// ABOUTME: Enforces workspace containment, ignore rules, and basic safety blocks.

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { isText } from "istextorbinary";
import mime from "mime-types";
import { z } from "zod";
import { ErrorCode } from "../types/error-codes.js";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	isSensitivePath,
	relativize,
	relativizePosix,
	resolveWithinWorkspace,
} from "../utils/workspace.js";

const MAX_FULL_READ_BYTES = 2 * 1024 * 1024; // 2MB cap for full-file reads
const SNIFF_BYTES = 8192;
const DEFAULT_PAGED_LINE_LIMIT = 2000;

export const readFileShape = {
	path: z
		.string()
		.optional()
		.describe(
			"Path to read (absolute within workspace or workspace-relative). Preferred over absolute_path.",
		),
	absolute_path: z
		.string()
		.optional()
		.describe(
			"(Deprecated) Alias for path. Accepts absolute within workspace or workspace-relative.",
		),
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
		.max(2000)
		.optional()
		.describe("Optional: number of lines to return."),
	allow_ignored: z
		.boolean()
		.optional()
		.describe(
			"Optional: allow reading files ignored by .gitignore (default false).",
		),
	include_line_numbers: z
		.boolean()
		.optional()
		.describe("Prefix returned lines with their 1-based line numbers."),
};
export const readFileInput = z.object(readFileShape);
export type ReadFileInput = z.infer<typeof readFileInput>;

// Output schema for structured content returned by this tool
export const readFileOutputShape = {
	path: z.string().optional(),
	relativePath: z.string().optional(),
	mimeType: z.string().optional(),
	binary: z.boolean().optional(),
	size: z.number().optional(),
	lineStart: z.number().optional(),
	lineEnd: z.number().optional(),
	totalLines: z.number().optional(),
	text: z.string().optional(),
	summary: z.string().optional(),
	nextOffset: z.number().optional(),
	truncated: z.boolean().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
};

function formatNumberedLines(
	lines: string[],
	startLineNumber: number,
	includeLineNumbers: boolean,
): string {
	if (!includeLineNumbers) return lines.join("\n");
	return lines
		.map((line, idx) => `${startLineNumber + idx}: ${line}`)
		.join("\n");
}

async function sniffIsText(abs: string, size: number): Promise<boolean> {
	const fh = await fs.open(abs, "r");
	try {
		const len = Math.min(SNIFF_BYTES, size);
		const buf = Buffer.alloc(len);
		const { bytesRead } = await fh.read(buf, 0, len, 0);
		return isText(null, buf.subarray(0, bytesRead));
	} finally {
		await fh.close();
	}
}

export async function readFileTool(input: ReadFileInput) {
	const requestedPath = input.path ?? input.absolute_path;
	const offset = input.offset;
	const limit = input.limit;
	const allow_ignored = input.allow_ignored;
	const includeLineNumbers = input.include_line_numbers ?? false;

	if (!requestedPath) {
		const msg = "Missing required parameter: path";
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				error: ErrorCode.NOT_FOUND,
				message: msg,
				summary: "Missing path parameter.",
			},
		};
	}
	let abs: string;
	try {
		abs = resolveWithinWorkspace(requestedPath);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				error: ErrorCode.OUTSIDE_WORKSPACE,
				message: msg,
				summary: "Refused path outside workspace.",
			},
		};
	}

	const relPosix = relativizePosix(abs);
	if (isSensitivePath(relPosix)) {
		const msg = `Refusing to read sensitive path: ${relPosix}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				error: ErrorCode.SENSITIVE_PATH,
				message: msg,
				path: abs,
				relativePath: relPosix,
				summary: "Refused sensitive path.",
			},
		};
	}

	// Respect .gitignore entries for safety/clarity unless allow_ignored is true
	if (!allow_ignored) {
		const ig = await buildIgnoreFilter({ respectGitIgnore: true });
		if (ig.ignores(relPosix)) {
			const msg = `File is ignored by .gitignore: ${relativize(abs)}`;
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: {
					error: ErrorCode.FILE_IGNORED,
					message: msg,
					path: abs,
					relativePath: relPosix,
					summary: "Refused ignored file.",
				},
			};
		}
	}
	const st = await fs.stat(abs).catch(() => null);
	if (!st || !st.isFile()) {
		const msg = `File not found or not a file: ${abs}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				error: ErrorCode.NOT_FOUND,
				message: msg,
				path: abs,
				relativePath: relPosix,
				summary: "File not found.",
			},
		};
	}

	let mimeType = (mime.lookup(abs) || "text/plain").toString();
	// Correct misleading MIME for TypeScript files from mime-types (video/mp2t)
	const ext = path.extname(abs).toLowerCase();
	if (ext === ".ts" || ext === ".tsx") {
		mimeType = "text/typescript";
	}

	const wantsPaging = offset !== undefined || limit !== undefined;
	const allowFullRead = st.size <= MAX_FULL_READ_BYTES;
	let fullBuf: Buffer | undefined;
	let isTextFile = false;
	if (allowFullRead) {
		fullBuf = await fs.readFile(abs);
		isTextFile = isText(null, fullBuf);
	} else {
		isTextFile = await sniffIsText(abs, st.size);
	}

	if (!isTextFile) {
		const info = `Binary file (${mimeType}), size ${st.size} bytes.`;
		return {
			content: [{ type: "text" as const, text: info }],
			structuredContent: {
				path: abs,
				relativePath: relPosix,
				mimeType,
				binary: true,
				size: st.size,
				summary: "Binary file; content not returned.",
			},
		};
	}

	if (!wantsPaging) {
		if (!allowFullRead) {
			const msg = `File too large (${st.size} bytes). Use offset/limit pagination to read sections (full read cap is ${MAX_FULL_READ_BYTES} bytes).`;
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: {
					error: ErrorCode.FILE_TOO_LARGE,
					message: msg,
					path: abs,
					relativePath: relPosix,
					size: st.size,
					summary: "File exceeds full read cap.",
				},
			};
		}

		const text = fullBuf!.toString("utf8");
		const lines = text.split(/\r?\n/);
		const rendered = formatNumberedLines(lines, 1, includeLineNumbers);
		return {
			content: [{ type: "text" as const, text: rendered }],
			structuredContent: {
				path: abs,
				relativePath: relPosix,
				mimeType,
				binary: false,
				size: fullBuf!.byteLength,
				totalLines: lines.length,
				text: rendered,
				summary: `Read ${lines.length} line(s).`,
			},
		};
	}

	if (allowFullRead) {
		const text = fullBuf!.toString("utf8");
		const lines = text.split(/\r?\n/);
		const start = offset ?? 0;
		const end = Math.min(lines.length, start + (limit ?? lines.length));
		const sliceLines = lines.slice(start, end);
		const rendered = formatNumberedLines(
			sliceLines,
			start + 1,
			includeLineNumbers,
		);
		const truncated = end < lines.length;
		return {
			content: [{ type: "text" as const, text: rendered }],
			structuredContent: {
				path: abs,
				relativePath: relPosix,
				lineStart: start + 1,
				lineEnd: end,
				totalLines: lines.length,
				mimeType,
				text: rendered,
				summary: `Read lines ${start + 1}-${end} of ${lines.length}.`,
				nextOffset: truncated ? end : undefined,
				truncated,
			},
		};
	}

	const start = offset ?? 0;
	const effectiveLimit =
		limit ?? (st.size > MAX_FULL_READ_BYTES ? DEFAULT_PAGED_LINE_LIMIT : undefined);
	const wantLines = effectiveLimit ?? DEFAULT_PAGED_LINE_LIMIT;

	const sliceLines: string[] = [];
	let lineIndex = 0;
	let sawBeyondEnd = false;

	const stream = createReadStream(abs, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of rl) {
			if (lineIndex < start) {
				lineIndex += 1;
				continue;
			}

			if (sliceLines.length < wantLines) {
				sliceLines.push(line);
				lineIndex += 1;
				continue;
			}

			sawBeyondEnd = true;
			break;
		}
	} finally {
		rl.close();
		stream.destroy();
	}

	const end = start + sliceLines.length;
	const rendered = formatNumberedLines(sliceLines, start + 1, includeLineNumbers);
	const truncated = sawBeyondEnd;

	return {
		content: [{ type: "text" as const, text: rendered }],
		structuredContent: {
			path: abs,
			relativePath: relPosix,
			lineStart: start + 1,
			lineEnd: end,
			mimeType,
			binary: false,
			size: st.size,
			text: rendered,
			summary: truncated
				? `Read lines ${start + 1}-${end} (additional lines available).`
				: `Read lines ${start + 1}-${end}.`,
			nextOffset: truncated ? end : undefined,
			truncated,
		},
	};
}
