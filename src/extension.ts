import * as vscode from "vscode";
import { Workbench } from "./workbench";

export function activate(context: vscode.ExtensionContext): void {
  const workbench = new Workbench(context);
  context.subscriptions.push(workbench);
  workbench.start();
}

export function deactivate(): void {
  // Disposables are registered on the extension context.
}
