// ABOUTME: Computes workspace roots and safely resolves paths within them.
// ABOUTME: Prevents path traversal and symlink escapes for all file tools.

import fs from "node:fs";
import path from "node:path";
import { WorkspaceContext } from "./workspace-context.js";

let WORKSPACE_ROOT: string | null = null;
let WORKSPACE_ROOTS: string[] | null = null;
let WORKSPACE_ROOTS_REAL: Map<string, string> | null = null;
let WORKSPACE_CONTEXT: WorkspaceContext | null = null;

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

function splitRoots(value: string | undefined | null): string[] {
	if (!value) return [];
	return value
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parseRootsArg(argv: string[]): string[] {
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--roots") {
			const v = argv[i + 1];
			return splitRoots(v);
		}
		if (a.startsWith("--roots=")) {
			return splitRoots(a.slice("--roots=".length));
		}
	}
	return [];
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

function initPrimaryRoot(): string {
	const envRoot = process.env.CODE_TOOLS_MCP_ROOT;
	if (envRoot) return path.resolve(envRoot);
	const argRoot = parseRootArg(process.argv.slice(2));
	if (argRoot) return path.resolve(argRoot);
	const gitRoot = findGitRoot(process.cwd());
	if (gitRoot) return gitRoot;
	return path.resolve(process.cwd());
}

function initWorkspaceRoots(): string[] {
	const primary = initPrimaryRoot();
	const envRoots = splitRoots(process.env.CODE_TOOLS_MCP_ROOTS);
	const argRoots = parseRootsArg(process.argv.slice(2));
	const extras = [...envRoots, ...argRoots]
		.map((entry) => path.resolve(entry))
		.filter((entry) => entry !== primary);
	const roots = [primary, ...extras];
	const unique = Array.from(new Set(roots));
	return unique;
}

function initWorkspaceContext(): WorkspaceContext {
	const roots = getWorkspaceRoots();
	const primary = roots[0];
	const extras = roots.slice(1);
	return new WorkspaceContext(primary, extras);
}

export function getWorkspaceRoot(): string {
	return getPrimaryWorkspaceRoot();
}

export function getPrimaryWorkspaceRoot(): string {
	if (!WORKSPACE_ROOT) {
		const roots = initWorkspaceRoots();
		WORKSPACE_ROOT = roots[0];
		WORKSPACE_ROOTS = roots;
		WORKSPACE_ROOTS_REAL = null;
		WORKSPACE_CONTEXT = null;
	}
	return WORKSPACE_ROOT;
}

export function getWorkspaceRoots(): readonly string[] {
	if (!WORKSPACE_ROOTS) {
		const roots = initWorkspaceRoots();
		WORKSPACE_ROOTS = roots;
		WORKSPACE_ROOT = roots[0];
		WORKSPACE_ROOTS_REAL = null;
		WORKSPACE_CONTEXT = null;
	}
	return WORKSPACE_ROOTS;
}

export function getWorkspaceContext(): WorkspaceContext {
	if (!WORKSPACE_CONTEXT) {
		WORKSPACE_CONTEXT = initWorkspaceContext();
	}
	return WORKSPACE_CONTEXT;
}

function getRootReal(root: string): string {
	if (!WORKSPACE_ROOTS_REAL) {
		WORKSPACE_ROOTS_REAL = new Map();
	}
	const existing = WORKSPACE_ROOTS_REAL.get(root);
	if (existing) return existing;
	let real = root;
	try {
		real = fs.realpathSync(root);
	} catch {
		real = root;
	}
	WORKSPACE_ROOTS_REAL.set(root, real);
	return real;
}

export function setWorkspaceRoot(root: string) {
	WORKSPACE_ROOT = path.resolve(root);
	WORKSPACE_ROOTS = [WORKSPACE_ROOT];
	WORKSPACE_ROOTS_REAL = null;
	WORKSPACE_CONTEXT = null;
}

export function setWorkspaceRoots(roots: readonly string[]) {
	if (roots.length === 0) return;
	WORKSPACE_ROOTS = roots.map((entry) => path.resolve(entry));
	WORKSPACE_ROOT = WORKSPACE_ROOTS[0];
	WORKSPACE_ROOTS_REAL = null;
	WORKSPACE_CONTEXT = null;
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

function isWithinRoot(absPath: string, root: string): boolean {
	const norm = path.normalize(absPath);
	const rootNorm = path.normalize(root);
	const rootWithSep = path.normalize(rootNorm + path.sep);
	const isWin = process.platform === "win32";
	const normCmp = isWin ? norm.toLowerCase() : norm;
	const rootCmp = isWin ? rootNorm.toLowerCase() : rootNorm;
	const rootWithSepCmp = isWin ? rootWithSep.toLowerCase() : rootWithSep;

	if (!normCmp.startsWith(rootWithSepCmp) && normCmp !== rootCmp) {
		return false;
	}

	const rootReal = getRootReal(root);
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

	return (
		existingRealCmp.startsWith(rootRealWithSepCmp) ||
		existingRealCmp === rootRealCmp
	);
}

export function resolveWithinWorkspace(p: string): {
	absPath: string;
	root: string;
} {
	const roots = getWorkspaceRoots();
	const primary = getPrimaryWorkspaceRoot();
	const abs = path.isAbsolute(p) ? p : path.resolve(primary, p);
	const norm = path.normalize(abs);

	for (const root of roots) {
		if (isWithinRoot(norm, root)) {
			return { absPath: norm, root };
		}
	}
	throw new Error(`Path is outside workspace roots: ${p}`);
}

export function relativize(p: string, root?: string): string {
	const base = root ?? getPrimaryWorkspaceRoot();
	return path.relative(base, p) || ".";
}

export function toPosixPath(p: string): string {
	return p.split(path.sep).join("/");
}

export function relativizePosix(p: string, root?: string): string {
	return toPosixPath(relativize(p, root));
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
