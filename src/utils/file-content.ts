// ABOUTME: Shared helpers/constants for binary content handling across tools.

import path from "node:path";
import mime from "mime-types";
import type { ToolContent } from "../types/tool-result.js";

export const MAX_BINARY_BYTES = 5 * 1024 * 1024;

export const IMAGE_EXTS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
	".bmp",
]);
export const AUDIO_EXTS = new Set([
	".mp3",
	".wav",
	".aiff",
	".aac",
	".ogg",
	".flac",
]);
export const PDF_EXTS = new Set([".pdf"]);

export function getMimeType(abs: string): string {
	const ext = path.extname(abs).toLowerCase();
	if (ext === ".ts" || ext === ".tsx") return "text/typescript";
	return (mime.lookup(abs) || "text/plain").toString();
}

export function isSupportedBinary(ext: string): boolean {
	return IMAGE_EXTS.has(ext) || AUDIO_EXTS.has(ext) || PDF_EXTS.has(ext);
}

export function mapBinaryPart(mimeType: string, data: string): ToolContent {
	if (mimeType.startsWith("image/")) {
		return { type: "image", data, mimeType };
	}
	return { type: "resource", data, mimeType };
}
