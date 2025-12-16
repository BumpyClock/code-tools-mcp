**Code Tools MCP Server**

- Local-only MCP server exposing core coding tools for LLMs via STDIO.
- Tools: `list_directory`, `read_file`, `write_file`, `grep`, `ripgrep`, `glob`, `edit`, `read_many_files`.

Codex CLI on windows sort of sucks because it relies on writing PS / Python scripts for basic read, write, grep operations. This MCP server exposes those standard tools making Codex CLI faster on Windows. You can use it on Linux or Mac, it will work but may not be necessary. 

This is without warranty, any issues or bugs should be reported to the repository but be aware of the risks and use it at your own risk.

**Install**

- Global: `npm i -g code-tools-mcp`
- One-off: `npx code-tools-mcp`

**Run**

- `code-tools-mcp --root C:/path/to/workspace`


**CODEX CLI Config Example**
```
[mcp_servers.code-tools]
command = "{path to npm.cmd}"
args = [ "-y", "code-tools-mcp"]
env = { APPDATA = "C:\\Users\\{username}\\AppData\\Roaming", LOCALAPPDATA = "C:\\Users\\{username}\\AppData\\Local", HOME = "C:\\Users\\{username}", SystemRoot = "C:\\Windows", ComSpec = "C:\\Windows\\System32\\cmd.exe" }
startup_timeout_ms = 20_000
```

Workspace root is auto-detected:
- If `CODE_TOOLS_MCP_ROOT` is set, it wins.
- Else if a CLI flag is passed, it’s used: `--root C:/path/to/workspace` (or `-r`).
- Else, the server looks upward from the current working directory for a `.git` folder and uses that directory as root.
- Else, it defaults to the current working directory.

Claude config example without env var (pass a root flag):
```
{
  "mcpServers": {
    "code-tools": {
      "command": "node",
      "args": [
        "C:/Users/adity/Projects/code-tools-mcp/dist/index.js",
        "--root",
        "C:/Users/adity/Projects/code-tools-mcp"
      ]
    }
  }
}
```

**Claude Desktop Config Example**

Add to your Claude config JSON:

```
{
  "mcpServers": {
    "code-tools": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/code-tools-mcp/dist/index.js"],
      "env": { "CODE_TOOLS_MCP_ROOT": "/ABSOLUTE/PATH/TO/YOUR/WORKSPACE" }
    }
  }
}
```



**Notes**

- Uses STDIO transport; avoid `console.log` (stdout). Any diagnostics are written to stderr.
- File operations are restricted to the workspace root.
- `read_file` caps file size at 2MB; larger batch reads are capped via `read_many_files`.
- Ignore rules honor nested `.gitignore`, `.git/info/exclude`, and common global ignore files (`.geminiignore` is NOT supported).


---
## TODO:
- Repomap using AST

---

## Tools

### list_directory
Lists directory contents with directories first, respects `.gitignore`.

**Parameters:**
- `path` (string, required): Absolute path, or workspace-relative path to directory
- `ignore` (string[], optional): Glob patterns to ignore
- `file_filtering_options` (object, optional): `{ respect_git_ignore?: boolean }`

**Example:**
```typescript
await client.callTool('list_directory', {
  path: '/path/to/workspace/src'
});
```

### read_file
Reads a file with optional pagination. Binary-aware.

**Parameters:**
- `absolute_path` (string, required): Absolute path, or workspace-relative path to file
- `offset` (number, optional): Starting line (0-based)
- `limit` (number, optional): Number of lines to return (max 2000)
- `allow_ignored` (boolean, optional): Allow reading `.gitignore`-ignored files (default: false)

**Features:**
- Returns `nextOffset` in structured content for paginated reads
- Includes `summary` with line count in all responses

**Example:**
```typescript
await client.callTool('read_file', {
  absolute_path: '/path/to/workspace/src/index.ts',
  offset: 0,
  limit: 100
});
```

### write_file
Creates or overwrites a file with preview mode.

**Parameters:**
- `file_path` (string, required): Absolute path, or workspace-relative path of file to write
- `content` (string, required): Full file content
- `apply` (boolean, default: false): If false, returns diff preview without writing
- `overwrite` (boolean, default: true): Allow overwriting existing files
- `allow_ignored` (boolean, optional): Allow writing `.gitignore`-ignored files (default: false)

**Features:**
- Preview mode by default (set `apply: true` to write)
- Returns diff in structured content

**Example:**
```typescript
await client.callTool('write_file', {
  file_path: '/path/to/workspace/src/new-file.ts',
  content: 'export const foo = "bar";',
  apply: true
});
```

### grep
Text/regex search with smart-case support.

**Parameters:**
- `pattern` (string, required): Search pattern (plain text or regex if `regex: true`)
- `path` (string, optional): Directory/file path (absolute or workspace-relative)
- `include` (string, optional): Glob filter (e.g., `**/*.{ts,tsx}`)
- `exclude` (string | string[], optional): Glob exclusion patterns
- `regex` (boolean, default: false): Treat pattern as regex
- `ignore_case` (boolean, optional): Case-insensitive search. If undefined, uses smart-case (case-sensitive if pattern has uppercase)
- `max_matches` (number, default: 2000): Maximum matches to return
- `useDefaultExcludes` (boolean, optional): Apply default excludes (node_modules, dist, .git, etc.). Default true.

**Features:**
- Smart-case: automatically case-sensitive if pattern contains uppercase letters
- Skips binary files
- Respects `.gitignore`
- Returns `truncated: true` if max_matches reached

