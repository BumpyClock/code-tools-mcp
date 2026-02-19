// ABOUTME: Parses client-provided MCP roots and applies them to workspace policy.
// ABOUTME: Keeps path authorization aligned with client-scoped roots.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { setWorkspaceRoots } from "./workspace.js";

export interface McpRootLike {
	uri: string;
	name?: string;
}

export interface ParsedMcpRoots {
	roots: string[];
	invalidUris: string[];
}

function toDedupKey(p: string): string {
	return process.platform === "win32" ? p.toLowerCase() : p;
}

function parseFileUri(uri: string): string | null {
	try {
		const url = new URL(uri);
		if (url.protocol !== "file:") return null;
		return path.resolve(fileURLToPath(url));
	} catch {
		return null;
	}
}

export function parseMcpRoots(roots: readonly McpRootLike[]): ParsedMcpRoots {
	const dedup = new Set<string>();
	const parsed: string[] = [];
	const invalidUris: string[] = [];

	for (const root of roots) {
		const resolved = parseFileUri(root.uri);
		if (!resolved) {
			invalidUris.push(root.uri);
			continue;
		}
		const key = toDedupKey(path.normalize(resolved));
		if (dedup.has(key)) continue;
		dedup.add(key);
		parsed.push(path.normalize(resolved));
	}

	return { roots: parsed, invalidUris };
}

export function applyMcpRoots(roots: readonly McpRootLike[]): {
	applied: boolean;
	roots: string[];
	invalidUris: string[];
} {
	const parsed = parseMcpRoots(roots);
	if (parsed.roots.length === 0) {
		return { applied: false, roots: [], invalidUris: parsed.invalidUris };
	}
	setWorkspaceRoots(parsed.roots);
	return {
		applied: true,
		roots: parsed.roots,
		invalidUris: parsed.invalidUris,
	};
}
