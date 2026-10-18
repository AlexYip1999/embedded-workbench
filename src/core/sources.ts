import * as fs from "fs";
import * as path from "path";

const PREFERRED_NAMES = ["main.cpp", "main.c", "main.ino", "app_main.c"];
const SOURCE_EXT = /\.(cpp|c|cc|ino)$/i;

function findRecursive(dir: string): string | undefined {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findRecursive(full);
      if (found) return found;
    } else if (SOURCE_EXT.test(entry.name)) {
      return full;
    }
  }
  return undefined;
}

/** Pick the project entry source: src/main.cpp etc., else the first source file. */
export function findProjectSource(projectDir: string): string | undefined {
  const srcDir = path.join(projectDir, "src");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  for (const name of PREFERRED_NAMES) {
    if (files.includes(name)) return path.join(srcDir, name);
  }
  const anySource = files.find(name => SOURCE_EXT.test(name));
  if (anySource) return path.join(srcDir, anySource);

  return findRecursive(srcDir);
}

function collectSources(dir: string, out: string[], depth: number): void {
  if (depth > 6) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(full, out, depth + 1);
    } else if (SOURCE_EXT.test(entry.name)) {
      out.push(full);
    }
  }
}

/** All source files under src/ (main.* first, then alphabetical). */
export function listProjectSources(projectDir: string): string[] {
  const out: string[] = [];
  collectSources(path.join(projectDir, "src"), out, 0);
  const rank = (file: string): number => {
    const index = PREFERRED_NAMES.indexOf(path.basename(file));
    return index === -1 ? PREFERRED_NAMES.length : index;
  };
  return out.sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.localeCompare(b);
  });
}
