import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { EnvModel, ProjectModel, findRepoRoot, hasProjectsDir, resolveEnv, scanProjects } from "./core/repo";
import { PioContext, locatePio, runPio } from "./core/pio";
import { PLATFORMIO_VERSION } from "./core/constants";
import { ensureEnvironment } from "./core/bootstrap";
import { scanSerialDevices } from "./core/ports";
import { ChipInfo, detectChip, findEsptool, installEsptool } from "./core/esptool";
import { collectSizeEntries, formatBytes } from "./core/sizes";
import { collectLockChecks } from "./core/versions";
import {
  BoardInfo,
  EnvConfig,
  addEnvironment,
  defaultMonitorFilters,
  defaultUploadSpeed,
  deleteProjectDirectory,
  filterBoardsForChip,
  frameworkChoices,
  getLatestPlatformVersion,
  listPlatformBoards,
  platformForChip,
  scaffoldProject,
  validateProjectName,
} from "./core/scaffold";
import { CacheEntryNode, CacheProvider } from "./trees/cacheTree";
import { DevicesProvider, SerialDeviceNode } from "./trees/devicesTree";
import { EnvNode, ProjectNode, ProjectsProvider, ProjectsState } from "./trees/projectsTree";
import { LockNode, VersionsProvider } from "./trees/versionsTree";
import { StatusBar } from "./statusbar";

interface Target {
  project: ProjectModel;
  env: EnvModel;
}

const ACTIVE_KEY = "embeddedEnv.active";

let repoRoot: string | undefined;
let pioCtx: PioContext | undefined;
let extensionContext: vscode.ExtensionContext;
let out: vscode.OutputChannel;
let projectsProvider: ProjectsProvider;
let devicesProvider: DevicesProvider;
let cacheProvider: CacheProvider;
let versionsProvider: VersionsProvider;
let statusBar: StatusBar;
let buildTerminal: vscode.Terminal | undefined;
let buildTerminalCwd: string | undefined;
let monitorTerminal: vscode.Terminal | undefined;
let monitorTerminalCwd: string | undefined;

let state: ProjectsState = { projects: [] };

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  out = vscode.window.createOutputChannel("统一嵌入式");
  context.subscriptions.push(out);

  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  repoRoot =
    findRepoRoot(folders.length > 0 ? folders : [process.cwd()]) ??
    (folders.length > 0 ? folders[0] : undefined);
  if (!repoRoot) {
    vscode.window.showWarningMessage("统一嵌入式：请先打开一个文件夹作为工程目录。");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("embeddedEnv");
  pioCtx = locatePio(
    repoRoot,
    cfg.get<string>("pioPath", ""),
    cfg.get<string>("coreDir", ".platformio")
  );
  state.active = context.workspaceState.get<{ project: string; env: string }>(ACTIVE_KEY);

  projectsProvider = new ProjectsProvider(() => state);
  devicesProvider = new DevicesProvider();
  cacheProvider = new CacheProvider();
  versionsProvider = new VersionsProvider();
  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.window.createTreeView("embeddedEnv.projects", {
      treeDataProvider: projectsProvider,
      showCollapseAll: true,
    }),
    vscode.window.createTreeView("embeddedEnv.devices", {
      treeDataProvider: devicesProvider,
    }),
    vscode.window.createTreeView("embeddedEnv.cache", {
      treeDataProvider: cacheProvider,
    }),
    vscode.window.createTreeView("embeddedEnv.versions", {
      treeDataProvider: versionsProvider,
    })
  );

  if (hasProjectsDir(repoRoot) && !fs.existsSync(pioCtx.pioExe)) {
    out.appendLine(`[warn] 未找到 pio：${pioCtx.pioExe}`);
    void vscode.window
      .showWarningMessage(
        "Embedded Workbench：还没有 PlatformIO 环境（首次使用需要安装）。",
        "初始化环境",
        "稍后"
      )
      .then(choice => {
        if (choice === "初始化环境") void bootstrapEnvironment();
      });
  }

  registerCommands(context);
  void refreshAll();
}

export function deactivate(): void {
  // Terminals and views are disposed by VS Code.
}

