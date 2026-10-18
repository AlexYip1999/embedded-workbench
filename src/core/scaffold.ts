import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { parseIni } from "./ini";
import { PioContext, runPio } from "./pio";

export interface BoardInfo {
  id: string;
  name: string;
  mcu: string;
  ram?: number;
  rom?: number;
  frameworks: string[];
  platform: string;
  vendor?: string;
}

export interface EnvConfig {
  envName: string;
  platformId: string;
  platformVersion?: string;
  boardId: string;
  framework: string;
  uploadSpeed: number;
  monitorFilters?: string;
}

export interface ScaffoldInput {
  projectName: string;
  projectDir: string;
  env: EnvConfig;
}

const FRAMEWORK_ORDER = [
  "arduino",
  "espidf",
  "stm32cube",
  "esp8266-rtos-sdk",
  "esp8266-nonos-sdk",
  "mbed",
  "zephyr",
  "cmsis",
  "spl",
  "libopencm3",
];

/** Only letters/digits plus `. _ -`, must start with a letter or digit. */
export function validateProjectName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "名称不能为空";
  if (trimmed.length > 64) return "名称太长（最多 64 字符）";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return "只能用字母、数字、点、下划线、短横线，且以字母或数字开头";
  }
  return undefined;
}

export function parseBoardsJson(text: string, platformId: string): BoardInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(text.trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const boards: BoardInfo[] = [];
  for (const raw of data) {
    const b = raw as Record<string, unknown>;
    const id = String(b.id ?? "");
    if (!id) continue;
    boards.push({
      id,
      name: String(b.name ?? id),
      mcu: String(b.mcu ?? "?"),
      ram: typeof b.ram === "number" ? b.ram : undefined,
      rom: typeof b.rom === "number" ? b.rom : undefined,
      frameworks: Array.isArray(b.frameworks) ? b.frameworks.map(String) : [],
      platform: String(b.platform ?? platformId),
      vendor: b.vendor ? String(b.vendor) : undefined,
    });
  }
  return boards.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listPlatformBoards(
  ctx: PioContext,
  platformId: string
): Promise<BoardInfo[]> {
  const res = await runPio(ctx, ["boards", platformId, "--json-output"], 60000);
  if (res.code !== 0) return [];
  return parseBoardsJson(res.stdout, platformId);
}

function registryUrl(platformId: string): string {
  const clean = platformId.replace(/^platformio\//i, "");
  const parts = clean.split("/").filter(Boolean);
  const owner = parts.length > 1 ? parts[0] : "platformio";
  const name = parts.length > 1 ? parts[1] : parts[0];
  return `https://api.registry.platformio.org/v3/packages/${encodeURIComponent(owner)}/platform/${encodeURIComponent(name)}`;
}

/** Latest platform version from the PlatformIO registry; undefined when offline/unknown. */
export function getLatestPlatformVersion(
  platformId: string,
  timeoutMs = 8000
): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const done = (value?: string): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = https.get(
      registryUrl(platformId),
      {
        headers: { "User-Agent": "embedded-workbench", Accept: "application/json" },
        timeout: timeoutMs,
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          done(undefined);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(body) as { version?: { name?: string } };
            done(json.version?.name);
          } catch {
            done(undefined);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      done(undefined);
    });
    req.on("error", () => done(undefined));
  });
}

function fallbackFrameworks(platformId: string): string[] {
  const p = platformId.toLowerCase();
  if (p.includes("espressif8266")) return ["arduino", "esp8266-rtos-sdk"];
  if (p.includes("espressif32")) return ["arduino", "espidf"];
  if (p.includes("ststm32")) return ["arduino", "stm32cube"];
  if (p.includes("raspberrypi")) return ["arduino"];
  if (p.includes("atmel")) return ["arduino"];
  return ["arduino"];
}

export function frameworkChoices(platformId: string, board?: BoardInfo): string[] {
  const offered = board && board.frameworks.length > 0 ? board.frameworks : fallbackFrameworks(platformId);
  const unique = [...new Set(offered)];
  const preferred = FRAMEWORK_ORDER.filter(f => unique.includes(f));
  const rest = unique.filter(f => !preferred.includes(f));
  return preferred.length > 0 ? [...preferred, ...rest] : unique;
}

export function defaultUploadSpeed(platformId: string, boardId: string): number {
  const p = platformId.toLowerCase();
  const b = boardId.toLowerCase();
  if (p.includes("espressif8266")) {
    return b.startsWith("esp01") || b.includes("esp8285") ? 115200 : 460800;
  }
  if (p.includes("espressif32")) return 921600;
  return 115200;
}

