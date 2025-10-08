import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildIgnoreFilter, matchCustomIgnore, type FilteringOptions } from '../utils/ignore.js';
import { getWorkspaceRoot, resolveWithinWorkspace, relativize } from '../utils/workspace.js';

export const lsShape = {
  path: z.string().describe('Absolute path to directory (must be within workspace).'),
  ignore: z.array(z.string()).optional().describe('Optional glob patterns to ignore (name matching).'),
  file_filtering_options: z
    .object({
      respect_git_ignore: z.boolean().optional(),
      respect_gemini_ignore: z.boolean().optional(),
    })
    .optional(),
};
export const lsInput = z.object(lsShape);
export type LsInput = z.infer<typeof lsInput>;

export async function lsTool(input: LsInput) {
  const root = getWorkspaceRoot();
  if (!path.isAbsolute(input.path)) {
    return {
      content: [{ type: 'text' as const, text: `Error: Path must be absolute: ${input.path}` }],
      structuredContent: { error: 'PATH_NOT_ABSOLUTE' },
    };
  }
  const abs = resolveWithinWorkspace(input.path);
  const st = await fs.stat(abs).catch(() => null);
  if (!st) {
    return {
      content: [{ type: 'text' as const, text: `Error: Directory not found or inaccessible: ${abs}` }],
      structuredContent: { error: 'FILE_NOT_FOUND' },
    };
  }
  if (!st.isDirectory()) {
    return {
      content: [{ type: 'text' as const, text: `Error: Path is not a directory: ${abs}` }],
      structuredContent: { error: 'PATH_IS_NOT_A_DIRECTORY' },
    };
  }

  const ig = await buildIgnoreFilter({
    respectGitIgnore: input.file_filtering_options?.respect_git_ignore ?? true,
    respectGeminiIgnore: input.file_filtering_options?.respect_gemini_ignore ?? true,
  } satisfies FilteringOptions);

  const names = await fs.readdir(abs);
  let gitIgnoredCount = 0;
  let geminiIgnoredCount = 0; // indistinguishable here; we lump into ignore totals from ig
  const entries = [] as Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedTime: string }>;

  for (const name of names) {
    const full = path.join(abs, name);
    const relToRoot = path.relative(root, full);

    // ignore lib works with posixish paths; convert separators
    const relPosix = relToRoot.split(path.sep).join('/');
    if (ig.ignores(relPosix)) {
      gitIgnoredCount += 1;
      continue;
    }
    if (matchCustomIgnore(name, input.ignore)) continue;
    try {
      const s = await fs.stat(full);
      entries.push({
        name,
        path: full,
        isDirectory: s.isDirectory(),
        size: s.isDirectory() ? 0 : s.size,
        modifiedTime: s.mtime.toISOString(),
      });
    } catch {}
  }

  entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  const listing = entries.map((e) => `${e.isDirectory ? '[DIR] ' : ''}${e.name}`).join('\n');
  let text = `Directory listing for ${relativize(abs)}:\n${listing}`;
  const ignoredMsgs = [] as string[];
  if (gitIgnoredCount > 0) ignoredMsgs.push(`${gitIgnoredCount} ignored by rules`);
  if (geminiIgnoredCount > 0) ignoredMsgs.push(`${geminiIgnoredCount} gemini-ignored`);
  if (ignoredMsgs.length) text += `\n\n(${ignoredMsgs.join(', ')})`;

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { directory: abs, entries, gitIgnoredCount, geminiIgnoredCount },
  };
}