function registerCommands(context: vscode.ExtensionContext): void {
  const reg = (command: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  reg("embeddedEnv.refresh", () => refreshAll());
  reg("embeddedEnv.bootstrap", () => bootstrapEnvironment());
  reg("embeddedEnv.refreshDevices", () => refreshDevices());
  reg("embeddedEnv.focusPanel", () => focusPanel());
  reg("embeddedEnv.focusDevices", () => focusDevices());
  reg("embeddedEnv.newProject", () => newProjectWizard());
  reg("embeddedEnv.addEnvironment", () => addEnvironmentWizard());
  reg("embeddedEnv.computeSizes", () => computeSizes(true));
  reg("embeddedEnv.build", node => runTarget(node, "build"));
  reg("embeddedEnv.flash", node => runTarget(node, "flash"));
  reg("embeddedEnv.flashToPort", node => runTargetToPort(node, "flash"));
  reg("embeddedEnv.detectChip", node => detectChipForNode(node));
  reg("embeddedEnv.newProjectForDevice", node => newProjectForDevice(node));
  reg("embeddedEnv.deleteProject", node => deleteProject(node));
  reg("embeddedEnv.monitor", node => runTarget(node, "monitor"));
  reg("embeddedEnv.monitorPort", node => runTargetToPort(node, "monitor"));
  reg("embeddedEnv.copyPortName", node => copyPortName(node));
  reg("embeddedEnv.clean", node => runTarget(node, "clean"));
  reg("embeddedEnv.cleanBuild", node => cleanBuild(node));
  reg("embeddedEnv.setActiveEnv", node => setActiveFromNode(node));
  reg("embeddedEnv.pickActive", () => pickActive());
  reg("embeddedEnv.openIni", node => openIni(node));
  reg("embeddedEnv.openPath", node => openPath(node));
  reg("embeddedEnv.openCheckFile", node => openCheckFile(node));
  reg("embeddedEnv.checkUpdates", () => checkUpdates());
}

async function refreshAll(): Promise<void> {
  if (!repoRoot) return;
  state.projects = scanProjects(repoRoot);

  if (state.active) {
    const project = state.projects.find(p => p.name === state.active?.project);
    if (!project || !project.envs.some(e => e.name === state.active?.env)) {
      state.active = undefined;
    }
  }
  if (!state.active && state.projects.length > 0) {
    const project = state.projects[0];
    const env = resolveEnv(project);
    if (env) state.active = { project: project.name, env: env.name };
  }

  projectsProvider.refresh();
  cacheProvider.reset();

  const workspaceReady = hasProjectsDir(repoRoot);
  if (pioCtx && workspaceReady) {
    const version = await readPioVersion();
    if (version) statusBar.setPioVersion(version);
    statusBar.update(state, pioCtx);

    try {
      const checks = await collectLockChecks(repoRoot, pioCtx, state.projects);
      versionsProvider.setChecks(checks);
    } catch (err) {
      out.appendLine(`[error] 版本检查失败: ${String(err)}`);
    }

    void refreshDevices();
  } else if (!workspaceReady) {
    devicesProvider.setNotice("当前工作区不是嵌入式工程目录（缺少 projects/），未扫描串口。");
    versionsProvider.setChecks([
      {
        id: "workspace",
        label: "工作区",
        detail: "缺少 projects/ 目录，不是嵌入式工作区",
        status: "info",
      },
    ]);
  }
  void computeSizes(false);
}

async function bootstrapEnvironment(): Promise<void> {
  if (!repoRoot) return;
  out.show(true);

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "初始化 PlatformIO 环境（首次需要下载）…",
      cancellable: false,
    },
    () =>
      ensureEnvironment(repoRoot as string, PLATFORMIO_VERSION, line => out.appendLine(line))
  );

  if (!result.ok) {
    vscode.window.showErrorMessage(`初始化失败：${result.message}`);
    return;
  }

  const cfg = vscode.workspace.getConfiguration("embeddedEnv");
  pioCtx = locatePio(
    repoRoot,
    cfg.get<string>("pioPath", ""),
    cfg.get<string>("coreDir", ".platformio")
  );
  await refreshAll();
  vscode.window.showInformationMessage(`环境已就绪：${result.message}`);
}

