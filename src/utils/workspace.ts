// ABOUTME: Computes the workspace root and safely resolves paths within it.
// ABOUTME: Prevents path traversal and symlink escapes for all file tools.

import fs from "node:fs";
import path from "node:path";

let WORKSPACE_ROOT: string | null = null;
let WORKSPACE_ROOT_REAL: string | null = null;

function parseRootArg(argv: string[]): string | null {
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--root" || a === "-r") {
			const v = argv[i + 1];
			if (v) return v;
		}
		if (a.startsWith("--root=")) {
			return a.slice("--root=".length);
		}
	}
	return null;
}

function findGitRoot(start: string): string | null {
	let dir = path.resolve(start);
	while (true) {
		const dotgit = path.join(dir, ".git");
		if (fs.existsSync(dotgit)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function initWorkspaceRoot(): string {
	// 1) explicit env override
	const envRoot = process.env.CODE_TOOLS_MCP_ROOT;
	if (envRoot) return path.resolve(envRoot);
	// 2) CLI flag --root or -r
	const argRoot = parseRootArg(process.argv.slice(2));
	if (argRoot) return path.resolve(argRoot);
	// 3) Git repo root from cwd if available
	const gitRoot = findGitRoot(process.cwd());
	if (gitRoot) return gitRoot;
	// 4) fallback to cwd
	return path.resolve(process.cwd());
}

// Determines and caches the workspace root for all file operations
export function getWorkspaceRoot(): string {
	if (!WORKSPACE_ROOT) {
		WORKSPACE_ROOT = initWorkspaceRoot();
		WORKSPACE_ROOT_REAL = null;
	}
	return WORKSPACE_ROOT;
}

function getWorkspaceRootReal(): string {
	const root = getWorkspaceRoot();
	if (!WORKSPACE_ROOT_REAL) {
		try {
			WORKSPACE_ROOT_REAL = fs.realpathSync(root);
		} catch {
			WORKSPACE_ROOT_REAL = root;
		}
	}
	return WORKSPACE_ROOT_REAL;
}

// Optional programmatic override
export function setWorkspaceRoot(root: string) {
	WORKSPACE_ROOT = path.resolve(root);
	WORKSPACE_ROOT_REAL = null;
}

function findNearestExistingAncestor(p: string): string {
	let cur = p;
	while (true) {
		if (fs.existsSync(cur)) return cur;
		const parent = path.dirname(cur);
		if (parent === cur) return cur;
		cur = parent;
	}
}

export function resolveWithinWorkspace(p: string): string {
	const root = getWorkspaceRoot();
	const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
	const norm = path.normalize(abs);
	const rootWithSep = path.normalize(root + path.sep);

	// On Windows, filesystems are typically case-insensitive. Normalize case
	// to prevent false rejections for paths that differ only by letter casing.
	const isWin = process.platform === "win32";
	const normCmp = isWin ? norm.toLowerCase() : norm;
	const rootWithSepCmp = isWin ? rootWithSep.toLowerCase() : rootWithSep;
	const rootCmp = isWin
		? path.normalize(root).toLowerCase()
		: path.normalize(root);

	if (!normCmp.startsWith(rootWithSepCmp) && normCmp !== rootCmp) {
		throw new Error(`Path is outside workspace root: ${p}`);
	}

	// Symlink safety: ensure the real path of the nearest existing ancestor
	// remains within the workspace root's real path.
	const rootReal = getWorkspaceRootReal();
	const rootRealNorm = path.normalize(rootReal);
	const rootRealWithSep = path.normalize(rootRealNorm + path.sep);
	const rootRealCmp = isWin ? rootRealNorm.toLowerCase() : rootRealNorm;
	const rootRealWithSepCmp = isWin
		? rootRealWithSep.toLowerCase()
		: rootRealWithSep;

	const existing = findNearestExistingAncestor(norm);
	let existingReal = existing;
	try {
		existingReal = fs.realpathSync(existing);
	} catch {}
	const existingRealNorm = path.normalize(existingReal);
	const existingRealCmp = isWin
		? existingRealNorm.toLowerCase()
		: existingRealNorm;

	if (
		!existingRealCmp.startsWith(rootRealWithSepCmp) &&
		existingRealCmp !== rootRealCmp
	) {
		throw new Error(`Path resolves outside workspace root: ${p}`);
	}
	return norm;
}

export function relativize(p: string): string {
	const root = getWorkspaceRoot();
	return path.relative(root, p) || ".";
}

export function toPosixPath(p: string): string {
	return p.split(path.sep).join("/");
}

export function relativizePosix(p: string): string {
	return toPosixPath(relativize(p));
}

export function isSensitivePath(relPosix: string): boolean {
	if (relPosix === ".") return false;

	if (
		relPosix === ".git" ||
		relPosix.startsWith(".git/") ||
		relPosix === ".hg" ||
		relPosix.startsWith(".hg/") ||
		relPosix === ".svn" ||
		relPosix.startsWith(".svn/")
	) {
		return true;
	}

	return path.posix.basename(relPosix) === ".env";
}
