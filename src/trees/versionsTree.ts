import * as vscode from "vscode";
import { CheckStatus, LockCheck } from "../core/versions";

const STATUS_ICON: Record<CheckStatus, string> = {
  ok: "pass-filled",
  info: "info",
  warn: "warning",
  error: "error",
};

export class LockNode {
  constructor(public readonly check: LockCheck) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.check.label,
      this.check.children && this.check.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.description = this.check.detail;
    item.iconPath = new vscode.ThemeIcon(STATUS_ICON[this.check.status]);
    item.contextValue = "versionCheck";
    if (this.check.children && this.check.children.length > 0) {
      item.tooltip = new vscode.MarkdownString(
        `**${this.check.label}**\n\n${this.check.children.map(c => `- ${c.label}: ${c.detail}`).join("\n")}`
      );
    }
    if (this.check.file) {
      item.command = {
        command: "embeddedEnv.openCheckFile",
        title: "打开相关文件",
        arguments: [this],
      };
    }
    return item;
  }
}

export type VersionsTreeItem = LockNode;

export class VersionsProvider implements vscode.TreeDataProvider<VersionsTreeItem> {
  private readonly emitter = new vscode.EventEmitter<VersionsTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private checks: LockCheck[] | undefined;

  setChecks(checks: LockCheck[]): void {
    this.checks = checks;
    this.emitter.fire();
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: VersionsTreeItem): vscode.TreeItem {
    return element.toTreeItem();
  }

  getChildren(element?: VersionsTreeItem): VersionsTreeItem[] {
    if (!this.checks) {
      return [];
    }
    if (!element) {
      return this.checks.map(c => new LockNode(c));
    }
    return (element.check.children ?? []).map(c => new LockNode(c));
  }
}