async function refreshDevices(): Promise<void> {
  if (!pioCtx || !repoRoot) return;
  if (!hasProjectsDir(repoRoot)) {
    devicesProvider.setNotice("当前工作区不是嵌入式工程目录（缺少 projects/），未扫描串口。");
    return;
  }
  devicesProvider.setScanning();
  try {
    devicesProvider.setListing(await scanSerialDevices(pioCtx));
  } catch (err) {
    devicesProvider.setListing({
      serial: [],
      error: String(err),
      scannedAt: new Date().toLocaleTimeString(),
    });
  }
}

async function focusPanel(): Promise<void> {
  await vscode.commands.executeCommand("workbench.view.extension.embeddedEnv");
}

async function focusDevices(): Promise<void> {
  await focusPanel();
  await vscode.commands.executeCommand("embeddedEnv.devices.focus");
  await refreshDevices();
}

async function readPioVersion(): Promise<string | undefined> {
  if (!pioCtx) return undefined;
  const res = await runPio(pioCtx, ["--version"], 15000);
  return /version\s+([0-9][^\s,]*)/i.exec(`${res.stdout}\n${res.stderr}`)?.[1];
}

async function computeSizes(notify: boolean): Promise<void> {
  if (!repoRoot) return;
  cacheProvider.setComputing(true);
  try {
    const task = collectSizeEntries(repoRoot, state.projects);
    const entries = notify
      ? await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "统计缓存体积…",
            cancellable: false,
          },
          () => task
        )
      : await task;
    cacheProvider.setEntries(entries);
  } catch (err) {
    out.appendLine(`[error] 统计体积失败: ${String(err)}`);
    cacheProvider.setComputing(false);
  }
}

function targetFromNode(node?: unknown): Target | undefined {
  if (node instanceof EnvNode) return { project: node.project, env: node.env };
  if (node instanceof ProjectNode) {
    const activeEnv =
      state.active && state.active.project === node.project.name ? state.active.env : undefined;
    const env = resolveEnv(node.project, activeEnv);
    return env ? { project: node.project, env } : undefined;
  }
  if (!state.active) return undefined;
  const project = state.projects.find(p => p.name === state.active?.project);
  if (!project) return undefined;
  const env = project.envs.find(e => e.name === state.active?.env);
  return env ? { project, env } : undefined;
}

async function pickTarget(node?: unknown): Promise<Target | undefined> {
  const fromNode = targetFromNode(node);
  if (fromNode) return fromNode;

  const items = state.projects.flatMap(project =>
    project.envs.map(env => ({
      label: `${project.name} / ${env.name}`,
      description: env.board ?? "",
      project,
      env,
    }))
  );
  if (items.length === 0) {
    vscode.window.showInformationMessage("没有可用的工程环境，先在 projects/ 下创建工程。");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "选择工程 / 环境" });
  return picked ? { project: picked.project, env: picked.env } : undefined;
}

async function runTarget(
  node: unknown,
  action: "build" | "flash" | "monitor" | "clean",
  explicitPort?: string
): Promise<void> {
  const target = await pickTarget(node);
  if (!target) return;
  await runActionFor(target, action, explicitPort);
}

async function runActionFor(
  target: Target,
  action: "build" | "flash" | "monitor" | "clean",
  explicitPort?: string
): Promise<void> {
  if (action === "monitor") {
    await startMonitor(target, explicitPort);
    return;
  }

  const args: string[] = ["run", "-e", target.env.name];
  let title = `PlatformIO Build · ${target.project.name}`;

  if (action === "flash") {
    args.push("-t", "upload");
    const port = explicitPort ?? (await pickPort());
    if (port) args.push("--upload-port", port);
    title = `PlatformIO Flash · ${target.project.name}`;
  } else if (action === "clean") {
    args.push("-t", "clean");
    title = `PlatformIO Clean · ${target.project.name}`;
  }

  const term = getBuildTerminal(target.project.dir, title);
  term.show(true);
  term.sendText(terminalCommand(args), true);
}

async function runTargetToPort(node: unknown, action: "flash" | "monitor"): Promise<void> {
  if (!(node instanceof SerialDeviceNode)) return;
  await runTarget(undefined, action, node.device.port);
}

