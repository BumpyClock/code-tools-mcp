import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { isText } from 'istextorbinary';
import { buildIgnoreFilter } from '../utils/ignore.js';
import { getWorkspaceRoot, resolveWithinWorkspace } from '../utils/workspace.js';

export const grepShape = {
  pattern: z.string().describe('Pattern to search for (plain text).'),
  path: z.string().optional().describe('Optional directory path relative to workspace.'),
  include: z.string().optional().describe('Optional glob filter, e.g. **/*.{ts,tsx,js,jsx}'),
  exclude: z.string().optional().describe('Optional glob to exclude, e.g. **/dist/**'),
  regex: z.boolean().optional().describe('Treat pattern as a regular expression (default false).'),
  ignore_case: z.boolean().optional().describe('Case-insensitive search (default true).'),
};
export const grepInput = z.object(grepShape);
export type GrepInput = z.infer<typeof grepInput>;

export async function grepTool(input: GrepInput, signal?: AbortSignal) {
  const root = getWorkspaceRoot();
  const baseDir = input.path ? resolveWithinWorkspace(path.resolve(root, input.path)) : root;
  const ig = await buildIgnoreFilter();
  const include = input.include ?? '**/*';
  const files = await fg(include, { cwd: baseDir, absolute: true, dot: true, ignore: input.exclude ? [input.exclude] : undefined });
  const matches: Array<{ filePath: string; lineNumber: number; line: string }> = [];

  const ignoreCase = input.ignore_case !== false;
  let rx: RegExp | null = null;
  if (input.regex) {
    try {
      rx = new RegExp(input.pattern, ignoreCase ? 'i' : undefined);
    } catch (e: any) {
      const msg = `Invalid regular expression: ${e?.message || 'unknown error'}`;
      return { content: [{ type: 'text' as const, text: msg }], structuredContent: { error: 'INVALID_REGEX', message: msg } };
    }
  }

  outer: for (const file of files) {
    if (signal?.aborted) break;
    const relToRoot = path.relative(root, file).split(path.sep).join('/');
    if (ig.ignores(relToRoot)) continue;
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) continue;
      if (st.size > 1024 * 1024) continue; // 1MB cap per file
      const buf = await fs.readFile(file);
      if (!isText(null, buf)) continue; // skip binaries
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      if (rx) {
        for (let i = 0; i < lines.length; i++) {
          if (rx.test(lines[i])) {
            matches.push({ filePath: path.relative(root, file), lineNumber: i + 1, line: lines[i] });
            if (matches.length >= 2000) break outer;
          }
        }
      } else {
        const needle = ignoreCase ? input.pattern.toLowerCase() : input.pattern;
        for (let i = 0; i < lines.length; i++) {
          const hay = ignoreCase ? lines[i].toLowerCase() : lines[i];
          if (hay.includes(needle)) {
            matches.push({ filePath: path.relative(root, file), lineNumber: i + 1, line: lines[i] });
            if (matches.length >= 2000) break outer;
          }
        }
      }
    } catch {}
  }

  if (matches.length === 0) {
    const where = path.relative(root, baseDir) || '.';
    const filter = input.include ? ` (filter: "${input.include}")` : '';
    return { content: [{ type: 'text' as const, text: `No matches for "${input.pattern}" in ${where}${filter}.` }], structuredContent: { matches: [], summary: 'No matches found.' } };
  }
  const textOut = matches.map((m) => `${m.filePath}:${m.lineNumber}: ${m.line}`).join('\n');
  const summary = `Found ${matches.length} match${matches.length === 1 ? '' : 'es'}.`;
  return { content: [{ type: 'text' as const, text: textOut }], structuredContent: { matches, summary } };
}
