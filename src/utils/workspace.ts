import fs from "node:fs";
import path from "node:path";

let WORKSPACE_ROOT: string | null = null;

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
	}
	return WORKSPACE_ROOT;
}

// Optional programmatic override
export function setWorkspaceRoot(root: string) {
	WORKSPACE_ROOT = path.resolve(root);
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
	return norm;
}

export function relativize(p: string): string {
	const root = getWorkspaceRoot();
	return path.relative(root, p) || ".";
}
