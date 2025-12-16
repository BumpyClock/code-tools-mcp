// ABOUTME: Performs fast regex searches using the ripgrep binary when available.
// ABOUTME: Falls back to the JS grep tool and enforces workspace/safety constraints.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { downloadRipGrep } from "@joshua.litt/get-ripgrep";
import { z } from "zod";
import { ErrorCode } from "../types/error-codes.js";
import { ensureDir, fileExists, getGlobalBinDir } from "../utils/storage.js";
import {
	getWorkspaceRoot,
	isSensitivePath,
	resolveWithinWorkspace,
	toPosixPath,
} from "../utils/workspace.js";
import { type grepInput, grepTool } from "./grep.js";

export const ripgrepShape = {
	pattern: z.string().describe("Regular expression to search for."),
	path: z
		.string()
		.optional()
		.describe("Directory to search (relative or absolute)."),
	include: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe("Glob include pattern(s), e.g. **/*.{ts,tsx}"),
	exclude: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe("Glob exclude pattern(s), e.g. **/dist/**"),
	ignore_case: z
		.boolean()
		.optional()
		.describe("Case-insensitive search (default true)."),
	context_lines_before: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Number of context lines before each match (-B)."),
	context_lines_after: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Number of context lines after each match (-A)."),
	context_lines: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Number of context lines before/after each match (-C)."),
	output_mode: z
		.enum(["full", "files_only", "count"])
		.optional()
		.describe("Output mode: full match objects, files only, or count."),
	max_matches: z
		.number()
		.optional()
		.describe("Maximum number of matches to return (default 20000)."),
};
export const ripgrepInput = z.object(ripgrepShape);
export type RipgrepInput = z.infer<typeof ripgrepInput>;

// Output schema for structured content returned by this tool
export const ripgrepOutputShape = {
	matches: z
		.array(
			z.object({
				filePath: z.string(),
				absoluteFilePath: z.string().optional(),
				lineNumber: z.number(),
				line: z.string(),
				contextBefore: z
					.array(z.object({ lineNumber: z.number(), line: z.string() }))
					.optional(),
				contextAfter: z
					.array(z.object({ lineNumber: z.number(), line: z.string() }))
					.optional(),
			}),
		)
		.optional(),
	files: z.array(z.string()).optional(),
	count: z.number().optional(),
	stderr: z.string().optional(),
	summary: z.string().optional(),
	truncated: z.boolean().optional(),
	maxMatches: z.number().optional(),
	aborted: z.boolean().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
};

let RG_ON_PATH: boolean | null = null;

