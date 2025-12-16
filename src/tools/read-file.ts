// ABOUTME: Reads a single file from the workspace with size and paging limits.
// ABOUTME: Enforces workspace containment, ignore rules, and basic safety blocks.

import fs from "node:fs/promises";
import path from "node:path";
import { isText } from "istextorbinary";
import mime from "mime-types";
import { z } from "zod";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	isSensitivePath,
	relativize,
	relativizePosix,
	resolveWithinWorkspace,
} from "../utils/workspace.js";

const MAX_BYTES = 2 * 1024 * 1024; // 2MB cap

export const readFileShape = {
	absolute_path: z
		.string()
		.describe(
			"Absolute path within the workspace, or a path relative to workspace root.",
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

export async function readFileTool({
	absolute_path,
	offset,
	limit,
	allow_ignored,
}: ReadFileInput) {
	let abs: string;
	try {
		abs = resolveWithinWorkspace(absolute_path);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				error: "OUTSIDE_WORKSPACE",
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
				error: "SENSITIVE_PATH",
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
					error: "FILE_IGNORED",
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
				error: "FILE_NOT_FOUND",
				message: msg,
				path: abs,
				relativePath: relPosix,
				summary: "File not found.",
			},
		};
	}
	if (st.size > MAX_BYTES) {
		const msg = `File too large (${st.size} bytes). Cap is ${MAX_BYTES}.`;
		return {
			content: [
				{
					type: "text" as const,
					text: msg,
				},
			],
			structuredContent: {
				error: "FILE_TOO_LARGE",
				message: msg,
				path: abs,
				relativePath: relPosix,
				size: st.size,
				summary: "File exceeds size cap.",
			},
		};
	}
	const buf = await fs.readFile(abs);
	let mimeType = (mime.lookup(abs) || "text/plain").toString();
	// Correct misleading MIME for TypeScript files from mime-types (video/mp2t)
	const ext = path.extname(abs).toLowerCase();
	if (ext === ".ts" || ext === ".tsx") {
		mimeType = "text/typescript";
	}
	const isTextFile = isText(null, buf);
	if (!isTextFile) {
		const info = `Binary file (${mimeType}), size ${buf.byteLength} bytes.`;
		return {
			content: [{ type: "text" as const, text: info }],
			structuredContent: {
				path: abs,
				relativePath: relPosix,
				mimeType,
				binary: true,
				size: buf.byteLength,
				summary: "Binary file; content not returned.",
			},
		};
	}
	const text = buf.toString("utf8");
	if (offset !== undefined || limit !== undefined) {
		const lines = text.split(/\r?\n/);
		const start = offset ?? 0;
		const end = Math.min(lines.length, start + (limit ?? lines.length));
		const slice = lines.slice(start, end).join("\n");
		const truncated = end < lines.length;
		return {
			content: [{ type: "text" as const, text: slice }],
			structuredContent: {
				path: abs,
				relativePath: relPosix,
				lineStart: start + 1,
				lineEnd: end,
				totalLines: lines.length,
				mimeType,
				text: slice,
				summary: `Read lines ${start + 1}-${end} of ${lines.length}.`,
				nextOffset: truncated ? end : undefined,
				truncated,
			},
		};
	}
	const lineCount = text.split(/\r?\n/).length;
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: {
			path: abs,
			relativePath: relPosix,
			mimeType,
			binary: false,
			size: buf.byteLength,
			totalLines: lineCount,
			text,
			summary: `Read ${lineCount} line(s).`,
		},
	};
}
