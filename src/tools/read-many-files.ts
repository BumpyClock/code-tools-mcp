// ABOUTME: Reads multiple files and concatenates content with separators.
// ABOUTME: Supports explicit binary inclusion for images/audio/PDF.

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { isText } from "istextorbinary";
import { z } from "zod";
import { type ToolContent, toolResultShape } from "../types/tool-result.js";
import {
	getMimeType,
	isSupportedBinary,
	MAX_BINARY_BYTES,
	mapBinaryPart,
} from "../utils/file-content.js";
import {
	getPathPolicyBlockReason,
	getPolicyContextForRoot,
	resolveRespectGitIgnore,
} from "../utils/path-policy.js";
import {
	getPrimaryWorkspaceRoot,
	getWorkspaceRoots,
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
	no_ignore: z
		.boolean()
		.optional()
		.describe("If true, do not respect ignore files."),
	respect_git_ignore: z
		.boolean()
		.optional()
		.describe("If false, do not respect gitignore filtering."),
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
	max_files: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Optional maximum number of files to include."),
	max_output_bytes: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Optional maximum output size in bytes."),
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
const TOTAL_BYTE_CAP = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

function isExplicitBinaryRequest(patterns: string[], ext: string): boolean {
	const lowerExt = ext.toLowerCase();
	const escaped = lowerExt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const extRegex = new RegExp(`${escaped}(?:$|[\\\\/]|\\?|#)`);
	return patterns.some((pattern) => extRegex.test(pattern.toLowerCase()));
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

async function globAbsoluteInclude(
	includePattern: string,
	exclude: string[],
): Promise<string[]> {
	const normalized = path.normalize(includePattern);
	const st = await fs.stat(normalized).catch(() => null);
	if (st?.isFile()) return [normalized];
	if (st?.isDirectory()) {
		return fg("**/*", {
			cwd: normalized,
			ignore: exclude,
			onlyFiles: true,
			dot: true,
			absolute: true,
			followSymbolicLinks: false,
		});
	}
	return fg(includePattern, {
		ignore: exclude,
		onlyFiles: true,
		dot: true,
		absolute: true,
		followSymbolicLinks: false,
	});
}

export async function readManyFilesTool(input: ReadManyFilesInput) {
	const primaryRoot = getPrimaryWorkspaceRoot();
	const roots = getWorkspaceRoots();
	const include = input.include;
	const exclude = input.exclude ?? [];
	const useDefaultExcludes = input.useDefaultExcludes !== false;
	const respectGit = resolveRespectGitIgnore(input);
	const maxFiles = input.max_files;
	const maxOutputBytes = input.max_output_bytes ?? TOTAL_BYTE_CAP;

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
	for (const includePattern of include) {
		if (!path.isAbsolute(includePattern)) continue;
		const matches = await globAbsoluteInclude(
			includePattern,
			effectiveExcludes,
		);
		for (const match of matches) {
			filesToConsider.add(path.normalize(match));
		}
	}

	if (filesToConsider.size === 0) {
		return {
			llmContent:
				"No files matching the criteria were found or all were skipped.",
		};
	}

	const contentParts: ToolContent[] = [];
	let totalBytes = 0;
	const policyByRoot = new Map<
		string,
		Awaited<ReturnType<typeof getPolicyContextForRoot>>
	>();
	let includedFiles = 0;
	let truncatedByFiles = false;
	let truncatedByBytes = false;

	const sortedFilesToConsider = Array.from(filesToConsider).sort((a, b) =>
		a.localeCompare(b),
	);

	for (const abs of sortedFilesToConsider) {
		if (typeof maxFiles === "number" && includedFiles >= maxFiles) {
			truncatedByFiles = true;
			break;
		}
		let resolvedRoot = primaryRoot;
		try {
			resolvedRoot = resolveWithinWorkspace(abs).root;
		} catch {
			continue;
		}
		const relPosix = relativizePosix(abs, resolvedRoot);
		let policy = policyByRoot.get(resolvedRoot);
		if (!policy) {
			policy = await getPolicyContextForRoot(resolvedRoot, respectGit);
			policyByRoot.set(resolvedRoot, policy);
		}
		if (getPathPolicyBlockReason(relPosix, policy)) {
			continue;
		}

		let st: Awaited<ReturnType<typeof fs.stat>> | undefined;
		try {
			st = await fs.stat(abs);
		} catch {
			continue;
		}
		if (!st.isFile()) {
			continue;
		}

		const ext = path.extname(abs).toLowerCase();
		const mimeType = getMimeType(abs);
		const isBinary = isSupportedBinary(ext);

		if (isBinary) {
			if (!isExplicitBinaryRequest(include, ext)) {
				continue;
			}
			if (st.size > MAX_BINARY_BYTES) {
				continue;
			}
			const buf = await fs.readFile(abs);
			contentParts.push(mapBinaryPart(mimeType, buf.toString("base64")));
			continue;
		}

		if (st.size > MAX_TEXT_BYTES) {
			continue;
		}

		let buf: Buffer;
		try {
			buf = await fs.readFile(abs);
		} catch {
			continue;
		}
		if (!isText(null, buf)) {
			continue;
		}

		const text = buf.toString("utf8");
		const separator = DEFAULT_OUTPUT_SEPARATOR_FORMAT.replace(
			"{filePath}",
			path.relative(primaryRoot, abs),
		);
		const chunk = `${separator}\n${text}\n`;
		const projected = totalBytes + Buffer.byteLength(chunk, "utf8");
		if (projected > maxOutputBytes) {
			truncatedByBytes = true;
			break;
		}
		contentParts.push({ type: "text", text: chunk });
		totalBytes = projected;
		includedFiles += 1;
	}

	if (contentParts.length > 0) {
		if (truncatedByFiles || truncatedByBytes) {
			const reasonParts: string[] = [];
			if (truncatedByFiles) reasonParts.push("max_files");
			if (truncatedByBytes) reasonParts.push("max_output_bytes");
			contentParts.push({
				type: "text",
				text: `TRUNCATED reason=${reasonParts.join(",")}`,
			});
		}
	} else {
		contentParts.push({
			type: "text",
			text: "No files matching the criteria were found or all were skipped.",
		});
	}

	return {
		llmContent: contentParts,
	};
}