export function defaultMonitorFilters(platformId: string): string | undefined {
  return platformId.toLowerCase().includes("espressif8266")
    ? "esp8266_exception_decoder"
    : undefined;
}

export function platformSpec(env: EnvConfig): string {
  return env.platformVersion ? `${env.platformId}@${env.platformVersion}` : env.platformId;
}

export function generateEnvSection(env: EnvConfig): string {
  const lines = [
    `[env:${env.envName}]`,
    `platform = ${platformSpec(env)}`,
    `board = ${env.boardId}`,
    `framework = ${env.framework}`,
    "monitor_speed = 115200",
    `upload_speed = ${env.uploadSpeed}`,
  ];
  if (env.monitorFilters) lines.push(`monitor_filters = ${env.monitorFilters}`);
  lines.push("build_flags = -Wall");
  return lines.join("\n") + "\n";
}

export function generatePlatformioIni(env: EnvConfig): string {
  return [
    "; generated by Embedded Workbench (unified environment wizard)",
    "; platform/board/framework versions are pinned on purpose",
    "",
    "[platformio]",
    `default_envs = ${env.envName}`,
    "",
    generateEnvSection(env),
  ].join("\n");
}

export function generateMainSource(
  env: EnvConfig,
  projectName: string
): { fileName: string; content: string } {
  if (env.framework === "espidf") {
    return {
      fileName: "main.c",
      content: [
        `// ${projectName} — generated by Embedded Workbench (ESP-IDF)`,
        "#include <stdio.h>",
        '#include "freertos/FreeRTOS.h"',
        '#include "freertos/task.h"',
        "",
        "void app_main(void)",
        "{",
        `    printf("hello from ${projectName}\\n");`,
        "    for (;;) {",
        '        printf("[tick]\\n");',
        "        vTaskDelay(pdMS_TO_TICKS(1000));",
        "    }",
        "}",
        "",
      ].join("\n"),
    };
  }

  return {
    fileName: "main.cpp",
    content: [
      `// ${projectName} — generated by Embedded Workbench`,
      `// framework: ${env.framework}`,
      "#include <Arduino.h>",
      "",
      "#ifndef LED_BUILTIN",
      "#define LED_BUILTIN 2",
      "#endif",
      "",
      "void setup()",
      "{",
      "    Serial.begin(115200);",
      "    delay(300);",
      "    pinMode(LED_BUILTIN, OUTPUT);",
      '    Serial.println();',
      `    Serial.println("hello from ${projectName}");`,
      "}",
      "",
      "void loop()",
      "{",
      "    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));",
      '    Serial.println("[tick]");',
      "    delay(500);",
      "}",
      "",
    ].join("\n"),
  };
}

export function generateProjectReadme(env: EnvConfig, projectName: string): string {
  return `# ${projectName}

由 Embedded Workbench 扩展向导生成。

| 项 | 值 |
| --- | --- |
| platform | \`${platformSpec(env)}\` |
| board | \`${env.boardId}\` |
| framework | \`${env.framework}\` |
| 环境 | \`${env.envName}\` |
| monitor_speed | 115200 |
| upload_speed | ${env.uploadSpeed} |

## 使用

在 VS Code 左侧「统一嵌入式」→「工程」视图里右键这个工程：

- 构建 / 烧录 / 监视串口 / 清理
- 切换当前环境
- 删除工程

首次使用如果提示缺少 PlatformIO，运行命令面板「初始化环境（安装 PlatformIO）」。

> 平台与工具链缓存在仓库内 \`.platformio/\`，构建产物在工程内 \`.pio/\`。
`;
}

export async function scaffoldProject(input: ScaffoldInput): Promise<void> {
  const { projectDir, projectName, env } = input;
  if (fs.existsSync(projectDir)) {
    const entries = await fs.promises.readdir(projectDir);
    if (entries.length > 0) throw new Error(`目录已存在且非空：${projectDir}`);
  }

  await fs.promises.mkdir(path.join(projectDir, "src"), { recursive: true });
  for (const dir of ["include", "lib", "test"]) {
    await fs.promises.mkdir(path.join(projectDir, dir), { recursive: true });
  }

  await fs.promises.writeFile(
    path.join(projectDir, "platformio.ini"),
    generatePlatformioIni(env),
    "utf8"
  );

  const source = generateMainSource(env, projectName);
  await fs.promises.writeFile(path.join(projectDir, "src", source.fileName), source.content, "utf8");
  await fs.promises.writeFile(
    path.join(projectDir, "README.md"),
    generateProjectReadme(env, projectName),
    "utf8"
  );
}

