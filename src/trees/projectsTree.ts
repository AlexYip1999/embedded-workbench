import * as vscode from "vscode";
import { EnvModel, ProjectModel } from "../core/repo";
import { boardHint } from "../core/boards";

export interface ActiveRef {
  project: string;
  env: string;
}

export interface ProjectsState {
  projects: ProjectModel[];
  active?: ActiveRef;
}

export class ProjectNode {
  public readonly kind = "project";
  constructor(public readonly project: ProjectModel, public readonly activeEnv?: string) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.project.name, vscode.TreeItemCollapsibleState.Collapsed);
    const envCount = this.project.envs.length;
    const defaultEnv = this.project.defaultEnvs[0];
    item.description = envCount === 1 ? "1 env" : `${envCount} env`;
    item.tooltip = new vscode.MarkdownString();
    item.tooltip.appendMarkdown(`**${this.project.name}**\n\n`);
    item.tooltip.appendMarkdown(`- 目录: \`${this.project.dir}\`\n`);
    item.tooltip.appendMarkdown(`- 默认环境: \`${defaultEnv ?? "-"}\`\n`);
    item.tooltip.appendMarkdown(`- 当前环境: \`${this.activeEnv ?? "-"}\``);
    item.contextValue = "project";
    item.iconPath = new vscode.ThemeIcon("circuit-board");
    item.command = {
      command: "embeddedEnv.openIni",
      title: "打开 platformio.ini",
      arguments: [this],
    };
    return item;
  }
}

export class EnvNode {
  public readonly kind = "env";
  constructor(
    public readonly project: ProjectModel,
    public readonly env: EnvModel,
    public readonly active: boolean
  ) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.env.name, vscode.TreeItemCollapsibleState.None);
    const hint = boardHint(this.env.board);
    const parts: string[] = [];
    if (this.env.board) parts.push(this.env.board);
    if (hint?.flashMb) parts.push(`${hint.flashMb}MB`);
    parts.push(this.active ? "● 当前" : "");
    item.description = parts.filter(Boolean).join(" · ");
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${this.project.name} / ${this.env.name}**\n\n`);
    tip.appendMarkdown(`- board: \`${this.env.board ?? "-"}\`\n`);
    tip.appendMarkdown(`- platform: \`${this.env.platform ?? "-"}\`\n`);
    tip.appendMarkdown(`- framework: \`${this.env.framework ?? "-"}\``);
    if (hint?.note) tip.appendMarkdown(`\n- ${hint.note}`);
    item.tooltip = tip;
    item.contextValue = "env";
    item.iconPath = new vscode.ThemeIcon(this.active ? "circle-filled" : "circle-outline");
    item.command = {
      command: "embeddedEnv.setActiveEnv",
      title: "设为当前环境",
      arguments: [this],
    };
    return item;
  }
}

export type ProjectTreeItem = ProjectNode | EnvNode;

export class ProjectsProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ProjectTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getState: () => ProjectsState) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: ProjectTreeItem): vscode.TreeItem {
    return element.toTreeItem();
  }

  getChildren(element?: ProjectTreeItem): ProjectTreeItem[] {
    const state = this.getState();
    if (!element) {
      return state.projects.map(project => {
        const active =
          state.active && state.active.project === project.name ? state.active.env : undefined;
        return new ProjectNode(project, active);
      });
    }
    if (element instanceof ProjectNode) {
      const activeProject = state.active?.project === element.project.name;
      return element.project.envs.map(
        env => new EnvNode(element.project, env, activeProject && state.active?.env === env.name)
      );
    }
    return [];
  }
}
