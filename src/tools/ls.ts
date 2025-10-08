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
    })
    .optional(),
};
export const lsInput = z.object(lsShape);
export type LsInput = z.infer<typeof lsInput>;


// Output schema for structured content returned by this tool
export const lsOutputShape = {
  directory: z.string().optional(),
  entries: z.array(z.object({
    name: z.string(),
    path: z.string(),
    isDirectory: z.boolean(),
    size: z.number(),
    modifiedTime: z.string(),
  })),
  gitIgnoredCount: z.number().optional(),
  summary: z.string(),
  error: z.string().optional(),
};

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

  const respectGit = input.file_filtering_options?.respect_git_ignore ?? true;
  const ig = await buildIgnoreFilter({ respectGitIgnore: respectGit } satisfies FilteringOptions);

  const names = await fs.readdir(abs);
  let gitIgnoredCount = 0;
  const entries = [] as Array<{ name: string; path: string; isDirectory: boolean; size: number; modifiedTime: string }>;

  for (const name of names) {
    const full = path.join(abs, name);
    const relToRoot = path.relative(root, full);

    // ignore lib works with posixish paths; convert separators
    const relPosix = relToRoot.split(path.sep).join('/');
    if (ig.ignores(relPosix)) { gitIgnoredCount += 1; continue; }
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

  let text: string;
  if (entries.length === 0) {
    // Empty directory - clearer message
    text = `Directory listing for ${relativize(abs)}:\n(empty directory)`;
    const ignoredMsgs = [] as string[];
    if (gitIgnoredCount > 0) ignoredMsgs.push(`${gitIgnoredCount} ignored by rules`);
    if (ignoredMsgs.length) text += `\n\n(${ignoredMsgs.join(', ')})`;
  } else {
    const listing = entries.map((e) => `${e.isDirectory ? '[DIR] ' : ''}${e.name}`).join('\n');
    text = `Directory listing for ${relativize(abs)}:\n${listing}`;
    const ignoredMsgs = [] as string[];
    if (gitIgnoredCount > 0) ignoredMsgs.push(`${gitIgnoredCount} ignored by rules`);
    if (ignoredMsgs.length) text += `\n\n(${ignoredMsgs.join(', ')})`;
  }

  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { directory: abs, entries, gitIgnoredCount, summary: `Listed ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.` },
  };
}

