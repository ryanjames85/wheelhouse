/**
 * extension.ts
 *
 * VS Code extension entry point — activates Wheelhouse and wires everything together.
 *
 * Responsibilities:
 *   - Instantiates StorageManager, ProviderRegistry, and WheelhousePanel.
 *   - Calls connectEnabled() on the active profile at startup and on workspace folder changes.
 *   - Registers all wheelhouse.* commands (refresh, popout, openSettings, switchProfile, export/importSettings).
 *   - Disposes all resources on deactivation.
 */
import * as vscode from 'vscode';
import { ProviderRegistry } from './core/ProviderRegistry';
import { StorageManager } from './storage/StorageManager';
import { WheelhousePanel } from './ui/WheelhousePanel';
import { PopoutPanel } from './ui/PopoutPanel';

let panel: WheelhousePanel | undefined;
let registry: ProviderRegistry | undefined;
let storage: StorageManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('[Wheelhouse] Activating…');

  storage = new StorageManager(context);
  registry = new ProviderRegistry();

  const activeProfile = storage.getActiveProfile();
  await registry.connectEnabled(activeProfile);

  panel = new WheelhousePanel(registry, storage, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      WheelhousePanel.viewType,
      panel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('wheelhouse.refresh', () => panel?.refresh()),

    vscode.commands.registerCommand('wheelhouse.popout', () => {
      PopoutPanel.open(registry!, storage!, context);
    }),

    vscode.commands.registerCommand('wheelhouse.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'wheelhouse');
    }),

    vscode.commands.registerCommand('wheelhouse.switchProfile', async () => {
      const profiles = storage!.getConfig().profiles;
      const items = profiles.map((p) => ({ label: p.name, description: p.id === storage!.getActiveProfile().id ? '(active)' : '', id: p.id }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a profile' });
      if (picked) {
        await storage!.setActiveProfile(picked.id);
        await registry!.connectEnabled(storage!.getActiveProfile());
        panel?.refresh();
      }
    }),

    vscode.commands.registerCommand('wheelhouse.exportSettings', async () => {
      const json = await storage!.exportConfig();
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('wheelhouse-settings.json'),
        filters: { JSON: ['json'] },
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
        vscode.window.showInformationMessage('Wheelhouse: Settings exported successfully.');
      }
    }),

    vscode.commands.registerCommand('wheelhouse.importSettings', async () => {
      const uris = await vscode.window.showOpenDialog({ filters: { JSON: ['json'] } });
      if (uris?.[0]) {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString('utf8');
        await storage!.importConfig(raw);
        await registry!.connectEnabled(storage!.getActiveProfile());
        panel?.refresh();
        vscode.window.showInformationMessage('Wheelhouse: Settings imported successfully.');
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await registry!.connectEnabled(storage!.getActiveProfile());
      panel?.refresh();
    })
  );

  console.log('[Wheelhouse] Ready.');
}

export function deactivate(): void {
  panel?.dispose();
  PopoutPanel.closeIfOpen();
  registry?.dispose();
  console.log('[Wheelhouse] Deactivated.');
}
