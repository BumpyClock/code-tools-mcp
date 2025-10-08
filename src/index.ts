import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { lsTool, lsInput, lsShape } from './tools/ls.js';
import { readFileTool, readFileInput, readFileShape } from './tools/read-file.js';
import { writeFileTool, writeFileInput, writeFileShape } from './tools/write-file.js';
import { grepTool, grepInput, grepShape } from './tools/grep.js';
import { ripgrepTool, ripgrepInput, ripgrepShape } from './tools/ripgrep.js';
import { globTool, globInput, globShape } from './tools/glob.js';
import { editTool, editInput, editShape } from './tools/edit.js';
import { readManyFilesTool, readManyFilesInput, readManyFilesShape } from './tools/read-many-files.js';

const server = new McpServer({
  name: 'code-tools-mcp',
  version: '0.1.0',
});

server.registerTool(
  'list_directory',
  {
    title: 'List Directory',
    description: 'Lists files and subdirectories in a specified directory (non-recursive). Returns entries sorted with directories first, then alphabetically. Respects .gitignore patterns by default.',
    inputSchema: lsShape,
  },
  async (input: z.infer<typeof lsInput>) => lsTool(input)
);

server.registerTool(
  'read_file',
  {
    title: 'Read File',
    description: 'Reads content from a single file with automatic text/binary detection. Supports pagination for large files using offset/limit parameters. Binary files return metadata only. Max 2MB per file.',
    inputSchema: readFileShape,
  },
  async (input: z.infer<typeof readFileInput>) => readFileTool(input)
);

server.registerTool(
  'write_file',
  {
    title: 'Write File',
    description: 'Creates or overwrites a file with specified content. Supports preview mode (apply=false) to see diff before writing. Validates workspace boundaries. Use for creating new files, replacing entire file contents, or generating configs.',
    inputSchema: writeFileShape,
  },
  async (input: z.infer<typeof writeFileInput>) => writeFileTool(input)
);

server.registerTool(
  'grep',
  {
    title: 'Grep',
    description: 'Searches file contents for plain-text patterns with optional regex support. Case-insensitive by default. Excludes binary files and respects .gitignore. Returns matching lines with context. Use for finding code usages, searching for strings, or locating TODOs/FIXMEs.',
    inputSchema: grepShape,
  },
  async (input: z.infer<typeof grepInput>) => grepTool(input)
);

server.registerTool(
  'ripgrep',
  {
    title: 'Ripgrep',
    description: 'High-performance regex search using ripgrep with automatic fallback to JavaScript grep. Supports complex patterns and multiple include/exclude globs. Returns JSON-formatted results. Best for large codebases, complex regex patterns, or when performance matters. Limited to 20K matches.',
    inputSchema: ripgrepShape,
  },
  async (input: z.infer<typeof ripgrepInput>, { signal }) => ripgrepTool(input, signal)
);

server.registerTool(
  'glob',
  {
    title: 'Glob',
    description: 'Finds files matching glob patterns (e.g., **/*.ts, src/**/*.js). Returns absolute paths sorted by modification time (newest first). Respects .gitignore by default. Use for finding files by extension, listing test files, or collecting files for batch operations.',
    inputSchema: globShape,
  },
  async (input: z.infer<typeof globInput>) => globTool(input)
);

server.registerTool(
  'edit',
  {
    title: 'Edit',
    description: 'Makes precise text replacements in files. Requires unique old_string to identify location. Supports preview mode (apply=false) and bulk replacements (replace_all=true). Use for refactoring, updating imports, fixing typos, or changing configuration values.',
    inputSchema: editShape,
  },
  async (input: z.infer<typeof editInput>) => editTool(input)
);

server.registerTool(
  'read_many_files',
  {
    title: 'Read Many Files',
    description: 'Reads and concatenates multiple files matching glob patterns. Ideal for getting overview of codebases, reading all configs, or analyzing related files together. Auto-excludes binaries and common build folders. Total output capped at 2MB. Files separated with clear markers.',
    inputSchema: readManyFilesShape,
  },
  async (input: z.infer<typeof readManyFilesInput>) => readManyFilesTool(input)
);

// Start with stdio transport for local-only use
const transport = new StdioServerTransport();
await server.connect(transport);

// Avoid logging to stdout to not break JSON-RPC; use stderr for any diagnostics
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
