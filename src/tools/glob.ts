import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { buildIgnoreFilter } from '../utils/ignore.js';
import { getWorkspaceRoot, resolveWithinWorkspace } from '../utils/workspace.js';

export const globShape = {
  pattern: z.string().describe('Glob pattern, e.g. **/*.ts'),
  path: z.string().optional().describe('Directory to search within; if omitted, search workspace root.'),
  case_sensitive: z.boolean().optional().describe('Match case sensitively (default false).'),
  respect_git_ignore: z.boolean().optional().describe('Respect .gitignore (default true).'),
};
export const globInput = z.object(globShape);
export type GlobInput = z.infer<typeof globInput>;

export async function globTool(input: GlobInput) {
  const root = getWorkspaceRoot();
  const baseDir = input.path ? resolveWithinWorkspace(path.isAbsolute(input.path) ? input.path : path.join(root, input.path)) : root;
  const ig = await buildIgnoreFilter({ respectGitIgnore: input.respect_git_ignore ?? true });

  const entries = await fg(input.pattern, {
    cwd: baseDir,
    dot: true,
    caseSensitiveMatch: input.case_sensitive ?? false,
    onlyFiles: true,
    absolute: true,
    followSymbolicLinks: false,
    stats: true,
  });

  // Filter by ignore rules relative to workspace root
  const filtered = [] as Array<{ full: string; mtimeMs: number }>;
  for (const e of entries) {
    const full = typeof e === 'string' ? e : (e as any).path;
    const stat = typeof e === 'string' ? await fs.stat(full).catch(() => null) : (e as any).stats;
    if (!stat) continue;
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (ig.ignores(rel)) continue;
    filtered.push({ full, mtimeMs: stat.mtimeMs });
  }

  if (filtered.length === 0) {
    return { content: [{ type: 'text' as const, text: `No files found matching "${input.pattern}" in ${path.relative(root, baseDir) || '.'}` }], structuredContent: { files: [], summary: 'No files found.' } };
  }

  // Sort newest-first by modification time for parity with reference behavior
  filtered.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const files = filtered.map((f) => f.full);
  const text = files.join('\n');
  return { content: [{ type: 'text' as const, text }], structuredContent: { files, summary: `Found ${files.length} matching file(s).` } };
}
