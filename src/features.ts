import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { hasProjectsDir, resolveEnv } from "./core/repo";
import { runPio } from "./core/pio";
import { collectSizeEntries } from "./core/sizes";
import { findProjectSource } from "./core/sources";
import { collectLockChecks, LockCheck } from "./core/versions";
import { deleteProjectDirectory } from "./core/scaffold";
import { CacheEntryNode } from "./trees/cacheTree";
import { SerialDeviceNode } from "./trees/devicesTree";
import { EnvNode, ProjectNode } from "./trees/projectsTree";
import { LockNode } from "./trees/versionsTree";
import type { Workbench } from "./workbench";

export async function collectVersionChecks(wb: Workbench): Promise<LockCheck[]> {
  if (!wb.repoRoot || !wb.pioCtx) return [];
  return collectLockChecks(wb.repoRoot, wb.pioCtx, wb.state.projects);
}

export async function computeSizes(wb: Workbench, notify: boolean): Promise<void> {
  if (!wb.repoRoot) return;
  wb.cacheProvider.setComputing(true);
  try {
    const task = collectSizeEntries(wb.repoRoot, wb.state.projects);
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
    wb.cacheProvider.setEntries(entries);
  } catch (err) {
    wb.out.appendLine(`[error] 统计体积失败: ${String(err)}`);
    wb.cacheProvider.setComputing(false);
  }
}

export async function cleanBuild(wb: Workbench, node: unknown): Promise<void> {
  if (!(node instanceof CacheEntryNode)) return;
  const projectName = node.entry.projectName;
  if (!projectName) return;
  const project = wb.state.projects.find(p => p.name === projectName);
  if (!project) return;
  const term = wb.getBuildTerminal(project.dir, `PlatformIO Clean · ${project.name}`);
  term.show(true);
  term.sendText(wb.terminalCommand(["run", "-t", "clean"]), true);
}

export async function setActiveFromNode(wb: Workbench, node: unknown): Promise<void> {
  if (node instanceof EnvNode) {
    await wb.setActive(node.project.name, node.env.name);
  } else if (node instanceof ProjectNode) {
    const env = resolveEnv(node.project);
    if (env) await wb.setActive(node.project.name, env.name);
  }
}

export async function pickActive(wb: Workbench): Promise<void> {
  const items = wb.state.projects.flatMap(project =>
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
  if (picked) await wb.setActive(picked.projectName, picked.envName);
}

export async function openIni(wb: Workbench, node: unknown): Promise<void> {
  let iniPath: string | undefined;
  if (node instanceof ProjectNode) iniPath = node.project.iniPath;
  else if (node instanceof EnvNode) iniPath = node.project.iniPath;
  if (!iniPath) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(iniPath));
  await vscode.window.showTextDocument(doc, { preview: false });
}

export async function openSource(wb: Workbench, node: unknown): Promise<void> {
  let project = undefined as ProjectNode["project"] | undefined;
  if (node instanceof ProjectNode) project = node.project;
  else if (node instanceof EnvNode) project = node.project;
  if (!project) return;

  const source = findProjectSource(project.dir);
  if (!source) {
    vscode.window.showInformationMessage(
      `projects/${project.name} 的 src/ 下没有可打开的源码文件（.cpp/.c/.ino）。`
    );
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
  await vscode.window.showTextDocument(doc, { preview: false });
}

export async function openPath(wb: Workbench, node: unknown): Promise<void> {
  if (!(node instanceof CacheEntryNode)) return;
  if (!fs.existsSync(node.entry.path)) {
    vscode.window.showInformationMessage(`目录不存在：${node.entry.path}`);
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(node.entry.path));
}

export async function openCheckFile(wb: Workbench, node: unknown): Promise<void> {
  if (!(node instanceof LockNode)) return;
  const file = node.check.file;
  if (!file || !fs.existsSync(file)) {
    vscode.window.showInformationMessage("没有可打开的相关文件。");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: true });
}

