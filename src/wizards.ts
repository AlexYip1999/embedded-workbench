import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { PioContext } from "./core/pio";
import {
  BoardInfo,
  EnvConfig,
  addEnvironment,
  defaultMonitorFilters,
  defaultUploadSpeed,
  filterBoardsForChip,
  frameworkChoices,
  getLatestPlatformVersion,
  listPlatformBoards,
  platformForChip,
  scaffoldProject,
  validateProjectName,
} from "./core/scaffold";
import { ChipInfo, detectChip, findEsptool, installEsptool } from "./core/esptool";
import { formatBytes } from "./core/sizes";
import { SerialDeviceNode } from "./trees/devicesTree";
import type { Workbench } from "./workbench";

interface PlatformChoice {
  id: string;
  label: string;
  description?: string;
}

const PLATFORM_CHOICES: PlatformChoice[] = [
  { id: "espressif8266", label: "ESP8266", description: "NodeMCU / D1 mini / ESP-01（Arduino）" },
  { id: "espressif32", label: "ESP32", description: "ESP32 / C3 / S3 / C6（Arduino 或 ESP-IDF）" },
  { id: "ststm32", label: "STM32", description: "STM32F1/F4/L4…（Arduino / STM32Cube）" },
  { id: "raspberrypi", label: "RP2040", description: "Raspberry Pi Pico" },
  { id: "atmelsam", label: "AVR / SAM", description: "Arduino UNO / MEGA" },
  { id: "__other__", label: "其他平台…", description: "手动输入 PlatformIO 平台名" },
];

export async function newProjectWizard(wb: Workbench): Promise<void> {
  const mode = await vscode.window.showQuickPick(
    [
      { id: "new", label: "新建工程", description: "在 projects/ 下创建新的 PlatformIO 工程" },
      {
        id: "add",
        label: "给现有工程添加环境",
        description: "在已有 platformio.ini 里追加板卡环境",
      },
    ],
    { placeHolder: "要做什么？" }
  );
  if (!mode) return;
  if (mode.id === "new") await createProjectWizard(wb);
  else await addEnvironmentWizard(wb);
}

export async function createProjectWizard(wb: Workbench): Promise<void> {
  if (!wb.repoRoot || !wb.pioCtx) return;

  const name = await vscode.window.showInputBox({
    prompt: "工程名（会在 projects/ 下创建同名目录）",
    value: "blinky",
    validateInput: validateProjectName,
  });
  if (!name) return;
  const projectName = name.trim();
  const projectDir = path.join(wb.repoRoot, "projects", projectName);
  if (fs.existsSync(projectDir)) {
    vscode.window.showErrorMessage(`projects/${projectName} 已存在，换一个名字。`);
    return;
  }

  const env = await buildEnvConfig(wb);
  if (!env) return;

  const versionText = env.platformVersion
    ? `@${env.platformVersion}`
    : "（未锁定，建议首次构建后锁定）";
  const answer = await vscode.window.showInformationMessage(
    [
      `新建工程：projects/${projectName}`,
      `platform = ${env.platformId}${versionText}`,
      `board = ${env.boardId}`,
      `framework = ${env.framework}`,
      `env = ${env.envName}`,
    ].join("\n"),
    { modal: true },
    "创建"
  );
  if (answer !== "创建") return;

  try {
    await scaffoldProject({ projectName, projectDir, env });
  } catch (err) {
    vscode.window.showErrorMessage(`创建失败：${String(err)}`);
    return;
  }

  await wb.setActive(projectName, env.envName);
  await wb.refreshAll();

  const build = await vscode.window.showInformationMessage(
    `工程已创建：projects/${projectName}（首次构建会下载平台与工具链）`,
    "现在构建",
    "稍后"
  );
  if (build === "现在构建") {
    const project = wb.state.projects.find(p => p.name === projectName);
    const envModel = project?.envs.find(e => e.name === env.envName);
    if (project && envModel) await wb.runActionFor({ project, env: envModel }, "build");
  }
}