async function startMonitor(target: Target, explicitPort?: string): Promise<void> {
  const baud = vscode.workspace.getConfiguration("embeddedEnv").get<number>("baud", 115200);
  const port = explicitPort ?? (await pickPort());
  const args = ["device", "monitor", "-b", String(baud)];
  if (port) args.push("-p", port);

  if (
    !monitorTerminal ||
    monitorTerminal.exitStatus !== undefined ||
    monitorTerminalCwd !== target.project.dir
  ) {
    monitorTerminal?.dispose();
    monitorTerminal = vscode.window.createTerminal({
      name: `Monitor · ${target.project.name}`,
      cwd: target.project.dir,
      env: terminalEnv(),
    });
    monitorTerminalCwd = target.project.dir;
  }
  monitorTerminal.show(true);
  monitorTerminal.sendText(terminalCommand(args), true);
}

async function pickPort(): Promise<string | undefined> {
  if (!pioCtx) return undefined;
  const listing = await scanSerialDevices(pioCtx);
  const devices = listing.serial;
  if (devices.length === 0) return undefined;
  if (devices.length === 1) return devices[0].port;

  const ports = devices.map(d => d.port);
  const items: vscode.QuickPickItem[] = [
    { label: "自动检测", description: "交给 PlatformIO 选择端口" },
    ...devices.map(d => ({
      label: d.port,
      description: [d.chip ?? d.description, d.hwid ? `(${d.hwid})` : ""]
        .filter(Boolean)
        .join(" "),
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "选择串口" });
  if (!picked) return undefined;
  return ports.includes(picked.label) ? picked.label : undefined;
}

async function copyPortName(node: unknown): Promise<void> {
  if (!(node instanceof SerialDeviceNode)) return;
  await vscode.env.clipboard.writeText(node.device.port);
  vscode.window.showInformationMessage(`已复制端口名：${node.device.port}`);
}

function terminalEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  if (pioCtx) env.PLATFORMIO_CORE_DIR = pioCtx.coreDir;
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  return env;
}

function getBuildTerminal(cwd: string, title: string): vscode.Terminal {
  if (!buildTerminal || buildTerminal.exitStatus !== undefined || buildTerminalCwd !== cwd) {
    buildTerminal?.dispose();
    buildTerminal = vscode.window.createTerminal({
      name: title,
      cwd,
      env: terminalEnv(),
    });
    buildTerminalCwd = cwd;
  }
  return buildTerminal;
}

function terminalCommand(args: string[]): string {
  if (!pioCtx) return "";
  const quote = (value: string): string =>
    /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  const line = `"${pioCtx.pioExe}" ${args.map(quote).join(" ")}`;
  const shell = path.basename(vscode.env.shell || "").toLowerCase();
  const isPowerShell = shell.includes("powershell") || shell.includes("pwsh");
  return isPowerShell ? `& ${line}` : line;
}

async function cleanBuild(node: unknown): Promise<void> {
  if (!(node instanceof CacheEntryNode)) return;
  const projectName = node.entry.projectName;
  if (!projectName) return;
  const project = state.projects.find(p => p.name === projectName);
  if (!project) return;
  const term = getBuildTerminal(project.dir, `PlatformIO Clean · ${project.name}`);
  term.show(true);
  term.sendText(terminalCommand(["run", "-t", "clean"]), true);
}

async function setActiveFromNode(node: unknown): Promise<void> {
  if (node instanceof EnvNode) {
    await setActive(node.project.name, node.env.name);
  } else if (node instanceof ProjectNode) {
    const env = resolveEnv(node.project);
    if (env) await setActive(node.project.name, env.name);
  }
}

async function setActive(projectName: string, envName: string): Promise<void> {
  state.active = { project: projectName, env: envName };
  await extensionContext.workspaceState.update(ACTIVE_KEY, state.active);
  projectsProvider.refresh();
  if (pioCtx) statusBar.update(state, pioCtx);
}

async function pickActive(): Promise<void> {
  const items = state.projects.flatMap(project =>
    project.envs.map(env => ({
      label: `${project.name} / ${env.name}`,
      description: env.board ?? "",
      projectName: project.name,
      envName: env.name,
    }))
  );
  if (items.length === 0) {
    vscode.window.showInformationMessage("没有可用的工程环境。");
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "选择当前工程环境" });
  if (picked) await setActive(picked.projectName, picked.envName);
}

