/**
 * PopoutPanel.ts
 *
 * Popout panel — opens Wheelhouse in a standalone editor column instead of the sidebar.
 *
 * Shares the same ProviderRegistry and StorageManager as the sidebar panel.
 * Only one popout can be open at a time (singleton via PopoutPanel.open()).
 * Useful when you want the panel detached and resizable alongside your editor.
 */
import * as vscode from 'vscode';
import { ProviderRegistry } from '../core/ProviderRegistry';
import { StorageManager } from '../storage/StorageManager';
import { WebviewMessage, Profile, Snippet } from '../types';

export class PopoutPanel {
  public static readonly viewType = 'wheelhouse.popout';
  private static instance: PopoutPanel | undefined;
  private panel: vscode.WebviewPanel;
  private refreshTimer?: ReturnType<typeof setInterval>;

  private logStreams = new Map<string, () => void>();

  private constructor(
    private readonly registry: ProviderRegistry,
    private readonly storage: StorageManager,
    private readonly context: vscode.ExtensionContext
  ) {
    this.panel = vscode.window.createWebviewPanel(
      PopoutPanel.viewType,
      'Wheelhouse',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(this.handleMessage.bind(this));
    this.panel.onDidDispose(() => {
      PopoutPanel.instance = undefined;
      if (this.refreshTimer) clearInterval(this.refreshTimer);
    });

    this.startRefresh();
    this.sendFullState();
  }

  static open(
    registry: ProviderRegistry,
    storage: StorageManager,
    context: vscode.ExtensionContext
  ): PopoutPanel {
    if (PopoutPanel.instance) {
      vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      return PopoutPanel.instance;
    }
    PopoutPanel.instance = new PopoutPanel(registry, storage, context);
    // Detach into its own OS window after the panel is created
    vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    return PopoutPanel.instance;
  }

  static isOpen(): boolean {
    return PopoutPanel.instance !== undefined;
  }

  static closeIfOpen(): void {
    PopoutPanel.instance?.dispose();
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    const profile = this.storage.getActiveProfile();

    switch (msg.type) {
      case 'ready':
        await this.sendFullState();
        break;

      case 'action': {
        const { tabId, resourceId, actionId } = msg.payload as { tabId: string; resourceId: string; actionId: string };
        const tab = this.registry.getVisibleTabs(profile).find((t) => t.id === tabId);
        if (!tab) break;
        const provider = this.registry.get(tab.providerId);
        if (!provider) break;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Wheelhouse: ${actionId} ${resourceId}`, cancellable: false },
          async () => {
            try {
              await provider.executeAction(tabId, resourceId, actionId);
            } catch (err) {
              vscode.window.showErrorMessage(`Wheelhouse: ${String(err)}`);
            }
          }
        );
        await this.sendFullState();
        break;
      }

      case 'refresh':
        await this.sendFullState();
        break;

      case 'switchProfile': {
        const { profileId } = msg.payload as { profileId: string };
        await this.storage.setActiveProfile(profileId);
        await this.registry.connectEnabled(this.storage.getActiveProfile());
        this.startRefresh();
        await this.sendFullState();
        break;
      }

      case 'runSnippet': {
        const { command, runMode } = msg.payload as { command: string; runMode?: string };
        if (runMode === 'clipboard') {
          await vscode.env.clipboard.writeText(command);
          vscode.window.showInformationMessage('Wheelhouse: Command copied to clipboard.');
        } else {
          const terminal = vscode.window.createTerminal('Wheelhouse');
          terminal.sendText(command);
          terminal.show();
        }
        break;
      }

      case 'exportSettings': {
        const json = await this.storage.exportConfig();
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file('wheelhouse-settings.json'),
          filters: { JSON: ['json'] },
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
          vscode.window.showInformationMessage('Wheelhouse: Settings exported.');
        }
        break;
      }

      case 'importSettings': {
        const uris = await vscode.window.showOpenDialog({ filters: { JSON: ['json'] } });
        if (uris?.[0]) {
          const raw = Buffer.from(await vscode.workspace.fs.readFile(uris[0])).toString('utf8');
          await this.storage.importConfig(raw);
          await this.registry.connectEnabled(this.storage.getActiveProfile());
          await this.sendFullState();
        }
        break;
      }

      case 'minimize':
        this.panel.dispose();
        break;

      case 'saveProfile': {
        const { profile } = msg.payload as { profile: Profile };
        await this.storage.saveProfile(profile);
        await this.sendFullState();
        break;
      }

      case 'deleteProfile': {
        const { profileId } = msg.payload as { profileId: string };
        await this.storage.deleteProfile(profileId);
        await this.sendFullState();
        break;
      }

      case 'saveSnippet': {
        const { snippet } = msg.payload as { snippet: Snippet };
        if (snippet.scope === 'global') {
          await this.storage.saveGlobalSnippet(snippet);
        } else {
          const existing = this.storage.getWorkspaceSnippets();
          const idx = existing.findIndex(s => s.id === snippet.id);
          if (idx >= 0) existing[idx] = snippet;
          else existing.push(snippet);
          await this.storage.saveWorkspaceSnippets(existing);
        }
        await this.sendFullState();
        break;
      }

      case 'deleteSnippet': {
        const { snippetId, scope } = msg.payload as { snippetId: string; scope: string };
        if (scope === 'global') {
          await this.storage.deleteGlobalSnippet(snippetId);
        } else {
          const ws = this.storage.getWorkspaceSnippets().filter(s => s.id !== snippetId);
          await this.storage.saveWorkspaceSnippets(ws);
        }
        await this.sendFullState();
        break;
      }

      case 'startLogStream': {
        const { serviceId } = msg.payload as { serviceId: string };
        this.stopStream(serviceId);
        const dockerProvider = this.registry.get('docker') as (object & { streamServiceLogs?: (s: string, onLine: (l: string) => void, onEnd: () => void) => () => void }) | undefined;
        if (!dockerProvider?.streamServiceLogs) break;
        const disposer = dockerProvider.streamServiceLogs(
          serviceId,
          (line) => { this.panel.webview.postMessage({ type: 'logLine', payload: { serviceId, line } }); },
          () => { this.panel.webview.postMessage({ type: 'logEnd', payload: { serviceId } }); }
        );
        this.logStreams.set(serviceId, disposer);
        break;
      }

      case 'stopLogStream': {
        const { serviceId } = msg.payload as { serviceId: string };
        this.stopStream(serviceId);
        break;
      }

      case 'stopAllLogStreams': {
        for (const id of [...this.logStreams.keys()]) this.stopStream(id);
        break;
      }
    }
  }

  private stopStream(serviceId: string): void {
    this.logStreams.get(serviceId)?.();
    this.logStreams.delete(serviceId);
  }

  private async sendFullState(): Promise<void> {
    const profile = this.storage.getActiveProfile();
    const config = this.storage.getConfig();
    const tabs = this.registry.getVisibleTabs(profile);
    const providers = this.registry.getAll().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      version: p.version,
      comingSoon: p.comingSoon,
      status: p.status,
      tabs: p.tabs,
      daemonAvailable: 'isDaemonAvailable' in p ? (p as { isDaemonAvailable: boolean }).isDaemonAvailable : undefined,
      composeFileFound: 'isComposeFileFound' in p ? (p as { isComposeFileFound: boolean }).isComposeFileFound : undefined,
    }));
    const snippets = this.storage.getAllSnippets(profile.snippetScope);

    const tabData = await Promise.all(
      tabs.map(async (tab) => {
        const provider = this.registry.get(tab.providerId);
        if (!provider || provider.status !== 'connected') {
          return { tabId: tab.id, resources: [], badge: 0 };
        }
        try {
          return await provider.getTabData(tab.id);
        } catch {
          return { tabId: tab.id, resources: [], sectionLabel: 'Error loading data' };
        }
      })
    );

    this.post({
      type: 'state',
      payload: { profile, config, tabs, tabData, providers, snippets, mode: 'popout' },
    });
  }

  refresh(): void {
    this.sendFullState();
  }

  private startRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const interval = this.storage.getActiveProfile().refreshInterval;
    if (interval > 0) {
      this.refreshTimer = setInterval(() => this.sendFullState(), interval);
    }
  }

  private post(msg: WebviewMessage): void {
    this.panel.webview.postMessage(msg);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const id of [...this.logStreams.keys()]) this.stopStream(id);
    this.panel.dispose();
    PopoutPanel.instance = undefined;
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) nonce += chars[Math.floor(Math.random() * chars.length)];
    return nonce;
  }

  private getHtml(): string {
    const nonce = this.getNonce();
    const csp = `default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: https:;`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wheelhouse</title>
<style nonce="${nonce}">
${this.getCss()}
</style>
</head>
<body>
<div id="app"><div class="loading"><div class="loading-dot"></div><span>Connecting…</span></div></div>
<script nonce="${nonce}">${this.getJs()}</script>
</body>
</html>`;
  }

  private getCss(): string {
    return `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; height: 100vh; }
#app { display: flex; flex-direction: column; height: 100vh; }

.loading { display: flex; align-items: center; gap: 8px; padding: 16px; color: var(--vscode-descriptionForeground); }
.loading-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-focusBorder); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }

.top-bar { display: flex; align-items: center; justify-content: space-between; padding: 6px 14px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); background: var(--vscode-sideBarSectionHeader-background); flex-shrink: 0; gap: 12px; }
.daemon-chip { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--vscode-descriptionForeground); }
.daemon-chip-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.daemon-chip-dot.up { background: #22c55e; }
.daemon-chip-dot.down { background: var(--vscode-descriptionForeground); opacity: 0.4; }
.brand { font-size: 11px; font-weight: 600; color: var(--vscode-sideBarSectionHeader-foreground); letter-spacing: 0.07em; text-transform: uppercase; display: flex; align-items: center; gap: 6px; }
.top-actions { display: flex; align-items: center; gap: 4px; }
.icon-btn { background: none; border: none; cursor: pointer; padding: 3px 5px; border-radius: 3px; color: var(--vscode-icon-foreground); opacity: 0.7; display: flex; align-items: center; }
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.icon-btn svg { width: 15px; height: 15px; }
.icon-btn.minimize { opacity: 1; color: var(--vscode-textLink-foreground); }

.main-layout { display: flex; flex: 1; overflow: hidden; }

.left-nav { width: 170px; flex-shrink: 0; border-right: 1px solid var(--vscode-sideBarSectionHeader-border); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; overflow-y: auto; }
.profile-section { padding: 8px 10px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); display: flex; align-items: center; gap: 6px; }
.profile-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.profile-name { font-size: 12px; color: var(--vscode-foreground); flex: 1; font-weight: 500; }
.profile-switch-btn { background: none; border: none; font-size: 10px; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 1px 3px; }

.nav-section-label { font-size: 9px; font-weight: 500; color: var(--vscode-descriptionForeground); letter-spacing: 0.08em; text-transform: uppercase; padding: 8px 10px 3px; }
.nav-item { display: flex; align-items: center; gap: 7px; padding: 5px 10px; font-size: 12px; color: var(--vscode-foreground); opacity: 0.7; cursor: pointer; border-left: 2px solid transparent; }
.nav-item:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
.nav-item.active { opacity: 1; background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-left-color: var(--vscode-focusBorder); font-weight: 500; }
.nav-item svg { width: 14px; height: 14px; flex-shrink: 0; }
.nav-badge { font-size: 9px; padding: 0 4px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); margin-left: auto; }
.nav-badge.ok { background: var(--vscode-testing-iconPassed); color: #fff; }
.nav-badge.warn { background: var(--vscode-testing-iconFailed); color: #fff; }

.content-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

.stats-bar { display: flex; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); background: var(--vscode-sideBarSectionHeader-background); flex-shrink: 0; }
.stat { flex: 1; padding: 8px 14px; border-right: 1px solid var(--vscode-sideBarSectionHeader-border); }
.stat:last-child { border-right: none; }
.stat-num { font-size: 20px; font-weight: 500; color: var(--vscode-foreground); }
.stat-num.green { color: var(--vscode-testing-iconPassed); }
.stat-num.warn { color: var(--vscode-charts-yellow, #f59e0b); }
.stat-num.err { color: var(--vscode-errorForeground); }
.stat-lbl { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 1px; }

.columns { display: flex; flex: 1; overflow: hidden; }
.col { flex: 1; border-right: 1px solid var(--vscode-sideBarSectionHeader-border); overflow-y: auto; display: flex; flex-direction: column; }
.col:last-child { border-right: none; }
.col-header { padding: 4px 12px; font-size: 10px; font-weight: 500; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.06em; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); flex-shrink: 0; }
.col-body { flex: 1; overflow-y: auto; }

.resource { border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
.resource:last-child { border-bottom: none; }
.resource-row { display: flex; align-items: center; gap: 6px; padding: 6px 12px; cursor: pointer; }
.resource-row:hover { background: var(--vscode-list-hoverBackground); }
.resource-row.expanded { background: var(--vscode-list-hoverBackground); }
.chev { font-size: 10px; color: var(--vscode-descriptionForeground); width: 10px; flex-shrink: 0; transition: transform 0.12s; }
.chev.open { transform: rotate(90deg); }
.status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dot-running { background: var(--vscode-testing-iconPassed); }
.dot-stopped, .dot-exited { background: transparent; border: 1.5px solid var(--vscode-descriptionForeground); }
.dot-restarting { background: var(--vscode-charts-yellow, #f59e0b); }
.dot-unhealthy { background: var(--vscode-errorForeground); }
.dot-orphaned { background: var(--vscode-charts-yellow, #f59e0b); }
.dot-in_use { background: var(--vscode-testing-iconPassed); }
.dot-unknown { background: transparent; border: 1.5px dashed var(--vscode-descriptionForeground); }
.resource-name { font-size: 12px; font-weight: 500; color: var(--vscode-foreground); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resource-name.dim { color: var(--vscode-descriptionForeground); }
.resource-meta { font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
.status-badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; }
.badge-running, .badge-in_use { background: var(--vscode-testing-iconPassed); color: #fff; opacity: 0.9; }
.badge-stopped, .badge-exited, .badge-unknown { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.badge-unhealthy { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
.badge-restarting, .badge-orphaned { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-inputValidation-warningForeground); }
.divider { width: 1px; height: 13px; background: var(--vscode-sideBarSectionHeader-border); flex-shrink: 0; }
.action-btns { display: flex; gap: 1px; flex-shrink: 0; }
.action-btn { background: none; border: none; cursor: pointer; padding: 3px 4px; border-radius: 3px; color: var(--vscode-icon-foreground); opacity: 0.7; display: flex; align-items: center; }
.action-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.action-btn.danger:hover { color: var(--vscode-errorForeground); }
.action-btn svg { width: 14px; height: 14px; }
.resource-children { display: none; background: var(--vscode-sideBarSectionHeader-background); border-top: 1px solid var(--vscode-sideBarSectionHeader-border); }
.resource-children.open { display: block; }
.child-row { display: flex; align-items: flex-start; gap: 8px; padding: 3px 12px 3px 28px; }
.child-row:first-child { padding-top: 5px; }
.child-row:last-child { padding-bottom: 5px; }
.child-label { font-size: 10px; color: var(--vscode-descriptionForeground); width: 44px; flex-shrink: 0; padding-top: 1px; font-family: var(--vscode-editor-font-family, monospace); }
.child-value { font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); line-height: 1.7; }
.child-value.ok { color: var(--vscode-testing-iconPassed); }
.child-value.warn { color: var(--vscode-charts-yellow, #f59e0b); }
.child-value.err { color: var(--vscode-errorForeground); }

.log-panel { height: 200px; flex-shrink: 0; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); display: flex; flex-direction: column; background: var(--vscode-terminal-background, var(--vscode-editor-background)); }
.log-header { display: flex; align-items: center; gap: 5px; padding: 4px 8px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); flex-shrink: 0; overflow-x: auto; scrollbar-width: none; }
.log-header::-webkit-scrollbar { display: none; }
.log-live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-testing-iconPassed); animation: pulse 1.5s ease-in-out infinite; flex-shrink: 0; }
.log-tabs { display: flex; gap: 2px; flex-shrink: 0; }
.log-tab { display: flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 3px; font-size: 10px; color: var(--vscode-descriptionForeground); cursor: pointer; background: none; border: 1px solid transparent; white-space: nowrap; }
.log-tab:hover { background: var(--vscode-list-hoverBackground); }
.log-tab-active { background: var(--vscode-sideBar-background); color: var(--vscode-foreground); border-color: var(--vscode-sideBarSectionHeader-border); }
.log-tab-close { background: none; border: none; cursor: pointer; color: inherit; opacity: 0.6; padding: 0; display: flex; align-items: center; }
.log-tab-close:hover { opacity: 1; }
.log-tab-close svg { width: 10px; height: 10px; }
.log-search { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 2px 6px; font-size: 10px; width: 100px; flex-shrink: 0; }
.log-search:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
.log-lvl { background: none; border: 1px solid var(--vscode-sideBarSectionHeader-border); border-radius: 3px; padding: 1px 5px; font-size: 9px; color: var(--vscode-descriptionForeground); cursor: pointer; flex-shrink: 0; opacity: 0.5; }
.log-lvl-on { opacity: 1; color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
.log-close { background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); opacity: 0.6; padding: 2px 3px; border-radius: 2px; display: flex; align-items: center; flex-shrink: 0; }
.log-close:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.log-close svg { width: 13px; height: 13px; }
.log-body { flex: 1; overflow-y: auto; padding: 6px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.6; }
.log-line { color: var(--vscode-terminal-foreground, var(--vscode-foreground)); opacity: 0.8; word-break: break-all; }
.log-line.err { color: var(--vscode-errorForeground); opacity: 1; }
.log-line.ok { color: var(--vscode-testing-iconPassed); opacity: 1; }
.log-line.dim { opacity: 0.4; }

.section-label { padding: 4px 12px; font-size: 10px; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); letter-spacing: 0.04em; }
.empty-state { padding: 24px 16px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.6; }

.settings-layout { display: flex; flex: 1; overflow: hidden; }
.settings-body { flex: 1; overflow-y: auto; padding: 16px; }
.settings-section { margin-bottom: 20px; }
.settings-section-title { font-size: 12px; font-weight: 500; color: var(--vscode-foreground); margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.settings-row:last-child { margin-bottom: 0; }
.settings-label { font-size: 12px; color: var(--vscode-foreground); flex: 1; }
.settings-hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.toggle { width: 32px; height: 18px; background: var(--vscode-inputOption-activeBackground, #666); border-radius: 9px; cursor: pointer; position: relative; flex-shrink: 0; transition: background 0.2s; border: 1px solid var(--vscode-inputOption-activeBorder, #888); }
.toggle.on { background: var(--vscode-testing-iconPassed); border-color: var(--vscode-testing-iconPassed); }
.toggle::after { content: ''; position: absolute; width: 12px; height: 12px; background: white; border-radius: 50%; top: 2px; left: 2px; transition: left 0.15s; }
.toggle.on::after { left: 16px; }

.snippet-item { display: flex; align-items: center; gap: 7px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
.snippet-item:last-child { border-bottom: none; }
.snippet-name { font-size: 12px; color: var(--vscode-foreground); flex: 1; }
.snippet-scope { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.snippet-btns { display: flex; gap: 2px; }
.snippet-btn { background: none; border: none; cursor: pointer; padding: 2px 3px; border-radius: 2px; color: var(--vscode-icon-foreground); opacity: 0.6; display: flex; align-items: center; }
.snippet-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.snippet-btn svg { width: 13px; height: 13px; }
.snippet-cmd { padding: 5px 12px 5px 32px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); background: var(--vscode-sideBarSectionHeader-background); border-top: 1px solid var(--vscode-sideBarSectionHeader-border); display: none; }
.snippet-cmd.open { display: block; }
.add-btn { display: flex; align-items: center; gap: 6px; padding: 8px 12px; color: var(--vscode-textLink-foreground); font-size: 12px; cursor: pointer; background: none; border: none; border-top: 1px dashed var(--vscode-sideBarSectionHeader-border); width: 100%; }
.add-btn svg { width: 14px; height: 14px; }
    `;
  }

  private getJs(): string {
    return `
const vscode = acquireVsCodeApi();
let state = null;
let activeNav = 'compose';
let activeLogService = null;
let activeLogTab = null;
let logTabs = {};   // { serviceId: string[] }
let logSearch = '';
let logLevels = { ERR: true, WARN: true, INFO: true, DEBUG: true };

const ICONS = {
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  minimize: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8H6a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  terminal2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 9l3 3-3 3"/><line x1="13" y1="15" x2="16" y2="15"/><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>',
  stack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-4h14v4"/><path d="M12 12V8"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  wheel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="3" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="8.5" y2="8.5"/><line x1="15.5" y1="15.5" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="15.5" y2="8.5"/><line x1="8.5" y1="15.5" x2="5.6" y2="18.4"/></svg>',
};

const NAV_ICONS = {
  compose: 'stack', containers: 'box', images: 'photo',
  volumes: 'database', networks: 'network', snippets: 'terminal2',
  providers: 'plug', profiles: 'user', safety: 'shield',
};

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'state') {
    state = msg.payload;
    render();
  } else if (msg.type === 'logLine') {
    appendLogLine(msg.payload.serviceId, msg.payload.line);
  } else if (msg.type === 'logEnd') {
    appendLogLine(msg.payload.serviceId, '[stream ended]');
  }
});

function post(type, payload) { vscode.postMessage({ type, payload }); }

function render() {
  if (!state) return;
  document.getElementById('app').innerHTML = buildApp();
}

function buildApp() {
  const profile = state.profile;
  const allTabData = state.tabData || [];
  const totalRunning = allTabData.reduce((sum, td) => {
    return sum + (td.resources || []).filter(r => r.status === 'running').length;
  }, 0);
  const totalStopped = allTabData.reduce((sum, td) => {
    return sum + (td.resources || []).filter(r => ['stopped','exited'].includes(r.status)).length;
  }, 0);
  const totalUnhealthy = allTabData.reduce((sum, td) => {
    return sum + (td.resources || []).filter(r => r.status === 'unhealthy').length;
  }, 0);
  const totalOrphaned = allTabData.reduce((sum, td) => {
    return sum + (td.resources || []).filter(r => r.status === 'orphaned').length;
  }, 0);

  const dockerProvider = (state.providers || []).find(p => p.id === 'docker');
  const daemonUp = dockerProvider?.daemonAvailable === true;
  const daemonChip = dockerProvider && !dockerProvider.comingSoon ? \`
    <span class="daemon-chip" title="\${daemonUp ? 'Docker daemon connected' : 'Docker daemon offline'}">
      <span class="daemon-chip-dot \${daemonUp ? 'up' : 'down'}"></span>
      \${daemonUp ? 'Docker' : 'Docker offline'}
    </span>
  \` : '';

  return \`
    <div class="top-bar">
      <span class="brand">\${ICONS.wheel} Wheelhouse</span>
      \${daemonChip}
      <div class="top-actions" style="margin-left:auto;">
        <button class="icon-btn" onclick="post('refresh')" title="Refresh all">\${ICONS.refresh}</button>
        <button class="icon-btn minimize" onclick="post('minimize')" title="Back to sidebar">\${ICONS.minimize}</button>
      </div>
    </div>
    <div class="main-layout">
      \${buildNav(profile)}
      <div class="content-area">
        \${buildStatsBar(totalRunning, totalStopped, totalUnhealthy, totalOrphaned)}
        \${buildContent()}
      </div>
    </div>
  \`;
}

function buildNav(profile) {
  const tabs = state.tabs || [];
  const tabDataMap = {};
  (state.tabData || []).forEach(td => { tabDataMap[td.tabId] = td; });

  // Group tabs by provider
  const providers = state.providers || [];
  const providerSections = providers
    .filter(p => !p.comingSoon)
    .map(p => {
      const providerTabs = tabs.filter(t => t.providerId === p.id);
      if (!providerTabs.length) return '';
      const items = providerTabs.map(tab => {
        const td = tabDataMap[tab.id];
        const badge = td?.badge ? \`<span class="nav-badge \${td.badgeType || ''}">\${td.badge}</span>\` : '';
        return \`<div class="nav-item \${activeNav === tab.id ? 'active' : ''}" onclick="setNav('\${tab.id}')">\${ICONS[NAV_ICONS[tab.id]] || ICONS.box} \${tab.label}\${badge}</div>\`;
      }).join('');
      return \`<div class="nav-section-label">\${p.name}</div>\${items}\`;
    }).join('');

  return \`
    <div class="left-nav">
      <div class="profile-section">
        <span class="profile-dot" style="background:\${profile.colour}"></span>
        <span class="profile-name">\${profile.name}</span>
        <button class="profile-switch-btn" onclick="setNav('profiles')">▾</button>
      </div>
      \${providerSections}
      <div class="nav-section-label">Workspace</div>
      <div class="nav-item \${activeNav === 'snippets' ? 'active' : ''}" onclick="setNav('snippets')">\${ICONS.terminal2} Snippets</div>
      <div class="nav-section-label">Settings</div>
      <div class="nav-item \${activeNav === 'providers' ? 'active' : ''}" onclick="setNav('providers')">\${ICONS.plug} Providers</div>
      <div class="nav-item \${activeNav === 'profiles' ? 'active' : ''}" onclick="setNav('profiles')">\${ICONS.user} Profiles</div>
      <div class="nav-item \${activeNav === 'safety' ? 'active' : ''}" onclick="setNav('safety')">\${ICONS.shield} Safety</div>
    </div>
  \`;
}

function buildStatsBar(running, stopped, unhealthy, orphaned) {
  return \`
    <div class="stats-bar">
      <div class="stat"><div class="stat-num green">\${running}</div><div class="stat-lbl">running</div></div>
      <div class="stat"><div class="stat-num">\${stopped}</div><div class="stat-lbl">stopped</div></div>
      <div class="stat"><div class="stat-num \${unhealthy > 0 ? 'err' : ''}">\${unhealthy}</div><div class="stat-lbl">unhealthy</div></div>
      <div class="stat"><div class="stat-num \${orphaned > 0 ? 'warn' : ''}">\${orphaned}</div><div class="stat-lbl">orphaned vols</div></div>
    </div>
  \`;
}

function buildContent() {
  const resourceNavs = ['compose','containers','images','volumes','networks'];

  if (resourceNavs.includes(activeNav)) {
    return buildResourceView();
  }
  if (activeNav === 'snippets') return buildSnippetsView();
  if (activeNav === 'providers') return buildProvidersView();
  if (activeNav === 'profiles') return buildProfilesView();
  if (activeNav === 'safety') return buildSafetyView();
  return '<div class="empty-state">Select a section from the left.</div>';
}

function buildResourceView() {
  const tabData = (state.tabData || []).find(td => td.tabId === activeNav);
  if (!tabData || !tabData.resources?.length) {
    return \`<div class="columns"><div class="col"><div class="empty-state">\${tabData?.sectionLabel || 'No resources found.'}</div></div></div>\`;
  }

  const settings = state.config?.settings || {};
  const resources = tabData.resources.map(r => buildResourceRow(r, activeNav)).join('');
  const sectionLabel = tabData.sectionLabel ? \`<div class="section-label">\${tabData.sectionLabel}</div>\` : '';

  const logPanel = activeLogService ? buildLogPanel() : '';

  return \`
    <div style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
      <div class="columns" style="flex:1;overflow:hidden;">
        <div class="col">
          <div class="col-header">\${activeNav}</div>
          <div class="col-body">\${sectionLabel}\${resources}</div>
        </div>
      </div>
      \${logPanel}
    </div>
  \`;
}

function buildResourceRow(resource, tabId) {
  const statusClass = 'dot-' + (resource.status || 'unknown');
  const nameClass = ['stopped','exited','orphaned','unknown'].includes(resource.status) ? 'dim' : '';
  const badgeClass = 'badge-' + (resource.status || 'unknown');

  const actions = (resource.actions || []).map(a => \`
    <button class="action-btn \${a.dangerous ? 'danger' : ''}"
      onclick="event.stopPropagation(); execAction('\${tabId}','\${resource.id}','\${a.id}')"
      title="\${a.label}">\${ICONS[a.icon] || ICONS.info}</button>
  \`).join('');

  const divider = actions ? '<span class="divider"></span>' : '';

  const children = (resource.children || []).map(c => \`
    <div class="child-row">
      <span class="child-label">\${c.label}</span>
      <span class="child-value \${c.type || ''}">\${c.value}</span>
    </div>
  \`).join('');

  const childrenDiv = children ? \`<div class="resource-children" id="rc-\${resource.id}">\${children}</div>\` : '';

  return \`
    <div class="resource">
      <div class="resource-row" onclick="toggleResource('\${resource.id}')">
        <span class="chev" id="chev-\${resource.id}">\${ICONS.chevron}</span>
        <span class="status-dot \${statusClass}"></span>
        <span class="resource-name \${nameClass}">\${resource.name}</span>
        <span class="status-badge \${badgeClass}">\${resource.status}</span>
        \${divider}
        <div class="action-btns">\${actions}</div>
      </div>
      \${childrenDiv}
    </div>
  \`;
}

function buildLogPanel() {
  const tabs = Object.keys(logTabs);
  if (!tabs.length) return '';
  if (!activeLogTab || !logTabs[activeLogTab]) activeLogTab = tabs[0];

  const tabsHtml = tabs.map(id => \`
    <span class="log-tab\${activeLogTab===id?' log-tab-active':''}" onclick="setLogTab('\${id}')">\${id}
      <button class="log-tab-close" onclick="event.stopPropagation();closeLogTab('\${id}')" title="Close \${id} logs">\${ICONS.x}</button>
    </span>\`).join('');

  const lines = (logTabs[activeLogTab] || [])
    .filter(l => !logSearch || l.toLowerCase().includes(logSearch.toLowerCase()))
    .filter(l => {
      const m = l.match(/\\b(ERROR|WARN(?:ING)?|INFO|DEBUG)\\b/i);
      const lvl = m ? m[1].replace('WARNING','WARN').toUpperCase() : null;
      return !lvl || logLevels[lvl];
    });
  const linesHtml = lines.length
    ? lines.map(l => \`<div class="log-line">\${l.replace(/</g,'&lt;')}</div>\`).join('')
    : \`<div class="log-line dim">No output matching current filters…</div>\`;

  const levelBtns = ['ERR','WARN','INFO','DEBUG'].map(l =>
    \`<button class="log-lvl\${logLevels[l]?' log-lvl-on':''}" onclick="logLevels.\${l}=!logLevels.\${l};render()" title="Toggle \${l}">\${l}</button>\`
  ).join('');

  return \`
    <div class="log-panel">
      <div class="log-header">
        <span class="log-live-dot"></span>
        <div class="log-tabs">\${tabsHtml}</div>
        <input class="log-search" placeholder="Search…" oninput="logSearch=this.value;render()" value="\${logSearch.replace(/"/g,'&quot;')}" title="Filter log lines">
        \${levelBtns}
        <button class="log-close" onclick="clearLogPanel()" title="Clear log">\${ICONS.trash}</button>
        <button class="log-close" onclick="closeAllLogs()" title="Close all logs">\${ICONS.x}</button>
      </div>
      <div class="log-body" id="log-body">\${linesHtml}</div>
    </div>
  \`;
  // TODO Phase 2: wire actual log streaming — extension pushes { type:'logLine', payload:{serviceId,line} }
}

function appendLogLine(serviceId, line) {
  if (!logTabs[serviceId]) logTabs[serviceId] = [];
  logTabs[serviceId].push(line);
  if (logTabs[serviceId].length > 1000) logTabs[serviceId].shift();
  if (activeLogTab === serviceId) {
    const body = document.getElementById('log-body');
    if (body) {
      const el = document.createElement('div');
      const upper = line.toUpperCase();
      el.className = 'log-line' + (upper.includes('ERROR') || upper.includes('ERR ') ? ' err' : upper.includes('WARN') ? '' : '');
      el.textContent = line;
      body.appendChild(el);
      body.scrollTop = body.scrollHeight;
    } else {
      activeLogService = serviceId;
      render();
    }
  }
}

function setLogTab(id) { activeLogTab = id; render(); }
function closeLogTab(id) {
  post('stopLogStream', { serviceId: id });
  delete logTabs[id];
  if (activeLogTab === id) activeLogTab = Object.keys(logTabs)[0] || null;
  if (!activeLogTab) activeLogService = null;
  render();
}
function closeAllLogs() { post('stopAllLogStreams', {}); logTabs = {}; activeLogTab = null; activeLogService = null; render(); }
function clearLogPanel() { if (activeLogTab) logTabs[activeLogTab] = []; render(); }

function buildSnippetsView() {
  const snippets = state.snippets || [];
  const wsSnips = snippets.filter(s => s.scope === 'workspace');
  const globalSnips = snippets.filter(s => s.scope === 'global');

  function renderSnips(list) {
    return list.map(s => \`
      <div class="snippet-item">
        <span class="snippet-name">\${s.name}</span>
        <span class="snippet-scope">\${s.scope}</span>
        <div class="snippet-btns">
          <button class="snippet-btn" onclick="post('runSnippet',{command:'\${s.command}',runMode:'\${s.runMode||'terminal'}'})" title="\${s.runMode==='clipboard'?'Copy to clipboard':'Run in terminal'}">\${s.runMode==='clipboard'?ICONS.download:ICONS.play}</button>
          <button class="snippet-btn" onclick="toggleSnippet('\${s.id}')" title="Show command">\${ICONS.logs}</button>
          <button class="snippet-btn" onclick="post('deleteSnippet',{snippetId:'\${s.id}'})" title="Delete">\${ICONS.trash}</button>
        </div>
      </div>
      <div class="snippet-cmd" id="sc-\${s.id}">\${s.command}</div>
    \`).join('');
  }

  return \`
    <div style="overflow-y:auto;flex:1;">
      <div class="section-label">Workspace snippets</div>
      \${wsSnips.length ? renderSnips(wsSnips) : '<div class="empty-state" style="padding:12px 16px;">No workspace snippets yet.</div>'}
      <div class="section-label">Global snippets</div>
      \${globalSnips.length ? renderSnips(globalSnips) : '<div class="empty-state" style="padding:12px 16px;">No global snippets yet.</div>'}
      <button class="add-btn" onclick="addSnippet()">\${ICONS.plus} New snippet</button>
    </div>
  \`;
}

function buildProvidersView() {
  const providers = state.providers || [];
  const items = providers.map(p => \`
    <div style="border:1px solid var(--vscode-sideBarSectionHeader-border);border-radius:6px;overflow:hidden;margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--vscode-sideBarSectionHeader-background);">
        <div style="font-size:13px;font-weight:500;color:var(--vscode-foreground);flex:1;">\${p.name}</div>
        <div style="font-size:11px;color:var(--vscode-descriptionForeground);">\${p.description}</div>
        \${p.comingSoon ? '<span style="font-size:10px;padding:2px 6px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);">coming soon</span>' : '<span style="font-size:10px;color:var(--vscode-testing-iconPassed);">● connected</span>'}
      </div>
      \${!p.comingSoon ? \`<div style="padding:8px 14px;font-size:11px;color:var(--vscode-descriptionForeground);">Tabs: \${p.tabs.map(t => t.label).join(' · ')}</div>\` : ''}
    </div>
  \`).join('');

  return \`<div class="settings-body">\${items}
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button onclick="post('exportSettings')" style="font-size:11px;padding:4px 10px;cursor:pointer;">Export settings</button>
      <button onclick="post('importSettings')" style="font-size:11px;padding:4px 10px;cursor:pointer;">Import settings</button>
    </div>
  </div>\`;
}

function buildProfilesView() {
  const config = state.config || {};
  const profiles = config.profiles || [];
  const activeId = config.activeProfileId;

  const items = profiles.map(p => \`
    <div style="border:1px solid \${p.id === activeId ? 'var(--vscode-focusBorder)' : 'var(--vscode-sideBarSectionHeader-border)'};border-radius:6px;overflow:hidden;margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--vscode-sideBarSectionHeader-background);">
        <span style="width:8px;height:8px;border-radius:50%;background:\${p.colour};flex-shrink:0;display:inline-block;"></span>
        <span style="font-size:12px;font-weight:500;color:var(--vscode-foreground);flex:1;">\${p.name}</span>
        \${p.id === activeId ? '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:var(--vscode-testing-iconPassed);color:#fff;">active</span>' : \`<button onclick="post('switchProfile',{profileId:'\${p.id}'})" style="font-size:10px;padding:1px 6px;cursor:pointer;">activate</button>\`}
      </div>
      <div style="padding:8px 12px;font-size:11px;color:var(--vscode-descriptionForeground);">
        Tabs: \${(p.visibleTabs || []).join(' · ')} &nbsp;·&nbsp; Refresh: \${p.refreshInterval}ms
      </div>
    </div>
  \`).join('');

  return \`<div class="settings-body">\${items}</div>\`;
}

function buildSafetyView() {
  const settings = state.config?.settings || {};
  function row(label, hint, key) {
    return \`<div class="settings-row">
      <div><div class="settings-label">\${label}</div><div class="settings-hint">\${hint}</div></div>
      <div class="toggle \${settings[key] ? 'on' : ''}" onclick="toggleSetting('\${key}')"></div>
    </div>\`;
  }
  return \`<div class="settings-body">
    <div class="settings-section">
      <div class="settings-section-title">Confirmations</div>
      \${row('Confirm before remove','Container, image, volume remove','confirmBeforeRemove')}
      \${row('Confirm before prune','Bulk prune operations','confirmBeforePrune')}
      \${row('Confirm compose down','Prompt before stopping all services','confirmComposeDown')}
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Appearance</div>
      \${row('Show tab badges','Count indicators on nav items','showTabBadges')}
      \${row('Show uptime','Display uptime in container rows','showUptime')}
    </div>
  </div>\`;
}

function setNav(nav) { activeNav = nav; render(); }

function toggleResource(id) {
  const ch = document.getElementById('rc-' + id);
  const chev = document.getElementById('chev-' + id);
  const row = chev?.closest('.resource-row');
  if (ch) ch.classList.toggle('open');
  if (chev) chev.classList.toggle('open');
  if (row) row.classList.toggle('expanded');
}

function toggleSnippet(id) {
  document.getElementById('sc-' + id)?.classList.toggle('open');
}

function execAction(tabId, resourceId, actionId) {
  if (actionId === 'logs') {
    if (!logTabs[resourceId]) {
      logTabs[resourceId] = [];
      post('startLogStream', { serviceId: resourceId });
    }
    activeLogTab = resourceId;
    activeLogService = resourceId;
    render();
    return;
  }
  post('action', { tabId, resourceId, actionId });
}

function toggleSetting(key) {
  const settings = state.config?.settings || {};
  settings[key] = !settings[key];
  post('saveSettings', { settings });
}

function addSnippet() {
  const name = prompt('Snippet name:');
  if (!name) return;
  const command = prompt('Command:');
  if (!command) return;
  const scope = confirm('Save globally? (Cancel = workspace only)') ? 'global' : 'workspace';
  post('saveSnippet', { snippet: { id: Date.now().toString(), name, command, scope, icon: 'terminal', runMode: 'terminal' } });
}

post('ready');
    `;
  }
}
