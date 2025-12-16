#!/usr/bin/env node
// ABOUTME: Hosts the MCP stdio server and registers workspace-safe code tools.
// ABOUTME: Wires Zod schemas to tool implementations with consistent structured outputs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import {
	type editInput,
	editOutputShape,
	editShape,
	editTool,
} from "./tools/edit.js";
import {
	type globInput,
	globOutputShape,
	globShape,
	globTool,
} from "./tools/glob.js";
import {
	type grepInput,
	grepOutputShape,
	grepShape,
	grepTool,
} from "./tools/grep.js";
import { type lsInput, lsOutputShape, lsShape, lsTool } from "./tools/ls.js";
import {
	type readFileInput,
	readFileOutputShape,
	readFileShape,
	readFileTool,
} from "./tools/read-file.js";
import {
	type readManyFilesInput,
	readManyFilesOutputShape,
	readManyFilesShape,
	readManyFilesTool,
} from "./tools/read-many-files.js";
import {
	type ripgrepInput,
	ripgrepOutputShape,
	ripgrepShape,
	ripgrepTool,
} from "./tools/ripgrep.js";
import {
	type writeFileInput,
	writeFileOutputShape,
	writeFileShape,
	writeFileTool,
} from "./tools/write-file.js";

function readPackageVersion(): string {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const pkgPath = path.resolve(here, "../package.json");
		const raw = fs.readFileSync(pkgPath, "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const server = new McpServer({
	name: "code-tools-mcp",
	version: readPackageVersion(),
});

server.registerTool(
	"list_directory",
	{
		title: "List Directory",
		description: "Non-recursive listing; dirs first; respects .gitignore.",
		inputSchema: lsShape,
		outputSchema: lsOutputShape,
	},
	async (input: z.infer<typeof lsInput>) => lsTool(input),
);

server.registerTool(
	"read_file",
	{
		title: "Read File",
		description: "Read a file; text/binary aware; optional pagination.",
		inputSchema: readFileShape,
		outputSchema: readFileOutputShape,
	},
	async (input: z.infer<typeof readFileInput>) => readFileTool(input),
);

server.registerTool(
	"write_file",
	{
		title: "Write File",
		description:
			"Create/overwrite file; preview with apply=false; workspace-safe.",
		inputSchema: writeFileShape,
		outputSchema: writeFileOutputShape,
	},
	async (input: z.infer<typeof writeFileInput>) => writeFileTool(input),
);

server.registerTool(
	"grep",
	{
		title: "Grep",
		description:
			"Text/regex search; smart-case default; skips binaries; respects .gitignore.",
		inputSchema: grepShape,
		outputSchema: grepOutputShape,
	},
	async (input: z.infer<typeof grepInput>, { signal }) =>
		grepTool(input, signal),
);

server.registerTool(
	"ripgrep",
	{
		title: "Ripgrep",
		description:
			"Fast regex search via ripgrep (JS fallback); include/exclude globs; 20k cap.",
		inputSchema: ripgrepShape,
		outputSchema: ripgrepOutputShape,
	},
	async (input: z.infer<typeof ripgrepInput>, { signal }) =>
		ripgrepTool(input, signal),
);

server.registerTool(
	"glob",
	{
		title: "Glob",
		description: "Match files by glob; newest-first; respects .gitignore.",
		inputSchema: globShape,
		outputSchema: globOutputShape,
	},
	async (input: z.infer<typeof globInput>) => globTool(input),
);

server.registerTool(
	"edit",
	{
		title: "Edit",
		description: "Targeted text replace; preview (apply=false).",
		inputSchema: editShape,
		outputSchema: editOutputShape,
	},
	async (input: z.infer<typeof editInput>) => editTool(input),
);

server.registerTool(
	"read_many_files",
	{
		title: "Read Many Files",
		description:
			"Read many files by glob; concatenated; skips binaries; 2MB cap.",
		inputSchema: readManyFilesShape,
		outputSchema: readManyFilesOutputShape,
	},
	async (input: z.infer<typeof readManyFilesInput>) => readManyFilesTool(input),
);

// Start with stdio transport for local-only use
const transport = new StdioServerTransport();
await server.connect(transport);

// Avoid logging to stdout to not break JSON-RPC; use stderr for any diagnostics
process.on("uncaughtException", (err) => {
	console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (err) => {
	console.error("[unhandledRejection]", err);
});
