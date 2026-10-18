import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findRepoRoot, scanProjects } from "../src/core/repo";
import { findProjectSource, listProjectSources } from "../src/core/sources";
import { locatePio } from "../src/core/pio";
import { chipFromHwid, parseVidPid, scanSerialDevices } from "../src/core/ports";
import { parseEsptoolOutput } from "../src/core/esptool";
import {
  EnvConfig,
  addEnvironment,
  defaultMonitorFilters,
  defaultUploadSpeed,
  deleteProjectDirectory,
  filterBoardsForChip,
  frameworkChoices,
  generatePlatformioIni,
  parseBoardsJson,
  parseFlashBytes,
  platformForChip,
  scaffoldProject,
  validateProjectName,
} from "../src/core/scaffold";
import { buildCppdbgConfig, platformSupportsDebug, upsertLaunchConfiguration } from "../src/core/debug";
import { collectLockChecks } from "../src/core/versions";
import { collectSizeEntries, formatBytes } from "../src/core/sizes";
import { parseIni, envValue, values } from "../src/core/ini";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  console.log(`  ok - ${message}`);
}

async function main(): Promise<void> {
  console.log("[smoke] ini parser");
  const doc = parseIni(
    [
      "[platformio]",
      "default_envs = nodemcuv2",
      "",
      "[env]",
      "platform = espressif8266",
      "framework = arduino",
      "lib_deps =",
      "    adafruit/Adafruit NeoPixel@^1.12.0",
      "    bblanchon/ArduinoJson",
      "",
      "[env:nodemcuv2]",
      "board = nodemcuv2",
    ].join("\n")
  );
  assert(values(doc, "platformio", "default_envs")[0] === "nodemcuv2", "reads default_envs");
  assert(
    values(doc, "env", "lib_deps").filter(v => v.trim()).length === 2,
    "keeps lib_deps continuation lines"
  );
  assert(envValue(doc, "nodemcuv2", "platform")[0] === "espressif8266", "inherits [env] values");

  console.log("[smoke] repo root + projects");
  const workspaceRoot = path.resolve(process.cwd(), "..");
  const root = findRepoRoot([workspaceRoot]);
  assert(root === workspaceRoot, "uses the opened workspace folder that owns projects/");
  assert(findRepoRoot([process.cwd()]) === process.cwd(), "never walks up into a parent folder");
  if (!root) return;
  console.log(`  root = ${root}`);
  const projects = scanProjects(root);
  console.log(`  projects = ${projects.map(p => `${p.name}:${p.envs.map(e => e.name).join("/")}`).join(", ")}`);
  assert(projects.length > 0, "scans at least one project");

  const env = projects[0].envs[0];
  assert(!!env?.board, "first env has a board");

  console.log("[smoke] pio context");
  const ctx = locatePio(root, "", ".platformio");
  console.log(`  pio = ${ctx.pioExe}`);
  console.log(`  core = ${ctx.coreDir}`);
  assert(fs.existsSync(ctx.pioExe), "pio executable exists");

  console.log("[smoke] lock checks");
  const checks = await collectLockChecks(root, ctx, projects);
  for (const check of checks) {
    console.log(`  ${check.status.toUpperCase().padEnd(5)} ${check.label} — ${check.detail}`);
    for (const child of check.children ?? []) {
      console.log(`        ${child.status.toUpperCase().padEnd(5)} ${child.label}: ${child.detail}`);
    }
  }
  assert(checks.length >= 1, "returns lock checks");

  console.log("[smoke] usb chip detection");
  assert(
    (chipFromHwid("USB VID:PID=1A86:7523 SER=ABC") ?? "").includes("CH340"),
    "detects CH340 from hwid"
  );
  assert(parseVidPid("USB VID:PID=10C4:EA60")?.pid === "EA60", "parses VID/PID");
  assert(chipFromHwid("n/a") === undefined, "unknown hwid has no chip");

  console.log("[smoke] serial devices");
  const devices = await scanSerialDevices(ctx);
  console.log(`  serial = ${devices.serial.length} (scanned at ${devices.scannedAt})`);
  assert(Array.isArray(devices.serial), "returns serial device array");

  console.log("[smoke] esptool output parser");
  const esptoolSample = [
    "esptool.py v4.5.1",
    "Serial port COM3",
    "Connecting....",
    "Detecting chip type... ESP8266",
    "Chip is ESP8266EX",
    "MAC: 4c:eb:d6:11:22:33",
    "Chip ID: 0x00112233",
    "Flash size: 4MB",
  ].join("\n");
  const parsedChip = parseEsptoolOutput(esptoolSample);
  assert(parsedChip.chip === "ESP8266EX", "parses chip name");
  assert(parsedChip.chipType === "ESP8266", "parses chip type");
  assert(parsedChip.chipId === "0x00112233", "parses chip id");
  assert(parsedChip.flashSize === "4MB", "parses flash size");
  assert(parsedChip.mac === "4c:eb:d6:11:22:33", "parses mac");

  console.log("[smoke] scaffold / wizard helpers");
  assert(validateProjectName("my-board") === undefined, "accepts valid project name");
  assert(!!validateProjectName("my board"), "rejects name with space");
  assert(!!validateProjectName("../etc"), "rejects path traversal");
  assert(!!validateProjectName(""), "rejects empty name");

  const sampleBoards = parseBoardsJson(
    '[{"id":"nodemcuv2","name":"NodeMCU 1.0","mcu":"ESP8266","ram":81920,"rom":4194304,"frameworks":["arduino","esp8266-rtos-sdk"],"platform":"espressif8266"}]',
    "espressif8266"
  );
  assert(sampleBoards.length === 1 && sampleBoards[0].id === "nodemcuv2", "parses board json");
  assert(sampleBoards[0].rom === 4194304, "keeps board flash size");
  assert(frameworkChoices("espressif8266", sampleBoards[0])[0] === "arduino", "prefers arduino");

  const boardFixtures = parseBoardsJson(
    JSON.stringify([
      { id: "nodemcuv2", name: "NodeMCU 1.0", mcu: "ESP8266", ram: 81920, rom: 4194304, frameworks: ["arduino"], platform: "espressif8266" },
      { id: "esp01_1m", name: "ESP-01S", mcu: "ESP8266", ram: 81920, rom: 1048576, frameworks: ["arduino"], platform: "espressif8266" },
      { id: "esp32dev", name: "ESP32 Dev", mcu: "ESP32", ram: 327680, rom: 4194304, frameworks: ["arduino"], platform: "espressif32" },
      { id: "esp32-s3-devkitc-1", name: "ESP32-S3 DevKit", mcu: "ESP32-S3", ram: 327680, rom: 8388608, frameworks: ["arduino"], platform: "espressif32" },
    ]),
    "espressif8266"
  );
  assert(platformForChip({ chipType: "ESP8266" }) === "espressif8266", "maps ESP8266 platform");
  assert(
    platformForChip({ chip: "ESP32-D0WD-V3 (revision v3.1)" }) === "espressif32",
    "maps ESP32 platform"
  );
  assert(parseFlashBytes("4MB") === 4 * 1024 * 1024, "parses flash size");
  assert(parseFlashBytes("512KB") === 512 * 1024, "parses small flash size");

  const esp8266BoardChoices = filterBoardsForChip(boardFixtures, {
    chipType: "ESP8266",
    flashSize: "4MB",
  });
  assert(
    esp8266BoardChoices.length === 1 && esp8266BoardChoices[0].id === "nodemcuv2",
    "filters ESP8266 4MB boards"
  );

  const s3BoardChoices = filterBoardsForChip(boardFixtures, {
    chipType: "ESP32-S3",
    flashSize: "8MB",
  });
  assert(
    s3BoardChoices.length === 1 && s3BoardChoices[0].id === "esp32-s3-devkitc-1",
    "filters ESP32-S3 boards"
  );

  const generic32Choices = filterBoardsForChip(boardFixtures, { chipType: "ESP32" });
  assert(
    generic32Choices.length === 1 && generic32Choices[0].id === "esp32dev",
    "filters generic ESP32 boards only"
  );
  assert(defaultUploadSpeed("espressif8266", "esp01_1m") === 115200, "esp01 upload speed");
  assert(defaultUploadSpeed("espressif8266", "nodemcuv2") === 460800, "nodemcuv2 upload speed");
  assert(
    defaultMonitorFilters("espressif8266") === "esp8266_exception_decoder",
    "esp8266 monitor filter"
  );

  const envConfig: EnvConfig = {
    envName: "nodemcuv2",
    platformId: "espressif8266",
    platformVersion: "4.2.1",
    boardId: "nodemcuv2",
    framework: "arduino",
    uploadSpeed: 460800,
    monitorFilters: "esp8266_exception_decoder",
  };
  const generatedIni = generatePlatformioIni(envConfig);
  assert(generatedIni.includes("platform = espressif8266@4.2.1"), "pins platform in ini");
  assert(generatedIni.includes("[env:nodemcuv2]"), "writes env section");

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "envgui-smoke-"));
  try {
    const projectDir = path.join(tmp, "demo");
    await scaffoldProject({ projectName: "demo", projectDir, env: envConfig });
    assert(fs.existsSync(path.join(projectDir, "platformio.ini")), "scaffold writes ini");
    assert(fs.existsSync(path.join(projectDir, "src", "main.cpp")), "scaffold writes main.cpp");

    const secondEnv: EnvConfig = { ...envConfig, envName: "d1_mini", boardId: "d1_mini" };
    await addEnvironment(path.join(projectDir, "platformio.ini"), secondEnv);
    const iniText = await fs.promises.readFile(path.join(projectDir, "platformio.ini"), "utf8");
    assert(iniText.includes("[env:d1_mini]"), "appends environment");

    let duplicateRejected = false;
    try {
      await addEnvironment(path.join(projectDir, "platformio.ini"), secondEnv);
    } catch {
      duplicateRejected = true;
    }
    assert(duplicateRejected, "rejects duplicate environment");
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }

  console.log("[smoke] debug helpers");
  assert(platformSupportsDebug("espressif32@6.7.0"), "espressif32 supports debug");
  assert(!platformSupportsDebug("espressif8266@4.2.1"), "espressif8266 has no debug support");
  const debugCfg = buildCppdbgConfig({
    name: "PIO Debug · demo / env",
    projectDir: "C:/demo",
    firmwareElf: "C:/demo/.pio/build/env/firmware.elf",
    gdbPath: "C:/gdb/xtensa-esp32-elf-gdb.exe",
  });
  assert(debugCfg.type === "cppdbg", "builds cppdbg config");
  assert(debugCfg.miDebuggerServerAddress === "localhost:3333", "defaults gdb server address");
  assert(String(debugCfg.program).endsWith("firmware.elf"), "points at firmware.elf");

  const tmpDebug = await fs.promises.mkdtemp(path.join(os.tmpdir(), "envgui-debug-"));
  try {
    const first = await upsertLaunchConfiguration(tmpDebug, debugCfg);
    assert(fs.existsSync(first.path), "creates launch.json");
    const second = await upsertLaunchConfiguration(tmpDebug, {
      ...debugCfg,
      name: "PIO Debug · demo / env2",
    });
    assert(second.updated, "updates launch.json");
    const launch = JSON.parse(await fs.promises.readFile(first.path, "utf8")) as {
      configurations: Array<{ name: string }>;
    };
    assert(launch.configurations.length === 2, "merges debug configurations");
  } finally {
    await fs.promises.rm(tmpDebug, { recursive: true, force: true });
  }

  console.log("[smoke] project source discovery");
  const tmpSrc = await fs.promises.mkdtemp(path.join(os.tmpdir(), "envgui-src-"));
  try {
    await fs.promises.mkdir(path.join(tmpSrc, "src"), { recursive: true });
    assert(findProjectSource(tmpSrc) === undefined, "returns undefined without sources");
    await fs.promises.writeFile(path.join(tmpSrc, "src", "other.cpp"), "");
    assert((findProjectSource(tmpSrc) ?? "").endsWith("other.cpp"), "finds first source");
    await fs.promises.writeFile(path.join(tmpSrc, "src", "main.cpp"), "");
    assert((findProjectSource(tmpSrc) ?? "").endsWith("main.cpp"), "prefers main.cpp");

    await fs.promises.mkdir(path.join(tmpSrc, "src", "sub"), { recursive: true });
    await fs.promises.writeFile(path.join(tmpSrc, "src", "a.cpp"), "");
    await fs.promises.writeFile(path.join(tmpSrc, "src", "sub", "z.cpp"), "");
    const listed = listProjectSources(tmpSrc);
    assert(listed.length === 4, "lists source files recursively");
    assert(listed[0].endsWith("main.cpp"), "main.cpp first in source list");
  } finally {
    await fs.promises.rm(tmpSrc, { recursive: true, force: true });
  }

  console.log("[smoke] delete project guard");
  const tmp2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "envgui-del-"));
  try {
    const projectsRoot = path.join(tmp2, "projects");
    const good = path.join(projectsRoot, "demo");
    await fs.promises.mkdir(good, { recursive: true });
    await fs.promises.writeFile(path.join(good, "platformio.ini"), "[platformio]\n", "utf8");
    await deleteProjectDirectory(good, projectsRoot);
    assert(!fs.existsSync(good), "deletes a valid project directory");

    let rejectedOutside = false;
    try {
      await deleteProjectDirectory(tmp2, projectsRoot);
    } catch {
      rejectedOutside = true;
    }
    assert(rejectedOutside, "rejects paths outside projects/");

    const notProject = path.join(projectsRoot, "not-a-project");
    await fs.promises.mkdir(notProject, { recursive: true });
    let rejectedNoIni = false;
    try {
      await deleteProjectDirectory(notProject, projectsRoot);
    } catch {
      rejectedNoIni = true;
    }
    assert(rejectedNoIni, "rejects directory without platformio.ini");
  } finally {
    await fs.promises.rm(tmp2, { recursive: true, force: true });
  }

  console.log("[smoke] sizes");
  const sizes = await collectSizeEntries(root, projects);
  for (const size of sizes) {
    console.log(`  ${size.group.padEnd(6)} ${size.label.padEnd(24)} ${size.exists ? formatBytes(size.bytes) : "missing"}`);
  }
  assert(sizes.length > 0, "returns size entries");

  console.log("[smoke] done");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

// keep imports used
void path;
