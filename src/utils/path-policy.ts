// ABOUTME: Centralizes workspace path gating, sensitive-path checks, and gitignore policy checks.
// ABOUTME: Provides one policy path for tools to enforce consistent access behavior.

import type { Ignore } from "ignore";
import { ToolErrorType } from "../types/tool-error-type.js";
import type { ToolError } from "../types/tool-result.js";
import { buildIgnoreFilter } from "./ignore.js";
import {
	isSensitivePath,
	relativizePosix,
	resolveWithinWorkspace,
} from "./workspace.js";

export interface CommonFileFilteringOptions {
	no_ignore?: boolean;
	respect_git_ignore?: boolean;
	file_filtering_options?: {
		respect_git_ignore?: boolean;
		respect_gemini_ignore?: boolean;
	};
}

export interface PathPolicyContext {
	respectGitIgnore: boolean;
	ignoreFilter: Ignore | null;
}

export type PathPolicyBlockReason = "sensitive" | "ignored";

export type PathAccessResult =
	| {
			ok: true;
			absPath: string;
			root: string;
			relPosix: string;
			policy: PathPolicyContext;
	  }
	| {
			ok: false;
			llmContent: string;
			error: ToolError;
	  };

function toPolicyError(message: string, type: ToolErrorType): PathAccessResult {
	return { ok: false, llmContent: message, error: { message, type } };
}

export function resolveRespectGitIgnore(
	options?: CommonFileFilteringOptions,
	defaults?: { outsideWorkspace?: boolean },
): boolean {
	if (options?.no_ignore === true) return false;
	if (typeof options?.respect_git_ignore === "boolean") {
		return options.respect_git_ignore;
	}
	if (
		typeof options?.file_filtering_options?.respect_git_ignore === "boolean"
	) {
		return options.file_filtering_options.respect_git_ignore;
	}
	return defaults?.outsideWorkspace !== true;
}

export function getPathPolicyBlockReason(
	relPosix: string,
	policy: PathPolicyContext,
): PathPolicyBlockReason | null {
	if (relPosix === "." || relPosix === "") return null;
	if (isSensitivePath(relPosix)) return "sensitive";
	if (policy.respectGitIgnore && policy.ignoreFilter?.ignores(relPosix)) {
		return "ignored";
	}
	return null;
}

export function blockedPathMessage(
	action: string,
	relPosix: string,
	reason: PathPolicyBlockReason,
): string {
	if (reason === "sensitive") {
		return `Refusing to ${action} sensitive path: ${relPosix}`;
	}
	return `Refusing to ${action} ignored path: ${relPosix}`;
}

export function blockedPathErrorType(
	reason: PathPolicyBlockReason,
): ToolErrorType {
	return reason === "sensitive"
		? ToolErrorType.SENSITIVE_PATH
		: ToolErrorType.PATH_IGNORED_BY_POLICY;
}

export async function getPolicyContextForRoot(
	root: string,
	respectGitIgnore: boolean,
): Promise<PathPolicyContext> {
	return {
		respectGitIgnore,
		ignoreFilter: respectGitIgnore
			? await buildIgnoreFilter({ respectGitIgnore: true }, root)
			: null,
	};
}

export async function resolvePathAccess(
	pathInput: string,
	options: {
		action: string;
		filtering?: CommonFileFilteringOptions;
	},
): Promise<PathAccessResult> {
	let resolved: ReturnType<typeof resolveWithinWorkspace>;
	try {
		resolved = resolveWithinWorkspace(pathInput);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return toPolicyError(msg, ToolErrorType.PATH_NOT_IN_WORKSPACE);
	}

	const relPosix = relativizePosix(resolved.absPath, resolved.root);
	const respectGitIgnore = resolveRespectGitIgnore(options.filtering, {
		outsideWorkspace: resolved.outsideWorkspace === true,
	});
	const policy = await getPolicyContextForRoot(resolved.root, respectGitIgnore);
	const blocked = getPathPolicyBlockReason(relPosix, policy);
	if (blocked) {
		const msg = blockedPathMessage(options.action, relPosix, blocked);
		return toPolicyError(msg, blockedPathErrorType(blocked));
	}

	return {
		ok: true,
		absPath: resolved.absPath,
		root: resolved.root,
		relPosix,
		policy,
	};
}
