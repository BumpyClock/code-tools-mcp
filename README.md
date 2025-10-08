**Code Tools MCP Server**

- Local-only MCP server exposing core coding tools for LLMs via STDIO.
- Tools: `list_directory`, `read_file`, `write_file`, `search`.

**Install**

- `npm install`
- `npm run build`

**Run**

- `npm start`

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
- `read_file` caps file size at 2MB; `search` ignores common large folders.
