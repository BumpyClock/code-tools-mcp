// ABOUTME: Applies a targeted string replacement to a workspace file.
// ABOUTME: Supports preview diffs, enforces ignore/safety, and preserves line endings.

import fs from "node:fs/promises";
import path from "node:path";
import * as Diff from "diff";
import { z } from "zod";
import { ErrorCode } from "../types/error-codes.js";
import { buildIgnoreFilter } from "../utils/ignore.js";
import {
	isSensitivePath,
	relativize,
	relativizePosix,
	resolveWithinWorkspace,
} from "../utils/workspace.js";

export const editShape = {
	file_path: z
		.string()
		.describe(
			"Absolute path within the workspace, or a path relative to workspace root.",
		),
	old_string: z
		.string()
		.describe("Text to replace. Use empty string to create a new file."),
	new_string: z.string().describe("Replacement text."),
	expected_replacements: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("Expected number of replacements (default 1)."),
	apply: z
		.boolean()
		.default(false)
		.describe("If false (default), return diff preview without writing."),
	allow_ignored: z
		.boolean()
		.optional()
		.describe(
			"Optional: allow editing files ignored by .gitignore (default false).",
		),
	modified_by_user: z.boolean().optional(),
	ai_proposed_content: z.string().optional(),
};
export const editInput = z.object(editShape);
export type EditInput = z.infer<typeof editInput>;

// Output schema for structured content returned by this tool
export const editOutputShape = {
	path: z.string().optional(),
	relativePath: z.string().optional(),
	applied: z.boolean().optional(),
	diff: z.string().optional(),
	occurrences: z.number().optional(),
	affectedLines: z.array(z.number()).optional(),
	totalLinesAffected: z.number().optional(),
	summary: z.string().optional(),
	error: z.string().optional(),
	message: z.string().optional(),
};

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	return haystack.split(needle).length - 1;
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") starts.push(i + 1);
	}
	return starts;
}

function lineNumberAtIndex(starts: number[], index: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const v = starts[mid];
		if (v === index) return mid + 1;
		if (v < index) lo = mid + 1;
		else hi = mid - 1;
	}
	return Math.max(1, hi + 1);
}

function computeAffectedLines(
	source: string,
	oldNeedle: string,
	newContent: string,
	isNewFile: boolean,
): number[] {
	if (isNewFile) {
		const count = newContent.length === 0 ? 0 : newContent.split("\n").length;
		return Array.from({ length: count }, (_v, i) => i + 1);
	}
	if (!oldNeedle) return [];

	const starts = lineStarts(source);
	const affected = new Set<number>();
	let fromIndex = 0;
	while (true) {
		const idx = source.indexOf(oldNeedle, fromIndex);
		if (idx === -1) break;
		const startLine = lineNumberAtIndex(starts, idx);
		const endIdx = Math.max(idx, idx + oldNeedle.length - 1);
		const endLine = lineNumberAtIndex(starts, endIdx);
		for (let l = startLine; l <= endLine; l++) affected.add(l);
		fromIndex = idx + oldNeedle.length;
	}
	return Array.from(affected).sort((a, b) => a - b);
}