function haveRgOnPath(): Promise<boolean> {
	if (RG_ON_PATH !== null) return Promise.resolve(RG_ON_PATH);
	return new Promise((resolve) => {
		const proc = spawn("rg", ["--version"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		proc.on("error", () => {
			RG_ON_PATH = false;
			resolve(false);
		});
		proc.on("exit", (code) => {
			RG_ON_PATH = code === 0;
			resolve(code === 0);
		});
	});
}

function localRgPath(): string {
	const bin = getGlobalBinDir();
	const exe = process.platform === "win32" ? "rg.exe" : "rg";
	return path.join(bin, exe);
}

async function ensureLocalRg(): Promise<string | null> {
	const rgPath = localRgPath();
	if (await fileExists(rgPath)) return rgPath;
	const bin = getGlobalBinDir();
	await ensureDir(bin);
	try {
		await downloadRipGrep(bin);
	} catch {
		return null;
	}
	return (await fileExists(rgPath)) ? rgPath : null;
}

function resolveContextCounts(input: RipgrepInput): {
	before: number;
	after: number;
} {
	const c = input.context_lines ?? 0;
	const before = input.context_lines_before ?? c;
	const after = input.context_lines_after ?? c;
	return { before, after };
}

export async function ripgrepTool(input: RipgrepInput, signal?: AbortSignal) {
	const root = getWorkspaceRoot();
	let baseDir = root;
	let fileOnly: string | null = null;
	if (input.path) {
		let resolved: string;
		try {
			resolved = resolveWithinWorkspace(
				path.isAbsolute(input.path) ? input.path : path.join(root, input.path),
			);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: { error: ErrorCode.OUTSIDE_WORKSPACE, message: msg },
			};
		}

		const st = await fs.stat(resolved).catch(() => null);
		if (st?.isFile()) {
			const relFilePosix = toPosixPath(path.relative(root, resolved));
			if (isSensitivePath(relFilePosix)) {
				const msg = `Refusing to search sensitive file: ${relFilePosix}`;
				return {
					content: [{ type: "text" as const, text: msg }],
					structuredContent: { error: ErrorCode.SENSITIVE_PATH, message: msg },
				};
			}
			fileOnly = resolved;
			baseDir = path.dirname(resolved);
		} else if (st?.isDirectory()) {
			baseDir = resolved;
		} else {
			const msg = `Path not found: ${resolved}`;
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: { error: ErrorCode.NOT_FOUND, message: msg },
			};
		}
	}

	const baseDirRelPosix = toPosixPath(path.relative(root, baseDir) || ".");
	if (isSensitivePath(baseDirRelPosix)) {
		const msg = `Refusing to search in sensitive path: ${baseDirRelPosix}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: { error: ErrorCode.SENSITIVE_PATH, message: msg },
		};
	}

	const maxMatches = input.max_matches ?? 20000;
	const outputMode = input.output_mode ?? "full";
	const { before: ctxBefore, after: ctxAfter } = resolveContextCounts(input);
	const includeContext =
		outputMode === "full" && (ctxBefore > 0 || ctxAfter > 0);

	let rgCmd: string | null = null;
	if (await haveRgOnPath()) {
		rgCmd = "rg";
	} else {
		rgCmd = await ensureLocalRg();
	}
	if (!rgCmd) {
		// Fallback to JS grep implementation
		const includeStr = Array.isArray(input.include)
			? `{${input.include.join(",")}}`
			: input.include;
		const excludeStr = Array.isArray(input.exclude)
			? `{${input.exclude.join(",")}}`
			: input.exclude;
		return grepTool(
			{
				pattern: input.pattern,
				path: fileOnly
					? path.relative(root, fileOnly)
					: path.relative(root, baseDir) || ".",
				include: includeStr,
				exclude: excludeStr,
				regex: true,
				ignore_case: input.ignore_case,
				context_lines_before: input.context_lines_before,
				context_lines_after: input.context_lines_after,
				context_lines: input.context_lines,
				output_mode: outputMode,
				max_matches: maxMatches,
			} as z.infer<typeof grepInput>,
			signal,
		);
	}

	const args = ["--json", "--line-number"];

	// Smart-case: if ignore_case is undefined, use --smart-case
	if (input.ignore_case === undefined) {
		args.push("--smart-case");
	} else if (input.ignore_case !== false) {
		args.push("--ignore-case");
	}

	// include globs
	const includes = input.include
		? Array.isArray(input.include)
			? input.include
			: [input.include]
		: [];
	for (const inc of includes) args.push("-g", inc);
	// exclude globs
	const excludes = input.exclude
		? Array.isArray(input.exclude)
			? input.exclude
			: [input.exclude]
		: [];
	for (const exc of excludes) args.push("-g", `!${exc}`);
	// Always exclude sensitive dirs/files from search.
	args.push("-g", "!.git/**");
	args.push("-g", "!.hg/**");
	args.push("-g", "!.svn/**");
	args.push("-g", "!.env");
	// ripgrep respects .gitignore by default; include hidden files but still honor ignore rules
	args.push("--hidden");
	args.push(input.pattern);
	args.push(fileOnly ? path.basename(fileOnly) : ".");

	const proc = spawn(rgCmd, args, {
		cwd: baseDir,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const matches: Array<{
		filePath: string;
		absoluteFilePath?: string;
		lineNumber: number;
		line: string;
		contextBefore?: Array<{ lineNumber: number; line: string }>;
		contextAfter?: Array<{ lineNumber: number; line: string }>;
	}> = [];
	const matchedFiles = new Set<string>();
	let matchCount = 0;
	let stderrBuf = "";
	let aborted = false;
	let truncated = false;

	signal?.addEventListener("abort", () => {
		aborted = true;
		proc.kill();
	});

	let pending = "";
	const handleJsonLine = (line: string) => {
		if (!line.trim()) return;
		// Enforce a hard total match cap; ripgrep's streaming output can emit more
		// JSON events after the process is killed.
		if (truncated || matchCount >= maxMatches) return;
		try {
			const evt = JSON.parse(line);
			if (evt.type !== "match") return;
			const absFile = path.resolve(baseDir, evt.data.path.text);
			const relPosix = toPosixPath(path.relative(root, absFile));
			if (isSensitivePath(relPosix)) return;

			matchCount += 1;
			matchedFiles.add(relPosix);
			if (outputMode === "full") {
				matches.push({
					filePath: relPosix,
					absoluteFilePath: absFile,
					lineNumber: evt.data.line_number,
					line: evt.data.lines.text.trimEnd(),
				});
			}
			if (matchCount >= maxMatches) {
				truncated = true;
				proc.kill();
			}
		} catch {}
	};

	await new Promise<void>((resolve) => {
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			pending += chunk;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				handleJsonLine(line);
			}
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
		});
		proc.on("exit", () => {
			if (pending.trim()) handleJsonLine(pending);
			resolve();
		});
		proc.on("error", () => resolve());
	});

	if (aborted) {
		return {
			content: [{ type: "text" as const, text: "Search aborted." }],
			structuredContent: { aborted: true },
		};
	}

	if (matchCount === 0) {
		const where = path.relative(root, baseDir) || ".";
		const filterDesc = includes.length
			? ` (filter: ${includes.join(", ")})`
			: "";
		const excludeDesc = excludes.length
			? ` (exclude: ${excludes.join(", ")})`
			: "";
		const msg = `No matches for "${input.pattern}" in ${where}${filterDesc}${excludeDesc}.`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				matches: outputMode === "full" ? [] : undefined,
				files: outputMode === "files_only" ? [] : undefined,
				count: outputMode !== "full" ? 0 : undefined,
				stderr: stderrBuf || undefined,
				summary: "No matches found.",
				truncated: false,
			},
		};
	}

	// Improved scope messaging
	const searchScope = fileOnly
		? `in ${toPosixPath(path.relative(root, fileOnly))}`
		: baseDir === root
			? "across workspace"
			: `in ${toPosixPath(path.relative(root, baseDir))}`;

	if (outputMode === "count") {
		const summary = truncated
			? `Found ${matchCount} matches (limited to ${maxMatches}).`
			: `Found ${matchCount} match${matchCount === 1 ? "" : "es"}.`;
		return {
			content: [{ type: "text" as const, text: summary }],
			structuredContent: {
				count: matchCount,
				stderr: stderrBuf || undefined,
				summary,
				truncated,
				maxMatches: truncated ? maxMatches : undefined,
			},
		};
	}

	if (outputMode === "files_only") {
		const files = Array.from(matchedFiles).sort((a, b) => a.localeCompare(b));
		const summary = truncated
			? `Found ${files.length} file(s) with matches (limited to ${maxMatches} matches).`
			: `Found ${files.length} file(s) with matches.`;
		return {
			content: [{ type: "text" as const, text: files.join("\n") }],
			structuredContent: {
				files,
				count: matchCount,
				stderr: stderrBuf || undefined,
				summary,
				truncated,
				maxMatches: truncated ? maxMatches : undefined,
			},
		};
	}

	if (includeContext) {
		const CONTEXT_FILE_BYTE_CAP = 2 * 1024 * 1024;
		const matchesByAbs = new Map<string, Array<(typeof matches)[number]>>();
		for (const m of matches) {
			const abs = m.absoluteFilePath;
			if (!abs) continue;
			if (!matchesByAbs.has(abs)) matchesByAbs.set(abs, []);
			matchesByAbs.get(abs)?.push(m);
		}

		for (const [abs, fileMatches] of matchesByAbs) {
			try {
				const st = await fs.stat(abs);
				if (!st.isFile()) continue;
				if (st.size > CONTEXT_FILE_BYTE_CAP) continue;
				const text = await fs.readFile(abs, "utf8");
				const lines = text.split(/\r?\n/);
				for (const m of fileMatches) {
					const lineIndex = m.lineNumber - 1;
					if (lineIndex < 0 || lineIndex >= lines.length) continue;
					if (ctxBefore > 0) {
						const start = Math.max(0, lineIndex - ctxBefore);
						if (start < lineIndex) {
							m.contextBefore = lines
								.slice(start, lineIndex)
								.map((line, offset) => ({
									lineNumber: start + offset + 1,
									line,
								}));
						}
					}
					if (ctxAfter > 0) {
						const endExclusive = Math.min(
							lines.length,
							lineIndex + 1 + ctxAfter,
						);
						if (lineIndex + 1 < endExclusive) {
							m.contextAfter = lines
								.slice(lineIndex + 1, endExclusive)
								.map((line, offset) => ({
									lineNumber: lineIndex + 2 + offset,
									line,
								}));
						}
					}
				}
			} catch {}
		}
	}

	const byFile = new Map<string, Array<(typeof matches)[number]>>();
	for (const m of matches) {
		if (!byFile.has(m.filePath)) byFile.set(m.filePath, []);
		byFile.get(m.filePath)?.push(m);
	}
	for (const arr of byFile.values())
		arr.sort((a, b) => a.lineNumber - b.lineNumber);

	let text = `Found ${matches.length} matches for pattern "${input.pattern}" ${searchScope}${input.include ? ` (filter: "${input.include}")` : ""}:\n---\n`;
	for (const [file, arr] of byFile) {
		text += `File: ${file}\n`;
		for (const r of arr) {
			if (r.contextBefore?.length) {
				for (const c of r.contextBefore)
					text += `L${c.lineNumber}: ${c.line}\n`;
			}
			text += `L${r.lineNumber}: ${r.line}\n`;
			if (r.contextAfter?.length) {
				for (const c of r.contextAfter) text += `L${c.lineNumber}: ${c.line}\n`;
			}
		}
		text += "---\n";
	}
	if (truncated) text += `(limited to ${maxMatches} matches)\n`;

	const summary = truncated
		? `Found ${matches.length} matches (limited to ${maxMatches}).`
		: `Found ${matches.length} match${matches.length === 1 ? "" : "es"}.`;

	return {
		content: [{ type: "text" as const, text: text.trimEnd() }],
		structuredContent: {
			matches,
			count: matchCount,
			stderr: stderrBuf || undefined,
			summary,
			truncated,
			maxMatches: truncated ? maxMatches : undefined,
		},
	};
}
