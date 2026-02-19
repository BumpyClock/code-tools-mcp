// ABOUTME: Performs fast regex searches using the ripgrep binary when available.
// ABOUTME: Falls back to a JS search and enforces workspace/safety constraints.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { downloadRipGrep } from "@joshua.litt/get-ripgrep";
import fg from "fast-glob";
import { z } from "zod";
import { ToolErrorType } from "../types/tool-error-type.js";
import { toolResultShape } from "../types/tool-result.js";
import { buildIgnoreFilter } from "../utils/ignore.js";
import { ensureDir, fileExists, getGlobalBinDir } from "../utils/storage.js";
import {
	isSensitivePath,
	resolveWithinWorkspace,
	toPosixPath,
} from "../utils/workspace.js";

const DEFAULT_MAX_MATCHES = 20000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_EXCLUDES = [
	"**/{node_modules,.git,dist,build,out}/**",
	"*.log",
	"*.tmp",
];
const MAX_REGEX_LENGTH = 1000;

export const searchFileContentShape = {
	pattern: z.string().describe("The pattern to search for."),
	dir_path: z
		.string()
		.optional()
		.describe("Directory or file to search (defaults to '.')."),
	include: z
		.string()
		.optional()
		.describe("Glob pattern to filter files (e.g., '*.ts')."),
	case_sensitive: z
		.boolean()
		.optional()
		.describe("If true, search is case-sensitive. Defaults to false."),
	fixed_strings: z
		.boolean()
		.optional()
		.describe("If true, treat pattern as a literal string."),
	context: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Show this many lines of context around each match."),
	after: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Show this many lines after each match."),
	before: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Show this many lines before each match."),
	no_ignore: z
		.boolean()
		.optional()
		.describe("If true, do not respect ignore files or defaults."),
};
export const searchFileContentInput = z.object(searchFileContentShape);
export type SearchFileContentInput = z.infer<typeof searchFileContentInput>;

export const searchFileContentOutputShape = toolResultShape;

interface GrepMatch {
	filePath: string;
	lineNumber: number;
	line: string;
}

let RG_ON_PATH: boolean | null = null;

function isProbablySafeRegex(pattern: string): boolean {
	if (pattern.length > MAX_REGEX_LENGTH) return false;
	const nestedQuantifiers = /(\([^)]*[+*?][^)]*\))[+*?]/;
	const repeatedWildcards = /(\.\*){2,}/;
	return !nestedQuantifiers.test(pattern) && !repeatedWildcards.test(pattern);
}

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

async function parseRipgrepJson(
	proc: ReturnType<typeof spawn>,
	maxMatches: number,
	signal?: AbortSignal,
): Promise<{ matches: GrepMatch[]; stderr: string; truncated: boolean }> {
	const matches: GrepMatch[] = [];
	let stderrBuf = "";
	let truncated = false;
	let aborted = false;

	const onAbort = () => {
		aborted = true;
		proc.kill();
	};
	if (signal) {
		if (signal.aborted) onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
	}

	let pending = "";
	const handleLine = (line: string) => {
		if (!line.trim()) return;
		if (truncated || matches.length >= maxMatches) return;
		try {
			const json = JSON.parse(line);
			if (json.type !== "match") return;
			const match = json.data;
			if (match.path?.text && match.lines?.text) {
				matches.push({
					filePath: match.path.text,
					lineNumber: match.line_number,
					line: match.lines.text.trimEnd(),
				});
				if (matches.length >= maxMatches) {
					truncated = true;
					proc.kill();
				}
			}
		} catch {}
	};

	await new Promise<void>((resolve) => {
		if (!proc.stdout || !proc.stderr) {
			resolve();
			return;
		}
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			pending += chunk;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
		});
		proc.on("exit", () => {
			if (pending.trim()) handleLine(pending);
			resolve();
		});
		proc.on("error", () => resolve());
	});

	if (signal) signal.removeEventListener("abort", onAbort);
	if (aborted) return { matches: [], stderr: stderrBuf, truncated };

	return { matches, stderr: stderrBuf, truncated };
}

async function fallbackSearch(
	input: SearchFileContentInput,
	searchPath: string,
	maxMatches: number,
	signal?: AbortSignal,
	targetFile?: string,
): Promise<GrepMatch[]> {
	const results: GrepMatch[] = [];
	const caseSensitive = input.case_sensitive === true;
	const fixedStrings = input.fixed_strings === true;
	const includePattern = input.include ?? "**/*";
	const ignore = input.no_ignore ? [] : DEFAULT_EXCLUDES;
	const ig = input.no_ignore
		? null
		: await buildIgnoreFilter({ respectGitIgnore: true }, searchPath);

	const entries = targetFile
		? [targetFile]
		: await fg(includePattern, {
				cwd: searchPath,
				absolute: true,
				onlyFiles: true,
				dot: true,
				followSymbolicLinks: false,
				ignore,
			});

	const pattern = input.pattern;
	let regex: RegExp | null = null;
	let useFixedStrings = fixedStrings;
	if (!fixedStrings) {
		if (isProbablySafeRegex(pattern)) {
			try {
				regex = new RegExp(pattern, caseSensitive ? "" : "i");
			} catch {
				useFixedStrings = true;
			}
		} else {
			useFixedStrings = true;
		}
	}

	for (const absFile of entries) {
		if (signal?.aborted) break;
		const rel = toPosixPath(path.relative(searchPath, absFile));
		if (isSensitivePath(rel)) continue;
		if (ig?.ignores(rel)) continue;
		const text = await fs.readFile(absFile, "utf8").catch(() => null);
		if (text === null) continue;
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			if (signal?.aborted) break;
			const line = lines[i] ?? "";
			const matched = useFixedStrings
				? line.includes(pattern)
				: (regex?.test(line) ?? false);
			if (!matched) continue;
			results.push({ filePath: rel, lineNumber: i + 1, line: line.trimEnd() });
			if (results.length >= maxMatches) return results;
		}
	}

	return results;
}

