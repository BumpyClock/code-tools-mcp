// ABOUTME: Gemini CLI-compatible tool result schema for structured outputs.

import { z } from "zod";
import { ToolErrorType } from "./tool-error-type.js";

export const toolContentShape = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("text"),
		text: z.string(),
	}),
	z.object({
		type: z.literal("image"),
		data: z.string(),
		mimeType: z.string(),
	}),
	z.object({
		type: z.literal("resource"),
		data: z.string(),
		mimeType: z.string().optional(),
		uri: z.string().optional(),
	}),
]);

export const toolErrorShape = z.object({
	message: z.string(),
	type: z.nativeEnum(ToolErrorType).optional(),
});

export const toolResultShape = {
	llmContent: z.union([z.string(), z.array(toolContentShape)]).optional(),
	returnDisplay: z.unknown().optional(),
	error: toolErrorShape.optional(),
};

export type ToolContent = z.infer<typeof toolContentShape>;
export type ToolError = z.infer<typeof toolErrorShape>;
export type ToolResult = z.infer<z.ZodObject<typeof toolResultShape>>;
