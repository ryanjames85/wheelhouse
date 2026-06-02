import { vi } from 'vitest';

export const workspace = {
  workspaceFolders: undefined as unknown,
};

export const window = {
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  })),
  createTerminal: vi.fn(() => ({ sendText: vi.fn(), show: vi.fn() })),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  withProgress: vi.fn((_opts: unknown, task: () => Promise<unknown>) => task()),
};

export const ExtensionContext = {};

export const ProgressLocation = { Notification: 15 };

export const Uri = {
  file: (p: string) => ({ fsPath: p }),
};

export const ViewColumn = { One: 1 };

export const commands = {
  executeCommand: vi.fn(),
  registerCommand: vi.fn(),
};

export class ExtensionContext_ {
  private _store = new Map<string, unknown>();
  globalState = {
    get: <T>(key: string) => this._store.get(key) as T | undefined,
    update: vi.fn(async (key: string, value: unknown) => { this._store.set(key, value); }),
    keys: () => [...this._store.keys()],
  };
  extensionUri = Uri.file('/mock/extension');
  subscriptions: unknown[] = [];
}

export default {
  workspace,
  window,
  ProgressLocation,
  Uri,
  ViewColumn,
  commands,
};
