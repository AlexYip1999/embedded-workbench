import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PioContext, runPio } from "./pio";

export interface ChipInfo {
  /** e.g. "ESP8266EX", "ESP32-D0WD-V3 (revision v3.1)" */
  chip?: string;
  /** e.g. "ESP8266", "ESP32", "ESP32-C3" */
  chipType?: string;
  chipId?: string;
  flashSize?: string;
  mac?: string;
  raw: string;
}

export interface EsptoolLocation {
  python: string;
  args: string[];
  cwd: string;
  packageDir: string;
}

export interface ChipDetectResult {
  info?: ChipInfo;
  error?: string;
}

function pythonFor(ctx: PioContext): string {
  const dir = path.dirname(ctx.pioExe);
  const candidate =
    process.platform === "win32" ? path.join(dir, "python.exe") : path.join(dir, "python");
  if (fs.existsSync(candidate)) return candidate;
  return process.platform === "win32" ? "python" : "python3";
}

/** Locate the esptool script shipped by PlatformIO (tool-esptoolpy / tool-esptool). */
export function findEsptool(ctx: PioContext): EsptoolLocation | undefined {
  const packagesDir = path.join(ctx.coreDir, "packages");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const candidates = entries
    .filter(entry => entry.isDirectory() && /^tool-esptool/i.test(entry.name))
    .map(entry => path.join(packagesDir, entry.name));
  candidates.sort((a, b) => {
    const aPy = a.toLowerCase().includes("esptoolpy") ? 0 : 1;
    const bPy = b.toLowerCase().includes("esptoolpy") ? 0 : 1;
    return aPy - bPy;
  });

  const python = pythonFor(ctx);
  for (const packageDir of candidates) {
    const script = path.join(packageDir, "esptool.py");
    if (fs.existsSync(script)) {
      return { python, args: [script], cwd: packageDir, packageDir };
    }
    const moduleInit = path.join(packageDir, "esptool", "__init__.py");
    if (fs.existsSync(moduleInit)) {
      return { python, args: ["-m", "esptool"], cwd: packageDir, packageDir };
    }
  }
  return undefined;
}

export function parseEsptoolOutput(output: string): ChipInfo {
  const info: ChipInfo = { raw: output };

  const type = /Detecting chip type\.\.\.\s*([^\r\n]+)/i.exec(output);
  if (type) info.chipType = type[1].trim();

  const chip = /Chip is\s+([^\r\n]+)/i.exec(output);
  if (chip) info.chip = chip[1].trim();

  const chipId = /Chip ID:\s*(0x[0-9A-Fa-f]+)/i.exec(output);
  if (chipId) info.chipId = chipId[1];

  const flash = /(?:Detected )?[Ff]lash size:\s*([0-9.]+\s*[KMG]?B)/i.exec(output);
  if (flash) info.flashSize = flash[1].replace(/\s+/g, "").toUpperCase();

  const mac = /MAC:\s*([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/i.exec(output);
  if (mac) info.mac = mac[1].toLowerCase();

  return info;
}

function runEsptool(
  location: EsptoolLocation,
  port: string,
  timeoutMs: number
): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    execFile(
      location.python,
      [...location.args, "--port", port, "flash_id"],
      {
        cwd: location.cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          code = typeof e.code === "number" ? e.code : 1;
        }
        resolve({ code, output: `${stdout ?? ""}\n${stderr ?? ""}`.trim() });
      }
    );
  });
}

/**
 * Talk to the chip bootloader (esptool flash_id) and read chip type / chip id /
 * flash size / MAC. This resets the board and briefly owns the serial port.
 */
export async function detectChip(
  ctx: PioContext,
  port: string,
  timeoutMs = 60000
): Promise<ChipDetectResult> {
  const location = findEsptool(ctx);
  if (!location) return { error: "missing-esptool" };

  const result = await runEsptool(location, port, timeoutMs);
  const info = parseEsptoolOutput(result.output);
  if (!info.chip && !info.chipId && !info.chipType) {
    return { error: result.output || `esptool 退出码 ${result.code}` };
  }
  return { info };
}

/** Install just the esptool tool package (~small download) into the project core dir. */
export async function installEsptool(ctx: PioContext): Promise<{ ok: boolean; message: string }> {
  const result = await runPio(
    ctx,
    ["pkg", "install", "--global", "--tool", "platformio/tool-esptoolpy"],
    180000
  );
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code !== 0) {
    return { ok: false, message: text || `pio pkg install 退出码 ${result.code}` };
  }
  return { ok: true, message: text || "esptool 已安装" };
}
