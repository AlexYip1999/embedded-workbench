import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface BootstrapResult {
  ok: boolean;
  message: string;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

export function venvPaths(root: string): { venv: string; python: string; pio: string } {
  const venv = path.join(root, ".venv");
  return {
    venv,
    python: path.join(venv, isWindows() ? "Scripts" : "bin", isWindows() ? "python.exe" : "python"),
    pio: path.join(venv, isWindows() ? "Scripts" : "bin", isWindows() ? "pio.exe" : "pio"),
  };
}

function run(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(
      cmd,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          code = typeof e.code === "number" ? e.code : 1;
        }
        resolve({ code, out: `${stdout ?? ""}\n${stderr ?? ""}`.trim() });
      }
    );
  });
}

function tail(text: string, lines = 20): string {
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

async function findSystemPython(): Promise<{ cmd: string; args: string[] } | undefined> {
  const candidates: Array<{ cmd: string; args: string[] }> = isWindows()
    ? [
        { cmd: "python", args: [] },
        { cmd: "py", args: ["-3"] },
      ]
    : [
        { cmd: "python3", args: [] },
        { cmd: "python", args: [] },
      ];

  for (const candidate of candidates) {
    const result = await run(candidate.cmd, [...candidate.args, "--version"], 15000);
    if (result.code === 0 && /Python 3\.(9|1[0-9])/.test(result.out)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Make the workspace self-contained: create `<root>/.venv` (if missing) and
 * install the pinned PlatformIO Core. Everything stays inside the workspace.
 */
export async function ensureEnvironment(
  root: string,
  platformioVersion: string,
  log: (line: string) => void
): Promise<BootstrapResult> {
  const { venv, python, pio } = venvPaths(root);
  if (fs.existsSync(pio)) {
    return { ok: true, message: `PlatformIO 已就绪：${pio}` };
  }

  if (!fs.existsSync(python)) {
    const systemPython = await findSystemPython();
    if (!systemPython) {
      return { ok: false, message: "未找到 Python 3.9+，请先安装 Python 并加入 PATH。" };
    }
    log(`[bootstrap] 创建虚拟环境：${venv}`);
    const created = await run(systemPython.cmd, [...systemPython.args, "-m", "venv", venv], 180000);
    if (created.code !== 0 || !fs.existsSync(python)) {
      return { ok: false, message: `创建虚拟环境失败：\n${tail(created.out)}` };
    }
    log(tail(created.out));
  }

  log(`[bootstrap] 安装 platformio==${platformioVersion} …`);
  const installed = await run(
    python,
    ["-m", "pip", "install", "--disable-pip-version-check", `platformio==${platformioVersion}`],
    600000
  );
  log(tail(installed.out, 40));
  if (installed.code !== 0) {
    return { ok: false, message: `pip install 失败：\n${tail(installed.out)}` };
  }
  if (!fs.existsSync(pio)) {
    return { ok: false, message: "安装完成但未找到 pio 可执行文件。" };
  }

  await run(pio, ["settings", "set", "enable_telemetry", "no"], 30000);
  return { ok: true, message: `已安装 PlatformIO ${platformioVersion}` };
}
