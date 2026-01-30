// ABOUTME: Gemini CLI-compatible tool result schema for structured outputs.

import { z } from "zod";

export const toolContentShape = z.object({
	type: z.enum(["text", "image", "resource"]),
	text: z.string().optional(),
	data: z.string().optional(),
	mimeType: z.string().optional(),
});

export const toolErrorShape = z.object({
	message: z.string(),
	type: z.string().optional(),
});

export const toolResultShape = {
	llmContent: z.union([z.string(), z.array(toolContentShape)]).optional(),
	returnDisplay: z.unknown().optional(),
	error: toolErrorShape.optional(),
};

export type ToolContent = z.infer<typeof toolContentShape>;
export type ToolError = z.infer<typeof toolErrorShape>;
export type ToolResult = z.infer<z.ZodObject<typeof toolResultShape>>;
