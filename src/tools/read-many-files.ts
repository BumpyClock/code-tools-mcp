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
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	getPrimaryWorkspaceRoot,
	getWorkspaceRoots,
	isSensitivePath,
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
		};
	}

	const contentParts: ToolContent[] = [];
	let totalBytes = 0;
	const ignoreCache = new Map<
		string,
		Awaited<ReturnType<typeof buildIgnoreFilter>>
	>();

	const sortedFilesToConsider = Array.from(filesToConsider).sort((a, b) =>
		a.localeCompare(b),
	);

	for (const abs of sortedFilesToConsider) {
		let resolvedRoot = primaryRoot;
		try {
			resolvedRoot = resolveWithinWorkspace(abs).root;
		} catch {
			continue;
		}
		const relPosix = relativizePosix(abs, resolvedRoot);
		if (isSensitivePath(relPosix)) {
			continue;
		}
		if (respectGit) {
			let ig = ignoreCache.get(resolvedRoot);
			if (!ig) {
				ig = await buildIgnoreFilter({ respectGitIgnore: true }, resolvedRoot);
				ignoreCache.set(resolvedRoot, ig);
			}
			if (ig.ignores(relPosix)) {
				continue;
			}
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
		const chunk = `${separator}\n\n${text}\n\n`;
		const projected = totalBytes + Buffer.byteLength(chunk, "utf8");
		if (projected > TOTAL_BYTE_CAP) {
			break;
		}
		contentParts.push({ type: "text", text: chunk });
		totalBytes = projected;
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
	};
}
