// ABOUTME: Reads multiple text files in the workspace and concatenates results.
// ABOUTME: Applies ignore rules, safety checks, and output size caps.

import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { isText } from "istextorbinary";
import { z } from "zod";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	getWorkspaceRoot,
	isSensitivePath,
	resolveWithinWorkspace,
	toPosixPath,
} from "../utils/workspace.js";

export const readManyFilesShape = {
	paths: z
		.array(z.string())
		.describe("Array of file or directory globs relative to workspace."),
	include: z
		.array(z.string())
		.optional()
		.describe("Additional glob patterns to include."),
	exclude: z.array(z.string()).optional().describe("Glob patterns to exclude."),
	useDefaultExcludes: z
		.boolean()
		.optional()
		.describe(
			"Apply default excludes (node_modules, dist, .git, etc.). Default true.",
		),
	file_filtering_options: z
		.object({ respect_git_ignore: z.boolean().optional() })
		.optional(),
};
export const readManyFilesInput = z.object(readManyFilesShape);
export type ReadManyFilesInput = z.infer<typeof readManyFilesInput>;

// Output schema for structured content returned by this tool
export const readManyFilesOutputShape = {
	files: z.array(z.string()),
	relativeFiles: z.array(z.string()).optional(),
	fileStats: z
		.array(z.object({ path: z.string(), lines: z.number(), bytes: z.number() }))
		.optional(),
	skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
	skipCounts: z
		.object({
			ignored: z.number().optional(),
			sensitive: z.number().optional(),
			binary: z.number().optional(),
			tooLarge: z.number().optional(),
			notFile: z.number().optional(),
			totalCapReached: z.number().optional(),
			readError: z.number().optional(),
		})
		.optional(),
	totalBytes: z.number(),
	text: z.string().optional(),
	truncated: z.boolean().optional(),
	totalCapReached: z.boolean().optional(),
	summary: z.string(),
};

const DEFAULT_EXCLUDES = ["**/{node_modules,.git,dist,build,out}/**"];
const SEP_FORMAT = "--- {filePath} ---";
const TERMINATOR = "\n--- End of content ---";
const TOTAL_BYTE_CAP = 2 * 1024 * 1024; // 2MB total output cap

export async function readManyFilesTool(input: ReadManyFilesInput) {
	const root = getWorkspaceRoot();
	const searchPatterns = [...input.paths, ...(input.include ?? [])];
	const excludes = [
		...(input.useDefaultExcludes === false ? [] : DEFAULT_EXCLUDES),
		...(input.exclude ?? []),
	];
	const ig = await buildIgnoreFilter({
		respectGitIgnore: input.file_filtering_options?.respect_git_ignore ?? true,
	});

	const files = new Set<string>();
	for (const pattern of searchPatterns) {
		const absMatches = await fg(pattern, {
			cwd: root,
			absolute: true,
			dot: true,
			onlyFiles: true,
			followSymbolicLinks: false,
			ignore: excludes,
		});
		for (const p of absMatches) {
			// Belt-and-suspenders: re-check workspace containment for each resolved path
			try {
				resolveWithinWorkspace(p);
				files.add(p);
			} catch {
				// Path is outside workspace, skip it
			}
		}
	}
	const filesArr = Array.from(files).sort((a, b) =>
		path.relative(root, a).localeCompare(path.relative(root, b)),
	);
	if (filesArr.length === 0) {
		return {
			content: [{ type: "text" as const, text: "No files matched." }],
			structuredContent: {
				files: [],
				relativeFiles: [],
				fileStats: [],
				skipped: [],
				skipCounts: {
					ignored: 0,
					sensitive: 0,
					binary: 0,
					tooLarge: 0,
					notFile: 0,
					totalCapReached: 0,
					readError: 0,
				},
				totalBytes: 0,
				text: "",
				truncated: false,
				totalCapReached: false,
				summary: "No files matched.",
			},
		};
	}

	let totalBytes = 0;
	let output = "";
	const included: string[] = [];
	const includedRel: string[] = [];
	const fileStats: Array<{ path: string; lines: number; bytes: number }> = [];
	const skipped: Array<{ path: string; reason: string }> = [];

	// Track skip reasons for aggregation
	const skipCounts = {
		ignored: 0,
		sensitive: 0,
		binary: 0,
		tooLarge: 0,
		notFile: 0,
		totalCapReached: 0,
		readError: 0,
	};
	let totalCapReached = false;

	for (const abs of filesArr) {
		const relPosix = toPosixPath(path.relative(root, abs));
		if (isSensitivePath(relPosix)) {
			skipped.push({ path: abs, reason: "sensitive" });
			skipCounts.sensitive++;
			continue;
		}
		if (ig.ignores(relPosix)) {
			skipped.push({ path: abs, reason: "ignored" });
			skipCounts.ignored++;
			continue;
		}
		try {
			const st = await fs.stat(abs);
			if (!st.isFile()) {
				skipped.push({ path: abs, reason: "not a file" });
				skipCounts.notFile++;
				continue;
			}
			// small cap per file to avoid huge binaries
			if (st.size > 1024 * 1024) {
				skipped.push({ path: abs, reason: "too large" });
				skipCounts.tooLarge++;
				continue;
			}
			const buf = await fs.readFile(abs);
			if (!isText(null, buf)) {
				skipped.push({ path: abs, reason: "binary" });
				skipCounts.binary++;
				continue;
			}
			const sep = SEP_FORMAT.replace("{filePath}", path.relative(root, abs));
			const text = buf.toString("utf8");
			const chunk = `${sep}\n${text}\n`;
			const projected = totalBytes + Buffer.byteLength(chunk, "utf8");
			if (projected > TOTAL_BYTE_CAP) {
				skipped.push({ path: abs, reason: "total cap reached" });
				skipCounts.totalCapReached++;
				totalCapReached = true;
				break;
			}
			output += chunk;
			totalBytes = projected;
			included.push(abs);
			includedRel.push(relPosix);
			fileStats.push({
				path: abs,
				lines: text.length === 0 ? 0 : text.split(/\r?\n/).length,
				bytes: buf.byteLength,
			});
		} catch (_e) {
			skipped.push({ path: abs, reason: "read error" });
			skipCounts.readError++;
		}
	}

	output += TERMINATOR;

	// Build aggregated summary
	const summaryParts = [`Read ${included.length} file(s).`];
	if (skipped.length > 0) {
		const skipSummary: string[] = [];
		if (skipCounts.ignored > 0)
			skipSummary.push(`${skipCounts.ignored} ignored`);
		if (skipCounts.sensitive > 0)
			skipSummary.push(`${skipCounts.sensitive} sensitive`);
		if (skipCounts.binary > 0) skipSummary.push(`${skipCounts.binary} binary`);
		if (skipCounts.tooLarge > 0)
			skipSummary.push(`${skipCounts.tooLarge} too large`);
		if (skipCounts.notFile > 0)
			skipSummary.push(`${skipCounts.notFile} not a file`);
		if (skipCounts.totalCapReached > 0)
			skipSummary.push(`${skipCounts.totalCapReached} total cap reached`);
		if (skipCounts.readError > 0)
			skipSummary.push(`${skipCounts.readError} read errors`);
		summaryParts.push(`Skipped ${skipped.length}: ${skipSummary.join(", ")}`);
	}

	return {
		content: [{ type: "text" as const, text: output }],
		structuredContent: {
			files: included,
			relativeFiles: includedRel,
			fileStats,
			skipped,
			skipCounts,
			totalBytes,
			text: output,
			truncated: totalCapReached,
			totalCapReached,
			summary: summaryParts.join(" "),
		},
	};
}