async function openIni(node: unknown): Promise<void> {
  let iniPath: string | undefined;
  if (node instanceof ProjectNode) iniPath = node.project.iniPath;
  else if (node instanceof EnvNode) iniPath = node.project.iniPath;
  if (!iniPath) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(iniPath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function openPath(node: unknown): Promise<void> {
  if (!(node instanceof CacheEntryNode)) return;
  if (!fs.existsSync(node.entry.path)) {
    vscode.window.showInformationMessage(`目录不存在：${node.entry.path}`);
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(node.entry.path));
}

async function openCheckFile(node: unknown): Promise<void> {
  if (!(node instanceof LockNode)) return;
  const file = node.check.file;
  if (!file || !fs.existsSync(file)) {
    vscode.window.showInformationMessage("没有可打开的相关文件。");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function checkUpdates(): Promise<void> {
  if (!repoRoot || !pioCtx) return;
  out.clear();
  out.show(true);
  for (const project of state.projects) {
    out.appendLine(`===== ${project.name} =====`);
    const res = await runPio(pioCtx, ["pkg", "outdated", "-d", project.dir], 120000);
    const body = (res.stdout || res.stderr || "").trim();
    out.appendLine(body || "(无依赖或已是最新)");
    out.appendLine("");
  }
  vscode.window.showInformationMessage("依赖更新检查完成，结果见「统一嵌入式」输出面板。");
}

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

async function newProjectWizard(): Promise<void> {
  const mode = await vscode.window.showQuickPick(
    [
      { id: "new", label: "新建工程", description: "在 projects/ 下创建新的 PlatformIO 工程" },
      { id: "add", label: "给现有工程添加环境", description: "在已有 platformio.ini 里追加板卡环境" },
    ],
    { placeHolder: "要做什么？" }
  );
  if (!mode) return;
  if (mode.id === "new") await createProjectWizard();
  else await addEnvironmentWizard();
}

async function createProjectWizard(): Promise<void> {
  if (!repoRoot || !pioCtx) return;

  const name = await vscode.window.showInputBox({
    prompt: "工程名（会在 projects/ 下创建同名目录）",
    value: "blinky",
    validateInput: validateProjectName,
  });
  if (!name) return;
  const projectName = name.trim();
  const projectDir = path.join(repoRoot, "projects", projectName);
  if (fs.existsSync(projectDir)) {
    vscode.window.showErrorMessage(`projects/${projectName} 已存在，换一个名字。`);
    return;
  }

  const env = await buildEnvConfig();
  if (!env) return;

  const versionText = env.platformVersion ? `@${env.platformVersion}` : "（未锁定，建议首次构建后锁定）";
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

  state.active = { project: projectName, env: env.envName };
  await extensionContext.workspaceState.update(ACTIVE_KEY, state.active);
  await refreshAll();

  const build = await vscode.window.showInformationMessage(
    `工程已创建：projects/${projectName}（首次构建会下载平台与工具链）`,
    "现在构建",
    "稍后"
  );
  if (build === "现在构建") {
    const project = state.projects.find(p => p.name === projectName);
    const envModel = project?.envs.find(e => e.name === env.envName);
    if (project && envModel) await runActionFor({ project, env: envModel }, "build");
  }
}

async function addEnvironmentWizard(): Promise<void> {
  if (!repoRoot || !pioCtx) return;
  if (state.projects.length === 0) {
    vscode.window.showInformationMessage("还没有工程，先用「新建 PlatformIO 工程」。");
    return;
  }

  const projectPick = await vscode.window.showQuickPick(
    state.projects.map(p => ({ label: p.name, description: `projects/${p.name}`, project: p })),
    { placeHolder: "选择要添加环境的工程" }
  );
  if (!projectPick) return;

  const env = await buildEnvConfig();
  if (!env) return;

  try {
    await addEnvironment(projectPick.project.iniPath, env);
  } catch (err) {
    vscode.window.showErrorMessage(`添加失败：${String(err)}`);
    return;
  }

  await refreshAll();
  vscode.window.showInformationMessage(
    `已在 ${projectPick.label} 添加环境 [env:${env.envName}]，可在「工程」视图切换。`
  );
}

/** Shared flow: platform -> board -> framework -> pinned version -> env name. */
async function buildEnvConfig(): Promise<EnvConfig | undefined> {
  if (!pioCtx) return undefined;

  const platform = await pickPlatform();
  if (!platform) return undefined;

  const board = await pickBoard(platform.id);
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

async function pickBoard(platformId: string): Promise<BoardInfo | undefined> {
  if (!pioCtx) return undefined;

  const query = platformId.includes("/") ? (platformId.split("/").pop() as string) : platformId;
  let boards: BoardInfo[] = [];
  try {
    boards = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `读取 ${platformId} 板卡列表…`,
        cancellable: false,
      },
      () => listPlatformBoards(pioCtx as PioContext, query)
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

async function ensureEsptool(): Promise<boolean> {
  if (!pioCtx) return false;
  if (findEsptool(pioCtx)) return true;

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
    () => installEsptool(pioCtx as PioContext)
  );
  if (!result.ok) {
    vscode.window.showErrorMessage(`esptool 安装失败：${result.message}`);
    return false;
  }
  if (!findEsptool(pioCtx)) {
    vscode.window.showErrorMessage("esptool 安装完成但未找到工具目录，请重试或先构建一次。");
    return false;
  }
  return true;
}

async function detectChipWithProgress(port: string): Promise<ChipInfo | undefined> {
  if (!pioCtx) return undefined;
  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在识别 ${port} 芯片…`,
      cancellable: false,
    },
    () => detectChip(pioCtx as PioContext, port)
  );
  if (!outcome.info) {
    vscode.window.showErrorMessage(`识别失败：${outcome.error ?? "未知错误"}`);
    return undefined;
  }
  devicesProvider.setChipInfo(port, outcome.info);
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

async function detectChipForNode(node: unknown): Promise<void> {
  if (!(node instanceof SerialDeviceNode)) return;
  const port = node.device.port;

  const confirmed = await vscode.window.showWarningMessage(
    `识别芯片会复位板子并短暂占用 ${port}（请先关闭串口监视），继续？`,
    { modal: true },
    "开始识别"
  );
  if (confirmed !== "开始识别") return;
  if (!(await ensureEsptool())) return;

  const info = await detectChipWithProgress(port);
  if (!info) return;
  vscode.window.showInformationMessage(describeChip(info), { modal: true });
}

/**
 * Create a project directly from a serial port: detect the chip (or reuse an
 * earlier detection), then offer only the platforms/boards/frameworks that fit.
 */
async function newProjectForDevice(node: unknown): Promise<void> {
  if (!(node instanceof SerialDeviceNode)) return;
  if (!pioCtx || !repoRoot) return;
  const port = node.device.port;

  let chip = devicesProvider.getChipInfo(port);
  if (!chip) {
    const confirmed = await vscode.window.showWarningMessage(
      `需要先读取 ${port} 的芯片信息（会复位板子并短暂占用串口），继续？`,
      { modal: true },
      "读取并继续"
    );
    if (confirmed !== "读取并继续") return;
    if (!(await ensureEsptool())) return;
    chip = await detectChipWithProgress(port);
    if (!chip) return;
  }

  const platformId = platformForChip(chip);
  if (!platformId) {
    vscode.window.showWarningMessage(
      `未能从芯片信息（${chip.chip ?? chip.chipType ?? "未知"}）确定平台，改用完整新建向导。`
    );
    await newProjectWizard();
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: `为 ${chip.chip ?? chip.chipType}（${port}）新建工程`,
    value: "blinky",
    validateInput: validateProjectName,
  });
  if (!name) return;
  const projectName = name.trim();
  const projectDir = path.join(repoRoot, "projects", projectName);
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
    () => listPlatformBoards(pioCtx as PioContext, platformId)
  );
  if (allBoards.length === 0) {
    vscode.window.showErrorMessage(`读取 ${platformId} 板卡列表失败，请检查网络后重试。`);
    return;
  }

  const candidates = filterBoardsForChip(allBoards, chip);
  let board = candidates.length > 0
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
    board = await pickBoard(platformId);
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

  state.active = { project: projectName, env: env.envName };
  await extensionContext.workspaceState.update(ACTIVE_KEY, state.active);
  await refreshAll();

  const project = state.projects.find(p => p.name === projectName);
  const envModel = project?.envs.find(e => e.name === env.envName);
  const next = await vscode.window.showInformationMessage(
    `工程已创建：projects/${projectName}（${chip.chip ?? chip.chipType}）`,
    `构建并烧录到 ${port}`,
    "仅构建",
    "稍后"
  );
  if (project && envModel) {
    if (next && next.startsWith("构建并烧录")) {
      await runActionFor({ project, env: envModel }, "flash", port);
    } else if (next === "仅构建") {
      await runActionFor({ project, env: envModel }, "build");
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

async function deleteProject(node: unknown): Promise<void> {
  if (!(node instanceof ProjectNode) || !repoRoot) return;
  const project = node.project;

  const confirmed = await vscode.window.showWarningMessage(
    `确定删除工程 projects/${project.name}？\n目录会被永久删除（不进回收站）：\n${project.dir}`,
    { modal: true },
    "删除"
  );
  if (confirmed !== "删除") return;

  let deleted = false;
  for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
    const error = await attemptDeleteProject(project.dir);
    if (!error) {
      deleted = true;
      break;
    }
    const answer = await vscode.window.showErrorMessage(
      `删除失败：${error}\n\n通常是有程序正占用该目录（集成终端、串口监视、编辑器或资源管理器）。\n已尝试关闭工作目录在该工程内的 VS Code 终端，你可以关闭相关窗口后再试。`,
      "重试",
      "取消"
    );
    if (answer !== "重试") return;
  }
  if (!deleted) {
    out.appendLine(`[delete] 删除工程失败：projects/${project.name}`);
    return;
  }

  if (state.active?.project === project.name) {
    state.active = undefined;
    await extensionContext.workspaceState.update(ACTIVE_KEY, undefined);
  }

  await refreshAll();
  vscode.window.showInformationMessage(`已删除工程：projects/${project.name}`);
}

function pathIsInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function closeTabsInside(targetDir: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
  const toClose = tabs.filter(tab => {
    const input = tab.input as { uri?: vscode.Uri } | undefined;
    return input?.uri instanceof vscode.Uri && pathIsInside(targetDir, input.uri.fsPath);
  });
  if (toClose.length > 0) {
    await vscode.window.tabGroups.close(toClose, true);
  }
}

async function closeTerminalsInside(targetDir: string): Promise<number> {
  let closed = 0;
  for (const terminal of vscode.window.terminals) {
    const options = terminal.creationOptions as vscode.TerminalOptions;
    const cwdOption = options.cwd;
    const cwd =
      typeof cwdOption === "string"
        ? cwdOption
        : cwdOption && typeof cwdOption === "object" && "fsPath" in cwdOption
          ? cwdOption.fsPath
          : undefined;
    if (!cwd || !pathIsInside(targetDir, cwd)) continue;

    if (terminal === buildTerminal) {
      buildTerminal = undefined;
      buildTerminalCwd = undefined;
    }
    if (terminal === monitorTerminal) {
      monitorTerminal = undefined;
      monitorTerminalCwd = undefined;
    }
    terminal.dispose();
    closed++;
  }
  if (closed > 0) {
    // Give the shells a moment to die so Windows releases the directory handle.
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  return closed;
}

async function attemptDeleteProject(projectDir: string): Promise<string | undefined> {
  if (!repoRoot) return "仓库根目录未知";
  try {
    await closeTabsInside(projectDir);
    const closed = await closeTerminalsInside(projectDir);
    if (closed > 0) out.appendLine(`[delete] 关闭了 ${closed} 个占用终端`);
    await deleteProjectDirectory(projectDir, path.join(repoRoot, "projects"));
    return undefined;
  } catch (err) {
    return String(err);
  }
}
