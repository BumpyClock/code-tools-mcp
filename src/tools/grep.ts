import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { buildIgnoreFilter } from '../utils/ignore.js';
import { getWorkspaceRoot, resolveWithinWorkspace } from '../utils/workspace.js';

export const grepShape = {
  pattern: z.string().describe('Pattern to search for (plain text).'),
  path: z.string().optional().describe('Optional directory path relative to workspace.'),
  include: z.string().optional().describe('Optional glob filter, e.g. **/*.{ts,tsx,js,jsx}'),
};
export const grepInput = z.object(grepShape);
export type GrepInput = z.infer<typeof grepInput>;

export async function grepTool(input: GrepInput, signal?: AbortSignal) {
  const root = getWorkspaceRoot();
  const baseDir = input.path ? resolveWithinWorkspace(path.resolve(root, input.path)) : root;
  const ig = await buildIgnoreFilter();
  const include = input.include ?? '**/*';
  const files = await fg(include, { cwd: baseDir, absolute: true, dot: true });
  const matches: Array<{ filePath: string; lineNumber: number; line: string }> = [];

  outer: for (const file of files) {
    if (signal?.aborted) break;
    const relToRoot = path.relative(root, file).split(path.sep).join('/');
    if (ig.ignores(relToRoot)) continue;
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) continue;
      if (st.size > 1024 * 1024) continue; // 1MB cap per file
      const text = await fs.readFile(file, 'utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(input.pattern)) {
          matches.push({ filePath: path.relative(root, file), lineNumber: i + 1, line: lines[i] });
          if (matches.length >= 2000) break outer;
        }
      }
    } catch {}
  }

  if (matches.length === 0) {
    return { content: [{ type: 'text' as const, text: `No matches for "${input.pattern}" in ${path.relative(root, baseDir) || '.'}` }], structuredContent: { matches: [] } };
  }
  const text = matches.map((m) => `${m.filePath}:${m.lineNumber}: ${m.line}`).join('\n');
  return { content: [{ type: 'text' as const, text }], structuredContent: { matches } };
}

