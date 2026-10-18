import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  EnvModel,
  ProjectModel,
  findRepoRoot,
  hasProjectsDir,
  resolveEnv,
  scanProjects,
} from "./core/repo";
import { PioContext, locatePio, runPio } from "./core/pio";
import { PLATFORMIO_VERSION } from "./core/constants";
import { ensureEnvironment } from "./core/bootstrap";
import { scanSerialDevices } from "./core/ports";
import { CacheProvider } from "./trees/cacheTree";
import { DevicesProvider, SerialDeviceNode } from "./trees/devicesTree";
import { EnvNode, ProjectNode, ProjectsProvider, ProjectsState } from "./trees/projectsTree";
import { VersionsProvider } from "./trees/versionsTree";
import { StatusBar } from "./statusbar";
import { registerCommands } from "./commands";
import * as features from "./features";

export interface Target {
  project: ProjectModel;
  env: EnvModel;
}

export type RunAction = "build" | "flash" | "monitor" | "clean" | "flashMonitor";

const ACTIVE_KEY = "embeddedEnv.active";

/**
 * Composition root for the extension: owns the workspace state, tree providers,
 * terminal handles and the PlatformIO context. Command handlers are registered
 * by `commands.ts` and delegate back into this class or the feature modules.
 */
export class Workbench implements vscode.Disposable {
  readonly context: vscode.ExtensionContext;
  readonly out: vscode.OutputChannel;

  repoRoot?: string;
  pioCtx?: PioContext;
  state: ProjectsState = { projects: [] };

  projectsProvider: ProjectsProvider;
  devicesProvider: DevicesProvider;
  cacheProvider: CacheProvider;
  versionsProvider: VersionsProvider;
  statusBar: StatusBar;

  buildTerminal?: vscode.Terminal;
  buildTerminalCwd?: string;
  monitorTerminal?: vscode.Terminal;
  monitorTerminalCwd?: string;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.out = vscode.window.createOutputChannel("统一嵌入式");
    context.subscriptions.push(this.out);

    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    this.repoRoot =
      findRepoRoot(folders.length > 0 ? folders : [process.cwd()]) ??
      (folders.length > 0 ? folders[0] : undefined);

