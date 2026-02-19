import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { lsTool } from "./ls.js";
import { readFileTool } from "./read-file.js";
import { readManyFilesTool } from "./read-many-files.js";
import { searchFileContentTool } from "./ripgrep.js";
import { writeFileTool } from "./write-file.js";

const TEST_DIR = "tmp-tool-tests";
const CREATED_PATHS = new Set<string>();

function rememberPath(relativePath: string) {
	CREATED_PATHS.add(relativePath);
	return relativePath;
}

function textFromResult(result: {
	llmContent?: Array<{ type: string; text?: string }> | string;
}) {
	if (typeof result.llmContent === "string") return result.llmContent;
	if (!Array.isArray(result.llmContent)) return "";
	return result.llmContent
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

async function ensureTestDir() {
	await fs.mkdir(TEST_DIR, { recursive: true });
}

afterEach(async () => {
	for (const relativePath of CREATED_PATHS) {
		const absolute = path.resolve(relativePath);
		await fs.rm(absolute, { recursive: true, force: true });
	}
	CREATED_PATHS.clear();
});

describe("tool policy and paging regressions", () => {
	it("read_file reports accurate total lines for paged reads", async () => {
		await ensureTestDir();
		const filePath = rememberPath(path.join(TEST_DIR, "read-file-lines.txt"));
		const contents = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join(
			"\n",
		);
		await fs.writeFile(filePath, contents, "utf8");

		const result = await readFileTool({
			file_path: filePath,
			offset: 0,
			limit: 5,
		});
		const output = textFromResult(result);
		assert.match(output, /TRUNCATED 1-5\/12; next_offset=5/);
		assert.match(output, /line-1/);
		assert.match(output, /line-5/);
		assert.ok(!output.includes("line-6"));
	});

	it("blocks ignored paths consistently by default", async () => {
		await fs.mkdir(".cache", { recursive: true });
		const ignoredFile = ".cache/policy-gating.txt";
		rememberPath(ignoredFile);

		const write = await writeFileTool({
			file_path: ignoredFile,
			content: "needle = 1\n",
		});
		assert.equal(write.error?.type, "path_ignored_by_policy");

		const edit = await editTool({
			file_path: ignoredFile,
			old_string: "needle = 1",
			new_string: "needle = 2",
		});
		assert.equal(edit.error?.type, "path_ignored_by_policy");

		const read = await readFileTool({ file_path: ignoredFile });
		assert.equal(read.error?.type, "path_ignored_by_policy");

		const list = await lsTool({ dir_path: ".cache" });
		assert.equal(list.error?.type, "path_ignored_by_policy");

		const glob = await globTool({ pattern: "**/*.txt", dir_path: ".cache" });
		assert.equal(glob.error?.type, "path_ignored_by_policy");

		const search = await searchFileContentTool({
			pattern: "needle",
			dir_path: ".cache",
			fixed_strings: true,
		});
		assert.equal(search.error?.type, "path_ignored_by_policy");
	});

	it("supports explicit ignore override through file_filtering_options", async () => {
		await fs.mkdir(".cache", { recursive: true });
		const ignoredFile = ".cache/policy-override.txt";
		rememberPath(ignoredFile);

		const write = await writeFileTool({
			file_path: ignoredFile,
			file_filtering_options: { respect_git_ignore: false },
			content: "needle = 1\n",
		});
		assert.equal(write.error, undefined);

		const read = await readFileTool({
			file_path: ignoredFile,
			file_filtering_options: { respect_git_ignore: false },
		});
		assert.equal(read.error, undefined);
		assert.match(textFromResult(read), /needle = 1/);

		const search = await searchFileContentTool({
			pattern: "needle",
			dir_path: ignoredFile,
			fixed_strings: true,
			file_filtering_options: { respect_git_ignore: false },
		});
		assert.equal(search.error, undefined);
		assert.match(textFromResult(search), /policy-override\.txt:1:needle = 1/);
	});

	it("supports explicit ignore override through no_ignore", async () => {
		await fs.mkdir(".cache", { recursive: true });
		const ignoredFile = ".cache/policy-no-ignore.txt";
		rememberPath(ignoredFile);

		const write = await writeFileTool({
			file_path: ignoredFile,
			no_ignore: true,
			content: "needle = 1\n",
		});
		assert.equal(write.error, undefined);

		const read = await readFileTool({
			file_path: ignoredFile,
			no_ignore: true,
		});
		assert.equal(read.error, undefined);
		assert.match(textFromResult(read), /needle = 1/);
	});

	it("read_many_files honors max_files and trims legacy trailer", async () => {
		await ensureTestDir();
		const files = [
			path.join(TEST_DIR, "a.txt"),
			path.join(TEST_DIR, "b.txt"),
			path.join(TEST_DIR, "c.txt"),
		];
		for (const filePath of files) {
			rememberPath(filePath);
			await fs.writeFile(
				filePath,
				`content:${path.basename(filePath)}\n`,
				"utf8",
			);
		}

		const result = await readManyFilesTool({
			include: [`${TEST_DIR}/*.txt`],
			max_files: 2,
		});
		const output = textFromResult(result);
		assert.match(output, /TRUNCATED reason=max_files/);
		assert.ok(!output.includes("--- End of content ---"));
	});

	it("list_directory supports max_entries truncation", async () => {
		await ensureTestDir();
		const dir = rememberPath(path.join(TEST_DIR, "ls-max-entries"));
		await fs.mkdir(dir, { recursive: true });
		for (const name of ["one.txt", "two.txt", "three.txt"]) {
			await fs.writeFile(path.join(dir, name), `${name}\n`, "utf8");
		}

		const result = await lsTool({ dir_path: dir, max_entries: 2 });
		assert.equal(result.error, undefined);
		const output = textFromResult(result);
		assert.match(output, /truncated=1/);
	});

	it("allows root dir_path with ignore policy enabled", async () => {
		const list = await lsTool({ dir_path: "." });
		assert.equal(list.error, undefined);
		assert.match(textFromResult(list), /dir=/);

		const search = await searchFileContentTool({
			pattern: "search_file_content",
			dir_path: ".",
			include: "src/**/*.ts",
			fixed_strings: true,
		});
		assert.equal(search.error, undefined);
		assert.match(textFromResult(search), /matches=/);

		const glob = await globTool({ pattern: "src/**/*.ts", dir_path: "." });
		assert.equal(glob.error, undefined);
	});

	it("allows outside-workspace paths when CODE_TOOLS_MCP_ALLOW_ANY_PATHS is enabled", async () => {
		const prev = process.env.CODE_TOOLS_MCP_ALLOW_ANY_PATHS;
		const outsideFile = path.resolve("..", "code-tools-mcp-external-test.txt");
		rememberPath(outsideFile);
		try {
			process.env.CODE_TOOLS_MCP_ALLOW_ANY_PATHS = "1";
			await fs.writeFile(outsideFile, "external-content\n", "utf8");

			const read = await readFileTool({ file_path: outsideFile });
			assert.equal(read.error, undefined);
			assert.match(textFromResult(read), /external-content/);

			const write = await writeFileTool({
				file_path: outsideFile,
				content: "external-updated\n",
			});
			assert.equal(write.error, undefined);

			const search = await searchFileContentTool({
				pattern: "external-updated",
				dir_path: outsideFile,
				fixed_strings: true,
			});
			assert.equal(search.error, undefined);
			assert.match(textFromResult(search), /matches=1/);
		} finally {
			if (prev === undefined) delete process.env.CODE_TOOLS_MCP_ALLOW_ANY_PATHS;
			else process.env.CODE_TOOLS_MCP_ALLOW_ANY_PATHS = prev;
		}
	});
});
