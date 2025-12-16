// ABOUTME: Re-exports tool schemas and inferred TypeScript types for clients.
// ABOUTME: Keeps input/output typings in sync with the server's Zod definitions.

import type { z } from "zod";

export { ErrorCode } from "./error-codes.js";

/**
 * Unified TypeScript types for code-tools-mcp
 *
 * This file exports all tool input and output types for use by clients and tests.
 * Types are inferred from Zod schemas defined in individual tool files.
 */

export type { EditInput } from "../tools/edit.js";
export { editInput, editOutputShape, editShape } from "../tools/edit.js";
export type { GlobInput } from "../tools/glob.js";
export { globInput, globOutputShape, globShape } from "../tools/glob.js";
export type { GrepInput } from "../tools/grep.js";
export { grepInput, grepOutputShape, grepShape } from "../tools/grep.js";
// Import all tool inputs and schemas (types for inputs)
export type { LsInput } from "../tools/ls.js";
// Re-export Zod schemas for runtime validation
export { lsInput, lsOutputShape, lsShape } from "../tools/ls.js";
export type { ReadFileInput } from "../tools/read-file.js";
export {
	readFileInput,
	readFileOutputShape,
	readFileShape,
} from "../tools/read-file.js";
export type { ReadManyFilesInput } from "../tools/read-many-files.js";
export {
	readManyFilesInput,
	readManyFilesOutputShape,
	readManyFilesShape,
} from "../tools/read-many-files.js";
export type { RipgrepInput } from "../tools/ripgrep.js";
export {
	ripgrepInput,
	ripgrepOutputShape,
	ripgrepShape,
} from "../tools/ripgrep.js";
export type { WriteFileInput } from "../tools/write-file.js";
export {
	writeFileInput,
	writeFileOutputShape,
	writeFileShape,
} from "../tools/write-file.js";

// Generic MCP Tool result helpers (optional convenience)
export interface ToolContent {
	type: "text" | "image" | "resource";
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ToolResult {
	content: ToolContent[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

// Output types inferred from Zod output schemas (single source of truth)
export type LsOutput = z.infer<
	z.ZodObject<typeof import("../tools/ls.js").lsOutputShape>
>;
export type ReadFileOutput = z.infer<
	z.ZodObject<typeof import("../tools/read-file.js").readFileOutputShape>
>;
export type WriteFileOutput = z.infer<
	z.ZodObject<typeof import("../tools/write-file.js").writeFileOutputShape>
>;
export type GrepOutput = z.infer<
	z.ZodObject<typeof import("../tools/grep.js").grepOutputShape>
>;
export type RipgrepOutput = z.infer<
	z.ZodObject<typeof import("../tools/ripgrep.js").ripgrepOutputShape>
>;
export type GlobOutput = z.infer<
	z.ZodObject<typeof import("../tools/glob.js").globOutputShape>
>;
export type EditOutput = z.infer<
	z.ZodObject<typeof import("../tools/edit.js").editOutputShape>
>;
export type ReadManyFilesOutput = z.infer<
	z.ZodObject<
		typeof import("../tools/read-many-files.js").readManyFilesOutputShape
	>
>;

// Backwards/README-friendly aliases (structured content outputs)
export type LsStructuredOutput = LsOutput;
export type ReadFileStructuredOutput = ReadFileOutput;
export type WriteFileStructuredOutput = WriteFileOutput;
export type GrepStructuredOutput = GrepOutput;
export type RipgrepStructuredOutput = RipgrepOutput;
export type GlobStructuredOutput = GlobOutput;
export type EditStructuredOutput = EditOutput;
export type ReadManyFilesStructuredOutput = ReadManyFilesOutput;