export async function addEnvironment(iniPath: string, env: EnvConfig): Promise<void> {
  const text = await fs.promises.readFile(iniPath, "utf8");
  const doc = parseIni(text);
  const wanted = `env:${env.envName}`.toLowerCase();
  if (doc.sections.some(s => s.name.toLowerCase() === wanted)) {
    throw new Error(`环境已存在：[env:${env.envName}]`);
  }
  const suffix = text.endsWith("\n") ? "" : "\n";
  await fs.promises.writeFile(
    iniPath,
    `${text}${suffix}\n${generateEnvSection(env)}`,
    "utf8"
  );
}

export interface ChipSummary {
  chip?: string;
  chipType?: string;
  flashSize?: string;
}

/** Map an esptool-detected chip to a PlatformIO platform id. */
export function platformForChip(chip: ChipSummary): string | undefined {
  const chipType = (chip.chipType ?? "").trim().toUpperCase();
  const chipName = (chip.chip ?? "").trim().toUpperCase();
  if (chipType.startsWith("ESP8266") || chipName.startsWith("ESP8266")) return "espressif8266";
  if (chipType.startsWith("ESP32") || chipName.startsWith("ESP32")) return "espressif32";
  return undefined;
}

export function parseFlashBytes(flashSize?: string): number | undefined {
  if (!flashSize) return undefined;
  const m = /^([0-9.]+)\s*([KMG])B$/i.exec(flashSize.trim());
  if (!m) return undefined;
  const value = Number.parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const factor = unit === "K" ? 1024 : unit === "M" ? 1024 ** 2 : 1024 ** 3;
  return Math.round(value * factor);
}

/** Boards that commonly go with the chip; sorted first in the filtered list. */
const PREFERRED_BOARDS = [
  "nodemcuv2",
  "d1_mini",
  "esp01_1m",
  "esp01",
  "esp8285",
  "huzzah",
  "esp32dev",
  "esp32doit-devkit-v1",
  "esp32-c3-devkitm-1",
  "esp32-s3-devkitc-1",
  "esp32cam",
];

/**
 * Narrow the full board list down to boards matching the detected chip
 * (and flash size when known). Falls back to a wider list when nothing matches.
 */
export function filterBoardsForChip(boards: BoardInfo[], chip: ChipSummary): BoardInfo[] {
  let wanted = (chip.chipType ?? "").trim().toUpperCase();
  const chipName = (chip.chip ?? "").trim().toUpperCase();
  if (!wanted && /^ESP32[A-Z0-9-]*/.test(chipName)) {
    wanted = /^ESP32(?:-[A-Z0-9]+)?/.exec(chipName)?.[0] ?? "ESP32";
  }
  if (!wanted && chipName.startsWith("ESP8266")) wanted = "ESP8266";

  let filtered = wanted
    ? boards.filter(board => board.mcu.trim().toUpperCase() === wanted)
    : [];
  if (filtered.length === 0 && wanted) {
    filtered = boards.filter(board => {
      const mcu = board.mcu.trim().toUpperCase();
      return mcu.startsWith(wanted) || wanted.startsWith(mcu);
    });
  }
  if (filtered.length === 0) filtered = boards;

  const flashBytes = parseFlashBytes(chip.flashSize);
  if (flashBytes) {
    const byFlash = filtered.filter(board => board.rom === flashBytes);
    if (byFlash.length > 0) filtered = byFlash;
  }

  return [...filtered].sort((a, b) => {
    const ai = PREFERRED_BOARDS.indexOf(a.id);
    const bi = PREFERRED_BOARDS.indexOf(b.id);
    const ar = ai === -1 ? 999 : ai;
    const br = bi === -1 ? 999 : bi;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Delete a project directory. Only direct children of `projects/` that contain
 * a platformio.ini are accepted, so a bad path can never delete something else.
 */
export async function deleteProjectDirectory(
  projectDir: string,
  projectsRoot: string
): Promise<void> {
  const target = path.resolve(projectDir);
  const root = path.resolve(projectsRoot);
  if (path.dirname(target).toLowerCase() !== root.toLowerCase()) {
    throw new Error(`只能删除 projects/ 下的工程目录：${target}`);
  }
  if (!fs.existsSync(target)) throw new Error(`工程目录不存在：${target}`);
  if (!fs.existsSync(path.join(target, "platformio.ini"))) {
    throw new Error(`目标不是 PlatformIO 工程（缺少 platformio.ini）：${target}`);
  }
  await fs.promises.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250,
  });
}
