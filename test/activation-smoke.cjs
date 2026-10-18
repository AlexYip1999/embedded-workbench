/**
 * Activation smoke test: loads the bundled extension with a minimal `vscode`
 * API stub and verifies that activate() registers all contributed commands.
 * Run after `npm run build` (dist/extension.js exists).
 */
const path = require("path");
const Module = require("module");

function disposable() {
  return { dispose() {} };
}
const commands = new Map();

class Emitter {
  constructor() {
    this.event = () => disposable();
  }
  fire() {}
  dispose() {}
}
class TreeItem {
  constructor(label, state) {
    this.label = label;
    this.collapsibleState = state;
  }
}
class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}
class MarkdownString {
  appendMarkdown() {}
}
class Uri {
  constructor(p) {
    this.fsPath = p;
    this.path = p;
  }
  static file(p) {
    return new Uri(p);
  }
}

const windowStub = {
  createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }),
  createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
  createTreeView: () => disposable(),
  createTerminal: () => ({
    show() {},
    sendText() {},
    dispose() {},
    exitStatus: undefined,
    creationOptions: {},
  }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  withProgress: async (_opts, task) => task(),
  tabGroups: { all: [], close: async () => {} },
  terminals: [],
};

const vscodeStub = {
  window: windowStub,
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() }, name: "workspace" }],
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
  },
  commands: {
    registerCommand: (id, fn) => {
      commands.set(id, fn);
      return disposable();
    },
    executeCommand: async () => undefined,
  },
  env: {
    shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    clipboard: { writeText: async () => {} },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon,
  MarkdownString,
  Uri,
  EventEmitter: Emitter,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

process.on("unhandledRejection", reason => {
  console.error("[activation-smoke] unhandled rejection:", reason);
  process.exit(3);
});

const extension = require(path.resolve(__dirname, "..", "dist", "extension.js"));
const expectedCommands = require(path.resolve(__dirname, "..", "package.json")).contributes.commands.length;

const context = {
  subscriptions: [],
  workspaceState: { get: () => undefined, update: async () => {} },
  extensionUri: Uri.file(process.cwd()),
};

extension.activate(context);
console.log("[activation-smoke] activate OK, commands:", commands.size);

if (commands.size !== expectedCommands) {
  console.error(`[activation-smoke] expected ${expectedCommands} commands, got ${commands.size}`);
  process.exit(2);
}

setTimeout(() => {
  console.log("[activation-smoke] OK");
  extension.deactivate();
  process.exit(0);
}, 500);
