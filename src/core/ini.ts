export interface IniEntry {
  key: string;
  values: string[];
}

export interface IniSection {
  name: string;
  entries: IniEntry[];
}

export interface IniDoc {
  sections: IniSection[];
}

const BOM = "\uFEFF";

/**
 * Minimal platformio.ini parser: sections, `key = value`, `;`/`#` comments and
 * indented continuation lines (used by `lib_deps`). Inline comments are kept as
 * part of the value on purpose (URLs may contain `#`).
 */
export function parseIni(text: string): IniDoc {
  const sections: IniSection[] = [];
  let current: IniSection | undefined;
  let lastKey: string | undefined;

  const lines = text.replace(BOM, "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) {
      lastKey = undefined;
      continue;
    }
    if (trimmed.startsWith(";") || trimmed.startsWith("#")) continue;

    const m = /^\[([^\]]+)\]$/.exec(trimmed);
    if (m) {
      current = { name: m[1].trim(), entries: [] };
      sections.push(current);
      lastKey = undefined;
      continue;
    }
    if (!current) continue;

    const indented = /^\s/.test(line);
    if (indented && lastKey) {
      const entry = current.entries.find(e => e.key === lastKey);
      if (entry) {
        entry.values.push(trimmed);
        continue;
      }
    }

    const eq = line.indexOf("=");
    if (eq < 0) {
      lastKey = undefined;
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    const value = line.slice(eq + 1).trim();
    current.entries.push({ key, values: [value] });
    lastKey = key;
  }

  return { sections };
}

export function section(doc: IniDoc, name: string): IniSection | undefined {
  const want = name.toLowerCase();
  return doc.sections.find(s => s.name.toLowerCase() === want);
}

export function values(doc: IniDoc, sectionName: string, key: string): string[] {
  const sec = section(doc, sectionName);
  if (!sec) return [];
  const want = key.toLowerCase();
  const out: string[] = [];
  for (const e of sec.entries) {
    if (e.key.toLowerCase() === want) out.push(...e.values);
  }
  return out;
}

/** Effective value: `[env:<name>]` first, then the shared `[env]` section. */
export function envValue(doc: IniDoc, envName: string, key: string): string[] {
  const own = values(doc, `env:${envName}`, key);
  return own.length ? own : values(doc, "env", key);
}
