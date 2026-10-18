import * as vscode from "vscode";
import { ChipInfo } from "../core/esptool";
import { DeviceListing, SerialDevice } from "../core/ports";

export class SerialDeviceNode {
  public readonly kind = "serialDevice";
  constructor(
    public readonly device: SerialDevice,
    public readonly chipInfo?: ChipInfo
  ) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.device.port, vscode.TreeItemCollapsibleState.None);

    if (this.chipInfo?.chip) {
      const flash = this.chipInfo.flashSize ? ` · ${this.chipInfo.flashSize}` : "";
      item.description = `${this.chipInfo.chip}${flash}`;
    } else {
      const parts: string[] = [];
      if (this.device.chip) parts.push(this.device.chip);
      else if (this.device.description) parts.push(this.device.description);
      item.description = parts.join(" · ");
    }

    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${this.device.port}**\n\n`);
    tip.appendMarkdown(`- 描述: ${this.device.description || "-"}\n`);
    tip.appendMarkdown(`- 硬件 ID: \`${this.device.hwid || "-"}\`\n`);
    if (this.device.vid && this.device.pid) {
      tip.appendMarkdown(`- VID:PID: \`${this.device.vid}:${this.device.pid}\`\n`);
    }
    if (this.device.chip) tip.appendMarkdown(`- USB 桥接芯片: ${this.device.chip}\n`);
    if (this.chipInfo?.chip) {
      tip.appendMarkdown(`\n**目标芯片（esptool）**\n\n`);
      tip.appendMarkdown(`- 芯片: ${this.chipInfo.chip}\n`);
      if (this.chipInfo.chipType) tip.appendMarkdown(`- 类型: ${this.chipInfo.chipType}\n`);
      if (this.chipInfo.chipId) tip.appendMarkdown(`- Chip ID: \`${this.chipInfo.chipId}\`\n`);
      if (this.chipInfo.flashSize) tip.appendMarkdown(`- Flash: ${this.chipInfo.flashSize}\n`);
      if (this.chipInfo.mac) tip.appendMarkdown(`- MAC: \`${this.chipInfo.mac}\``);
    } else {
      tip.appendMarkdown(`- 目标芯片: 未识别（右键「识别芯片（esptool）」）`);
    }
    item.tooltip = tip;

    item.contextValue = "serialDevice";
    item.iconPath = new vscode.ThemeIcon(this.chipInfo ? "circuit-board" : "plug");
    item.command = {
      command: "embeddedEnv.monitorPort",
      title: "监视此串口",
      arguments: [this],
    };
    return item;
  }
}

export class DeviceGroupNode {
  public readonly kind = "deviceGroup";
  constructor(public readonly serialCount: number) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `串口（${this.serialCount}）`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.contextValue = "deviceGroup";
    item.iconPath = new vscode.ThemeIcon("plug");
    return item;
  }
}

export class DeviceInfoNode {
  public readonly kind = "deviceInfo";
  constructor(
    public readonly message: string,
    public readonly icon = "info"
  ) {}

  toTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    item.contextValue = "deviceInfo";
    item.iconPath = new vscode.ThemeIcon(this.icon);
    return item;
  }
}

export type DeviceTreeItem = DeviceGroupNode | SerialDeviceNode | DeviceInfoNode;

export class DevicesProvider implements vscode.TreeDataProvider<DeviceTreeItem> {
  private readonly emitter = new vscode.EventEmitter<DeviceTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private listing: DeviceListing | undefined;
  private scanning = false;
  private notice: string | undefined;
  private readonly chipInfo = new Map<string, ChipInfo>();

  refresh(): void {
    this.emitter.fire();
  }

  setScanning(): void {
    this.scanning = true;
    this.notice = undefined;
    this.listing = undefined;
    this.refresh();
  }

  setListing(listing: DeviceListing): void {
    this.scanning = false;
    this.notice = undefined;
    this.listing = listing;
    this.refresh();
  }

  setNotice(message: string): void {
    this.scanning = false;
    this.listing = undefined;
    this.notice = message;
    this.refresh();
  }

  setChipInfo(port: string, info: ChipInfo): void {
    this.chipInfo.set(port, info);
    this.refresh();
  }

  getChipInfo(port: string): ChipInfo | undefined {
    return this.chipInfo.get(port);
  }

  getTreeItem(element: DeviceTreeItem): vscode.TreeItem {
    return element.toTreeItem();
  }

  getChildren(element?: DeviceTreeItem): DeviceTreeItem[] {
    if (this.notice) {
      return [new DeviceInfoNode(this.notice, "info")];
    }
    if (!this.listing) {
      return [new DeviceInfoNode(this.scanning ? "正在扫描串口…" : "点击刷新扫描串口")];
    }
    if (this.listing.error) {
      return [new DeviceInfoNode(`扫描失败：${this.listing.error}`, "error")];
    }
    if (!element) {
      return [new DeviceGroupNode(this.listing.serial.length)];
    }
    if (element instanceof DeviceGroupNode) {
      if (this.listing.serial.length === 0) {
        return [
          new DeviceInfoNode(
            "未检测到串口。插上板子、确认数据线、安装 CH340/CP210x 驱动后点刷新。",
            "warning"
          ),
        ];
      }
      return this.listing.serial.map(
        device => new SerialDeviceNode(device, this.chipInfo.get(device.port))
      );
    }
    return [];
  }
}
