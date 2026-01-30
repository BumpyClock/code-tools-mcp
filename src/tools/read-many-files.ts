// ABOUTME: Reads multiple files and concatenates content with separators.
// ABOUTME: Supports explicit binary inclusion for images/audio/PDF.

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { isText } from "istextorbinary";
import mime from "mime-types";
import { z } from "zod";
import { type ToolContent, toolResultShape } from "../types/tool-result.js";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	getPrimaryWorkspaceRoot,
	getWorkspaceRoots,
	isSensitivePath,
	relativize,
	relativizePosix,
	resolveWithinWorkspace,
} from "../utils/workspace.js";

export const readManyFilesShape = {
	include: z
		.array(z.string())
		.min(1)
		.describe("Glob patterns or paths to include."),
	exclude: z
		.array(z.string())
		.optional()
		.describe("Optional glob patterns to exclude."),
	recursive: z
		.boolean()
		.optional()
		.describe("Optional: whether to search recursively. Defaults to true."),
	useDefaultExcludes: z
		.boolean()
		.optional()
		.describe("Optional: apply default exclusion patterns. Defaults to true."),
	file_filtering_options: z
		.object({
			respect_git_ignore: z.boolean().optional(),
			respect_gemini_ignore: z.boolean().optional(),
		})
		.optional(),
};
export const readManyFilesInput = z.object(readManyFilesShape);
export type ReadManyFilesInput = z.infer<typeof readManyFilesInput>;

export const readManyFilesOutputShape = toolResultShape;

const DEFAULT_EXCLUDES = [
	"**/{node_modules,.git,dist,build,out}/**",
	"**/*.log",
	"**/*.tmp",
];
const DEFAULT_OUTPUT_SEPARATOR_FORMAT = "--- {filePath} ---";
const DEFAULT_OUTPUT_TERMINATOR = "\n--- End of content ---";
const TOTAL_BYTE_CAP = 2 * 1024 * 1024;
const MAX_BINARY_BYTES = 5 * 1024 * 1024;

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

function isExplicitBinaryRequest(patterns: string[], ext: string): boolean {
	const lowerExt = ext.toLowerCase();
	return patterns.some((pattern) => pattern.toLowerCase().includes(lowerExt));
}

async function globWithinRoot(
	root: string,
	include: string[],
	exclude: string[],
): Promise<string[]> {
	const entries = new Set<string>();
	for (const pattern of include) {
		const normalized = pattern.replace(/\\/g, "/");
		const fullPath = path.join(root, normalized);
		let effective = normalized;
		try {
			await fs.access(fullPath);
			effective = fg.escapePath(normalized);
		} catch {
			effective = normalized;
		}
		const matches = await fg(effective, {
			cwd: root,
			ignore: exclude,
			onlyFiles: true,
			dot: true,
			absolute: true,
			followSymbolicLinks: false,
		});
		for (const match of matches) entries.add(match);
	}
	return Array.from(entries);
}