    const projectState = this.state;
    this.projectsProvider = new ProjectsProvider(() => projectState);
    this.devicesProvider = new DevicesProvider();
    this.cacheProvider = new CacheProvider();
    this.versionsProvider = new VersionsProvider();
    this.statusBar = new StatusBar();
    context.subscriptions.push(this.statusBar);
  }

  start(): void {
    if (!this.repoRoot) {
      vscode.window.showWarningMessage("统一嵌入式：请先打开一个文件夹作为工程目录。");
      return;
    }

    const cfg = vscode.workspace.getConfiguration("embeddedEnv");
    this.pioCtx = locatePio(
      this.repoRoot,
      cfg.get<string>("pioPath", ""),
      cfg.get<string>("coreDir", ".platformio")
    );
    this.state.active = this.context.workspaceState.get(ACTIVE_KEY);

    this.context.subscriptions.push(
      vscode.window.createTreeView("embeddedEnv.projects", {
        treeDataProvider: this.projectsProvider,
        showCollapseAll: true,
      }),
      vscode.window.createTreeView("embeddedEnv.devices", {
        treeDataProvider: this.devicesProvider,
      }),
      vscode.window.createTreeView("embeddedEnv.cache", {
        treeDataProvider: this.cacheProvider,
      }),
      vscode.window.createTreeView("embeddedEnv.versions", {
        treeDataProvider: this.versionsProvider,
      })
    );

    if (hasProjectsDir(this.repoRoot) && !fs.existsSync(this.pioCtx.pioExe)) {
      this.out.appendLine(`[warn] 未找到 pio：${this.pioCtx.pioExe}`);
      void vscode.window
        .showWarningMessage(
          "Embedded Workbench：还没有 PlatformIO 环境（首次使用需要安装）。",
          "初始化环境",
          "稍后"
        )
        .then(choice => {
          if (choice === "初始化环境") void this.bootstrapEnvironment();
        });
    }

    registerCommands(this);
    void this.refreshAll();
  }

  dispose(): void {
    // Views, terminals and the output channel are disposed by VS Code.
  }

  async refreshAll(): Promise<void> {
    if (!this.repoRoot) return;
    this.state.projects = scanProjects(this.repoRoot);

    if (this.state.active) {
      const project = this.state.projects.find(p => p.name === this.state.active?.project);
      if (!project || !project.envs.some(e => e.name === this.state.active?.env)) {
        this.state.active = undefined;
      }
    }
    if (!this.state.active && this.state.projects.length > 0) {
      const project = this.state.projects[0];
      const env = resolveEnv(project);
      if (env) this.state.active = { project: project.name, env: env.name };
    }

    this.projectsProvider.refresh();
    this.cacheProvider.reset();

    const workspaceReady = hasProjectsDir(this.repoRoot);
    if (this.pioCtx && workspaceReady) {
      const version = await this.readPioVersion();
      if (version) this.statusBar.setPioVersion(version);
      this.statusBar.update(this.state, this.pioCtx);

      try {
        this.versionsProvider.setChecks(await features.collectVersionChecks(this));
      } catch (err) {
        this.out.appendLine(`[error] 版本检查失败: ${String(err)}`);
      }

      void this.refreshDevices();
    } else if (!workspaceReady) {
      this.devicesProvider.setNotice(
        "当前工作区不是嵌入式工程目录（缺少 projects/），未扫描串口。"
      );
      this.versionsProvider.setChecks([
        {
          id: "workspace",
          label: "工作区",
          detail: "缺少 projects/ 目录，不是嵌入式工作区",
          status: "info",
        },
      ]);
    }
    void features.computeSizes(this, false);
  }

  async bootstrapEnvironment(): Promise<void> {
    if (!this.repoRoot) return;
    this.out.show(true);

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "初始化 PlatformIO 环境（首次需要下载）…",
        cancellable: false,
      },
      () =>
        ensureEnvironment(this.repoRoot as string, PLATFORMIO_VERSION, line =>
          this.out.appendLine(line)
        )
    );

    if (!result.ok) {
      vscode.window.showErrorMessage(`初始化失败：${result.message}`);
      return;
    }

    const cfg = vscode.workspace.getConfiguration("embeddedEnv");
    this.pioCtx = locatePio(
      this.repoRoot,
      cfg.get<string>("pioPath", ""),
      cfg.get<string>("coreDir", ".platformio")
    );
    await this.refreshAll();
    vscode.window.showInformationMessage(`环境已就绪：${result.message}`);
  }

  async refreshDevices(): Promise<void> {
    if (!this.pioCtx || !this.repoRoot) return;
    if (!hasProjectsDir(this.repoRoot)) {
      this.devicesProvider.setNotice(
        "当前工作区不是嵌入式工程目录（缺少 projects/），未扫描串口。"
      );
      return;
    }
    this.devicesProvider.setScanning();
    try {
      this.devicesProvider.setListing(await scanSerialDevices(this.pioCtx));
    } catch (err) {
      this.devicesProvider.setListing({
        serial: [],
        error: String(err),
        scannedAt: new Date().toLocaleTimeString(),
      });
    }
  }

  async focusPanel(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.embeddedEnv");
  }

  async focusDevices(): Promise<void> {
    await this.focusPanel();
    await vscode.commands.executeCommand("embeddedEnv.devices.focus");
    await this.refreshDevices();
  }

  async setActive(projectName: string, envName: string): Promise<void> {
    this.state.active = { project: projectName, env: envName };
    await this.context.workspaceState.update(ACTIVE_KEY, this.state.active);
    this.projectsProvider.refresh();
    if (this.pioCtx) this.statusBar.update(this.state, this.pioCtx);
  }

  async clearActive(): Promise<void> {
    this.state.active = undefined;
    await this.context.workspaceState.update(ACTIVE_KEY, undefined);
    this.projectsProvider.refresh();
    if (this.pioCtx) this.statusBar.update(this.state, this.pioCtx);
  }

  targetFromNode(node?: unknown): Target | undefined {
    if (node instanceof EnvNode) return { project: node.project, env: node.env };
    if (node instanceof ProjectNode) {
      const activeEnv =
        this.state.active && this.state.active.project === node.project.name
          ? this.state.active.env
          : undefined;
      const env = resolveEnv(node.project, activeEnv);
      return env ? { project: node.project, env } : undefined;
    }
    if (!this.state.active) return undefined;
    const project = this.state.projects.find(p => p.name === this.state.active?.project);
    if (!project) return undefined;
    const env = project.envs.find(e => e.name === this.state.active?.env);
    return env ? { project, env } : undefined;
  }

  async pickTarget(node?: unknown): Promise<Target | undefined> {
    const fromNode = this.targetFromNode(node);
    if (fromNode) return fromNode;

    const items = this.state.projects.flatMap(project =>
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

  async runTarget(node: unknown, action: RunAction, explicitPort?: string): Promise<void> {
    const target = await this.pickTarget(node);
    if (!target) return;
    await this.runActionFor(target, action, explicitPort);
  }

  async runActionFor(target: Target, action: RunAction, explicitPort?: string): Promise<void> {
    if (action === "monitor") {
      await this.startMonitor(target, explicitPort);
      return;
    }

    if (action === "flashMonitor") {
      const port = explicitPort ?? (await this.pickPort());
      const baud = this.monitorBaud(target);
      const uploadArgs = ["run", "-e", target.env.name, "-t", "upload"];
      if (port) uploadArgs.push("--upload-port", port);
      const monitorArgs = ["device", "monitor", "-b", String(baud)];
      if (port) monitorArgs.push("-p", port);

      const term = this.getBuildTerminal(
        target.project.dir,
        `PlatformIO Flash+Monitor · ${target.project.name}`
      );
      term.show(true);
      term.sendText(this.terminalChain(uploadArgs, monitorArgs), true);
      return;
    }

    const args: string[] = ["run", "-e", target.env.name];
    let title = `PlatformIO Build · ${target.project.name}`;

    if (action === "flash") {
      args.push("-t", "upload");
      const port = explicitPort ?? (await this.pickPort());
      if (port) args.push("--upload-port", port);
      title = `PlatformIO Flash · ${target.project.name}`;
    } else if (action === "clean") {
      args.push("-t", "clean");
      title = `PlatformIO Clean · ${target.project.name}`;
    }

    const term = this.getBuildTerminal(target.project.dir, title);
    term.show(true);
    term.sendText(this.terminalCommand(args), true);
  }

  async runTargetToPort(
    node: unknown,
    action: "flash" | "monitor" | "flashMonitor"
  ): Promise<void> {
    if (!(node instanceof SerialDeviceNode)) return;
    await this.runTarget(undefined, action, node.device.port);
  }

  /** Honour the project's monitor_speed when present, else the extension setting. */
  private monitorBaud(target?: Target): number {
    const configured = vscode.workspace.getConfiguration("embeddedEnv").get<number>("baud", 115200);
    const envSpeed = Number(target?.env.monitorSpeed);
    return Number.isFinite(envSpeed) && envSpeed > 0 ? envSpeed : configured;
  }

  private async startMonitor(target: Target, explicitPort?: string): Promise<void> {
    const baud = this.monitorBaud(target);
    const port = explicitPort ?? (await this.pickPort());
    const args = ["device", "monitor", "-b", String(baud)];
    if (port) args.push("-p", port);

    if (
      !this.monitorTerminal ||
      this.monitorTerminal.exitStatus !== undefined ||
      this.monitorTerminalCwd !== target.project.dir
    ) {
      this.monitorTerminal?.dispose();
      this.monitorTerminal = vscode.window.createTerminal({
        name: `Monitor · ${target.project.name}`,
        cwd: target.project.dir,
        env: this.terminalEnv(),
      });
      this.monitorTerminalCwd = target.project.dir;
    }
    this.monitorTerminal.show(true);
    this.monitorTerminal.sendText(this.terminalCommand(args), true);
  }

  async pickPort(): Promise<string | undefined> {
    if (!this.pioCtx) return undefined;
    const listing = await scanSerialDevices(this.pioCtx);
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

  terminalEnv(): { [key: string]: string } {
    const env: { [key: string]: string } = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    if (this.pioCtx) env.PLATFORMIO_CORE_DIR = this.pioCtx.coreDir;
    env.PYTHONIOENCODING = "utf-8";
    env.PYTHONUTF8 = "1";
    return env;
  }

  getBuildTerminal(cwd: string, title: string): vscode.Terminal {
    if (
      !this.buildTerminal ||
      this.buildTerminal.exitStatus !== undefined ||
      this.buildTerminalCwd !== cwd
    ) {
      this.buildTerminal?.dispose();
      this.buildTerminal = vscode.window.createTerminal({
        name: title,
        cwd,
        env: this.terminalEnv(),
      });
      this.buildTerminalCwd = cwd;
    }
    return this.buildTerminal;
  }

  private quoteCli(value: string): string {
    return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  }

  private pioLine(args: string[]): string {
    if (!this.pioCtx) return "";
    return `"${this.pioCtx.pioExe}" ${args.map(arg => this.quoteCli(arg)).join(" ")}`;
  }

  private isPowerShellShell(): boolean {
    const shell = path.basename(vscode.env.shell || "").toLowerCase();
    return shell.includes("powershell") || shell.includes("pwsh");
  }

  terminalCommand(args: string[]): string {
    const line = this.pioLine(args);
    return this.isPowerShellShell() ? `& ${line}` : line;
  }

  /**
   * Flash first, then open the serial monitor in the same terminal so the boot
   * output is visible right away. Monitor only starts when the upload succeeded.
   */
  private terminalChain(uploadArgs: string[], monitorArgs: string[]): string {
    const upload = this.terminalCommand(uploadArgs);
    const monitor = this.terminalCommand(monitorArgs);
    if (this.isPowerShellShell()) {
      return `${upload} ; if ($LASTEXITCODE -eq 0) { ${monitor} }`;
    }
    return `${upload} && ${monitor}`;
  }

  private async readPioVersion(): Promise<string | undefined> {
    if (!this.pioCtx) return undefined;
    const res = await runPio(this.pioCtx, ["--version"], 15000);
    return /version\s+([0-9][^\s,]*)/i.exec(`${res.stdout}\n${res.stderr}`)?.[1];
  }

  /** Export for wizards that need the current PlatformIO context. */
  requirePio(): PioContext | undefined {
    return this.pioCtx;
  }
}
