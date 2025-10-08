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
    description: 'Non-recursive listing; dirs first; respects .gitignore.',
    inputSchema: lsShape,
  },
  async (input: z.infer<typeof lsInput>) => lsTool(input)
);

server.registerTool(
  'read_file',
  {
    title: 'Read File',
    description: 'Read a file; text/binary aware; optional pagination.',
    inputSchema: readFileShape,
  },
  async (input: z.infer<typeof readFileInput>) => readFileTool(input)
);

server.registerTool(
  'write_file',
  {
    title: 'Write File',
    description: 'Create/overwrite file; preview with apply=false; workspace-safe.',
    inputSchema: writeFileShape,
  },
  async (input: z.infer<typeof writeFileInput>) => writeFileTool(input)
);

server.registerTool(
  'grep',
  {
    title: 'Grep',
    description: 'Text/regex search; case-insensitive default; skips binaries; respects .gitignore.',
    inputSchema: grepShape,
  },
  async (input: z.infer<typeof grepInput>) => grepTool(input)
);

server.registerTool(
  'ripgrep',
  {
    title: 'Ripgrep',
    description: 'Fast regex search via ripgrep (JS fallback); include/exclude globs; 20k cap.',
    inputSchema: ripgrepShape,
  },
  async (input: z.infer<typeof ripgrepInput>, { signal }) => ripgrepTool(input, signal)
);

server.registerTool(
  'glob',
  {
    title: 'Glob',
    description: 'Match files by glob; newest-first; respects .gitignore.',
    inputSchema: globShape,
  },
  async (input: z.infer<typeof globInput>) => globTool(input)
);

server.registerTool(
  'edit',
  {
    title: 'Edit',
    description: 'Targeted text replace; preview (apply=false); bulk via replace_all.',
    inputSchema: editShape,
  },
  async (input: z.infer<typeof editInput>) => editTool(input)
);

server.registerTool(
  'read_many_files',
  {
    title: 'Read Many Files',
    description: 'Read many files by glob; concatenated; skips binaries; 2MB cap.',
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
