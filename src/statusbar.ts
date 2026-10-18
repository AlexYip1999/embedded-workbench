import * as vscode from "vscode";
import { PioContext } from "./core/pio";
import { ProjectsState } from "./trees/projectsTree";

interface ActiveInfo {
  projectName: string;
  envName: string;
  board?: string;
}

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private pioVersion = "?";

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "embeddedEnv.pickActive";
    this.item.text = "$(circuit-board) 统一嵌入式";
    this.item.tooltip = "选择当前工程环境";
    this.item.show();
  }

  setPioVersion(version: string): void {
    this.pioVersion = version;
  }

  update(state: ProjectsState, ctx: PioContext): void {
    const active = this.current(state);
    this.item.text = active
      ? `$(circuit-board) ${active.envName}${active.board ? ` · ${active.board}` : ""}`
      : "$(circuit-board) 未选择环境";

    const tip = new vscode.MarkdownString();
    tip.appendMarkdown("**Embedded Workbench**\n\n");
    if (active) {
      tip.appendMarkdown(`- 工程: \`${active.projectName}\`\n`);
      tip.appendMarkdown(`- 环境: \`${active.envName}\`\n`);
      tip.appendMarkdown(`- 板卡: \`${active.board ?? "-"}\`\n`);
    } else {
      tip.appendMarkdown("- 未选择环境（点击选择）\n");
    }
    tip.appendMarkdown(`- PlatformIO: \`${this.pioVersion}\`\n`);
    tip.appendMarkdown(`- 缓存目录: \`${ctx.coreDir}\``);
    this.item.tooltip = tip;
  }

  private current(state: ProjectsState): ActiveInfo | undefined {
    if (!state.active) return undefined;
    const project = state.projects.find(p => p.name === state.active?.project);
    if (!project) return undefined;
    const env = project.envs.find(e => e.name === state.active?.env);
    if (!env) return undefined;
    return { projectName: project.name, envName: env.name, board: env.board };
  }

  dispose(): void {
    this.item.dispose();
  }
}
