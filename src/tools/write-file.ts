import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { relativize, resolveWithinWorkspace } from '../utils/workspace.js';
import * as Diff from 'diff';

export const writeFileShape = {
  file_path: z.string().describe('Absolute path of file to write within workspace.'),
  content: z.string().describe('Proposed full file content.'),
  // Parity-inspired options
  apply: z.boolean().default(false).describe('If false (default), return a diff preview without writing.'),
  overwrite: z.boolean().default(true).describe('Allow overwriting existing files.'),
  modified_by_user: z.boolean().optional(),
  ai_proposed_content: z.string().optional(),
};
export const writeFileInput = z.object(writeFileShape);
export type WriteFileInput = z.infer<typeof writeFileInput>;

async function readIfExists(abs: string): Promise<{ exists: boolean; content: string }> {
  try {
    const buf = await fs.readFile(abs, 'utf8');
    return { exists: true, content: buf };
  } catch (e) {
    return { exists: false, content: '' };
  }
}

function unifiedDiff(filename: string, oldStr: string, newStr: string) {
  return Diff.createPatch(filename, oldStr, newStr, 'Current', 'Proposed');
}

export async function writeFileTool(input: WriteFileInput) {
  const { file_path, content, apply, overwrite } = input;
  if (!path.isAbsolute(file_path)) {
    return { content: [{ type: 'text' as const, text: `Path must be absolute: ${file_path}` }], structuredContent: { error: 'PATH_NOT_ABSOLUTE' } };
  }
  const abs = resolveWithinWorkspace(file_path);
  const { exists, content: current } = await readIfExists(abs);
  if (exists === true && overwrite === false) {
    return { content: [{ type: 'text' as const, text: `File exists and overwrite=false: ${abs}` }], structuredContent: { error: 'OVERWRITE_DISABLED' } };
  }

  const fileName = path.basename(abs);
  const diff = unifiedDiff(fileName, current, content);
  const rel = relativize(abs);

  if (!apply) {
    const previewText = `Diff preview for ${rel} (no changes written). To apply, call write_file with apply: true.\n\n${diff}`;
    return { content: [{ type: 'text' as const, text: previewText }], structuredContent: { path: abs, applied: false, diff } };
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  const resultText = `Wrote ${rel}.\n\n${diff}`;
  return { content: [{ type: 'text' as const, text: resultText }], structuredContent: { path: abs, applied: true, diff } };
}