**Example:**
```typescript
await client.callTool('grep', {
  pattern: 'function.*async',
  regex: true,
  include: '**/*.ts',
  max_matches: 100
});
```

### ripgrep
Fast regex search using ripgrep binary (falls back to grep if unavailable).

**Parameters:**
- `pattern` (string, required): Regular expression
- `path` (string, optional): Directory or file to search (absolute or workspace-relative)
- `include` (string | string[], optional): Glob include patterns
- `exclude` (string | string[], optional): Glob exclude patterns
- `ignore_case` (boolean, optional): If undefined, uses `--smart-case`
- `max_matches` (number, default: 20000): Maximum matches to return

**Features:**
- Uses `--smart-case` by default when `ignore_case` not specified
- Returns `truncated: true` if max_matches reached
- Falls back to JavaScript grep if ripgrep unavailable
- Captures stderr in `structuredContent.stderr`

**Example:**
```typescript
await client.callTool('ripgrep', {
  pattern: 'TODO|FIXME',
  include: ['**/*.ts', '**/*.tsx'],
  exclude: '**/node_modules/**'
});
```

### glob
Matches files by glob pattern with two-tier sorting.

**Parameters:**
- `pattern` (string, required): Glob pattern (e.g., `**/*.ts`)
- `path` (string, optional): Directory to search (absolute or workspace-relative; defaults to workspace root)
- `case_sensitive` (boolean, default: false): Case-sensitive matching
- `respect_git_ignore` (boolean, default: true): Respect `.gitignore`

**Features:**
- Two-tier sorting: recent files (< 24h) newest-first, then older files alphabetically
- Reports `gitIgnoredCount` when no files found

**Example:**
```typescript
await client.callTool('glob', {
  pattern: '**/*.{ts,tsx}',
  path: '/path/to/workspace/src'
});
```

### edit
Targeted text replacement with preview mode.

**Parameters:**
- `file_path` (string, required): Absolute path, or workspace-relative path to file
- `old_string` (string, required): Text to replace (empty string creates new file)
- `new_string` (string, required): Replacement text
- `expected_replacements` (number, default: 1): Expected number of replacements
- `apply` (boolean, default: false): If false, returns diff preview
- `allow_ignored` (boolean, optional): Allow editing `.gitignore`-ignored files (default: false)

**Features:**
- Preview mode by default
- Detects no-change edits
- Returns `occurrences` in structured content

**Example:**
```typescript
await client.callTool('edit', {
  file_path: '/path/to/workspace/src/index.ts',
  old_string: 'const foo = "old";',
  new_string: 'const foo = "new";',
  apply: true
});
```

### read_many_files
Reads multiple files by glob patterns, concatenated output.

**Parameters:**
- `paths` (string[], required): Array of file/directory globs
- `include` (string[], optional): Additional glob patterns to include
- `exclude` (string[], optional): Glob patterns to exclude
- `useDefaultExcludes` (boolean, default: true): Apply default excludes (node_modules, dist, .git, etc.)
- `file_filtering_options` (object, optional): `{ respect_git_ignore?: boolean }`

**Features:**
- 2MB total output cap
- Workspace containment re-check for safety
- Aggregated skip reasons in structured content (`skipCounts`)
- Returns `truncated: true` when total cap reached

**Example:**
```typescript
await client.callTool('read_many_files', {
  paths: ['src/**/*.ts'],
  exclude: ['**/*.test.ts']
});
```

---

## Using These Tools from an MCP Client

> Tool discovery: clients call `tools/list` (supports cursor pagination) and may receive `tools/list_changed` when the set changes.

### TypeScript Example

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Connect to the server
const transport = new StdioClientTransport({
  command: 'node',
  args: ['/path/to/code-tools-mcp/dist/index.js'],
  env: { CODE_TOOLS_MCP_ROOT: '/path/to/workspace' }
});

const client = new Client({
  name: 'example-client',
  version: '1.0.0'
}, {
  capabilities: {}
});

await client.connect(transport);

// List available tools
const tools = await client.listTools();
console.log('Available tools:', tools.tools.map(t => t.name));

// Call a tool
const result = await client.callTool({
  name: 'read_file',
  arguments: {
    absolute_path: '/path/to/workspace/src/index.ts'
  }
});

console.log('Result:', result);
```

### Pagination Example

```typescript
// Read large file in chunks
let offset = 0;
const limit = 100;

while (true) {
  const result = await client.callTool({
    name: 'read_file',
    arguments: {
      absolute_path: '/path/to/large-file.ts',
      offset,
      limit
    }
  });

  console.log(result.content[0].text);

  // Check if there's more to read
  const nextOffset = result.structuredContent?.nextOffset;
  if (!nextOffset) break;

  offset = nextOffset;
}
```

---

## Tool Stability

- **Tool names are stable** and will not change in minor versions
- **Parameter names are stable** - new optional parameters may be added
- **Descriptions are concise** - detailed parameter docs are in JSON Schema (via Zod `.describe()`)
- **Structured content** includes `summary` field for all tools where applicable
- **Defaults and limits** are documented in parameter descriptions:
  - `read_file`: 2MB file cap, 2000 line limit per request
  - `read_many_files`: 2MB total output cap, 1MB per file
  - `grep`: 2000 matches default, configurable via `max_matches`
  - `ripgrep`: 20000 matches default, configurable via `max_matches`

---

## TypeScript Types

All tool input and output types are available in `src/types/tools.ts`:

```typescript
import type {
  ReadFileInput,
  ReadFileStructuredOutput,
  GrepInput,
  GrepStructuredOutput,
  // ... other types
} from 'code-tools-mcp/types/tools';
```
