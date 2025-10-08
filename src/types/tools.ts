/**
 * Unified TypeScript types for code-tools-mcp
 *
 * This file exports all tool input and output types for use by clients and tests.
 * Types are inferred from Zod schemas defined in individual tool files.
 */

// Import all tool inputs and schemas
export type { LsInput } from '../tools/ls.js';
export type { ReadFileInput } from '../tools/read-file.js';
export type { WriteFileInput } from '../tools/write-file.js';
export type { GrepInput } from '../tools/grep.js';
export type { RipgrepInput } from '../tools/ripgrep.js';
export type { GlobInput } from '../tools/glob.js';
export type { EditInput } from '../tools/edit.js';
export type { ReadManyFilesInput } from '../tools/read-many-files.js';

// Re-export Zod schemas for runtime validation
export { lsInput, lsShape, lsOutputShape } from '../tools/ls.js';
export { readFileInput, readFileShape, readFileOutputShape } from '../tools/read-file.js';
export { writeFileInput, writeFileShape, writeFileOutputShape } from '../tools/write-file.js';
export { grepInput, grepShape, grepOutputShape } from '../tools/grep.js';
export { ripgrepInput, ripgrepShape, ripgrepOutputShape } from '../tools/ripgrep.js';
export { globInput, globShape, globOutputShape } from '../tools/glob.js';
export { editInput, editShape, editOutputShape } from '../tools/edit.js';
export { readManyFilesInput, readManyFilesShape, readManyFilesOutputShape } from '../tools/read-many-files.js';

// Tool output types - based on MCP SDK's ToolResult type
export interface ToolContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, any>;
  isError?: boolean;
}

// Specific output types for structured content
export interface LsStructuredOutput {
  directory: string;
  entries: Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    modifiedTime: string;
  }>;
  gitIgnoredCount: number;
  summary: string;
  error?: string;
}

export interface ReadFileStructuredOutput {
  path: string;
  mimeType?: string;
  binary?: boolean;
  size?: number;
  lineStart?: number;
  lineEnd?: number;
  totalLines?: number;
  summary?: string;
  nextOffset?: number;
  error?: string;
}

export interface WriteFileStructuredOutput {
  path: string;
  applied: boolean;
  diff?: string;
  summary: string;
  error?: string;
}

export interface GrepStructuredOutput {
  matches: Array<{
    filePath: string;
    lineNumber: number;
    line: string;
  }>;
  summary: string;
  truncated: boolean;
  maxMatches?: number;
  error?: string;
}

export interface RipgrepStructuredOutput {
  matches: Array<{
    filePath: string;
    lineNumber: number;
    line: string;
  }>;
  stderr?: string;
  summary: string;
  truncated: boolean;
  maxMatches?: number;
  aborted?: boolean;
  error?: string;
}

export interface GlobStructuredOutput {
  files: string[];
  summary: string;
  gitIgnoredCount?: number;
  error?: string;
}

export interface EditStructuredOutput {
  path: string;
  applied: boolean;
  diff: string;
  occurrences: number;
  summary: string;
  error?: string;
}

export interface ReadManyFilesStructuredOutput {
  files: string[];
  skipped: Array<{
    path: string;
    reason: string;
  }>;
  skipCounts?: {
    ignored: number;
    binary: number;
    tooLarge: number;
    notFile: number;
    totalCapReached: number;
    readError: number;
  };
  totalBytes: number;
  truncated?: boolean;
  totalCapReached?: boolean;
  summary: string;
}
