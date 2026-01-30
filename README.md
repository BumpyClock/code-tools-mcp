**Code Tools MCP Server**

- Local-only MCP server exposing core coding tools for LLMs via STDIO.
- Tools: `list_directory`, `read_file`, `write_file`, `search_file_content`, `glob`, `replace`, `read_many_files`.

Codex CLI on Windows has limitations because it relies on writing PowerShell/Python scripts for basic read, write, grep operations. This MCP server exposes those standard tools making Codex CLI faster on Windows. You can use it on Linux or Mac, it will work but may not be necessary.

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

Additional workspace roots:
- Set `CODE_TOOLS_MCP_ROOTS` or pass `--roots` (path.delimiter-separated) to add extra workspace directories.

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
- File operations are restricted to workspace roots.
- `ripgrep` is a deprecated alias for `search_file_content`; use `search_file_content` going forward.
- `.geminiignore` parameters are parsed for Gemini parity but not yet applied to ignore logic (kept as a no-op while we align behavior with `.gitignore` handling). Planned for the next minor release; see CHANGELOG for updates.


---
## TODO:
- Repomap using AST

---

## Tools

### list_directory
Lists directory contents with directories first, respects `.gitignore`.

**Parameters:**
- `dir_path` (string, required): Absolute path, or workspace-relative path to directory
- `ignore` (string[], optional): Glob patterns to ignore (name matching)
- `file_filtering_options` (object, optional): `{ respect_git_ignore?: boolean, respect_gemini_ignore?: boolean }`

**Example:**
```typescript
await client.callTool('list_directory', {
  dir_path: '/path/to/workspace/src'
});
```

### read_file
Reads a file with optional pagination. Binary-aware (images, audio, PDF).

**Parameters:**
- `file_path` (string, required): Absolute path, or workspace-relative path to file
- `offset` (number, optional): Starting line (0-based)
- `limit` (number, optional): Number of lines to return

**Example:**
```typescript
await client.callTool('read_file', {
  file_path: '/path/to/workspace/src/index.ts',
  offset: 0,
  limit: 100
});
```

### write_file
Creates or overwrites a file.

**Parameters:**
- `file_path` (string, required): Absolute path, or workspace-relative path of file to write
- `content` (string, required): Full file content
- `modified_by_user` (boolean, optional)
- `ai_proposed_content` (string, optional)

**Example:**
```typescript
await client.callTool('write_file', {
  file_path: '/path/to/workspace/src/new-file.ts',
  content: 'export const foo = "bar";'
});
```

### search_file_content
Fast regex search using ripgrep (falls back to JS search if unavailable).

**Parameters:**
- `pattern` (string, required): Search pattern (regex by default)
- `dir_path` (string, optional): Directory or file to search (absolute or workspace-relative)
- `include` (string, optional): Glob filter (e.g., `**/*.ts`)
- `case_sensitive` (boolean, optional): If true, search is case-sensitive (default false)
- `fixed_strings` (boolean, optional): If true, treat pattern as literal
- `context` (number, optional): Context lines around each match (-C)
- `after` (number, optional): Lines after each match (-A)
- `before` (number, optional): Lines before each match (-B)
- `no_ignore` (boolean, optional): If true, do not respect ignore files/default excludes

**Example:**
```typescript
await client.callTool('search_file_content', {
  pattern: 'function.*async',
  include: '**/*.ts'
});
```

### glob
Finds files matching a glob pattern.

**Parameters:**
- `pattern` (string, required): Glob pattern (e.g., `src/**/*.ts`)
- `dir_path` (string, optional): Absolute directory to search within
- `case_sensitive` (boolean, optional): Case-sensitive matching (default false)
- `respect_git_ignore` (boolean, optional): Respect .gitignore (default true)
- `respect_gemini_ignore` (boolean, optional): Reserved for Gemini compatibility

**Example:**
```typescript
await client.callTool('glob', {
  pattern: 'src/**/*.ts'
});
```

### replace
Replaces text within a file using exact literal matching.

**Parameters:**
- `file_path` (string, required)
- `instruction` (string, optional)
- `old_string` (string, required)
- `new_string` (string, required)
- `expected_replacements` (number, optional)
- `modified_by_user` (boolean, optional)
- `ai_proposed_content` (string, optional)

**Example:**
```typescript
await client.callTool('replace', {
  file_path: '/path/to/workspace/src/index.ts',
  old_string: 'const foo = 1;',
  new_string: 'const foo = 2;'
});
```

### read_many_files
Reads and concatenates content from multiple files.

**Parameters:**
- `include` (string[], required): Glob patterns or paths
- `exclude` (string[], optional)
- `recursive` (boolean, optional): Defaults to true
- `useDefaultExcludes` (boolean, optional): Defaults to true
- `file_filtering_options` (object, optional): `{ respect_git_ignore?: boolean, respect_gemini_ignore?: boolean }`

**Example:**
```typescript
await client.callTool('read_many_files', {
  include: ['src/**/*.ts']
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
    file_path: '/path/to/workspace/src/index.ts'
  }
});

console.log('Result:', result);
```

---

## Tool Stability

- **Tool names are stable** and will not change in minor versions
- **Parameter names are stable** - new optional parameters may be added
- **Descriptions are concise** - detailed parameter docs are in JSON Schema (via Zod `.describe()`)

---

## TypeScript Types

All tool input and output types are available in `src/types/tools.ts`:

```typescript
import type {
  ReadFileInput,
  ReadFileOutput,
  SearchFileContentInput,
  SearchFileContentOutput,
  // ... other types
} from 'code-tools-mcp/types/tools';
```
