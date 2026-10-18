import * as fs from "fs";
import * as path from "path";
import { parseIni, IniDoc, section, values as iniValues, envValue } from "./ini";

export interface EnvModel {
  name: string;
  board?: string;
  platform?: string;
  framework?: string;
  monitorSpeed?: string;
  uploadSpeed?: string;
  libDeps: string[];
}

export interface ProjectModel {
  name: string;
  dir: string;
  iniPath: string;
  defaultEnvs: string[];
  envs: EnvModel[];
}

/** Locate the unified repository root: has `projects/` and `requirements.txt`. */
export function findRepoRoot(startDirs: string[]): string | undefined {
  for (const start of startDirs) {
    let cur = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(cur, "projects"))) {
        return cur;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return undefined;
}

function first(v: string[]): string | undefined {
  const found = v.find(x => x.trim().length > 0);
  return found?.trim();
}

function parseLibDeps(raw: string[]): string[] {
  const out: string[] = [];
  for (const chunk of raw) {
    for (const line of chunk.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const isRemote = /^https?:/i.test(t) || /^(file|symlink|git\+?):/i.test(t);
      if (!isRemote && t.includes(",")) {
        out.push(...t.split(",").map(s => s.trim()).filter(Boolean));
      } else {
        out.push(t);
      }
    }
  }
  return out;
}

function buildEnv(doc: IniDoc, envName: string): EnvModel {
  return {
    name: envName,
    board: first(envValue(doc, envName, "board")),
    platform: first(envValue(doc, envName, "platform")),
    framework: first(envValue(doc, envName, "framework")),
    monitorSpeed: first(envValue(doc, envName, "monitor_speed")),
    uploadSpeed: first(envValue(doc, envName, "upload_speed")),
    libDeps: parseLibDeps(envValue(doc, envName, "lib_deps")),
  };
}

export function scanProjects(root: string): ProjectModel[] {
  const projectsDir = path.join(root, "projects");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ProjectModel[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;

    const dir = path.join(projectsDir, entry.name);
    const iniPath = path.join(dir, "platformio.ini");
    if (!fs.existsSync(iniPath)) continue;

    let doc: IniDoc;
    try {
      doc = parseIni(fs.readFileSync(iniPath, "utf8"));
    } catch {
      continue;
    }

    const envNames = doc.sections
      .filter(s => /^env:/i.test(s.name))
      .map(s => s.name.slice(4).trim())
      .filter(Boolean);
    const defaultEnvs = iniValues(doc, "platformio", "default_envs")
      .join(",")
      .split(/[,\s]+/)
      .map(s => s.trim())
      .filter(Boolean);

    let envs = envNames.map(n => buildEnv(doc, n));
    if (envs.length === 0 && section(doc, "env")) {
      envs = [buildEnv(doc, defaultEnvs[0] ?? "default")];
    }

    out.push({ name: entry.name, dir, iniPath, defaultEnvs, envs });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveEnv(project: ProjectModel, envName?: string): EnvModel | undefined {
  if (envName) {
    const found = project.envs.find(e => e.name === envName);
    if (found) return found;
  }
  const preferred = project.defaultEnvs[0];
  if (preferred) {
    const found = project.envs.find(e => e.name === preferred);
    if (found) return found;
  }
  return project.envs[0];
}
