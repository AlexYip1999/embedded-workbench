import * as path from "path";
import * as vscode from "vscode";
import { EnvModel, ProjectModel } from "../core/repo";
import { boardHint } from "../core/boards";
import { listProjectSources } from "../core/sources";

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
    item.tooltip.appendMarkdown(`- 当前环境: \`${this.activeEnv ?? "-"}\`\n`);
    item.tooltip.appendMarkdown("- 点击打开源码（`src/main.cpp`）\n");
    item.tooltip.appendMarkdown("- 展开后可看到「源码」和板卡环境");
    item.contextValue = "project";
    item.iconPath = new vscode.ThemeIcon("circuit-board");
    item.command = {
      command: "embeddedEnv.openSource",
      title: "打开源码",
      arguments: [this],
    };
    return item;
  }
}

/** Group node that lists the project sources under `src/`. */
export class SourceGroupNode {
  public readonly kind = "sourceGroup";
  constructor(public readonly project: ProjectModel) {}

  toTreeItem(): vscode.TreeItem {
    const files = listProjectSources(this.project.dir);
    const item = new vscode.TreeItem(
      "源码",
      files.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    item.description = files.length > 0 ? `${files.length} 个文件` : "无";
    item.contextValue = "sourceGroup";
    item.iconPath = new vscode.ThemeIcon("file-code");
    item.tooltip = path.join(this.project.dir, "src");
    return item;
  }
}

export class SourceFileNode {
  public readonly kind = "sourceFile";
  constructor(
    public readonly project: ProjectModel,
    public readonly filePath: string
  ) {}

  toTreeItem(): vscode.TreeItem {
    const srcDir = path.join(this.project.dir, "src");
    const relative = path.relative(srcDir, this.filePath) || path.basename(this.filePath);
    const item = new vscode.TreeItem(relative, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "sourceFile";
    item.iconPath = new vscode.ThemeIcon("file-code");
    item.tooltip = this.filePath;
    item.command = {
      command: "vscode.open",
      title: "打开源码",
      arguments: [vscode.Uri.file(this.filePath)],
    };
    return item;
  }
}

export class SourceHintNode {
  public readonly kind = "sourceHint";
  constructor(public readonly message: string) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "sourceHint";
    item.iconPath = new vscode.ThemeIcon("info");
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

export type ProjectTreeItem =
  | ProjectNode
  | SourceGroupNode
  | SourceFileNode
  | SourceHintNode
  | EnvNode;

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
      const envNodes = element.project.envs.map(
        env => new EnvNode(element.project, env, activeProject && state.active?.env === env.name)
      );
      return [new SourceGroupNode(element.project), ...envNodes];
    }
    if (element instanceof SourceGroupNode) {
      const files = listProjectSources(element.project.dir);
      if (files.length === 0) {
        return [new SourceHintNode("src/ 下没有源码文件")];
      }
      return files.map(file => new SourceFileNode(element.project, file));
    }
    return [];
  }
}
