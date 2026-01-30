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
	type searchFileContentInput,
	searchFileContentOutputShape,
	searchFileContentShape,
	searchFileContentTool,
} from "./tools/ripgrep.js";
import {
	type writeFileInput,
	writeFileOutputShape,
	writeFileShape,
	writeFileTool,
} from "./tools/write-file.js";
import type { ToolContent, ToolError } from "./types/tool-result.js";

type GeminiToolResult = {
	llmContent?: string | ToolContent[];
	returnDisplay?: unknown;
	error?: ToolError;
};

type McpContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| {
			type: "resource";
			resource: { uri: string; blob: string; mimeType?: string };
	  };

function toContent(llmContent?: string | ToolContent[]): McpContent[] {
	if (!llmContent) return [];
	if (typeof llmContent === "string") {
		return [{ type: "text", text: llmContent }];
	}
	return llmContent.map((part) => {
		if (part.type === "text") {
			return { type: "text", text: part.text ?? "" };
		}
		if (part.type === "image") {
			return {
				type: "image",
				data: part.data ?? "",
				mimeType: part.mimeType ?? "application/octet-stream",
			};
		}
		return {
			type: "resource",
			resource: {
				uri: "inline://resource",
				blob: part.data ?? "",
				mimeType: part.mimeType,
			},
		};
	});
}

function wrapResult(result: GeminiToolResult) {
	return {
		content: toContent(result.llmContent),
		structuredContent: result,
	};
}

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
		description: "Lists names of files/subdirectories in a directory.",
		inputSchema: lsShape,
		outputSchema: lsOutputShape,
	},
	async (input: z.infer<typeof lsInput>) => wrapResult(await lsTool(input)),
);

server.registerTool(
	"read_file",
	{
		title: "Read File",
		description: "Read a file; text/binary aware; optional pagination.",
		inputSchema: readFileShape,
		outputSchema: readFileOutputShape,
	},
	async (input: z.infer<typeof readFileInput>) =>
		wrapResult(await readFileTool(input)),
);

server.registerTool(
	"write_file",
	{
		title: "Write File",
		description: "Create or overwrite a file within the workspace.",
		inputSchema: writeFileShape,
		outputSchema: writeFileOutputShape,
	},
	async (input: z.infer<typeof writeFileInput>) =>
		wrapResult(await writeFileTool(input)),
);

server.registerTool(
	"search_file_content",
	{
		title: "Search File Content",
		description: "FAST regex search powered by ripgrep.",
		inputSchema: searchFileContentShape,
		outputSchema: searchFileContentOutputShape,
	},
	async (input: z.infer<typeof searchFileContentInput>, { signal }) =>
		wrapResult(await searchFileContentTool(input, signal)),
);

server.registerTool(
	"glob",
	{
		title: "Glob",
		description: "Finds files matching a glob pattern.",
		inputSchema: globShape,
		outputSchema: globOutputShape,
	},
	async (input: z.infer<typeof globInput>, { signal }) =>
		wrapResult(await globTool(input, signal)),
);

server.registerTool(
	"replace",
	{
		title: "Replace",
		description: "Replace text within a file.",
		inputSchema: editShape,
		outputSchema: editOutputShape,
	},
	async (input: z.infer<typeof editInput>) => wrapResult(await editTool(input)),
);

server.registerTool(
	"read_many_files",
	{
		title: "Read Many Files",
		description: "Read and concatenate content from multiple files.",
		inputSchema: readManyFilesShape,
		outputSchema: readManyFilesOutputShape,
	},
	async (input: z.infer<typeof readManyFilesInput>) =>
		wrapResult(await readManyFilesTool(input)),
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
