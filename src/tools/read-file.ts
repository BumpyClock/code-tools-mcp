import fs from "node:fs/promises";
import path from "node:path";
import { isText } from "istextorbinary";
import mime from "mime-types";
import { z } from "zod";
import { buildIgnoreFilter } from "../utils/ignore.js";
import { relativize, resolveWithinWorkspace } from "../utils/workspace.js";

const MAX_BYTES = 2 * 1024 * 1024; // 2MB cap

export const readFileShape = {
	absolute_path: z
		.string()
		.describe("Absolute path to the file within the workspace."),
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
	mimeType: z.string().optional(),
	binary: z.boolean().optional(),
	size: z.number().optional(),
	lineStart: z.number().optional(),
	lineEnd: z.number().optional(),
	totalLines: z.number().optional(),
	summary: z.string().optional(),
	nextOffset: z.number().optional(),
	truncated: z.boolean().optional(),
	error: z.string().optional(),
};

export async function readFileTool({
	absolute_path,
	offset,
	limit,
	allow_ignored,
}: ReadFileInput) {
	if (!path.isAbsolute(absolute_path)) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Path must be absolute: ${absolute_path}`,
				},
			],
			structuredContent: { error: "PATH_NOT_ABSOLUTE" },
		};
	}
	const abs = resolveWithinWorkspace(absolute_path);
	// Respect .gitignore entries for safety/clarity unless allow_ignored is true
	if (!allow_ignored) {
		const ig = await buildIgnoreFilter({ respectGitIgnore: true });
		const relPosix = relativize(abs).split(path.sep).join("/");
		if (ig.ignores(relPosix)) {
			const msg = `File is ignored by .gitignore: ${relativize(abs)}`;
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: { error: "FILE_IGNORED", path: abs },
			};
		}
	}
	const st = await fs.stat(abs).catch(() => null);
	if (!st || !st.isFile()) {
		return {
			content: [
				{ type: "text" as const, text: `File not found or not a file: ${abs}` },
			],
			structuredContent: { error: "FILE_NOT_FOUND" },
		};
	}
	if (st.size > MAX_BYTES) {
		return {
			content: [
				{
					type: "text" as const,
					text: `File too large (${st.size} bytes). Cap is ${MAX_BYTES}.`,
				},
			],
			structuredContent: { error: "FILE_TOO_LARGE", size: st.size },
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
				mimeType,
				binary: true,
				size: buf.byteLength,
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
				lineStart: start + 1,
				lineEnd: end,
				totalLines: lines.length,
				mimeType,
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
			mimeType,
			binary: false,
			totalLines: lineCount,
			summary: `Read ${lineCount} line(s).`,
		},
	};
}
