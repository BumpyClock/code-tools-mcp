// ABOUTME: Re-exports tool schemas and inferred TypeScript types for clients.
// ABOUTME: Keeps input/output typings in sync with the server's Zod definitions.

import type { z } from "zod";

export type { EditInput } from "../tools/edit.js";
export { editInput, editOutputShape, editShape } from "../tools/edit.js";
export type { GlobInput } from "../tools/glob.js";
export { globInput, globOutputShape, globShape } from "../tools/glob.js";
export type { LsInput } from "../tools/ls.js";
export { lsInput, lsOutputShape, lsShape } from "../tools/ls.js";
export type { ReadFileInput } from "../tools/read-file.js";
export {
	readFileInput,
	readFileOutputShape,
	readFileShape,
} from "../tools/read-file.js";
export type { ReadManyFilesInput } from "../tools/read-many-files.js";
export {
	readManyFilesInput,
	readManyFilesOutputShape,
	readManyFilesShape,
} from "../tools/read-many-files.js";
export type { SearchFileContentInput } from "../tools/ripgrep.js";
export {
	searchFileContentInput,
	searchFileContentOutputShape,
	searchFileContentShape,
} from "../tools/ripgrep.js";
export type { WriteFileInput } from "../tools/write-file.js";
export {
	writeFileInput,
	writeFileOutputShape,
	writeFileShape,
} from "../tools/write-file.js";
export { ToolErrorType } from "./tool-error-type.js";
export type { ToolContent, ToolError, ToolResult } from "./tool-result.js";
export {
	toolContentShape,
	toolErrorShape,
	toolResultShape,
} from "./tool-result.js";

export type EditOutput = z.infer<
	z.ZodObject<typeof import("../tools/edit.js").editOutputShape>
>;
export type GlobOutput = z.infer<
	z.ZodObject<typeof import("../tools/glob.js").globOutputShape>
>;
export type LsOutput = z.infer<
	z.ZodObject<typeof import("../tools/ls.js").lsOutputShape>
>;
export type ReadFileOutput = z.infer<
	z.ZodObject<typeof import("../tools/read-file.js").readFileOutputShape>
>;
export type ReadManyFilesOutput = z.infer<
	z.ZodObject<
		typeof import("../tools/read-many-files.js").readManyFilesOutputShape
	>
>;
export type SearchFileContentOutput = z.infer<
	z.ZodObject<typeof import("../tools/ripgrep.js").searchFileContentOutputShape>
>;
export type WriteFileOutput = z.infer<
	z.ZodObject<typeof import("../tools/write-file.js").writeFileOutputShape>
>;
