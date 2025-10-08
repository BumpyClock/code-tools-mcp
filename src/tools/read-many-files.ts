import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { isText } from 'istextorbinary';
import { z } from 'zod';
import { buildIgnoreFilter } from '../utils/ignore.js';
import { getWorkspaceRoot, resolveWithinWorkspace } from '../utils/workspace.js';

export const readManyFilesShape = {
  paths: z.array(z.string()).describe('Array of file or directory globs relative to workspace.'),
  include: z.array(z.string()).optional().describe('Additional glob patterns to include.'),
  exclude: z.array(z.string()).optional().describe('Glob patterns to exclude.'),
  useDefaultExcludes: z.boolean().optional().describe('Apply default excludes (node_modules, dist, .git, etc.). Default true.'),
  file_filtering_options: z
    .object({ respect_git_ignore: z.boolean().optional() })
    .optional(),
};
export const readManyFilesInput = z.object(readManyFilesShape);
export type ReadManyFilesInput = z.infer<typeof readManyFilesInput>;

const DEFAULT_EXCLUDES = ['**/{node_modules,.git,dist,build,out}/**'];
const SEP_FORMAT = '--- {filePath} ---';
const TERMINATOR = '\n--- End of content ---';
const TOTAL_BYTE_CAP = 2 * 1024 * 1024; // 2MB total output cap

export async function readManyFilesTool(input: ReadManyFilesInput) {
  const root = getWorkspaceRoot();
  const searchPatterns = [...input.paths, ...(input.include ?? [])];
  const excludes = [
    ...(input.useDefaultExcludes === false ? [] : DEFAULT_EXCLUDES),
    ...(input.exclude ?? []),
  ];
  const ig = await buildIgnoreFilter({ respectGitIgnore: input.file_filtering_options?.respect_git_ignore ?? true });

  const files = new Set<string>();
  for (const pattern of searchPatterns) {
    const absMatches = await fg(pattern, { cwd: root, absolute: true, dot: true, ignore: excludes });
    for (const p of absMatches) files.add(p);
  }
  const filesArr = Array.from(files);
  if (filesArr.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No files matched.' }], structuredContent: { files: [] } };
  }

  let totalBytes = 0;
  let output = '';
  const included: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const abs of filesArr) {
    const relPosix = path.relative(root, abs).split(path.sep).join('/');
    if (ig.ignores(relPosix)) { skipped.push({ path: abs, reason: 'ignored' }); continue; }
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) { skipped.push({ path: abs, reason: 'not a file' }); continue; }
      // small cap per file to avoid huge binaries
      if (st.size > 1024 * 1024) { skipped.push({ path: abs, reason: 'too large' }); continue; }
      const buf = await fs.readFile(abs);
      if (!isText(null, buf)) { skipped.push({ path: abs, reason: 'binary' }); continue; }
      const sep = SEP_FORMAT.replace('{filePath}', path.relative(root, abs));
      const text = buf.toString('utf8');
      const chunk = `${sep}\n${text}\n`;
      const projected = totalBytes + Buffer.byteLength(chunk, 'utf8');
      if (projected > TOTAL_BYTE_CAP) { skipped.push({ path: abs, reason: 'total cap reached' }); break; }
      output += chunk;
      totalBytes = projected;
      included.push(abs);
    } catch (e) {
      skipped.push({ path: abs, reason: 'read error' });
    }
  }

  output += TERMINATOR;
  return { content: [{ type: 'text' as const, text: output }], structuredContent: { files: included, skipped, totalBytes, summary: `Read ${included.length} file(s).` } };
}