export async function readManyFilesTool(input: ReadManyFilesInput) {
	const primaryRoot = getPrimaryWorkspaceRoot();
	const roots = getWorkspaceRoots();
	const include = input.include;
	const exclude = input.exclude ?? [];
	const useDefaultExcludes = input.useDefaultExcludes !== false;
	const respectGit = input.file_filtering_options?.respect_git_ignore ?? true;

	const effectiveExcludes = useDefaultExcludes
		? [...DEFAULT_EXCLUDES, ...exclude]
		: [...exclude];

	const filesToConsider = new Set<string>();
	for (const root of roots) {
		const matches = await globWithinRoot(root, include, effectiveExcludes);
		for (const match of matches) {
			filesToConsider.add(match);
		}
	}

	if (filesToConsider.size === 0) {
		return {
			llmContent:
				"No files matching the criteria were found or all were skipped.",
			returnDisplay: "No files were read.",
		};
	}

	const processedFilesRelativePaths: string[] = [];
	const skippedFiles: Array<{ path: string; reason: string }> = [];
	const contentParts: ToolContent[] = [];
	let totalBytes = 0;
	const ignoreCache = new Map<
		string,
		Awaited<ReturnType<typeof buildIgnoreFilter>>
	>();

	for (const abs of Array.from(filesToConsider)) {
		let resolvedRoot = primaryRoot;
		try {
			resolvedRoot = resolveWithinWorkspace(abs).root;
		} catch {
			continue;
		}
		const relPosix = relativizePosix(abs, resolvedRoot);
		if (isSensitivePath(relPosix)) {
			skippedFiles.push({ path: relPosix, reason: "sensitive" });
			continue;
		}
		if (respectGit) {
			let ig = ignoreCache.get(resolvedRoot);
			if (!ig) {
				ig = await buildIgnoreFilter({ respectGitIgnore: true }, resolvedRoot);
				ignoreCache.set(resolvedRoot, ig);
			}
			if (ig.ignores(relPosix)) {
				skippedFiles.push({ path: relPosix, reason: "ignored" });
				continue;
			}
		}

		let st: Awaited<ReturnType<typeof fs.stat>> | undefined;
		try {
			st = await fs.stat(abs);
		} catch {
			skippedFiles.push({ path: relPosix, reason: "read error" });
			continue;
		}
		if (!st.isFile()) {
			skippedFiles.push({ path: relPosix, reason: "not a file" });
			continue;
		}

		const ext = path.extname(abs).toLowerCase();
		const mimeType = getMimeType(abs);
		const isBinary = isSupportedBinary(ext);

		if (isBinary) {
			if (!isExplicitBinaryRequest(include, ext)) {
				skippedFiles.push({ path: relPosix, reason: "binary" });
				continue;
			}
			if (st.size > MAX_BINARY_BYTES) {
				skippedFiles.push({ path: relPosix, reason: "too large" });
				continue;
			}
			const buf = await fs.readFile(abs);
			contentParts.push(mapBinaryPart(mimeType, buf.toString("base64")));
			processedFilesRelativePaths.push(relativize(abs, primaryRoot));
			continue;
		}

		if (st.size > 1024 * 1024) {
			skippedFiles.push({ path: relPosix, reason: "too large" });
			continue;
		}

		let buf: Buffer;
		try {
			buf = await fs.readFile(abs);
		} catch {
			skippedFiles.push({ path: relPosix, reason: "read error" });
			continue;
		}
		if (!isText(null, buf)) {
			skippedFiles.push({ path: relPosix, reason: "binary" });
			continue;
		}

		const text = buf.toString("utf8");
		const separator = DEFAULT_OUTPUT_SEPARATOR_FORMAT.replace(
			"{filePath}",
			path.relative(primaryRoot, abs),
		);
		const chunk = `${separator}\n\n${text}\n\n`;
		const projected = totalBytes + Buffer.byteLength(chunk, "utf8");
		if (projected > TOTAL_BYTE_CAP) {
			skippedFiles.push({ path: relPosix, reason: "total cap reached" });
			break;
		}
		contentParts.push({ type: "text", text: chunk });
		totalBytes = projected;
		processedFilesRelativePaths.push(relativize(abs, primaryRoot));
	}

	let displayMessage = `### ReadManyFiles Result (Target Dir: \`${primaryRoot}\`)\n\n`;
	if (processedFilesRelativePaths.length > 0) {
		displayMessage += `Successfully read and concatenated content from **${processedFilesRelativePaths.length} file(s)**.\n`;
		const slice = processedFilesRelativePaths.slice(0, 10);
		if (slice.length > 0) {
			displayMessage += `\n**Processed Files${processedFilesRelativePaths.length > 10 ? " (first 10 shown)" : ""}:**\n`;
			for (const p of slice) {
				displayMessage += `- \`${p}\`\n`;
			}
			if (processedFilesRelativePaths.length > 10) {
				displayMessage += `- ...and ${processedFilesRelativePaths.length - 10} more.\n`;
			}
		}
	}

	if (skippedFiles.length > 0) {
		if (processedFilesRelativePaths.length === 0) {
			displayMessage += `No files were read and concatenated based on the criteria.\n`;
		}
		const slice = skippedFiles.slice(0, 5);
		displayMessage += `\n**Skipped ${skippedFiles.length} item(s)${
			skippedFiles.length > 5 ? " (first 5 shown)" : ""
		}:**\n`;
		for (const f of slice) {
			displayMessage += `- \`${f.path}\` (Reason: ${f.reason})\n`;
		}
		if (skippedFiles.length > 5) {
			displayMessage += `- ...and ${skippedFiles.length - 5} more.\n`;
		}
	}

	if (contentParts.length > 0) {
		contentParts.push({ type: "text", text: DEFAULT_OUTPUT_TERMINATOR });
	} else {
		contentParts.push({
			type: "text",
			text: "No files matching the criteria were found or all were skipped.",
		});
	}

	return {
		llmContent: contentParts,
		returnDisplay: displayMessage.trim(),
	};
}
