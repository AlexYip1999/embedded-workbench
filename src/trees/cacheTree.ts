import * as vscode from "vscode";
import { SizeEntry, SizeGroup, formatBytes } from "../core/sizes";

export class CacheGroupNode {
  public readonly kind = "cacheGroup";
  constructor(public readonly group: SizeGroup, public readonly label: string) {}

  toTreeItem(hasChildren: boolean): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.label,
      hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = "cacheGroup";
    item.iconPath = new vscode.ThemeIcon(
      this.group === "pio" ? "package" : this.group === "python" ? "symbol-package" : "archive"
    );
    return item;
  }
}

export class CacheEntryNode {
  public readonly kind = "cacheEntry";
  constructor(public readonly entry: SizeEntry) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.entry.label, vscode.TreeItemCollapsibleState.None);
    if (!this.entry.exists) {
      item.description = "不存在";
      item.iconPath = new vscode.ThemeIcon("circle-slash");
    } else {
      item.description = formatBytes(this.entry.bytes);
      item.iconPath = new vscode.ThemeIcon("folder-library");
    }
    item.tooltip = `${this.entry.path}\n${this.entry.exists ? formatBytes(this.entry.bytes) : "不存在"}`;
    item.contextValue = this.entry.group === "build" ? "buildCache" : "cacheItem";
    item.command = {
      command: "embeddedEnv.openPath",
      title: "在资源管理器中打开",
      arguments: [this],
    };
    return item;
  }
}

export class CacheInfoNode {
  public readonly kind = "cacheInfo";
  constructor(public readonly message: string) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "cacheInfo";
    item.iconPath = new vscode.ThemeIcon("info");
    return item;
  }
}

export type CacheTreeItem = CacheGroupNode | CacheEntryNode | CacheInfoNode;

const GROUP_LABELS: Record<SizeGroup, string> = {
  pio: "PlatformIO 缓存",
  python: "Python 环境",
  build: "构建产物",
};

const GROUP_ORDER: SizeGroup[] = ["pio", "python", "build"];

export class CacheProvider implements vscode.TreeDataProvider<CacheTreeItem> {
  private readonly emitter = new vscode.EventEmitter<CacheTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private entries: SizeEntry[] | undefined;
  private computing = false;
  private computedAt: string | undefined;

  refresh(): void {
    this.emitter.fire();
  }

  reset(): void {
    this.entries = undefined;
    this.computedAt = undefined;
    this.refresh();
  }

  setComputing(value: boolean): void {
    this.computing = value;
    this.refresh();
  }

  setEntries(entries: SizeEntry[]): void {
    this.entries = entries;
    this.computedAt = new Date().toLocaleTimeString();
    this.computing = false;
    this.refresh();
  }

  getTreeItem(element: CacheTreeItem): vscode.TreeItem {
    if (element instanceof CacheGroupNode) {
      const count = this.entries?.filter(e => e.group === element.group).length ?? 0;
      return element.toTreeItem(count > 0);
    }
    return element.toTreeItem();
  }

  getChildren(element?: CacheTreeItem): CacheTreeItem[] {
    if (!this.entries) {
      return [
        new CacheInfoNode(
          this.computing ? "正在计算缓存体积…" : "点击标题栏的数据库图标计算缓存体积"
        ),
      ];
    }
    if (!element) {
      return GROUP_ORDER.map(group => new CacheGroupNode(group, GROUP_LABELS[group]));
    }
    if (element instanceof CacheGroupNode) {
      const nodes = this.entries
        .filter(e => e.group === element.group)
        .map(e => new CacheEntryNode(e));
      if (nodes.length === 0) return [new CacheInfoNode("（无）")];
      return nodes;
    }
    return [];
  }

  get computedTime(): string | undefined {
    return this.computedAt;
  }
}
