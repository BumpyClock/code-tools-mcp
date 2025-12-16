// ABOUTME: Builds a gitignore-compatible filter for workspace-relative paths.
// ABOUTME: Loads nested .gitignore files and .git/info/exclude with caching.

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ignore, { type Ignore } from "ignore";
import { getWorkspaceRoot } from "./workspace.js";

export interface FilteringOptions {
	respectGitIgnore?: boolean;
}

const DEFAULT_IGNORE_EXCLUDES = ["**/{node_modules,.git,dist,build,out}/**"];

let IGNORE_CACHE: { root: string; key: string; filter: Ignore } | null = null;

let GLOBAL_IGNORE_FILES: string[] | null = null;

function getGlobalIgnoreFiles(): string[] {
	if (GLOBAL_IGNORE_FILES) return GLOBAL_IGNORE_FILES;

	const files = new Set<string>();

	// Respect user's git config if available.
	try {
		const res = spawnSync(
			"git",
			["config", "--path", "--get", "core.excludesFile"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		const p = (res.stdout || "").trim();
		if (res.status === 0 && p) files.add(p);
	} catch {}

	const home = process.env.HOME || process.env.USERPROFILE;
	const xdgConfigHome =
		process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : null);
	if (xdgConfigHome) files.add(path.join(xdgConfigHome, "git", "ignore"));
	if (home) files.add(path.join(home, ".gitignore_global"));
	if (home) files.add(path.join(home, ".gitignore"));

	GLOBAL_IGNORE_FILES = Array.from(files).filter(Boolean);
	return GLOBAL_IGNORE_FILES;
}

async function listIgnoreFiles(root: string): Promise<string[]> {
	const gitignoreFiles = await fg("**/.gitignore", {
		cwd: root,
		absolute: true,
		onlyFiles: true,
		dot: true,
		followSymbolicLinks: false,
		ignore: DEFAULT_IGNORE_EXCLUDES,
	});

	const infoExclude = path.join(root, ".git", "info", "exclude");
	try {
		const st = await fs.stat(infoExclude);
		if (st.isFile()) gitignoreFiles.push(infoExclude);
	} catch {}

	for (const file of getGlobalIgnoreFiles()) {
		try {
			const st = await fs.stat(file);
			if (st.isFile()) gitignoreFiles.push(file);
		} catch {}
	}

	const unique = Array.from(new Set(gitignoreFiles));

	// Deterministic ordering
	unique.sort((a, b) => a.localeCompare(b));
	return unique;
}

async function computeIgnoreKey(files: string[]): Promise<string> {
	const parts = await Promise.all(
		files.map(async (file) => {
			try {
				const st = await fs.stat(file);
				return `${file}:${st.mtimeMs}`;
			} catch {
				return `${file}:missing`;
			}
		}),
	);
	parts.sort((a, b) => a.localeCompare(b));
	return parts.join("|");
}

function prefixGitIgnorePattern(
	relDirPosix: string,
	line: string,
): string | null {
	// Skip blank lines and true comments to avoid corrupting them with prefixes.
	if (!line.trim()) return null;
	const trimmedLeft = line.trimStart();
	if (trimmedLeft.startsWith("#")) return null;

	const isNegated = line.startsWith("!");
	const raw = isNegated ? line.slice(1) : line;

	// Root-level patterns can be added verbatim.
	if (!relDirPosix) return line;

	const isAnchored = raw.startsWith("/");
	const body = isAnchored ? raw.slice(1) : raw;

	// Name-only patterns (no path separators) match at any depth within relDir.
	const bodyNoTrailingSlash = body.endsWith("/") ? body.slice(0, -1) : body;
	const hasPathSeparator = bodyNoTrailingSlash.includes("/");

	const prefixed = isAnchored
		? `${relDirPosix}/${body}`
		: hasPathSeparator
			? `${relDirPosix}/${body}`
			: `${relDirPosix}/**/${body}`;

	return isNegated ? `!${prefixed}` : prefixed;
}

async function addGitIgnoreFile(ig: Ignore, root: string, absPath: string) {
	let relDirPosix = "";

	const normalizedAbs = path.normalize(absPath);
	const infoExclude = path.normalize(
		path.join(root, ".git", "info", "exclude"),
	);
	const rootWithSep = path.normalize(root + path.sep);

	const isWorkspaceFile =
		normalizedAbs === path.normalize(path.join(root, ".gitignore")) ||
		(normalizedAbs.startsWith(rootWithSep) &&
			!normalizedAbs.startsWith(infoExclude));

	if (isWorkspaceFile && normalizedAbs !== infoExclude) {
		const relPosix = path.relative(root, absPath).split(path.sep).join("/");
		const dir = path.posix.dirname(relPosix);
		relDirPosix = dir === "." ? "" : dir;
	}

	const contents = await fs.readFile(absPath, "utf8");
	const lines = contents.split(/\r?\n/);
	const transformed = lines
		.map((line) => prefixGitIgnorePattern(relDirPosix, line))
		.filter((line): line is string => Boolean(line));
	if (transformed.length > 0) ig.add(transformed);
}

export async function buildIgnoreFilter(
	options?: FilteringOptions,
): Promise<Ignore> {
	const ig = ignore();
	const root = getWorkspaceRoot();

	if (options?.respectGitIgnore !== false) {
		const files = await listIgnoreFiles(root);
		const key = await computeIgnoreKey(files);
		if (
			IGNORE_CACHE &&
			IGNORE_CACHE.root === root &&
			IGNORE_CACHE.key === key
		) {
			return IGNORE_CACHE.filter;
		}

		for (const file of files) {
			try {
				await addGitIgnoreFile(ig, root, file);
			} catch {}
		}

		IGNORE_CACHE = { root, key, filter: ig };
	}

	return ig;
}

export function matchCustomIgnore(name: string, patterns?: string[]): boolean {
	if (!patterns || patterns.length === 0) return false;
	// simple glob to regex
	for (const p of patterns) {
		const rx = new RegExp(
			"^" +
				p
					.replace(/[.+^${}()|[\]\\]/g, "\\$&")
					.replace(/\*/g, ".*")
					.replace(/\?/g, ".") +
				"$",
		);
		if (rx.test(name)) return true;
	}
	return false;
}
