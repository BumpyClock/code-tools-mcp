import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { getWorkspaceRoot, resolveWithinWorkspace } from '../utils/workspace.js';
import { grepTool, grepInput } from './grep.js';
import { getGlobalBinDir, ensureDir, fileExists } from '../utils/storage.js';
import { downloadRipGrep } from '@joshua.litt/get-ripgrep';

export const ripgrepShape = {
  pattern: z.string().describe('Regular expression to search for.'),
  path: z.string().optional().describe('Directory to search (relative or absolute).'),
  include: z.union([z.string(), z.array(z.string())]).optional().describe('Glob include pattern(s), e.g. **/*.{ts,tsx}'),
  exclude: z.union([z.string(), z.array(z.string())]).optional().describe('Glob exclude pattern(s), e.g. **/dist/**'),
  ignore_case: z.boolean().optional().describe('Case-insensitive search (default true).'),
};
export const ripgrepInput = z.object(ripgrepShape);
export type RipgrepInput = z.infer<typeof ripgrepInput>;

function haveRgOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('rg', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

function localRgPath(): string {
  const bin = getGlobalBinDir();
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  return path.join(bin, exe);
}

async function ensureLocalRg(): Promise<string | null> {
  const rgPath = localRgPath();
  if (await fileExists(rgPath)) return rgPath;
  const bin = getGlobalBinDir();
  await ensureDir(bin);
  try {
    await downloadRipGrep(bin);
  } catch {
    return null;
  }
  return (await fileExists(rgPath)) ? rgPath : null;
}

export async function ripgrepTool(input: RipgrepInput, signal?: AbortSignal) {
  const root = getWorkspaceRoot();
  const baseDir = input.path ? resolveWithinWorkspace(path.isAbsolute(input.path) ? input.path : path.join(root, input.path)) : root;

  let rgCmd: string | null = null;
  if (await haveRgOnPath()) {
    rgCmd = 'rg';
  } else {
    rgCmd = await ensureLocalRg();
  }
  if (!rgCmd) {
    // Fallback to JS grep implementation
    const includeStr = Array.isArray(input.include)
      ? `{${input.include.join(',')}}`
      : input.include;
    const excludeStr = Array.isArray(input.exclude)
      ? `{${input.exclude.join(',')}}`
      : input.exclude;
    return grepTool({ pattern: input.pattern, path: path.relative(root, baseDir) || '.', include: includeStr, exclude: excludeStr, regex: true, ignore_case: input.ignore_case !== false } as z.infer<typeof grepInput>, signal);
  }

  const args = ['--json', '--line-number'];
  if (input.ignore_case !== false) args.push('--ignore-case');
  // include globs
  const includes = input.include ? (Array.isArray(input.include) ? input.include : [input.include]) : [];
  for (const inc of includes) args.push('-g', inc);
  // exclude globs
  const excludes = input.exclude ? (Array.isArray(input.exclude) ? input.exclude : [input.exclude]) : [];
  for (const exc of excludes) args.push('-g', `!${exc}`);
  // ripgrep respects .gitignore by default; include hidden files but still honor ignore rules
  args.push('--hidden');
  args.push(input.pattern);
  args.push('.');

  const proc = spawn(rgCmd, args, { cwd: baseDir, stdio: ['ignore', 'pipe', 'pipe'] });
  const matches: Array<{ filePath: string; lineNumber: number; line: string }> = [];
  let stderrBuf = '';
  let aborted = false;
  const MAX = 20000;

  signal?.addEventListener('abort', () => {
    aborted = true;
    proc.kill();
  });

  await new Promise<void>((resolve) => {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'match') {
            const filePath = path.relative(root, path.resolve(baseDir, evt.data.path.text));
            const submatches = evt.data.submatches as Array<{ match: { text: string } }>;
            matches.push({ filePath, lineNumber: evt.data.line_number, line: evt.data.lines.text.trimEnd() });
            // We ignore submatch ranges for simplicity; line text is enough
            if (matches.length >= MAX) {
              proc.kill();
              break;
            }
          }
        } catch {}
      }
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
    });
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
  });

  if (aborted) {
    return { content: [{ type: 'text' as const, text: 'Search aborted.' }], structuredContent: { aborted: true } };
  }

  if (matches.length === 0) {
    const where = path.relative(root, baseDir) || '.';
  const filterDesc = includes.length ? ` (filter: ${includes.join(', ')})` : '';
  const excludeDesc = excludes.length ? ` (exclude: ${excludes.join(', ')})` : '';
  const msg = `No matches for "${input.pattern}" in ${where}${filterDesc}${excludeDesc}.`;
    return { content: [{ type: 'text' as const, text: msg }], structuredContent: { matches: [], stderr: stderrBuf || undefined, summary: 'No matches found.' } };
  }

  const byFile = new Map<string, Array<{ lineNumber: number; line: string }>>();
  for (const m of matches) {
    if (!byFile.has(m.filePath)) byFile.set(m.filePath, []);
    byFile.get(m.filePath)!.push({ lineNumber: m.lineNumber, line: m.line });
  }
  for (const arr of byFile.values()) arr.sort((a, b) => a.lineNumber - b.lineNumber);

  let text = `Found ${matches.length} matches for pattern "${input.pattern}"${input.include ? ` (filter: "${input.include}")` : ''}:\n---\n`;
  for (const [file, arr] of byFile) {
    text += `File: ${file}\n`;
    for (const r of arr) text += `L${r.lineNumber}: ${r.line}\n`;
    text += '---\n';
  }
  if (matches.length >= MAX) text += `(limited to ${MAX} matches)\n`;

  const summary = `Found ${matches.length} match${matches.length === 1 ? '' : 'es'}.`;
  return { content: [{ type: 'text' as const, text: text.trimEnd() }], structuredContent: { matches, stderr: stderrBuf || undefined, summary } };
}
