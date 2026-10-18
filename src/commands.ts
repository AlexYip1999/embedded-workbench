import * as vscode from "vscode";
import type { Workbench } from "./workbench";
import * as features from "./features";
import * as wizards from "./wizards";

/**
 * Single place where every contributed command is wired to its handler.
 * Handlers stay thin: state lives in `Workbench`, UI flows in `wizards.ts`
 * and `features.ts`.
 */
export function registerCommands(wb: Workbench): void {
  const reg = (command: string, handler: (...args: unknown[]) => unknown): void => {
    wb.context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  // refresh / environment
  reg("embeddedEnv.refresh", () => wb.refreshAll());
  reg("embeddedEnv.bootstrap", () => wb.bootstrapEnvironment());
  reg("embeddedEnv.refreshDevices", () => wb.refreshDevices());
  reg("embeddedEnv.focusPanel", () => wb.focusPanel());
  reg("embeddedEnv.focusDevices", () => wb.focusDevices());

  // project creation / switching
  reg("embeddedEnv.newProject", () => wizards.newProjectWizard(wb));
  reg("embeddedEnv.addEnvironment", () => wizards.addEnvironmentWizard(wb));
  reg("embeddedEnv.setActiveEnv", node => features.setActiveFromNode(wb, node));
  reg("embeddedEnv.pickActive", () => features.pickActive(wb));

  // build / flash / monitor
  reg("embeddedEnv.build", node => wb.runTarget(node, "build"));
  reg("embeddedEnv.flash", node => wb.runTarget(node, "flash"));
  reg("embeddedEnv.flashToPort", node => wb.runTargetToPort(node, "flash"));
  reg("embeddedEnv.flashAndMonitor", node => wb.runTarget(node, "flashMonitor"));
  reg("embeddedEnv.monitor", node => wb.runTarget(node, "monitor"));
  reg("embeddedEnv.monitorPort", node => wb.runTargetToPort(node, "monitor"));
  reg("embeddedEnv.flashMonitorPort", node => wb.runTargetToPort(node, "flashMonitor"));
  reg("embeddedEnv.clean", node => wb.runTarget(node, "clean"));

  // devices
  reg("embeddedEnv.detectChip", node => wizards.detectChipForNode(wb, node));
  reg("embeddedEnv.newProjectForDevice", node => wizards.newProjectForDevice(wb, node));
  reg("embeddedEnv.copyPortName", node => features.copyPortName(wb, node));

  // cache / versions
  reg("embeddedEnv.computeSizes", () => features.computeSizes(wb, true));
  reg("embeddedEnv.cleanBuild", node => features.cleanBuild(wb, node));
  reg("embeddedEnv.checkVersions", () => features.checkVersions(wb));
  reg("embeddedEnv.openCheckFile", node => features.openCheckFile(wb, node));
  reg("embeddedEnv.checkUpdates", () => features.checkUpdates(wb));

  // navigation
  reg("embeddedEnv.openIni", node => features.openIni(wb, node));
  reg("embeddedEnv.openSource", node => features.openSource(wb, node));
  reg("embeddedEnv.openPath", node => features.openPath(wb, node));
  reg("embeddedEnv.deleteProject", node => features.deleteProject(wb, node));
}
