import fs from 'node:fs/promises';
import path from 'node:path';
import * as Diff from 'diff';
import { z } from 'zod';
import { resolveWithinWorkspace } from '../utils/workspace.js';

export const editShape = {
  file_path: z.string().describe('Absolute path to file within workspace.'),
  old_string: z.string().describe('Text to replace. Use empty string to create a new file.'),
  new_string: z.string().describe('Replacement text.'),
  expected_replacements: z.number().int().min(1).optional().describe('Expected number of replacements (default 1).'),
  apply: z.boolean().default(false).describe('If false (default), return diff preview without writing.'),
  modified_by_user: z.boolean().optional(),
  ai_proposed_content: z.string().optional(),
};
export const editInput = z.object(editShape);
export type EditInput = z.infer<typeof editInput>;

// Output schema for structured content returned by this tool
export const editOutputShape = {
  path: z.string().optional(),
  applied: z.boolean(),
  diff: z.string(),
  occurrences: z.number(),
  summary: z.string(),
  error: z.string().optional(),
};


function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

export async function editTool(input: EditInput) {
  const { file_path, old_string, new_string, expected_replacements, apply } = input;
  if (!path.isAbsolute(file_path)) {
    return { content: [{ type: 'text' as const, text: `Path must be absolute: ${file_path}` }], structuredContent: { error: 'PATH_NOT_ABSOLUTE' } };
  }
  
  // Check for no-change edits early
  if (old_string === new_string) {
    return { 
      content: [{ type: 'text' as const, text: `No changes to apply: old_string and new_string are identical.` }], 
      structuredContent: { error: 'EDIT_NO_CHANGE', message: 'old_string and new_string are identical' } 
    };
  }
  
  const abs = resolveWithinWorkspace(file_path);
  let current: string | null = null;
  let exists = false;
  try {
    current = await fs.readFile(abs, 'utf8');
    // normalize line endings like the reference
    current = current.replace(/\r\n/g, '\n');
    exists = true;
  } catch {}

  if (!exists && old_string !== '') {
    return { content: [{ type: 'text' as const, text: `File not found. Cannot apply edit unless old_string is empty to create a new file.` }], structuredContent: { error: 'FILE_NOT_FOUND' } };
  }
  
  // Better error for existing file with empty old_string
  if (exists && old_string === '') {
    return { 
      content: [{ type: 'text' as const, text: `File already exists. Cannot use empty old_string on existing file. Use old_string to specify text to replace.` }], 
      structuredContent: { error: 'EDIT_FILE_EXISTS', message: 'Cannot use empty old_string on existing file' } 
    };
  }

  const isNewFile = !exists && old_string === '';
  const source = current ?? '';
  const occ = isNewFile ? 0 : countOccurrences(source, old_string);
  const expected = expected_replacements ?? 1;

  if (!isNewFile) {
    if (occ === 0) {
      return { content: [{ type: 'text' as const, text: `Failed to edit: 0 occurrences found for old_string.` }], structuredContent: { error: 'EDIT_NO_OCCURRENCE_FOUND' } };
    }
    if (occ !== expected) {
      return { content: [{ type: 'text' as const, text: `Failed to edit: expected ${expected} occurrences but found ${occ}.` }], structuredContent: { error: 'EDIT_EXPECTED_OCCURRENCE_MISMATCH' } };
    }
  }

  const newContent = isNewFile ? new_string : source.split(old_string).join(new_string);
  
  // Check if content actually changed
  if (!isNewFile && newContent === source) {
    return { 
      content: [{ type: 'text' as const, text: `No changes resulted from the edit operation.` }], 
      structuredContent: { error: 'EDIT_NO_CHANGE', message: 'Content unchanged after replacements' } 
    };
  }
  
  const fileName = path.basename(abs);
  const diff = Diff.createPatch(fileName, source, newContent, 'Current', 'Proposed');
  
  // Add summary to structured content
  const summary = isNewFile 
    ? 'Creating new file' 
    : `Replacing ${occ} occurrence${occ > 1 ? 's' : ''} in file`;

  if (!apply) {
    const preview = `Edit preview for ${abs} (not applied). To apply, call edit with apply: true.\n\n${diff}`;
    return { 
      content: [{ type: 'text' as const, text: preview }], 
      structuredContent: { 
        path: abs, 
        applied: false, 
        diff, 
        occurrences: isNewFile ? 0 : occ,
        summary: `${summary} (preview)`
      } 
    };
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, newContent, 'utf8');
  const result = `Applied edit to ${abs}.\n\n${diff}`;
  return { 
    content: [{ type: 'text' as const, text: result }], 
    structuredContent: { 
      path: abs, 
      applied: true, 
      diff, 
      occurrences: isNewFile ? 0 : occ,
      summary: `${summary} (applied)`
    } 
  };
}


