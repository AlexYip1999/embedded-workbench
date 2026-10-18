import * as fs from "fs";
import * as path from "path";

export type SizeGroup = "pio" | "python" | "build";

export interface SizeEntry {
  id: string;
  label: string;
  path: string;
  group: SizeGroup;
  exists: boolean;
  bytes: number;
  projectName?: string;
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        try {
          total += (await fs.promises.stat(p)).size;
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  return total;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export interface SizeProject {
  name: string;
  dir: string;
}

export async function collectSizeEntries(
  root: string,
  projects: SizeProject[]
): Promise<SizeEntry[]> {
  const entries: SizeEntry[] = [];
  const pioDir = path.join(root, ".platformio");

  if (fs.existsSync(pioDir)) {
    let kids: fs.Dirent[] = [];
    try {
      kids = await fs.promises.readdir(pioDir, { withFileTypes: true });
    } catch {
      kids = [];
    }
    for (const k of kids) {
      if (!k.isDirectory() || k.name.startsWith(".")) continue;
      const p = path.join(pioDir, k.name);
      entries.push({
        id: `pio:${k.name}`,
        label: k.name,
        path: p,
        group: "pio",
        exists: true,
        bytes: await dirSize(p),
      });
    }
  }
  if (entries.length === 0) {
    entries.push({
      id: "pio:missing",
      label: ".platformio（尚未生成）",
      path: pioDir,
      group: "pio",
      exists: false,
      bytes: 0,
    });
  }

  const venv = path.join(root, ".venv");
  const venvExists = fs.existsSync(venv);
  entries.push({
    id: "python:.venv",
    label: ".venv",
    path: venv,
    group: "python",
    exists: venvExists,
    bytes: venvExists ? await dirSize(venv) : 0,
  });

  for (const p of projects) {
    const build = path.join(p.dir, ".pio");
    const exists = fs.existsSync(build);
    entries.push({
      id: `build:${p.name}`,
      label: `${p.name}/.pio`,
      path: build,
      group: "build",
      exists,
      bytes: exists ? await dirSize(build) : 0,
      projectName: p.name,
    });
  }

  entries.sort((a, b) => b.bytes - a.bytes);
  return entries;
}
