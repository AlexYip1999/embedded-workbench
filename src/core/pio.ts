import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface PioContext {
  workspaceRoot: string;
  /** Absolute path to pio(.exe), or bare "pio" when nothing was found. */
  pioExe: string;
  coreDir: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function locatePio(
  workspaceRoot: string,
  pioPathSetting = "",
  coreDirSetting = ".platformio"
): PioContext {
  const candidates: string[] = [];
  const configured = pioPathSetting.trim();
  if (configured) {
    candidates.push(path.isAbsolute(configured) ? configured : path.join(workspaceRoot, configured));
  }
  candidates.push(
    path.join(workspaceRoot, ".venv", isWindows() ? "Scripts" : "bin", isWindows() ? "pio.exe" : "pio")
  );
  const found = candidates.find(c => fs.existsSync(c));
  const coreDir = path.isAbsolute(coreDirSetting)
    ? coreDirSetting
    : path.join(workspaceRoot, coreDirSetting);
  return { workspaceRoot, pioExe: found ?? "pio", coreDir };
}

/** Environment inherited by every pio child process: project-local cache, utf-8 output. */
export function pioEnv(ctx: PioContext): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PLATFORMIO_CORE_DIR: ctx.coreDir,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

export function runPio(
  ctx: PioContext,
  args: string[],
  timeoutMs = 30000,
  cwd = ctx.workspaceRoot
): Promise<RunResult> {
  return new Promise(resolve => {
    execFile(
      ctx.pioExe,
      args,
      {
        cwd,
        env: pioEnv(ctx),
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          code = typeof e.code === "number" ? e.code : 1;
        }
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      }
    );
  });
}

export interface SerialPort {
  port: string;
  label: string;
}

export async function listSerialPorts(ctx: PioContext): Promise<SerialPort[]> {
  const res = await runPio(ctx, ["device", "list", "--json-output"], 20000);
  if (res.code !== 0) return [];
  try {
    const data = JSON.parse(res.stdout.trim() || "[]") as unknown;
    const arr: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { serial?: unknown[] })?.serial)
        ? (data as { serial: unknown[] }).serial
        : [];
    const out: SerialPort[] = [];
    for (const raw of arr) {
      const d = raw as Record<string, unknown>;
      const port = String(d.port ?? d.device ?? "");
      if (!port) continue;
      const desc = String(d.description ?? d.hwid ?? "");
      out.push({ port, label: desc ? `${port} — ${desc}` : port });
    }
    return out;
  } catch {
    return [];
  }
}