export async function addEnvironmentWizard(wb: Workbench): Promise<void> {
  if (!wb.repoRoot || !wb.pioCtx) return;
  if (wb.state.projects.length === 0) {
    vscode.window.showInformationMessage("还没有工程，先用「新建 PlatformIO 工程」。");
    return;
  }

  const projectPick = await vscode.window.showQuickPick(
    wb.state.projects.map(p => ({ label: p.name, description: `projects/${p.name}`, project: p })),
    { placeHolder: "选择要添加环境的工程" }
  );
  if (!projectPick) return;

  const env = await buildEnvConfig(wb);
  if (!env) return;

  try {
    await addEnvironment(projectPick.project.iniPath, env);
  } catch (err) {
    vscode.window.showErrorMessage(`添加失败：${String(err)}`);
    return;
  }

  await wb.refreshAll();
  vscode.window.showInformationMessage(
    `已在 ${projectPick.label} 添加环境 [env:${env.envName}]，可在「工程」视图切换。`
  );
}

/** Shared flow: platform -> board -> framework -> pinned version -> env name. */
export async function buildEnvConfig(wb: Workbench): Promise<EnvConfig | undefined> {
  if (!wb.pioCtx) return undefined;

  const platform = await pickPlatform();
  if (!platform) return undefined;

  const board = await pickBoard(wb, platform.id);
  if (!board) return undefined;

  const framework = await pickFramework(platform.id, board);
  if (!framework) return undefined;

  const version = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `查询 ${platform.id} 最新版本…`,
      cancellable: false,
    },
    () => getLatestPlatformVersion(platform.id)
  );

  return {
    envName: board.id,
    platformId: platform.id,
    platformVersion: version,
    boardId: board.id,
    framework,
    uploadSpeed: defaultUploadSpeed(platform.id, board.id),
    monitorFilters: defaultMonitorFilters(platform.id),
  };
}

async function pickPlatform(): Promise<PlatformChoice | undefined> {
  const picked = await vscode.window.showQuickPick(PLATFORM_CHOICES, {
    placeHolder: "选择平台（芯片家族）",
    matchOnDescription: true,
  });
  if (!picked) return undefined;
  if (picked.id !== "__other__") return picked;

  const custom = await vscode.window.showInputBox({
    prompt: "输入 PlatformIO 平台名",
    placeHolder: "如 espressif32、ststm32 或 owner/name",
    validateInput: value => (value.trim() ? undefined : "不能为空"),
  });
  return custom ? { id: custom.trim(), label: custom.trim() } : undefined;
}

async function pickBoard(wb: Workbench, platformId: string): Promise<BoardInfo | undefined> {
  if (!wb.pioCtx) return undefined;

  const query = platformId.includes("/") ? (platformId.split("/").pop() as string) : platformId;
  let boards: BoardInfo[] = [];
  try {
    boards = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `读取 ${platformId} 板卡列表…`,
        cancellable: false,
      },
      () => listPlatformBoards(wb.pioCtx as PioContext, query)
    );
  } catch {
    boards = [];
  }

  if (boards.length === 0) {
    vscode.window.showWarningMessage(
      `无法获取 ${platformId} 的板卡列表（网络或平台名问题），改为手动输入板卡 ID。`
    );
    const id = await vscode.window.showInputBox({
      prompt: "输入 PlatformIO 板卡 ID",
      placeHolder: "如 nodemcuv2 / esp32dev",
      validateInput: value => (value.trim() ? undefined : "不能为空"),
    });
    if (!id) return undefined;
    return { id: id.trim(), name: id.trim(), mcu: "?", frameworks: [], platform: platformId };
  }

  const picked = await vscode.window.showQuickPick(
    boards.map(board => ({
      label: board.id,
      description: `${board.name} · ${board.mcu}`,
      detail: [
        board.rom ? `Flash ${formatBytes(board.rom)}` : "",
        board.ram ? `RAM ${formatBytes(board.ram)}` : "",
        board.frameworks.length > 0 ? board.frameworks.join(" / ") : "",
      ]
        .filter(Boolean)
        .join(" · "),
      board,
    })),
    { placeHolder: "选择板卡（可输入过滤）", matchOnDescription: true, matchOnDetail: true }
  );
  return picked?.board;
}

async function pickFramework(platformId: string, board: BoardInfo): Promise<string | undefined> {
  const choices = frameworkChoices(platformId, board);
  if (choices.length === 0) return "arduino";
  const notes: Record<string, string> = {
    arduino: "上手快、生态大（推荐）",
    espidf: "ESP32 官方框架，功能全、调试好",
    stm32cube: "ST 官方 HAL 框架",
    "esp8266-rtos-sdk": "ESP8266 FreeRTOS SDK（已有代码时用）",
  };
  const picked = await vscode.window.showQuickPick(
    choices.map(framework => ({ label: framework, description: notes[framework] ?? "" })),
    { placeHolder: "选择框架" }
  );
  return picked?.label;
}

