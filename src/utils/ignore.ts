import fs from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { getWorkspaceRoot } from './workspace.js';

export interface FilteringOptions {
  respectGitIgnore?: boolean;
  respectGeminiIgnore?: boolean;
}

export async function buildIgnoreFilter(options?: FilteringOptions): Promise<Ignore> {
  const ig = ignore();
  const root = getWorkspaceRoot();

  if (options?.respectGitIgnore !== false) {
    try {
      const gi = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
      ig.add(gi.split(/\r?\n/));
    } catch {}
  }

  if (options?.respectGeminiIgnore !== false) {
    try {
      const gmi = await fs.readFile(path.join(root, '.geminiignore'), 'utf8');
      ig.add(gmi.split(/\r?\n/));
    } catch {}
  }

  return ig;
}

export function matchCustomIgnore(name: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  // simple glob to regex
  for (const p of patterns) {
    const rx = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    if (rx.test(name)) return true;
  }
  return false;
}
