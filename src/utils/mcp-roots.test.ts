import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { applyMcpRoots, parseMcpRoots } from "./mcp-roots.js";
import { getWorkspaceRoots, setWorkspaceRoots } from "./workspace.js";

const ORIGINAL_ROOTS = Array.from(getWorkspaceRoots());

afterEach(() => {
	setWorkspaceRoots(ORIGINAL_ROOTS);
});

describe("mcp roots sync", () => {
	it("parses file:// URIs, dedupes, and reports non-file URIs", () => {
		const rootPath = path.resolve("src");
		const rootUri = pathToFileURL(rootPath).href;

		const parsed = parseMcpRoots([
			{ uri: rootUri },
			{ uri: rootUri },
			{ uri: "https://example.com/workspace" },
			{ uri: "not-a-uri" },
		]);

		assert.deepEqual(parsed.roots, [path.normalize(rootPath)]);
		assert.deepEqual(parsed.invalidUris, [
			"https://example.com/workspace",
			"not-a-uri",
		]);
	});

	it("applies parsed roots without clearing current roots on invalid input", () => {
		const baseline = Array.from(getWorkspaceRoots());
		const applied = applyMcpRoots([{ uri: "https://example.com/workspace" }]);
		assert.equal(applied.applied, false);
		assert.deepEqual(Array.from(getWorkspaceRoots()), baseline);
	});

	it("updates workspace roots when valid file roots are provided", () => {
		const first = path.resolve("src");
		const second = path.resolve(".");
		const result = applyMcpRoots([
			{ uri: pathToFileURL(first).href },
			{ uri: pathToFileURL(second).href },
		]);
		assert.equal(result.applied, true);
		assert.deepEqual(result.roots, [
			path.normalize(first),
			path.normalize(second),
		]);
		assert.deepEqual(Array.from(getWorkspaceRoots()), [
			path.normalize(first),
			path.normalize(second),
		]);
	});
});
