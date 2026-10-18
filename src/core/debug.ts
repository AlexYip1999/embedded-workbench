import * as fs from "fs";
import * as path from "path";

export interface DebugConfigInput {
  name: string;
  projectDir: string;
  firmwareElf: string;
  gdbPath: string;
  serverAddress?: string;
}

/** Only platforms with a PlatformIO debug tool can be attached to a debugger. */
export function platformSupportsDebug(platformSpec?: string): boolean {
  const spec = (platformSpec ?? "").toLowerCase();
  return spec.includes("espressif32");
}

/** Locate a gdb executable inside the project-local PlatformIO toolchains. */
export function findGdbPath(coreDir: string): string | undefined {
  const packagesDir = path.join(coreDir, "packages");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^toolchain-/i.test(entry.name)) continue;
    const binDir = path.join(packagesDir, entry.name, "bin");
    let files: string[] = [];
    try {
      files = fs.readdirSync(binDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (/gdb(\.exe)?$/i.test(file)) {
        candidates.push(path.join(binDir, file));
      }
    }
  }
  return candidates.sort()[0];
}

export function buildCppdbgConfig(input: DebugConfigInput): Record<string, unknown> {
  return {
    name: input.name,
    type: "cppdbg",
    request: "launch",
    cwd: input.projectDir,
    program: input.firmwareElf,
    MIMode: "gdb",
    miDebuggerPath: input.gdbPath,
    miDebuggerServerAddress: input.serverAddress ?? "localhost:3333",
    externalConsole: false,
    setupCommands: [
      {
        description: "Enable pretty-printing",
        text: "-enable-pretty-printing",
        ignoreFailures: true,
      },
    ],
  };
}

export interface LaunchMergeResult {
  path: string;
  updated: boolean;
  skipped?: string;
}

/** Create/update `.vscode/launch.json` with the generated cppdbg configuration. */
export async function upsertLaunchConfiguration(
  workspaceRoot: string,
  config: Record<string, unknown>
): Promise<LaunchMergeResult> {
  const dir = path.join(workspaceRoot, ".vscode");
  const file = path.join(dir, "launch.json");
  await fs.promises.mkdir(dir, { recursive: true });

  let doc: { version?: string; configurations?: unknown[] } = {
    version: "0.2.0",
    configurations: [],
  };
  const existed = fs.existsSync(file);
  if (existed) {
    const text = await fs.promises.readFile(file, "utf8");
    try {
      doc = JSON.parse(text) as typeof doc;
    } catch {
      return { path: file, updated: false, skipped: "launch.json 不是纯 JSON，未自动修改" };
    }
    if (!Array.isArray(doc.configurations)) doc.configurations = [];
  }

  const configurations = doc.configurations as Array<Record<string, unknown>>;
  const name = String(config.name ?? "");
  const index = configurations.findIndex(item => item && item.name === name);
  if (index >= 0) {
    configurations[index] = config;
  } else {
    configurations.push(config);
  }

  await fs.promises.writeFile(file, `${JSON.stringify(doc, null, 4)}\n`, "utf8");
  return { path: file, updated: true };
}
