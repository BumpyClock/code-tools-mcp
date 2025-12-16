// ABOUTME: Performs fast regex searches using the ripgrep binary when available.
// ABOUTME: Falls back to the JS grep tool and enforces workspace/safety constraints.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { downloadRipGrep } from "@joshua.litt/get-ripgrep";
import { z } from "zod";
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
			}),
		)
		.optional(),
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
				structuredContent: { error: "OUTSIDE_WORKSPACE", message: msg },
			};
		}

		const st = await fs.stat(resolved).catch(() => null);
		if (st?.isFile()) {
			const relFilePosix = toPosixPath(path.relative(root, resolved));
			if (isSensitivePath(relFilePosix)) {
				const msg = `Refusing to search sensitive file: ${relFilePosix}`;
				return {
					content: [{ type: "text" as const, text: msg }],
					structuredContent: { error: "SENSITIVE_PATH", message: msg },
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
				structuredContent: { error: "PATH_NOT_FOUND", message: msg },
			};
		}
	}

	const baseDirRelPosix = toPosixPath(path.relative(root, baseDir) || ".");
	if (isSensitivePath(baseDirRelPosix)) {
		const msg = `Refusing to search in sensitive path: ${baseDirRelPosix}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: { error: "SENSITIVE_PATH", message: msg },
		};
	}

	const maxMatches = input.max_matches ?? 20000;

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
	}> = [];
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
		try {
			const evt = JSON.parse(line);
			if (evt.type !== "match") return;
			const absFile = path.resolve(baseDir, evt.data.path.text);
			const relPosix = toPosixPath(path.relative(root, absFile));
			if (isSensitivePath(relPosix)) return;

			matches.push({
				filePath: relPosix,
				absoluteFilePath: absFile,
				lineNumber: evt.data.line_number,
				line: evt.data.lines.text.trimEnd(),
			});
			if (matches.length >= maxMatches) {
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

	if (matches.length === 0) {
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
				matches: [],
				stderr: stderrBuf || undefined,
				summary: "No matches found.",
				truncated: false,
			},
		};
	}

	const byFile = new Map<string, Array<{ lineNumber: number; line: string }>>();
	for (const m of matches) {
		if (!byFile.has(m.filePath)) byFile.set(m.filePath, []);
		byFile.get(m.filePath)?.push({ lineNumber: m.lineNumber, line: m.line });
	}
	for (const arr of byFile.values())
		arr.sort((a, b) => a.lineNumber - b.lineNumber);

	// Improved scope messaging
	const searchScope = fileOnly
		? `in ${toPosixPath(path.relative(root, fileOnly))}`
		: baseDir === root
			? "across workspace"
			: `in ${toPosixPath(path.relative(root, baseDir))}`;

	let text = `Found ${matches.length} matches for pattern "${input.pattern}" ${searchScope}${input.include ? ` (filter: "${input.include}")` : ""}:\n---\n`;
	for (const [file, arr] of byFile) {
		text += `File: ${file}\n`;
		for (const r of arr) text += `L${r.lineNumber}: ${r.line}\n`;
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
			stderr: stderrBuf || undefined,
			summary,
			truncated,
			maxMatches: truncated ? maxMatches : undefined,
		},
	};
}