export async function checkVersions(wb: Workbench): Promise<void> {
  if (!wb.pioCtx || !wb.repoRoot) return;
  if (!hasProjectsDir(wb.repoRoot)) {
    vscode.window.showInformationMessage("当前工作区不是嵌入式工程目录（缺少 projects/）。");
    return;
  }
  try {
    const checks = await collectVersionChecks(wb);
    wb.out.show(true);
    wb.out.appendLine("===== 版本体检 =====");
    let issues = 0;
    for (const check of checks) {
      wb.out.appendLine(`${check.status.toUpperCase().padEnd(5)} ${check.label} — ${check.detail}`);
      if (check.status === "warn" || check.status === "error") issues++;
      for (const child of check.children ?? []) {
        wb.out.appendLine(
          `      ${child.status.toUpperCase().padEnd(5)} ${child.label}: ${child.detail}`
        );
      }
    }
    vscode.window.showInformationMessage(
      `版本体检完成：${checks.length} 项，${issues} 项需要注意。结果见「统一嵌入式」输出面板。`
    );
  } catch (err) {
    vscode.window.showErrorMessage(`版本体检失败：${String(err)}`);
  }
}

export async function checkUpdates(wb: Workbench): Promise<void> {
  if (!wb.repoRoot || !wb.pioCtx) return;
  wb.out.clear();
  wb.out.show(true);
  for (const project of wb.state.projects) {
    wb.out.appendLine(`===== ${project.name} =====`);
    const res = await runPio(wb.pioCtx, ["pkg", "outdated", "-d", project.dir], 120000);
    const body = (res.stdout || res.stderr || "").trim();
    wb.out.appendLine(body || "(无依赖或已是最新)");
    wb.out.appendLine("");
  }
  vscode.window.showInformationMessage("依赖更新检查完成，结果见「统一嵌入式」输出面板。");
}

export async function copyPortName(wb: Workbench, node: unknown): Promise<void> {
  if (!(node instanceof SerialDeviceNode)) return;
  await vscode.env.clipboard.writeText(node.device.port);
  vscode.window.showInformationMessage(`已复制端口名：${node.device.port}`);
}

// ---------------------------------------------------------------------------
// Project deletion (with terminal/tab cleanup on Windows)
// ---------------------------------------------------------------------------

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

async function closeTerminalsInside(wb: Workbench, targetDir: string): Promise<number> {
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

    if (terminal === wb.buildTerminal) {
      wb.buildTerminal = undefined;
      wb.buildTerminalCwd = undefined;
    }
    if (terminal === wb.monitorTerminal) {
      wb.monitorTerminal = undefined;
      wb.monitorTerminalCwd = undefined;
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

async function attemptDeleteProject(
  wb: Workbench,
  projectDir: string
): Promise<string | undefined> {
  if (!wb.repoRoot) return "仓库根目录未知";
  try {
    await closeTabsInside(projectDir);
    const closed = await closeTerminalsInside(wb, projectDir);
    if (closed > 0) wb.out.appendLine(`[delete] 关闭了 ${closed} 个占用终端`);
    await deleteProjectDirectory(projectDir, path.join(wb.repoRoot, "projects"));
    return undefined;
  } catch (err) {
    return String(err);
  }
}

export async function deleteProject(wb: Workbench, node: unknown): Promise<void> {
  if (!(node instanceof ProjectNode) || !wb.repoRoot) return;
  const project = node.project;

  const confirmed = await vscode.window.showWarningMessage(
    `确定删除工程 projects/${project.name}？\n目录会被永久删除（不进回收站）：\n${project.dir}`,
    { modal: true },
    "删除"
  );
  if (confirmed !== "删除") return;

  let deleted = false;
  for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
    const error = await attemptDeleteProject(wb, project.dir);
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
    wb.out.appendLine(`[delete] 删除工程失败：projects/${project.name}`);
    return;
  }

  if (wb.state.active?.project === project.name) {
    await wb.clearActive();
  }

  await wb.refreshAll();
  vscode.window.showInformationMessage(`已删除工程：projects/${project.name}`);
}
