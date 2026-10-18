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
    candidates.push(
      path.isAbsolute(configured) ? configured : path.join(workspaceRoot, configured)
    );
  }
  candidates.push(
    path.join(
      workspaceRoot,
      ".venv",
      isWindows() ? "Scripts" : "bin",
      isWindows() ? "pio.exe" : "pio"
    )
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
