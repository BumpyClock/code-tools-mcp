import fs from 'node:fs/promises';
import path from 'node:path';

export function getGlobalBinDir(): string {
  const appName = 'code-tools-mcp';
  const isWin = process.platform === 'win32';
  if (isWin) {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.USERPROFILE || process.cwd();
    return path.join(base, appName, 'bin');
  }
  const xdg = process.env.XDG_DATA_HOME || (process.env.HOME ? path.join(process.env.HOME, '.local', 'share') : process.cwd());
  return path.join(xdg, appName, 'bin');
}

export async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