export async function editTool(input: EditInput) {
	const {
		file_path,
		old_string,
		new_string,
		expected_replacements,
		apply,
		allow_ignored,
	} = input;

	// Check for no-change edits early
	if (old_string === new_string) {
		return {
			content: [
				{
					type: "text" as const,
					text: `No changes to apply: old_string and new_string are identical.`,
				},
			],
			structuredContent: {
				error: ErrorCode.EDIT_NO_CHANGE,
				message: "old_string and new_string are identical",
			},
		};
	}

	let abs: string;
	try {
		abs = resolveWithinWorkspace(file_path);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: { error: ErrorCode.OUTSIDE_WORKSPACE, message: msg },
		};
	}

	const relPosix = relativizePosix(abs);
	if (isSensitivePath(relPosix)) {
		const msg = `Refusing to edit sensitive path: ${relPosix}`;
		return {
			content: [{ type: "text" as const, text: msg }],
			structuredContent: {
				error: ErrorCode.SENSITIVE_PATH,
				message: msg,
				path: abs,
				relativePath: relPosix,
			},
		};
	}

	let current: string | null = null;
	let exists = false;
	let hadCrlf = false;
	try {
		const raw = await fs.readFile(abs, "utf8");
		hadCrlf = raw.includes("\r\n");
		current = raw.replace(/\r\n/g, "\n");
		exists = true;
	} catch {}

	// Respect .gitignore unless allow_ignored is true.
	if (!allow_ignored) {
		const ig = await buildIgnoreFilter({ respectGitIgnore: true });
		if (ig.ignores(relPosix)) {
			const msg = `Refusing to edit ignored file: ${relativize(abs)}`;
			return {
				content: [{ type: "text" as const, text: msg }],
				structuredContent: {
					error: ErrorCode.FILE_IGNORED,
					message: msg,
					path: abs,
					relativePath: relPosix,
				},
			};
		}
	}

	if (!exists && old_string !== "") {
		return {
			content: [
				{
					type: "text" as const,
					text: `File not found. Cannot apply edit unless old_string is empty to create a new file.`,
				},
			],
			structuredContent: { error: ErrorCode.NOT_FOUND },
		};
	}

	// Better error for existing file with empty old_string
	if (exists && old_string === "") {
		return {
			content: [
				{
					type: "text" as const,
					text: `File already exists. Cannot use empty old_string on existing file. Use old_string to specify text to replace.`,
				},
			],
			structuredContent: {
				error: ErrorCode.EDIT_FILE_EXISTS,
				message: "Cannot use empty old_string on existing file",
			},
		};
	}

	const isNewFile = !exists && old_string === "";
	const source = current ?? "";
	const oldNorm = old_string.replace(/\r\n/g, "\n");
	const newNorm = new_string.replace(/\r\n/g, "\n");
	const occ = isNewFile ? 0 : countOccurrences(source, oldNorm);
	const expected = expected_replacements ?? 1;

	if (!isNewFile) {
		if (occ === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Failed to edit: 0 occurrences found for old_string.`,
					},
				],
				structuredContent: { error: ErrorCode.EDIT_NO_OCCURRENCE_FOUND },
			};
		}
		if (occ !== expected) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Failed to edit: expected ${expected} occurrences but found ${occ}.`,
					},
				],
				structuredContent: {
					error: ErrorCode.EDIT_EXPECTED_OCCURRENCE_MISMATCH,
				},
			};
		}
	}

	const newContent = isNewFile ? newNorm : source.split(oldNorm).join(newNorm);

	// Check if content actually changed
	if (!isNewFile && newContent === source) {
		return {
			content: [
				{
					type: "text" as const,
					text: `No changes resulted from the edit operation.`,
				},
			],
			structuredContent: {
				error: ErrorCode.EDIT_NO_CHANGE,
				message: "Content unchanged after replacements",
			},
		};
	}

	const fileName = path.basename(abs);
	const diff = Diff.createPatch(
		fileName,
		source,
		newContent,
		"Current",
		"Proposed",
	);
	const rel = relativize(abs);

	// Add summary to structured content
	const summary = isNewFile
		? "Creating new file"
		: `Replacing ${occ} occurrence${occ > 1 ? "s" : ""} in file`;

	const affectedLines = computeAffectedLines(
		source,
		oldNorm,
		newContent,
		isNewFile,
	);
	const totalLinesAffected = affectedLines.length;

	if (!apply) {
		const preview = `Edit preview for ${rel} (not applied). To apply, call edit with apply: true.\n\n${diff}`;
		return {
			content: [{ type: "text" as const, text: preview }],
			structuredContent: {
				path: abs,
				relativePath: relPosix,
				applied: false,
				diff,
				occurrences: isNewFile ? 0 : occ,
				affectedLines,
				totalLinesAffected,
				summary: `${summary} (preview)`,
			},
		};
	}

	await fs.mkdir(path.dirname(abs), { recursive: true });
	const toWrite = hadCrlf ? newContent.replace(/\n/g, "\r\n") : newContent;
	await fs.writeFile(abs, toWrite, "utf8");
	const result = `Applied edit to ${rel}.\n\n${diff}`;
	return {
		content: [{ type: "text" as const, text: result }],
		structuredContent: {
			path: abs,
			relativePath: relPosix,
			applied: true,
			diff,
			occurrences: isNewFile ? 0 : occ,
			affectedLines,
			totalLinesAffected,
			summary: `${summary} (applied)`,
		},
	};
}