export async function ensureEsptool(wb: Workbench): Promise<boolean> {
  if (!wb.pioCtx) return false;
  if (findEsptool(wb.pioCtx)) return true;

  const install = await vscode.window.showInformationMessage(
    "还没有 esptool 工具（首次识别需要下载几 MB）。",
    "安装 esptool",
    "取消"
  );
  if (install !== "安装 esptool") return false;

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "安装 esptool…",
      cancellable: false,
    },
    () => installEsptool(wb.pioCtx as PioContext)
  );
  if (!result.ok) {
    vscode.window.showErrorMessage(`esptool 安装失败：${result.message}`);
    return false;
  }
  if (!findEsptool(wb.pioCtx)) {
    vscode.window.showErrorMessage("esptool 安装完成但未找到工具目录，请重试或先构建一次。");
    return false;
  }
  return true;
}

export async function detectChipWithProgress(
  wb: Workbench,
  port: string
): Promise<ChipInfo | undefined> {
  if (!wb.pioCtx) return undefined;
  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在识别 ${port} 芯片…`,
      cancellable: false,
    },
    () => detectChip(wb.pioCtx as PioContext, port)
  );
  if (!outcome.info) {
    vscode.window.showErrorMessage(`识别失败：${outcome.error ?? "未知错误"}`);
    return undefined;
  }
  wb.devicesProvider.setChipInfo(port, outcome.info);
  return outcome.info;
}

function describeChip(info: ChipInfo): string {
  return [
    info.chip ? `芯片：${info.chip}` : "",
    info.chipType ? `类型：${info.chipType}` : "",
    info.chipId ? `Chip ID：${info.chipId}` : "",
    info.flashSize ? `Flash：${info.flashSize}` : "",
    info.mac ? `MAC：${info.mac}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function detectChipForNode(wb: Workbench, node: unknown): Promise<void> {
  if (!(node instanceof SerialDeviceNode)) return;
  const port = node.device.port;

  const confirmed = await vscode.window.showWarningMessage(
    `识别芯片会复位板子并短暂占用 ${port}（请先关闭串口监视），继续？`,
    { modal: true },
    "开始识别"
  );
  if (confirmed !== "开始识别") return;
  if (!(await ensureEsptool(wb))) return;

  const info = await detectChipWithProgress(wb, port);
  if (!info) return;
  vscode.window.showInformationMessage(describeChip(info), { modal: true });
}

/**
 * Create a project directly from a serial port: detect the chip (or reuse an
 * earlier detection), then offer only the platforms/boards/frameworks that fit.
 */
export async function newProjectForDevice(wb: Workbench, node: unknown): Promise<void> {
  if (!(node instanceof SerialDeviceNode)) return;
  if (!wb.pioCtx || !wb.repoRoot) return;
  const port = node.device.port;

  let chip = wb.devicesProvider.getChipInfo(port);
  if (!chip) {
    const confirmed = await vscode.window.showWarningMessage(
      `需要先读取 ${port} 的芯片信息（会复位板子并短暂占用串口），继续？`,
      { modal: true },
      "读取并继续"
    );
    if (confirmed !== "读取并继续") return;
    if (!(await ensureEsptool(wb))) return;
    chip = await detectChipWithProgress(wb, port);
    if (!chip) return;
  }

  const platformId = platformForChip(chip);
  if (!platformId) {
    vscode.window.showWarningMessage(
      `未能从芯片信息（${chip.chip ?? chip.chipType ?? "未知"}）确定平台，改用完整新建向导。`
    );
    await newProjectWizard(wb);
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: `为 ${chip.chip ?? chip.chipType}（${port}）新建工程`,
    value: "blinky",
    validateInput: validateProjectName,
  });
  if (!name) return;
  const projectName = name.trim();
  const projectDir = path.join(wb.repoRoot, "projects", projectName);
  if (fs.existsSync(projectDir)) {
    vscode.window.showErrorMessage(`projects/${projectName} 已存在，换一个名字。`);
    return;
  }

  const allBoards = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `读取 ${platformId} 板卡列表…`,
      cancellable: false,
    },
    () => listPlatformBoards(wb.pioCtx as PioContext, platformId)
  );
  if (allBoards.length === 0) {
    vscode.window.showErrorMessage(`读取 ${platformId} 板卡列表失败，请检查网络后重试。`);
    return;
  }

  const candidates = filterBoardsForChip(allBoards, chip);
  let board =
    candidates.length > 0
      ? await pickBoardFromList(
          candidates,
          `选择板卡（已按 ${chip.chipType ?? chip.chip ?? "芯片"}${chip.flashSize ? ` · ${chip.flashSize}` : ""} 筛选）`
        )
      : undefined;
  if (!board) {
    const useFullList = await vscode.window.showInformationMessage(
      "没有匹配当前芯片的板卡，是否从完整列表选择？",
      "完整列表",
      "取消"
    );
    if (useFullList !== "完整列表") return;
    board = await pickBoard(wb, platformId);
  }
  if (!board) return;

  const framework = await pickFrameworkForChip(platformId, board);
  if (!framework) return;

  const version = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `查询 ${platformId} 最新版本…`,
      cancellable: false,
    },
    () => getLatestPlatformVersion(platformId)
  );

  const env: EnvConfig = {
    envName: board.id,
    platformId,
    platformVersion: version,
    boardId: board.id,
    framework,
    uploadSpeed: defaultUploadSpeed(platformId, board.id),
    monitorFilters: defaultMonitorFilters(platformId),
  };

  const summary = [
    `设备：${port}（${chip.chip ?? chip.chipType ?? "未知芯片"}${chip.flashSize ? ` · ${chip.flashSize}` : ""}）`,
    `新建工程：projects/${projectName}`,
    `platform = ${env.platformId}${env.platformVersion ? `@${env.platformVersion}` : "（未锁定）"}`,
    `board = ${env.boardId}`,
    `framework = ${env.framework}`,
  ].join("\n");
  const answer = await vscode.window.showInformationMessage(summary, { modal: true }, "创建");
  if (answer !== "创建") return;

  try {
    await scaffoldProject({ projectName, projectDir, env });
  } catch (err) {
    vscode.window.showErrorMessage(`创建失败：${String(err)}`);
    return;
  }

  await wb.setActive(projectName, env.envName);
  await wb.refreshAll();

  const project = wb.state.projects.find(p => p.name === projectName);
  const envModel = project?.envs.find(e => e.name === env.envName);
  const next = await vscode.window.showInformationMessage(
    `工程已创建：projects/${projectName}（${chip.chip ?? chip.chipType}）`,
    `构建并烧录到 ${port}`,
    "仅构建",
    "稍后"
  );
  if (project && envModel) {
    if (next && next.startsWith("构建并烧录")) {
      await wb.runActionFor({ project, env: envModel }, "flash", port);
    } else if (next === "仅构建") {
      await wb.runActionFor({ project, env: envModel }, "build");
    }
  }
}