export async function searchFileContentTool(
	input: SearchFileContentInput,
	signal?: AbortSignal,
) {
	const pathParam = input.dir_path ?? ".";
	let resolved: { absPath: string; root: string };
	try {
		resolved = resolveWithinWorkspace(pathParam);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.PATH_NOT_IN_WORKSPACE },
		};
	}

	const searchAbs = resolved.absPath;
	let stats: Awaited<ReturnType<typeof fs.stat>> | undefined;
	try {
		stats = await fs.stat(searchAbs);
	} catch (_error: unknown) {
		const msg = `Path does not exist: ${searchAbs}`;
		return {
			llmContent: msg,
			error: { message: msg, type: ToolErrorType.FILE_NOT_FOUND },
		};
	}
	if (!stats.isDirectory() && !stats.isFile()) {
		return {
			llmContent: `Path is not a valid directory or file: ${searchAbs}`,
		};
	}

	const searchDir = stats.isFile() ? path.dirname(searchAbs) : searchAbs;
	const searchLocationDescription = `in path "${pathParam}"`;
	const maxMatches = DEFAULT_MAX_MATCHES;
	const timeoutController = new AbortController();
	const timeoutId = setTimeout(
		() => timeoutController.abort(),
		DEFAULT_TIMEOUT_MS,
	);
	const combinedController = new AbortController();
	const onAbort = () => combinedController.abort();
	if (signal) {
		if (signal.aborted) onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
	}
	timeoutController.signal.addEventListener("abort", onAbort, { once: true });

	let matches: GrepMatch[] = [];
	let wasTruncated = false;
	let usedRipgrep = false;

	let rgCmd: string | null = null;
	if (await haveRgOnPath()) {
		rgCmd = "rg";
	} else {
		rgCmd = await ensureLocalRg();
	}

	if (rgCmd) {
		usedRipgrep = true;
		const args: string[] = ["--json"];
		if (!input.case_sensitive) args.push("--ignore-case");
		if (input.fixed_strings) {
			args.push("--fixed-strings", input.pattern);
		} else {
			args.push("--regexp", input.pattern);
		}
		if (input.context !== undefined) {
			args.push("--context", input.context.toString());
		}
		if (input.after !== undefined) {
			args.push("--after-context", input.after.toString());
		}
		if (input.before !== undefined) {
			args.push("--before-context", input.before.toString());
		}
		if (input.no_ignore) {
			args.push("--no-ignore");
		}
		if (input.include) {
			args.push("--glob", input.include);
		}
		if (!input.no_ignore) {
			for (const exclude of DEFAULT_EXCLUDES) {
				args.push("--glob", `!${exclude}`);
			}
		}
		args.push(searchAbs);

		const proc = spawn(rgCmd, args, {
			cwd: searchDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const parsed = await parseRipgrepJson(
			proc,
			maxMatches,
			combinedController.signal,
		);
		matches = parsed.matches.map((match) => {
			const absoluteFilePath = path.resolve(searchDir, match.filePath);
			const relativeFilePath =
				path.relative(searchDir, absoluteFilePath) ||
				path.basename(absoluteFilePath);
			return { ...match, filePath: relativeFilePath };
		});
		wasTruncated = parsed.truncated || matches.length >= maxMatches;
	} else {
		matches = await fallbackSearch(
			input,
			searchDir,
			maxMatches,
			combinedController.signal,
			stats.isFile() ? searchAbs : undefined,
		);
		wasTruncated = matches.length >= maxMatches;
	}

	clearTimeout(timeoutId);
	if (signal) signal.removeEventListener("abort", onAbort);
	timeoutController.signal.removeEventListener("abort", onAbort);

	if (!usedRipgrep && !input.no_ignore) {
		const ig = await buildIgnoreFilter(
			{ respectGitIgnore: true },
			resolved.root,
		);
		matches = matches.filter((match) => {
			const absFile = path.resolve(searchDir, match.filePath);
			const relToRoot = toPosixPath(path.relative(resolved.root, absFile));
			if (isSensitivePath(relToRoot)) return false;
			if (ig.ignores(relToRoot)) return false;
			return true;
		});
	}

	if (matches.length === 0) {
		const filterNote = input.include ? ` (filter: "${input.include}")` : "";
		const noMatchMsg = `No matches found for pattern "${input.pattern}" ${searchLocationDescription}${filterNote}.`;
		return { llmContent: noMatchMsg };
	}

	const matchesByFile = matches.reduce<Record<string, GrepMatch[]>>(
		(acc, match) => {
			if (!acc[match.filePath]) acc[match.filePath] = [];
			acc[match.filePath].push(match);
			acc[match.filePath].sort((a, b) => a.lineNumber - b.lineNumber);
			return acc;
		},
		{},
	);

	const matchCount = matches.length;
	const matchTerm = matchCount === 1 ? "match" : "matches";
	let llmContent = `Found ${matchCount} ${matchTerm} for pattern "${input.pattern}" ${searchLocationDescription}${input.include ? ` (filter: "${input.include}")` : ""}${wasTruncated ? ` (results limited to ${maxMatches} matches for performance)` : ""}:\n---\n`;

	for (const filePath in matchesByFile) {
		llmContent += `File: ${filePath}\n`;
		for (const match of matchesByFile[filePath] ?? []) {
			llmContent += `L${match.lineNumber}: ${match.line.trim()}\n`;
		}
		llmContent += "---\n";
	}

	return {
		llmContent: llmContent.trim(),
	};
}