async function pickFrameworkForChip(
  platformId: string,
  board: BoardInfo
): Promise<string | undefined> {
  const all = frameworkChoices(platformId, board);
  const preferred = all.filter(f => f === "arduino" || f === "espidf");
  const choices = preferred.length > 0 ? preferred : all.slice(0, 1);
  if (choices.length <= 1) return choices[0] ?? "arduino";

  const notes: Record<string, string> = {
    arduino: "上手快、生态大（推荐）",
    espidf: "ESP32 官方框架，功能全、调试好",
  };
  const picked = await vscode.window.showQuickPick(
    choices.map(framework => ({ label: framework, description: notes[framework] ?? "" })),
    { placeHolder: "选择框架" }
  );
  return picked?.label;
}

async function pickBoardFromList(
  boards: BoardInfo[],
  placeHolder: string
): Promise<BoardInfo | undefined> {
  const picked = await vscode.window.showQuickPick(
    boards.map(board => ({
      label: board.id,
      description: `${board.name} · ${board.mcu}`,
      detail: [
        board.rom ? `Flash ${formatBytes(board.rom)}` : "",
        board.ram ? `RAM ${formatBytes(board.ram)}` : "",
        board.frameworks.length > 0 ? board.frameworks.join(" / ") : "",
      ]
        .filter(Boolean)
        .join(" · "),
      board,
    })),
    { placeHolder, matchOnDescription: true, matchOnDetail: true }
  );
  return picked?.board;
}
