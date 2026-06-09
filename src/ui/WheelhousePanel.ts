/**
 * WheelhousePanel.ts
 *
 * Webview panel — renders the entire Wheelhouse sidebar UI and handles all message traffic.
 *
 * The UI is inline HTML/CSS/JS (no framework, no bundler). All rendering happens in the webview;
 * the extension host sends state over postMessage and receives action/refresh/settings messages back.
 *
 * Key responsibilities:
 *   - sendFullState(): polls all visible tabs and posts a complete state snapshot to the webview.
 *   - startRefresh() / stopRefresh(): interval-based polling at the profile's refresh rate.
 *   - startDaemonRecovery(): 2s poll when Docker is unreachable; calls sendFullState() on recovery.
 *   - handleMessage(): routes inbound webview messages to provider actions, settings saves, etc.
 */
import * as vscode from 'vscode';
import { ProviderRegistry } from '../core/ProviderRegistry';
import { StorageManager } from '../storage/StorageManager';
import { Profile, Snippet, WebviewMessage } from '../types';

export class WheelhousePanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'wheelhouse.main';
  private view?: vscode.WebviewView;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private daemonRecoveryTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly storage: StorageManager,
    private readonly context: vscode.ExtensionContext
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage(this.handleMessage.bind(this));
    webviewView.onDidChangeVisibility(() => {
      console.log('[Wheelhouse] onDidChangeVisibility: visible =', webviewView.visible);
      if (webviewView.visible) this.sendFullState();
    });
    this.startRefresh();
    console.log('[Wheelhouse] resolveWebviewView: calling sendFullState');
    this.sendFullState();
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        console.log('[Wheelhouse] handleMessage: received ready');
        await this.sendFullState();
        break;

      case 'action': {
        const { tabId, resourceId, actionId } = msg.payload as { tabId: string; resourceId: string; actionId: string };
        const profile = this.storage.getActiveProfile();
        const tab = this.registry.getVisibleTabs(profile).find((t) => t.id === tabId);
        if (!tab) break;
        const provider = this.registry.get(tab.providerId);
        if (!provider) break;

        const cfg = profile.providers.find(p => p.id === provider.id);
        if (cfg) provider.configure(cfg);

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
        await this.sendTabData(tabId);
        break;
      }

      case 'refresh':
        await this.sendFullState();
        break;

      case 'activateProfile': {
        const { profileId } = msg.payload as { profileId: string };
        await this.storage.setActiveProfile(profileId);
        await this.registry.connectEnabled(this.storage.getActiveProfile());
        this.startRefresh();
        await this.sendFullState();
        break;
      }

      case 'openSettings':
        // now handled inline in the webview — just send state so it has fresh data
        await this.sendFullState();
        break;

      case 'popout':
        vscode.commands.executeCommand('wheelhouse.popout');
        break;

      case 'saveProviderEnabled': {
        const { providerId, enabled } = msg.payload as { providerId: string; enabled: boolean };
        const profile = this.storage.getActiveProfile();
        const existing = profile.providers.find(p => p.id === providerId);
        if (existing) {
          existing.enabled = enabled;
        } else {
          profile.providers.push({ id: providerId, enabled, settings: {} });
        }
        await this.storage.saveProfile(profile);
        if (enabled) await this.registry.connectEnabled(profile);
        await this.sendFullState();
        break;
      }

      case 'saveTabVisible': {
        const { tabId, visible } = msg.payload as { tabId: string; visible: boolean };
        const profile = this.storage.getActiveProfile();
        if (visible && !profile.visibleTabs.includes(tabId)) {
          profile.visibleTabs.push(tabId);
        } else if (!visible) {
          profile.visibleTabs = profile.visibleTabs.filter(t => t !== tabId);
        }
        await this.storage.saveProfile(profile);
        await this.sendFullState();
        break;
      }

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

      case 'saveSettings': {
        const { settings } = msg.payload as { settings: Record<string, unknown> };
        await this.storage.updateSettings(settings as Parameters<typeof this.storage.updateSettings>[0]);
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

      case 'openLink': {
        const { url } = msg.payload as { url: string };
        vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }

      case 'renameProfile': {
        const { profileId } = msg.payload as { profileId: string };
        const prof = this.storage.getConfig().profiles.find(p => p.id === profileId);
        if (!prof) break;
        const name = await vscode.window.showInputBox({ prompt: 'Profile name', value: prof.name });
        if (name?.trim()) {
          await this.storage.saveProfile({ ...prof, name: name.trim() });
          await this.sendFullState();
        }
        break;
      }

      case 'newProfile': {
        const name = await vscode.window.showInputBox({ prompt: 'New profile name', placeHolder: 'e.g. Work, Personal' });
        if (!name?.trim()) break;
        const base = this.storage.getActiveProfile();
        await this.storage.saveProfile({ ...base, id: Date.now().toString(), name: name.trim() });
        await this.sendFullState();
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
          vscode.window.showInformationMessage('Wheelhouse: Settings imported.');
        }
        break;
      }

      case 'dismissHint': {
        const { hintId } = msg.payload as { hintId: string };
        await this.storage.dismissHint(hintId);
        await this.sendFullState();
        break;
      }

      case 'resetHints': {
        await this.storage.resetDismissedHints();
        await this.sendFullState();
        break;
      }

      case 'markOnboarding': {
        const { moment } = msg.payload as { moment: 'moment1' | 'moment2' | 'moment3' };
        await this.storage.setOnboardingFlag(moment);
        await this.sendFullState();
        break;
      }

      case 'openComposeFile': {
        const { filePath } = msg.payload as { filePath: string };
        if (filePath) {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
        }
        break;
      }

      case 'pullImage': {
        const { imageRef } = msg.payload as { imageRef: string };
        const dockerProvider = this.registry.get('docker');
        if (!dockerProvider) break;
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Wheelhouse: pulling ${imageRef}`, cancellable: false },
            async () => { await dockerProvider.executeAction('images', imageRef, 'pull'); }
          );
          await this.sendTabData('images');
        } catch (err) {
          this.post({ type: 'pullError', payload: { message: String(err) } });
        }
        break;
      }

      case 'daemonAction': {
        const { action } = msg.payload as { action: 'start' | 'stop' | 'restart' };
        let cmd: string;
        if (process.platform === 'win32') {
          // Docker Desktop installs to Program Files — "Docker Desktop" is a window title, not an exe name
          const exe = '"$env:ProgramFiles\\Docker\\Docker\\Docker Desktop.exe"';
          const startCmd = `Start-Process ${exe}`;
          const stopCmd = `Stop-Process -Name "Docker Desktop" -Force -ErrorAction SilentlyContinue`;
          cmd = action === 'start' ? startCmd
              : action === 'stop'  ? stopCmd
              : `${stopCmd}; Start-Sleep 3; ${startCmd}`;
        } else if (process.platform === 'darwin') {
          const startCmd = 'open -a Docker';
          const stopCmd = `osascript -e 'quit app "Docker Desktop"'`;
          cmd = action === 'start' ? startCmd
              : action === 'stop'  ? stopCmd
              : `${stopCmd} && sleep 3 && ${startCmd}`;
        } else {
          cmd = `sudo systemctl ${action} docker`;
        }
        const t = vscode.window.createTerminal('Wheelhouse: Docker');
        t.sendText(cmd);
        t.show();
        break;
      }
    }
  }

  private async sendFullState(): Promise<void> {
    console.log('[Wheelhouse] sendFullState: start');
    const profile = this.storage.getActiveProfile();
    const config = this.storage.getConfig();

    // Pass performance-gating settings to providers that support it
    const dockerProvider = this.registry.get('docker');
    if (dockerProvider && 'configureGlobal' in dockerProvider) {
      (dockerProvider as { configureGlobal(s: { checkPortConflicts?: boolean }): void })
        .configureGlobal({ checkPortConflicts: config.settings.checkPortConflicts });
    }

    const tabs = this.registry.getVisibleTabs(profile);
    console.log('[Wheelhouse] sendFullState: tabs =', tabs.map(t => t.id));

    const snippets = this.storage.getAllSnippets(profile.snippetScope);

    const tabData = await Promise.all(
      tabs.map(async (tab) => {
        console.log('[Wheelhouse] sendFullState: fetching tab', tab.id);
        const provider = this.registry.get(tab.providerId);
        if (!provider || provider.status === 'disconnected') {
          console.log('[Wheelhouse] sendFullState: tab', tab.id, 'provider not connected, status =', provider?.status);
          return { tabId: tab.id, resources: [], badge: 0 };
        }
        try {
          const data = await provider.getTabData(tab.id);
          console.log('[Wheelhouse] sendFullState: tab', tab.id, 'done, resources =', data.resources.length);
          return data;
        } catch (err) {
          console.error('[Wheelhouse] sendFullState: tab', tab.id, 'error:', err);
          return { tabId: tab.id, resources: [], sectionLabel: 'Error loading data' };
        }
      })
    );
    console.log('[Wheelhouse] sendFullState: all tabs done, posting state');

    // Build providers AFTER tabData so status reflects any mid-session daemon changes
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
      composeFilePath: 'composeFilePath' in p ? (p as { composeFilePath: string | undefined }).composeFilePath : undefined,
      activeContext: 'activeContext' in p ? (p as { activeContext: string }).activeContext : undefined,
    }));

    // Start fast-polling when Docker is unreachable so recovery is detected quickly
    const dockerMeta = providers.find(p => p.id === 'docker');
    if (dockerMeta?.status === 'error') {
      this.startDaemonRecovery();
    } else {
      this.stopDaemonRecovery();
    }

    this.post({
      type: 'state',
      payload: {
        profile, config, tabs, tabData, providers, snippets,
        platform: process.platform,
        dismissedHints: this.storage.getDismissedHints(),
        onboarding: this.storage.getOnboardingFlags(),
      },
    });
  }

  private async sendTabData(tabId: string): Promise<void> {
    const profile = this.storage.getActiveProfile();
    const tab = this.registry.getVisibleTabs(profile).find((t) => t.id === tabId);
    if (!tab) return;
    const provider = this.registry.get(tab.providerId);
    if (!provider) return;
    const data = await provider.getTabData(tabId);
    this.post({ type: 'tabData', payload: data });
  }

  private startRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const interval = this.storage.getActiveProfile().refreshInterval;
    if (interval > 0) {
      this.refreshTimer = setInterval(() => this.sendFullState(), interval);
    }
  }

  refresh(): void {
    this.sendFullState();
  }

  private post(msg: WebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.stopDaemonRecovery();
  }

  private startDaemonRecovery(): void {
    if (this.daemonRecoveryTimer) return;
    this.daemonRecoveryTimer = setInterval(async () => {
      const docker = this.registry.get('docker');
      if (!docker) { this.stopDaemonRecovery(); return; }
      const available = await docker.isAvailable();
      if (available) {
        this.stopDaemonRecovery();
        await this.sendFullState();
      }
    }, 2000);
  }

  private stopDaemonRecovery(): void {
    if (this.daemonRecoveryTimer) {
      clearInterval(this.daemonRecoveryTimer);
      this.daemonRecoveryTimer = undefined;
    }
  }

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) nonce += chars[Math.floor(Math.random() * chars.length)];
    return nonce;
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wheelhouse</title>
<style>
  ${this.getCss()}
</style>
</head>
<body>
<div id="app">
  <div class="loading">
    <div class="loading-dot"></div>
    <span>Connecting…</span>
  </div>
</div>
<script>
  ${this.getJs()}
</script>
<div id="chip-overlay" style="position:fixed;z-index:9999;display:none;"></div>
</body>
</html>`;
  }

  private getCss(): string {
    return `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { height: 100%; }
      body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); overflow: hidden; display: flex; flex-direction: column; }
      #app { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
      body.vscode-light {
        --wh-bg-success: rgba(34,197,94,0.12); --wh-text-success: #2d7a3a;
        --wh-bg-warning: rgba(245,158,11,0.12); --wh-text-warning: #854f0b;
        --wh-bg-danger: rgba(239,68,68,0.12); --wh-text-danger: #a32d2d;
        --wh-bg-info: rgba(55,138,221,0.12); --wh-text-info: #185fa5;
        --wh-bg-neutral: rgba(0,0,0,0.06); --wh-text-neutral: #5f5e5a;
        --wh-border-soft: rgba(0,0,0,0.10);
        --wh-dot-run: #22c55e; --wh-dot-warn: #f59e0b; --wh-dot-err: #ef4444; --wh-dot-info: #378add;
      }
      body.vscode-dark, body.vscode-high-contrast {
        --wh-bg-success: rgba(34,197,94,0.12); --wh-text-success: #c0dd97;
        --wh-bg-warning: rgba(245,158,11,0.12); --wh-text-warning: #fac775;
        --wh-bg-danger: rgba(239,68,68,0.12); --wh-text-danger: #f09595;
        --wh-bg-info: rgba(55,138,221,0.12); --wh-text-info: #85b7eb;
        --wh-bg-neutral: rgba(255,255,255,0.05); --wh-text-neutral: #9d9d9d;
        --wh-border-soft: rgba(255,255,255,0.08);
        --wh-dot-run: #22c55e; --wh-dot-warn: #f59e0b; --wh-dot-err: #ef4444; --wh-dot-info: #378add;
      }

      .loading { display: flex; align-items: center; gap: 8px; padding: 16px; color: var(--vscode-descriptionForeground); }
      .loading-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-focusBorder); animation: pulse 1.2s ease-in-out infinite; }
      @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
      @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }

      /* ── provider chips bar ── */
      .providers { display: flex; align-items: center; gap: 5px; padding: 5px 8px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); flex-wrap: wrap; position: relative; z-index: 10; }

      .chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px 3px 5px; border-radius: 4px; font-size: 10px; font-weight: 500; border: 1px solid var(--wh-border-soft); cursor: default; user-select: none; }
      .chip-logo { width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .chip-logo svg { width: 14px; height: 14px; }
      .chip-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
      .chip-ok { background: var(--wh-bg-success); color: var(--wh-text-success); }
      .dot-ok { background: var(--wh-dot-run); }
      .chip-info { background: var(--wh-bg-info); color: var(--wh-text-info); }
      .dot-info { background: var(--wh-dot-info); }
      .chip-err { background: var(--wh-bg-danger); color: var(--wh-text-danger); }
      .dot-err { background: var(--wh-dot-err); animation: blink 1.4s ease-in-out infinite; }
      .chip-off { background: var(--wh-bg-neutral); color: var(--wh-text-neutral); }
      .dot-off { background: var(--vscode-descriptionForeground); opacity: 0.4; }
      .chips-spacer { flex: 1; }
      .chip-actions { display: flex; gap: 1px; }
      .icon-btn { background: none; border: none; cursor: pointer; padding: 3px 4px; border-radius: 3px; color: var(--vscode-icon-foreground); opacity: 0.6; display: flex; align-items: center; }
      .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
      .icon-btn svg { width: 14px; height: 14px; }

      /* ── helper card ── */
      .helper { display: flex; align-items: flex-start; gap: 8px; padding: 10px; margin: 8px; border-radius: 6px; border: 1px solid var(--vscode-sideBarSectionHeader-border); background: var(--vscode-sideBarSectionHeader-background); }
      .helper > svg { width: 16px; height: 16px; color: var(--vscode-descriptionForeground); flex-shrink: 0; margin-top: 1px; }
      .helper-body { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.6; }
      .helper-body strong { color: var(--vscode-foreground); display: block; margin-bottom: 2px; }
      .helper-link { font-size: 10px; color: var(--vscode-textLink-foreground); cursor: pointer; display: inline-block; margin-top: 4px; }
      .helper-link:hover { text-decoration: underline; }

      /* ── profile row ── */
      .profile-row { display: flex; align-items: center; gap: 6px; padding: 5px 10px; background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .dropdown-wrap { position: relative; }
      .profile-pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; background: var(--vscode-sideBarSectionHeader-background); border: 1px solid var(--vscode-sideBarSectionHeader-border); cursor: pointer; user-select: none; max-width: 160px; }
      .profile-pill:hover { border-color: var(--vscode-focusBorder); }
      .p-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .p-name { color: var(--vscode-foreground); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .p-caret { font-size: 9px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
      .p-icon-btn { background: none; border: none; padding: 3px 4px; cursor: pointer; border-radius: 3px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; flex-shrink: 0; }
      .p-icon-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
      .p-icon-btn svg { width: 13px; height: 13px; }

      /* ── profile dropdown ── */
      .dropdown { position: absolute; top: calc(100% + 3px); left: 0; min-width: 160px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 5px; z-index: 100; overflow: hidden; box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
      .d-item { display: flex; align-items: center; gap: 7px; padding: 7px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); cursor: pointer; }
      .d-item:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
      .d-item.d-active { color: var(--vscode-foreground); font-weight: 500; }
      .d-item svg { width: 12px; height: 12px; flex-shrink: 0; }
      .d-check { margin-left: auto; color: var(--wh-dot-run); }
      .d-divider { height: 1px; background: var(--vscode-sideBarSectionHeader-border); }

      /* ── tabs bar ── */
      .tabs-bar { display: flex; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); overflow-x: auto; scrollbar-width: none; flex-shrink: 0; }
      .tabs-bar::-webkit-scrollbar { display: none; }
      .tab { padding: 6px 9px; font-size: 11px; font-weight: 500; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; white-space: nowrap; display: flex; align-items: center; gap: 3px; flex-shrink: 0; cursor: pointer; user-select: none; }
      .tab:hover { color: var(--vscode-foreground); }
      .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
      .t-ct { font-size: 9px; padding: 0 4px; border-radius: 10px; font-weight: 600; }
      .ct-ok { background: var(--wh-bg-success); color: var(--wh-text-success); }
      .ct-warn { background: var(--wh-bg-warning); color: var(--wh-text-warning); }
      .ct-n { background: var(--wh-bg-neutral); color: var(--vscode-descriptionForeground); }

      /* ── deck layout ── */
      .deck { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      .tab-content { display: none; flex: 1; min-height: 0; overflow-y: auto; flex-direction: column; }
      .tab-content.active { display: flex; }

      /* ── section header ── */
      .sec-hdr { display: flex; align-items: center; padding: 4px 10px; font-size: 10px; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); gap: 3px; flex-shrink: 0; }
      .sec-txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sec-btn { background: none; border: none; padding: 2px 3px; cursor: pointer; border-radius: 3px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; opacity: 0.7; }
      .sec-btn:hover { opacity: 1; color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
      .sec-btn svg { width: 12px; height: 12px; }

      /* ── services ── */
      .svc { border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .svc:last-child { border-bottom: none; }
      .svc-row { display: flex; align-items: center; gap: 5px; padding: 5px 10px; min-height: 30px; cursor: pointer; }
      .svc-row:hover { background: var(--vscode-list-hoverBackground); }
      .svc-row:hover .ab { opacity: 0.6; }
      .chev { width: 10px; flex-shrink: 0; display: flex; align-items: center; color: var(--vscode-descriptionForeground); transition: transform 0.12s; }
      .chev svg { width: 10px; height: 10px; }
      .chev.open { transform: rotate(90deg); }
      .svc-name { font-size: 12px; font-weight: 500; color: var(--vscode-foreground); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .svc-name.dim { color: var(--vscode-descriptionForeground); }
      .s-chip { font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px; }
      .s-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
      .sc-run { background: var(--wh-bg-success); color: var(--wh-text-success); }
      .sd-run { background: var(--wh-dot-run); }
      .sc-stop { background: var(--wh-bg-neutral); color: var(--vscode-descriptionForeground); border: 1px solid var(--wh-border-soft); }
      .sd-stop { background: var(--vscode-descriptionForeground); opacity: 0.5; }
      .sc-err { background: var(--wh-bg-danger); color: var(--wh-text-danger); }
      .sd-err { background: var(--wh-dot-err); }
      .sc-warn { background: var(--wh-bg-warning); color: var(--wh-text-warning); }
      .sd-warn { background: var(--wh-dot-warn); }
      .divr { width: 1px; height: 12px; background: var(--vscode-sideBarSectionHeader-border); flex-shrink: 0; }
      .acts { display: flex; flex-shrink: 0; }
      .ab { background: none; border: none; padding: 3px; cursor: pointer; border-radius: 3px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; opacity: 0; }
      .ab:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); opacity: 1 !important; }
      .ab.danger:hover { color: var(--wh-text-danger); }
      .ab svg { width: 13px; height: 13px; }

      /* ── expanded children ── */
      .children { background: var(--vscode-sideBarSectionHeader-background); border-top: 1px solid var(--vscode-sideBarSectionHeader-border); display: none; }
      .children.open { display: block; }
      .child-row { display: flex; gap: 8px; padding: 2px 10px 2px 24px; }
      .child-row:first-child { padding-top: 5px; }
      .child-row:last-child { padding-bottom: 5px; }
      .c-lbl { font-size: 9px; color: var(--vscode-descriptionForeground); width: 36px; flex-shrink: 0; padding-top: 1px; font-family: var(--vscode-editor-font-family, monospace); }
      .c-val { font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.8; color: var(--vscode-descriptionForeground); overflow-wrap: break-word; word-break: break-all; }
      .c-val.ok { color: var(--wh-text-success); }
      .c-val.warn { color: var(--wh-text-warning); }
      .c-val.err { color: var(--wh-text-danger); }
      .c-val.dim { opacity: 0.7; }

      /* ── empty state ── */
      .empty-state { padding: 20px 12px; text-align: center; }
      .empty-state svg { width: 22px; height: 22px; color: var(--vscode-descriptionForeground); display: block; margin: 0 auto 8px; opacity: 0.4; }
      .empty-state p { font-size: 11px; color: var(--vscode-descriptionForeground); line-height: 1.6; }

      /* ── snippets ── */
      .snip-section-lbl { font-size: 9px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); padding: 4px 10px; background: var(--vscode-sideBarSectionHeader-background); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .snippet-item { border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .snippet-item:last-of-type { border-bottom: none; }
      .snippet-header { display: flex; align-items: center; gap: 7px; padding: 6px 10px; cursor: pointer; }
      .snippet-header:hover { background: var(--vscode-list-hoverBackground); }
      .snippet-header:hover .ab { opacity: 0.6; }
      .snippet-icon { color: var(--vscode-descriptionForeground); display: flex; align-items: center; flex-shrink: 0; }
      .snippet-icon svg { width: 12px; height: 12px; }
      .snippet-name { font-size: 11px; color: var(--vscode-foreground); flex: 1; }
      .snippet-scope-badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: var(--wh-bg-neutral); color: var(--vscode-descriptionForeground); border: 1px solid var(--wh-border-soft); }
      .snippet-cmd { display: none; padding: 5px 10px 5px 30px; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); background: var(--vscode-sideBarSectionHeader-background); border-top: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .snippet-cmd.open { display: block; }
      .add-btn { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-top: 1px dashed var(--vscode-sideBarSectionHeader-border); color: var(--vscode-descriptionForeground); font-size: 11px; cursor: pointer; background: none; width: 100%; border-bottom: none; border-left: none; border-right: none; }
      .add-btn:hover { color: var(--vscode-foreground); }
      .add-btn svg { width: 13px; height: 13px; }

      /* ── forms ── */
      .inline-form { padding: 10px; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); background: var(--vscode-sideBarSectionHeader-background); display: flex; flex-direction: column; gap: 8px; }
      .form-row { display: flex; flex-direction: column; gap: 3px; }
      .form-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
      .form-input { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 4px 7px; font-size: 12px; width: 100%; font-family: inherit; }
      .form-input:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
      .form-select { background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); color: var(--vscode-dropdown-foreground); border-radius: 3px; padding: 4px 7px; font-size: 12px; width: 100%; font-family: inherit; }
      .form-textarea { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 5px 7px; font-size: 12px; width: 100%; font-family: var(--vscode-editor-font-family, monospace); resize: vertical; min-height: 52px; }
      .form-textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
      .form-actions { display: flex; gap: 6px; justify-content: flex-end; }
      .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
      .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
      .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
      .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
      .btn-danger { background: var(--wh-bg-danger); color: var(--wh-text-danger); border: 1px solid var(--wh-text-danger); border-radius: 3px; padding: 4px 12px; font-size: 12px; cursor: pointer; }

      /* ── colour swatches ── */
      .colour-swatches { display: flex; gap: 5px; flex-wrap: wrap; }
      .swatch { width: 18px; height: 18px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; }
      .swatch.selected { border-color: var(--vscode-focusBorder); }

      /* ── settings panel ── */
      .settings-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
      .settings-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); background: var(--vscode-sideBarSectionHeader-background); flex-shrink: 0; }
      .settings-title { font-size: 11px; font-weight: 600; color: var(--vscode-foreground); letter-spacing: 0.05em; text-transform: uppercase; }
      .settings-body { display: flex; flex: 1; overflow: hidden; }
      .settings-nav { width: 120px; flex-shrink: 0; border-right: 1px solid var(--vscode-sideBarSectionHeader-border); background: var(--vscode-sideBarSectionHeader-background); overflow-y: auto; padding: 6px 0; }
      .nav-section-lbl { font-size: 9px; font-weight: 600; color: var(--vscode-descriptionForeground); letter-spacing: 0.08em; text-transform: uppercase; padding: 7px 10px 3px; }
      .nav-item { display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); cursor: pointer; border-left: 2px solid transparent; user-select: none; }
      .nav-item:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
      .nav-item.active { color: var(--vscode-foreground); background: var(--vscode-sideBar-background); border-left-color: var(--vscode-focusBorder); font-weight: 500; }
      .nav-item svg { width: 13px; height: 13px; flex-shrink: 0; opacity: 0.7; }
      .nav-item.active svg { opacity: 1; }
      .settings-content { flex: 1; overflow-y: auto; }

      /* ── provider cards ── */
      .provider-card { border: 1px solid var(--vscode-sideBarSectionHeader-border); border-radius: 6px; overflow: hidden; margin: 8px 8px 0; }
      .provider-card.enabled { border-color: var(--vscode-focusBorder); }
      .prov-hdr { display: flex; align-items: center; gap: 8px; padding: 7px 9px; background: var(--vscode-sideBarSectionHeader-background); }
      .prov-icon { width: 22px; height: 22px; border-radius: 4px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: var(--wh-bg-info); }
      .prov-icon svg { width: 13px; height: 13px; color: var(--wh-text-info); }
      .prov-icon.k8s { background: var(--wh-bg-success); }
      .prov-icon.k8s svg { color: var(--wh-text-success); }
      .prov-info { flex: 1; min-width: 0; }
      .prov-name { font-size: 11px; font-weight: 500; color: var(--vscode-foreground); }
      .prov-desc { font-size: 9px; color: var(--vscode-descriptionForeground); }
      .prov-soon { font-size: 9px; padding: 1px 4px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
      .prov-body { padding: 6px 9px; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .tab-row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
      .tab-row svg { width: 11px; height: 11px; flex-shrink: 0; color: var(--vscode-descriptionForeground); }
      .tab-row-name { font-size: 10px; color: var(--vscode-descriptionForeground); flex: 1; }
      .coming-soon-msg { font-size: 9px; color: var(--vscode-descriptionForeground); padding: 8px 9px; text-align: center; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); }

      /* ── toggle ── */
      .toggle { display: inline-block; width: 28px; height: 16px; border-radius: 8px; background: rgba(128,128,128,0.4); position: relative; cursor: pointer; flex-shrink: 0; transition: background 0.15s; vertical-align: middle; }
      .toggle.on { background: var(--wh-dot-run); }
      .toggle::after { content: ''; position: absolute; width: 12px; height: 12px; background: #ffffff; border-radius: 50%; top: 2px; left: 2px; transition: left 0.15s; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
      .toggle.on::after { left: 14px; }
      .tab-toggle { width: 22px; height: 12px; border-radius: 6px; }
      .tab-toggle::after { width: 8px; height: 8px; top: 2px; left: 2px; }
      .tab-toggle.on::after { left: 12px; }

      /* ── profile cards (settings) ── */
      .profile-card { border: 1px solid var(--vscode-sideBarSectionHeader-border); border-radius: 6px; overflow: hidden; margin: 8px 8px 0; }
      .profile-card.active-card { border-color: var(--vscode-focusBorder); }
      .prof-hdr { display: flex; align-items: center; gap: 7px; padding: 6px 9px; background: var(--vscode-sideBarSectionHeader-background); }
      .prof-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
      .prof-name { font-size: 11px; font-weight: 500; color: var(--vscode-foreground); flex: 1; }
      .prof-active-badge { font-size: 9px; padding: 1px 5px; border-radius: 2px; background: var(--wh-bg-success); color: var(--wh-text-success); }
      .prof-body { padding: 7px 9px; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); display: flex; flex-direction: column; gap: 6px; }
      .p-row { display: flex; align-items: flex-start; gap: 8px; }
      .p-lbl { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; width: 52px; padding-top: 2px; }
      .p-val { font-size: 10px; color: var(--vscode-descriptionForeground); }
      .pills { display: flex; gap: 3px; flex-wrap: wrap; flex: 1; }
      .pill { font-size: 9px; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--vscode-sideBarSectionHeader-border); color: var(--vscode-descriptionForeground); }
      .pill.on { background: var(--wh-bg-info); color: var(--wh-text-info); border-color: transparent; }
      .p-mono { font-size: 9px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); }
      .prof-actions { display: flex; gap: 4px; padding: 5px 9px; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .add-profile-btn { display: flex; align-items: center; gap: 6px; padding: 6px 9px; margin: 8px 8px 0; border: 1px dashed var(--vscode-sideBarSectionHeader-border); border-radius: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; cursor: pointer; background: none; width: calc(100% - 16px); }
      .add-profile-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }

      /* ── settings rows ── */
      .settings-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .settings-row:last-child { border-bottom: none; }
      .settings-row-lbl { font-size: 11px; color: var(--vscode-foreground); flex: 1; }
      .settings-row-desc { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 1px; }
      .settings-group-lbl { padding: 8px 10px 3px; font-size: 9px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
      .settings-import-export { display: flex; gap: 6px; padding: 8px 10px 4px; }

      /* ── chip dropdowns ── */
      .chip { cursor: pointer; position: relative; }
      .chip-dd { min-width: 190px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 5px; box-shadow: 0 6px 20px rgba(0,0,0,0.3); overflow: hidden; }
      .chip-dd-hdr { padding: 7px 10px 5px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .chip-dd-title { font-size: 11px; font-weight: 500; color: var(--vscode-foreground); }
      .chip-dd-sub { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 1px; font-family: var(--vscode-editor-font-family, monospace); }
      .chip-dd-item { display: flex; align-items: center; gap: 7px; padding: 6px 10px; font-size: 11px; color: var(--vscode-foreground); cursor: pointer; }
      .chip-dd-item:hover { background: var(--vscode-list-hoverBackground); }
      .chip-dd-item svg { width: 12px; height: 12px; flex-shrink: 0; }
      .chip-dd-item.primary { color: var(--wh-text-info); font-weight: 500; }
      .chip-dd-warn { display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 10px; color: var(--wh-text-warning); background: var(--wh-bg-warning); border-top: 1px solid var(--wh-border-soft); cursor: pointer; }
      .chip-dd-divider { height: 1px; background: var(--vscode-sideBarSectionHeader-border); }

      /* ── hints banner ── */
      .hint-banner { display: flex; align-items: flex-start; gap: 8px; padding: 7px 10px; border-left: 3px solid var(--wh-dot-warn); background: var(--wh-bg-warning); font-size: 11px; color: var(--vscode-foreground); flex-shrink: 0; }
      .hint-banner.hint-success { border-left-color: var(--wh-dot-run); background: var(--wh-bg-success); }
      .hint-banner svg { width: 14px; height: 14px; flex-shrink: 0; margin-top: 1px; color: var(--wh-dot-warn); }
      .hint-banner.hint-success svg { color: var(--wh-dot-run); }
      .hint-body { flex: 1; line-height: 1.5; }
      .hint-act { font-size: 10px; color: var(--vscode-textLink-foreground); cursor: pointer; display: inline-block; margin-top: 3px; }
      .hint-act:hover { text-decoration: underline; }
      .hint-dismiss { background: none; border: none; cursor: pointer; padding: 1px 3px; color: var(--vscode-descriptionForeground); border-radius: 2px; flex-shrink: 0; display: flex; align-items: center; }
      .hint-dismiss:hover { color: var(--vscode-foreground); }
      .hint-dismiss svg { width: 11px; height: 11px; }

      /* ── onboarding ── */
      .onboarding-card { margin: 8px; padding: 10px; border-radius: 6px; border: 1px solid var(--wh-dot-info); background: var(--wh-bg-info); font-size: 11px; flex-shrink: 0; }
      .onboarding-title { font-size: 12px; font-weight: 500; color: var(--vscode-foreground); margin-bottom: 8px; display: block; }
      .onboarding-step { display: flex; align-items: center; gap: 7px; padding: 3px 0; color: var(--vscode-descriptionForeground); }
      .onboarding-step.done { color: var(--wh-text-success); }
      .onboarding-step svg { width: 13px; height: 13px; flex-shrink: 0; }
      .onboarding-dismiss { margin-top: 8px; font-size: 10px; color: var(--vscode-textLink-foreground); cursor: pointer; display: inline-block; }
      .onboarding-dismiss:hover { text-decoration: underline; }

      /* ── onboarding moment 3 inline callout ── */
      .ob3-callout { display: flex; align-items: flex-start; gap: 7px; padding: 6px 10px; background: var(--wh-bg-danger); border-top: 1px solid var(--wh-border-soft); font-size: 10px; color: var(--wh-text-danger); }
      .ob3-callout svg { width: 12px; height: 12px; flex-shrink: 0; margin-top: 1px; }
      .ob3-callout-body { flex: 1; line-height: 1.5; }
      .ob3-dismiss { font-size: 10px; color: var(--vscode-textLink-foreground); cursor: pointer; flex-shrink: 0; align-self: flex-end; white-space: nowrap; }
      .ob3-dismiss:hover { text-decoration: underline; }

      /* ── pending action state ── */
      .svc-row.pending { opacity: 0.6; pointer-events: none; }
      .pending-chip { font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; background: var(--wh-bg-info); color: var(--wh-text-info); flex-shrink: 0; animation: pulse 1.2s ease-in-out infinite; }

      /* ── images pull row ── */
      .pull-row { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); background: var(--vscode-sideBarSectionHeader-background); flex-shrink: 0; }
      .pull-input { flex: 1; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 4px 7px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); min-width: 0; }
      .pull-input:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
      .pull-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 4px 10px; font-size: 11px; cursor: pointer; flex-shrink: 0; white-space: nowrap; }
      .pull-btn:hover { background: var(--vscode-button-hoverBackground); }
      .pull-error { padding: 4px 10px; font-size: 10px; color: var(--wh-text-danger); background: var(--wh-bg-danger); border-bottom: 1px solid var(--wh-border-soft); flex-shrink: 0; }
      .img-unused { opacity: 0.75; }
      .img-unused-note { padding: 2px 10px 5px 24px; font-size: 9px; color: var(--wh-text-warning); font-family: var(--vscode-editor-font-family, monospace); }

      /* ── commands cheat sheet ── */
      .cmd-search { display: block; width: calc(100% - 20px); margin: 8px 10px 4px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 3px; padding: 4px 7px; font-size: 11px; font-family: inherit; }
      .cmd-search:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
      .cmd-group-lbl { padding: 6px 10px 3px; font-size: 9px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
      .cmd-row { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); }
      .cmd-row:last-child { border-bottom: none; }
      .cmd-label { font-size: 11px; color: var(--vscode-foreground); flex: 1; min-width: 0; }
      .cmd-code { font-size: 10px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); flex: 2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .cmd-svc { color: var(--wh-text-success); font-weight: 500; }
      .cmd-copy { background: none; border: 1px solid var(--wh-border-soft); border-radius: 3px; padding: 1px 6px; font-size: 9px; color: var(--vscode-descriptionForeground); cursor: pointer; flex-shrink: 0; }
      .cmd-copy:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
      .cmd-copied { color: var(--wh-text-success); border-color: var(--wh-text-success) !important; }
      .cmd-note { padding: 6px 10px 8px; font-size: 10px; color: var(--vscode-descriptionForeground); font-style: italic; }
    `;
  }

  private getJs(): string {
    return `
      const vscode = acquireVsCodeApi();
      let state = null;
      let activeTab = null;
      let profilePickerOpen = false;
      let openChipId = null;
      let pullError = '';
      let cmdFilter = '';
      const expandedResources = new Set();
      const expandedSnippets = new Set();
      const pendingActions = new Map(); // resourceId → { tabId, actionId }

      // settings state
      let settingsOpen = false;
      let settingsSection = 'providers';
      let editingProfileId = null;  // profile being edited in settings
      let newProfileDraft = null;   // draft for new profile form
      let editingSnippetId = null;  // snippet being edited
      let newSnippetDraft = null;   // draft for new snippet form

      const PRESET_COLOURS = ['#378add','#22c55e','#f59e0b','#ef4444','#a855f7','#ec4899','#14b8a6','#6366f1','#f97316','#64748b'];

      // ── icons ──────────────────────────────────────────────────────────────
      const ICONS = {
        refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
        stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
        play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
        terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
        logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
        download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
        plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22v-5"/><path d="M9 7V2"/><path d="M15 7V2"/><path d="M6 13v-2a6 6 0 0 1 12 0v2a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/></svg>',
        user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
        terminal2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 16 21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="7 10 10 13 7 16"/><line x1="13" y1="16" x2="17" y2="16"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
        upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
        docker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12.5c0 .8-.7 1.5-1.5 1.5H3.5C2.7 14 2 13.3 2 12.5V9h20v3.5z"/><rect x="5" y="6" width="3" height="3"/><rect x="9" y="6" width="3" height="3"/><rect x="13" y="6" width="3" height="3"/><rect x="9" y="3" width="3" height="3"/></svg>',
        hexagon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/></svg>',
        'external-link': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      };

      function icon(name) { return ICONS[name] || ICONS['settings']; }

      // ── message handling ───────────────────────────────────────────────────
      console.log('[Wheelhouse webview] script loaded, posting ready');
      window.addEventListener('message', (event) => {
        const msg = event.data;
        console.log('[Wheelhouse webview] message received:', msg.type);
        if (msg.type === 'state') {
          state = msg.payload;
          if (!activeTab && state.tabs.length > 0) activeTab = state.tabs[0].id;
          render();
        } else if (msg.type === 'tabData') {
          if (state) {
            const idx = state.tabData.findIndex(t => t.tabId === msg.payload.tabId);
            if (idx >= 0) {
              (msg.payload.resources || []).forEach(r => pendingActions.delete(r.id));
              state.tabData[idx] = msg.payload;
            }
            if (!settingsOpen) render();
          }
        } else if (msg.type === 'pullError') {
          pullError = msg.payload.message || 'Pull failed';
          render();
        }
      });

      function post(type, payload) { vscode.postMessage({ type, payload }); }

      // ── render ─────────────────────────────────────────────────────────────
      function render() {
        if (!state) return;
        const activeContent = document.querySelector('.tab-content.active');
        const savedScroll = activeContent ? activeContent.scrollTop : 0;
        try {
          document.getElementById('app').innerHTML = settingsOpen ? renderSettings() : renderDeck();
          restoreExpanded();
          if (savedScroll > 0) {
            const newActiveContent = document.querySelector('.tab-content.active');
            if (newActiveContent) newActiveContent.scrollTop = savedScroll;
          }
        } catch(e) {
          console.error('[Wheelhouse webview] render() threw:', e);
          document.getElementById('app').innerHTML = '<div style="padding:16px;color:red;font-size:11px;">Render error: ' + e.message + '</div>';
        }
      }

      function restoreExpanded() {
        expandedResources.forEach(id => {
          const children = document.getElementById('rc-' + id);
          const chev = document.getElementById('chev-' + id);
          if (children) children.classList.add('open');
          if (chev) chev.classList.add('open');
        });
        expandedSnippets.forEach(id => {
          document.getElementById('sc-' + id)?.classList.add('open');
        });
      }

      function outsidePickerHandler(e) {
        const dropdown = document.querySelector('.dropdown');
        if (dropdown && !dropdown.contains(e.target)) {
          profilePickerOpen = false;
          render();
        }
      }

      // ── deck ───────────────────────────────────────────────────────────────
      function renderDeck() {
        const profile = state.profile;
        const docker = (state.providers || []).find(p => p.id === 'docker');
        const helperCard = docker && docker.status === 'error' ? renderHelperCard('docker') : '';
        return \`<div class="deck">\${renderProviders()}\${renderOnboarding()}\${renderHintsBanner()}\${helperCard}\${renderProfileRow(profile)}\${renderTabs()}\${renderTabContents()}</div>\`;
      }

      function evaluateHints() {
        const hints = [];
        const tabData = state.tabData || [];
        const allResources = tabData.flatMap(td => td.resources || []);

        // V1 compose syntax
        const composeTd = tabData.find(td => td.tabId === 'compose');
        if (composeTd?.v1Syntax) hints.push({
          id: 'v1-syntax', type: 'warn',
          message: 'Compose file uses deprecated version: field',
          action: 'View docs →', actionFn: \`post('openLink',{url:'https://docs.docker.com/compose/compose-file/'})\`
        });

        // Missing .env file
        if (composeTd?.missingEnvFile) hints.push({
          id: 'missing-env', type: 'warn',
          message: 'Compose references environment variables but no .env file found',
          action: 'Learn more →', actionFn: \`post('openLink',{url:'https://docs.docker.com/compose/environment-variables/'})\`
        });

        // Port conflicts — detected by warn-typed port children
        const portConflictSvcs = allResources.filter(r =>
          (r.children || []).some(c => c.label === 'ports' && c.type === 'warn')
        );
        if (portConflictSvcs.length > 0) {
          const name = portConflictSvcs[0].name;
          hints.push({
            id: 'port-conflict', type: 'warn',
            message: \`Port conflict detected — \${name} may fail to start\`,
            action: 'Go to Compose →', actionFn: \`switchTab('compose')\`
          });
        }

        const orphaned = allResources.filter(r => r.status === 'orphaned').length;
        if (orphaned > 0) hints.push({
          id: 'orphaned-vols', type: 'warn',
          message: \`\${orphaned} volume\${orphaned > 1 ? 's' : ''} not connected to any container\`,
          action: 'Go to Volumes →', actionFn: \`switchTab('volumes')\`
        });
        const unhealthy = allResources.filter(r => r.status === 'unhealthy').length;
        if (unhealthy > 0) hints.push({
          id: 'unhealthy-svcs', type: 'warn',
          message: \`\${unhealthy} service\${unhealthy > 1 ? 's are' : ' is'} unhealthy\`,
          action: 'Check Compose →', actionFn: \`switchTab('compose')\`
        });
        const restarting = allResources.filter(r => r.status === 'restarting').length;
        if (restarting > 0) hints.push({
          id: 'restarting-svcs', type: 'warn',
          message: \`\${restarting} service\${restarting > 1 ? 's are' : ' is'} restarting — check logs\`,
          action: 'Check Compose →', actionFn: \`switchTab('compose')\`
        });
        const services = (composeTd?.resources) || [];
        if (services.length > 0 && services.every(r => r.status === 'running')) {
          hints.push({ id: 'all-running', type: 'success', message: \`All \${services.length} services are up ✓\` });
        }
        return hints;
      }

      function renderHintsBanner() {
        if (!state.config?.settings?.proactiveHintsEnabled) return '';
        const dismissed = state.dismissedHints || [];
        const hint = evaluateHints().find(h => !dismissed.includes(h.id));
        if (!hint) return '';
        const warnIcon = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>\`;
        const okIcon = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>\`;
        const isSuccess = hint.type === 'success';
        if (isSuccess) setTimeout(() => { if (state) { const d = state.dismissedHints||[]; if(!d.includes('all-running')){ post('dismissHint',{hintId:'all-running'}); } } }, 5000);
        return \`<div class="hint-banner\${isSuccess ? ' hint-success' : ''}">
          \${isSuccess ? okIcon : warnIcon}
          <div class="hint-body">\${hint.message}\${hint.action ? \`<br><span class="hint-act" onclick="\${hint.actionFn}">\${hint.action}</span>\` : ''}</div>
          \${!isSuccess ? \`<button class="hint-dismiss" onclick="post('dismissHint',{hintId:'\${hint.id}'})" title="Dismiss">\${icon('x')}</button>\` : ''}
        </div>\`;
      }

      function renderOnboarding() {
        const ob = state.onboarding || {};
        const docker = (state.providers||[]).find(p=>p.id==='docker');
        const dockerUp = docker?.daemonAvailable === true;
        const composeFound = docker?.composeFileFound === true;
        const checkSvg = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>\`;
        const dotSvg = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="4"/></svg>\`;

        // Moment 1: first install — docker up but no compose file
        if (!ob.moment1 && dockerUp && !composeFound) {
          return \`<div class="onboarding-card">
            <span class="onboarding-title">Getting started</span>
            <div class="onboarding-step done">\${checkSvg} Docker connected</div>
            <div class="onboarding-step">\${dotSvg} Open a project folder with a compose file</div>
            <div class="onboarding-step">\${dotSvg} Your services appear here</div>
            <span class="onboarding-dismiss" onclick="post('markOnboarding',{moment:'moment1'})">Dismiss →</span>
          </div>\`;
        }

        // Moment 2: using Default profile — nudge to rename
        if (!ob.moment2 && state.profile?.name === 'Default' && composeFound) {
          return \`<div class="onboarding-card">
            <span class="onboarding-title">Tip: use profiles for different projects</span>
            <div style="color:var(--vscode-descriptionForeground);line-height:1.5;">Rename "Default" or create a new profile for this project — each profile has its own tabs, snippets and settings.</div>
            <span class="onboarding-dismiss" onclick="post('markOnboarding',{moment:'moment2'})">Got it →</span>
          </div>\`;
        }

        return '';
      }

      function renderProviders() {
        const providers = state.providers || [];
        const docker = providers.find(p => p.id === 'docker');
        const k8s = providers.find(p => p.id === 'kubernetes');
        const dockerUp = docker?.daemonAvailable === true;
        const dockerErr = docker?.status === 'error';
        const composeFound = docker?.composeFileFound === true;

        // K8s chip only renders when the provider is enabled in the active profile
        const k8sEnabled = (state.profile?.providers || []).some(p => p.id === 'kubernetes' && p.enabled);
        const k8sUp = k8s?.status === 'connected';
        const k8sErr = k8s?.status === 'error';

        const dockerChipClass = dockerErr ? 'chip-err' : dockerUp ? 'chip-ok' : 'chip-off';
        const dockerDotClass = dockerErr ? 'dot-err' : dockerUp ? 'dot-ok' : 'dot-off';
        const composeChipClass = composeFound ? 'chip-info' : 'chip-off';
        const composeDotClass = composeFound ? 'dot-info' : 'dot-off';
        const k8sChipClass = k8sErr ? 'chip-err' : k8sUp ? 'chip-ok' : 'chip-off';
        const k8sDotClass = k8sErr ? 'dot-err' : k8sUp ? 'dot-ok' : 'dot-off';

        const dockerSvg = \`<svg viewBox="0 0 24 24"><path fill="currentColor" d="M13.5 11H15V9.5h-1.5V11zm-3 0H12V9.5h-1.5V11zm-3 0H9V9.5H7.5V11zm0-3H9V6.5H7.5V8zm3 0H12V6.5h-1.5V8zm3 0H15V6.5h-1.5V8zm3 0H18V6.5h-1.5V8zm0 3H18V9.5h-1.5V11zM22.5 11.5c-.3-.2-.9-.3-1.4-.2-.1-.6-.5-1.1-1.1-1.4l-.4-.2-.2.4c-.2.4-.3 1-.2 1.5-.1.1-.5.2-.7.2H2.3c-.2.9 0 2 .6 2.8.7.9 1.7 1.4 3 1.4 2.9 0 5-.9 6.3-2.8.7.1 2.2.1 3-.9h.1c.3.5.8.8 1.5.8h1.5v-1.6c.1 0 .5.1.7.1s.5 0 .7-.1l.3-.1v-1.6l-.5.1z"/></svg>\`;
        const composeSvg = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>\`;
        const k8sSvg = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>\`;

        const dockerTitle = dockerErr ? 'Docker · not reachable · click for options' : dockerUp ? 'Docker · connected · click for options' : 'Docker · not running · click for options';
        const composeTitle = composeFound ? 'Compose · file found · click for options' : 'Compose · no file · click for options';
        const k8sTitle = k8sErr ? 'Kubernetes · cluster unreachable · click for options' : k8sUp ? 'Kubernetes · connected · click for options' : 'Kubernetes · connecting · click for options';

        return \`<div class="providers">
          <div class="chip \${dockerChipClass}" onclick="toggleChip('docker',event)" title="\${dockerTitle}">
            <span class="chip-logo">\${dockerSvg}</span>
            <span class="chip-dot \${dockerDotClass}"></span>Docker
          </div>
          <div class="chip \${composeChipClass}" onclick="toggleChip('compose',event)" title="\${composeTitle}">
            <span class="chip-logo">\${composeSvg}</span>
            <span class="chip-dot \${composeDotClass}"></span>Compose
          </div>
          \${k8sEnabled ? \`<div class="chip \${k8sChipClass}" onclick="toggleChip('k8s',event)" title="\${k8sTitle}">
            <span class="chip-logo">\${k8sSvg}</span>
            <span class="chip-dot \${k8sDotClass}"></span>K8s
          </div>\` : ''}
          <div class="chips-spacer"></div>
          <div class="chip-actions">
            <button class="icon-btn" onclick="post('refresh')" title="Refresh all">\${icon('refresh')}</button>
            <button class="icon-btn" onclick="openSettings('providers')" title="Open settings">\${icon('settings')}</button>
            <button class="icon-btn" onclick="post('popout')" title="Open full view" style="color:var(--vscode-textLink-foreground);">\${icon('external-link')}</button>
          </div>
        </div>\`;
      }

      function renderChipDropdown(chipId) {
        const docker = (state.providers||[]).find(p=>p.id==='docker');
        const dockerUp = docker?.daemonAvailable === true;
        const dockerErr = docker?.status === 'error';
        const composeFound = docker?.composeFileFound === true;
        const composePath = docker?.composeFilePath || '';
        const composeFileName = composePath ? composePath.split(/[\\/]/).pop() : '';
        const composeTd = (state.tabData||[]).find(td=>td.tabId==='compose');
        const serviceCount = composeTd?.resources?.length ?? 0;

        if (chipId === 'docker') {
          const statusLine = dockerErr ? 'Daemon not reachable' : dockerUp ? 'Daemon connected' : 'Daemon not running';
          const playSvg = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>\`;
          const stopSvg = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>\`;
          const restartSvg = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>\`;
          const settingsSvg = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33H15a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>\`;
          return \`<div class="chip-dd" onclick="event.stopPropagation()">
            <div class="chip-dd-hdr">
              <div class="chip-dd-title">Docker</div>
              <div class="chip-dd-sub">\${statusLine}</div>
            </div>
            \${!dockerUp ? \`<div class="chip-dd-item primary" onclick="post('daemonAction',{action:'start'})" title="Start Docker daemon">
              \${playSvg} Start daemon
            </div>\` : ''}
            \${dockerUp ? \`
            <div class="chip-dd-item" onclick="post('daemonAction',{action:'stop'})" title="Stop Docker daemon">
              \${stopSvg} Stop daemon
            </div>
            <div class="chip-dd-item" onclick="post('daemonAction',{action:'restart'})" title="Restart Docker daemon">
              \${restartSvg} Restart daemon
            </div>
            <div class="chip-dd-divider"></div>
            <div class="chip-dd-item" onclick="openSettings('providers')">
              \${settingsSvg} Provider settings
            </div>\` : ''}
          </div>\`;
        }

        if (chipId === 'compose') {
          const composeTd2 = (state.tabData||[]).find(td=>td.tabId==='compose');
          const v1Warn = composeTd2?.v1Syntax ? \`<div class="chip-dd-warn" onclick="post('openLink',{url:'https://docs.docker.com/compose/compose-file/'})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            Deprecated version: field — view migration docs →
          </div>\` : '';
          return \`<div class="chip-dd" onclick="event.stopPropagation()">
            <div class="chip-dd-hdr">
              <div class="chip-dd-title">Compose</div>
              <div class="chip-dd-sub">\${composeFound ? \`\${composeFileName} · \${serviceCount} service\${serviceCount!==1?'s':''}\` : 'No compose file found'}</div>
            </div>
            \${composeFound ? \`
              <div class="chip-dd-item" onclick="post('openComposeFile',{filePath:'\${composePath}'})">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                Open \${composeFileName}
              </div>
              <div class="chip-dd-item" onclick="post('refresh');toggleChip('compose',{stopPropagation:()=>{}})">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                Reload
              </div>
              \${v1Warn}
            \` : \`<div class="chip-dd-item" style="color:var(--vscode-descriptionForeground);">Open a folder with a compose file</div>\`}
          </div>\`;
        }

        if (chipId === 'k8s') {
          const k8sProv = (state.providers||[]).find(p=>p.id==='kubernetes');
          const k8sUp = k8sProv?.status === 'connected';
          const k8sErr = k8sProv?.status === 'error';
          const ctxName = k8sProv?.activeContext || '';
          const nsName = (state.profile?.providers||[]).find(p=>p.id==='kubernetes')?.settings?.namespace || 'default';
          const statusLine = k8sErr ? 'Cluster unreachable' : k8sUp ? \`\${ctxName || 'connected'}\` : 'Connecting…';
          return \`<div class="chip-dd" onclick="event.stopPropagation()">
            <div class="chip-dd-hdr">
              <div class="chip-dd-title">Kubernetes</div>
              <div class="chip-dd-sub">\${statusLine}</div>
            </div>
            \${k8sUp ? \`
              <div class="chip-dd-item" style="pointer-events:none;opacity:0.7;font-size:10px;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:11px;height:11px;"><path d="M3 7h18M3 12h18M3 17h18"/></svg>
                namespace: \${nsName}
              </div>
            \` : ''}
            \${k8sErr ? \`<div class="chip-dd-item primary" onclick="post('openLink',{url:'https://kubernetes.io/docs/tasks/tools/'})">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              Troubleshoot cluster access
            </div>\` : ''}
            <div class="chip-dd-item" onclick="openSettings('providers')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4H15a1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              Provider settings
            </div>
          </div>\`;
        }

        return '';
      }

      function toggleChip(id, event) {
        event.stopPropagation();
        const overlay = document.getElementById('chip-overlay');
        if (openChipId === id) {
          openChipId = null;
          overlay.style.display = 'none';
          overlay.innerHTML = '';
          return;
        }
        openChipId = id;
        overlay.innerHTML = renderChipDropdown(id);
        overlay.style.display = 'block';
        const rect = event.currentTarget.getBoundingClientRect();
        const ddWidth = 200;
        const left = Math.max(4, Math.min(rect.left, window.innerWidth - ddWidth - 4));
        overlay.style.top = (rect.bottom + 4) + 'px';
        overlay.style.left = left + 'px';
        document.addEventListener('click', () => {
          openChipId = null;
          overlay.style.display = 'none';
          overlay.innerHTML = '';
        }, { once: true });
      }

      function renderHelperCard(type) {
        if (type === 'docker') {
          const platform = state.platform;
          const startHint = platform === 'win32' ? 'Start Docker Desktop from the Start Menu or system tray.'
            : platform === 'darwin' ? 'Start Docker Desktop from Applications or the menu bar.'
            : 'Start the Docker daemon: sudo systemctl start docker';
          return \`<div class="helper">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <div class="helper-body"><strong>Docker not running</strong>\${startHint}
            \${platform !== 'linux' ? \`<span class="helper-link" onclick="post('daemonAction',{action:'start'})">Start Docker →</span>\` : \`<span class="helper-link" onclick="post('openLink',{url:'https://docs.docker.com/engine/install/'})">Install guide →</span>\`}
            </div>
          </div>\`;
        }
        return '';
      }

      function renderProfileRow(profile) {
        const profiles = (state.config?.profiles) || [];
        const activeId = state.profile?.id;
        const dropdownHtml = profilePickerOpen ? \`<div class="dropdown">
          \${profiles.map(p => \`<div class="d-item \${p.id === activeId ? 'd-active' : ''}" onclick="activateProfile('\${p.id}')">
            <span style="width:7px;height:7px;border-radius:50%;background:\${p.colour};flex-shrink:0;display:inline-block;"></span>
            \${p.name}
            \${p.id === activeId ? \`<svg class="d-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:12px;height:12px;margin-left:auto;"><polyline points="20 6 9 17 4 12"/></svg>\` : ''}
          </div>\`).join('')}
          <div class="d-divider"></div>
          <div class="d-item" onclick="post('newProfile')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New profile…
          </div>
        </div>\` : '';
        return \`<div class="profile-row">
          <div class="dropdown-wrap">
            <div class="profile-pill" onclick="toggleProfilePicker(event)">
              <span class="p-dot" style="background:\${profile.colour}"></span>
              <span class="p-name">\${profile.name}</span>
              <span class="p-caret">▾</span>
            </div>
            \${dropdownHtml}
          </div>
          <button class="p-icon-btn" onclick="post('renameProfile',{profileId:'\${profile.id}'})" title="Rename this profile">\${icon('pencil')}</button>
          <button class="p-icon-btn" onclick="post('newProfile')" title="Create a new profile">\${icon('plus')}</button>
        </div>\`;
      }

      function statusChip(status) {
        const map = {
          running:    ['sc-run','sd-run','running'],
          in_use:     ['sc-run','sd-run','in use'],
          stopped:    ['sc-stop','sd-stop','stopped'],
          exited:     ['sc-stop','sd-stop','exited'],
          restarting: ['sc-warn','sd-warn','restarting'],
          unhealthy:  ['sc-err','sd-err','unhealthy'],
          orphaned:   ['sc-warn','sd-warn','orphaned'],
        };
        const [chipCls, dotCls, label] = map[status] || ['sc-stop','sd-stop', status || 'unknown'];
        return \`<span class="s-chip \${chipCls}"><span class="s-dot \${dotCls}"></span>\${label}</span>\`;
      }

      function renderTabs() {
        const tabs = state.tabs;
        if (!tabs.length) return \`<div class="empty-state"><p>No providers enabled.</p></div>\`;
        const tabsHtml = tabs.map(tab => {
          const data = state.tabData.find(d => d.tabId === tab.id);
          let badge = '';
          if (data?.badge) {
            const cls = data.badgeType === 'warn' ? 'ct-warn' : data.badgeType === 'ok' ? 'ct-ok' : 'ct-n';
            badge = \`<span class="t-ct \${cls}">\${data.badge}</span>\`;
          }
          return \`<div class="tab \${activeTab === tab.id ? 'active' : ''}" onclick="switchTab('\${tab.id}')">\${tab.label}\${badge}</div>\`;
        }).join('');
        const snippetsTab = \`<div class="tab \${activeTab === 'snippets' ? 'active' : ''}" onclick="switchTab('snippets')">Snippets</div>\`;
        return \`<div class="tabs-bar">\${tabsHtml}\${snippetsTab}</div>\`;
      }

      function renderTabContents() {
        const tabs = state.tabs;
        const providerContents = tabs.map(tab => {
          const data = state.tabData.find(d => d.tabId === tab.id);
          return \`<div class="tab-content \${activeTab === tab.id ? 'active' : ''}" id="tab-\${tab.id}">
            \${data ? renderTabContent(data) : '<div class="empty-state"><p>Loading…</p></div>'}
          </div>\`;
        }).join('');
        const snippetsContent = \`<div class="tab-content \${activeTab === 'snippets' ? 'active' : ''}" id="tab-snippets">
          \${renderSnippetsTab(state.snippets)}
        </div>\`;
        return providerContents + snippetsContent;
      }

      function renderTabContent(data) {
        const sectionHeader = renderSectionHeader(data.tabId, data.sectionLabel);
        const pullRow = data.tabId === 'images' ? renderPullRow() : '';

        if (!data.resources || !data.resources.length) {
          if (data.sectionLabel?.startsWith('Docker daemon')) {
            const platform = state.platform;
            const startHint = platform === 'win32' ? 'Start Docker Desktop from the Start Menu or system tray.'
              : platform === 'darwin' ? 'Start Docker Desktop from Applications or the menu bar.'
              : 'Start the Docker daemon: sudo systemctl start docker';
            const startLink = platform !== 'linux'
              ? \`<span class="helper-link" onclick="post('daemonAction',{action:'start'})">Start Docker →</span>\`
              : \`<span class="helper-link" onclick="post('openLink',{url:'https://docs.docker.com/engine/install/'})">Install guide →</span>\`;
            return pullRow + sectionHeader + \`<div class="helper" style="margin:8px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <div class="helper-body"><strong>Docker not reachable</strong>\${startHint}\${startLink}</div>
            </div>\`;
          }
          if (data.tabId === 'compose' && !data.sectionLabel?.includes('services')) {
            return pullRow + sectionHeader + \`<div class="helper" style="margin:8px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              <div class="helper-body"><strong>No compose file found</strong>Open a project folder containing a <code style="font-family:monospace;font-size:10px;background:var(--wh-bg-neutral);padding:1px 4px;border-radius:3px;">docker-compose.yml</code> to see your services here.</div>
            </div>\`;
          }
          return pullRow + sectionHeader + \`<div class="empty-state"><p>\${data.sectionLabel || 'No resources found.'}</p></div>\`;
        }

        // For images tab, determine which images are in use by containers
        let usedImageNames = new Set();
        if (data.tabId === 'images') {
          const containersTd = (state.tabData||[]).find(td => td.tabId === 'containers');
          if (containersTd) {
            (containersTd.resources||[]).forEach(c => {
              const img = c.meta?.image || '';
              if (img) usedImageNames.add(img.split(':')[0]);
            });
          }
        }

        const ob = state.onboarding || {};
        let shownMoment3 = false;
        const resources = data.resources.map(r => {
          let showCallout = false;
          if (data.tabId === 'compose' && r.status === 'unhealthy' && !ob.moment3 && !shownMoment3) {
            showCallout = true;
            shownMoment3 = true;
          }
          if (data.tabId === 'images') {
            const isUsed = usedImageNames.has(r.name) || usedImageNames.size === 0;
            return renderResource(r, data.tabId, !isUsed, showCallout);
          }
          return renderResource(r, data.tabId, false, showCallout);
        }).join('');
        return pullRow + sectionHeader + resources;
      }

      function renderPullRow() {
        const err = pullError ? \`<div class="pull-error">\${pullError}</div>\` : '';
        return \`<div class="pull-row">
          <input class="pull-input" id="pull-input" placeholder="nginx:alpine, mysql:8.0…"
            onkeydown="if(event.key==='Enter'){pullError='';doPull();}"
            title="Enter image name to pull">
          <button class="pull-btn" onclick="pullError='';doPull()" title="Pull image">Pull</button>
        </div>\${err}\`;
      }

      function doPull() {
        const ref = document.getElementById('pull-input')?.value?.trim();
        if (ref) post('pullImage', { imageRef: ref });
      }

      function renderSectionHeader(tabId, sectionLabel) {
        if (!sectionLabel) return '';
        if (tabId === 'compose') return \`<div class="sec-hdr">
          <span class="sec-txt">\${sectionLabel}</span>
          <button class="sec-btn" onclick="event.stopPropagation();execAction('compose','__all__','up')" title="Start all services (docker compose up)">\${icon('play')}</button>
          <button class="sec-btn" onclick="event.stopPropagation();execAction('compose','__all__','down')" title="Stop all services (docker compose down)">\${icon('stop')}</button>
          <button class="sec-btn" onclick="event.stopPropagation();execAction('compose','__all__','restart')" title="Restart all services">\${icon('refresh')}</button>
        </div>\`;
        return \`<div class="sec-hdr"><span class="sec-txt">\${sectionLabel}</span></div>\`;
      }

      function renderResource(resource, tabId, unused, showCallout) {
        const nameClass = ['stopped','exited','orphaned','unknown'].includes(resource.status) ? 'dim' : '';
        const unusedClass = unused ? ' img-unused' : '';
        const pending = pendingActions.get(resource.id);
        const actionTitles = { restart: \`Restart \${resource.name}\`, stop: \`Stop \${resource.name}\`, start: \`Start \${resource.name}\`, shell: \`Open shell in \${resource.name}\`, logs: \`Tail logs for \${resource.name}\`, remove: \`Remove \${resource.name}\`, pull: \`Pull latest \${resource.name}\`, inspect: \`Inspect \${resource.name}\` };
        const actions = (resource.actions || []).map(a => \`
          <button class="ab \${a.dangerous ? 'danger' : ''}"
            onclick="event.stopPropagation(); execAction('\${tabId}','\${resource.id}','\${a.id}')"
            title="\${actionTitles[a.id] || a.label}">\${icon(a.icon)}</button>
        \`).join('');
        const rightSide = pending
          ? \`<span class="pending-chip">\${pending.actionId}…</span>\`
          : \`\${statusChip(resource.status)}\${actions ? '<span class="divr"></span>' : ''}<div class="acts">\${actions}</div>\`;
        const children = (resource.children || []).map(c => \`
          <div class="child-row">
            <span class="c-lbl">\${c.label}</span>
            <span class="c-val \${c.type || ''}">\${c.value}</span>
          </div>
        \`).join('');
        const unusedNote = unused ? \`<div class="img-unused-note">\${resource.name} is not used by any container — safe to remove</div>\` : '';
        const childrenDiv = children ? \`<div class="children" id="rc-\${resource.id}">\${children}\${unusedNote}</div>\` : (unusedNote ? \`<div class="children open" id="rc-\${resource.id}">\${unusedNote}</div>\` : '');
        const warnSvg = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>\`;
        const callout = showCallout ? \`<div class="ob3-callout">\${warnSvg}<div class="ob3-callout-body">Expand to see what's wrong, or click Restart.</div><span class="ob3-dismiss" onclick="maybeDismissMoment3('\${resource.id}')">Got it →</span></div>\` : '';
        return \`
          <div class="svc\${unusedClass}">
            <div class="svc-row\${pending ? ' pending' : ''}" onclick="toggleResource('\${resource.id}')">
              <span class="chev" id="chev-\${resource.id}"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 2 7 5 3 8"/></svg></span>
              <span class="svc-name \${nameClass}">\${resource.name}</span>
              \${rightSide}
            </div>
            \${callout}
            \${childrenDiv}
          </div>
        \`;
      }

      // ── snippets tab ────────────────────────────────────────────────────────
      function renderSnippetsTab(snippets) {
        const ws = (snippets || []).filter(s => s.scope === 'workspace');
        const gl = (snippets || []).filter(s => s.scope === 'global');
        if (!ws.length && !gl.length) {
          return \`<div class="snippets-list">
            <div class="empty-state">No snippets yet.<br>Save commands you always retype.</div>
            \${renderNewSnippetForm(null)}
            <button class="add-btn" onclick="startNewSnippet()">\${icon('plus')} New snippet</button>
          </div>\`;
        }
        const wsSection = ws.length ? \`
          <div class="snip-section-lbl">workspace</div>
          \${ws.map(s => renderSnippetItem(s)).join('')}
        \` : '';
        const glSection = gl.length ? \`
          <div class="snip-section-lbl">global</div>
          \${gl.map(s => renderSnippetItem(s)).join('')}
        \` : '';
        const newForm = newSnippetDraft ? renderNewSnippetForm(newSnippetDraft) : '';
        return \`<div class="snippets-list">
          \${wsSection}\${glSection}
          \${newForm}
          <button class="add-btn" onclick="startNewSnippet()">\${icon('plus')} New snippet</button>
        </div>\`;
      }

      function renderSnippetItem(s) {
        const isEditing = editingSnippetId === s.id;
        const editForm = isEditing ? renderEditSnippetForm(s) : '';
        return \`<div class="snippet-item">
          <div class="snippet-header" onclick="toggleSnippet('\${s.id}')">
            <span class="snippet-name">\${s.name}</span>
            <span class="snippet-scope-badge">\${s.scope}</span>
            <div class="snippet-btns">
              <button onclick="event.stopPropagation(); runSnippet('\${escJs(s.command)}','\${s.runMode||'terminal'}')" title="\${s.runMode==='clipboard'?'Copy to clipboard':'Run in terminal'}">\${icon(s.runMode==='clipboard'?'download':'play')}</button>
              <button onclick="event.stopPropagation(); startEditSnippet('\${s.id}')" title="Edit">\${icon('pencil')}</button>
              <button class="danger" onclick="event.stopPropagation(); deleteSnippet('\${s.id}','\${s.scope}')" title="Delete">\${icon('trash')}</button>
            </div>
          </div>
          <div class="snippet-cmd \${isEditing ? 'open' : ''}" id="sc-\${s.id}">\${isEditing ? editForm : s.command}</div>
        </div>\`;
      }

      function renderEditSnippetForm(s) {
        return \`<div class="inline-form" onclick="event.stopPropagation()">
          <div class="form-row"><label class="form-label">Name</label>
            <input class="form-input" id="snip-edit-name" value="\${escHtml(s.name)}" placeholder="Snippet name">
          </div>
          <div class="form-row"><label class="form-label">Command</label>
            <textarea class="form-textarea" id="snip-edit-cmd">\${escHtml(s.command)}</textarea>
          </div>
          <div class="form-row"><label class="form-label">Scope</label>
            <select class="form-select" id="snip-edit-scope">
              <option value="workspace" \${s.scope==='workspace'?'selected':''}>Workspace</option>
              <option value="global" \${s.scope==='global'?'selected':''}>Global</option>
            </select>
          </div>
          <div class="form-actions">
            <button class="btn-secondary" onclick="cancelEditSnippet()">Cancel</button>
            <button class="btn-primary" onclick="saveEditSnippet('\${s.id}','\${s.scope}')">Save</button>
          </div>
        </div>\`;
      }

      function renderNewSnippetForm(draft) {
        if (!draft) return '';
        return \`<div class="inline-form">
          <div class="form-row"><label class="form-label">Name</label>
            <input class="form-input" id="snip-new-name" value="\${escHtml(draft.name || '')}" placeholder="Snippet name">
          </div>
          <div class="form-row"><label class="form-label">Command</label>
            <textarea class="form-textarea" id="snip-new-cmd">\${escHtml(draft.command || '')}</textarea>
          </div>
          <div class="form-row"><label class="form-label">Scope</label>
            <select class="form-select" id="snip-new-scope">
              <option value="workspace" \${(draft.scope||'workspace')==='workspace'?'selected':''}>Workspace</option>
              <option value="global" \${(draft.scope||'')==='global'?'selected':''}>Global</option>
            </select>
          </div>
          <div class="form-actions">
            <button class="btn-secondary" onclick="cancelNewSnippet()">Cancel</button>
            <button class="btn-primary" onclick="saveNewSnippet()">Add snippet</button>
          </div>
        </div>\`;
      }

      // ── settings panel ─────────────────────────────────────────────────────
      function renderSettings() {
        return \`<div class="settings-panel">
          <div class="settings-header">
            <span class="settings-title">⎈ Settings</span>
            <button class="icon-btn" onclick="closeSettings()" title="Close">\${icon('x')}</button>
          </div>
          <div class="settings-body">
            \${renderSettingsNav()}
            <div class="settings-content">
              \${renderSettingsSection()}
            </div>
          </div>
        </div>\`;
      }

      function renderSettingsNav() {
        const items = [
          { id: 'providers', label: 'Providers', ic: 'plug', group: 'Wheelhouse' },
          { id: 'profiles', label: 'Profiles', ic: 'user', group: null },
          { id: 'general', label: 'General', ic: 'settings', group: 'Global' },
          { id: 'safety', label: 'Safety', ic: 'shield', group: null },
          { id: 'snippets', label: 'Snippets', ic: 'terminal2', group: 'Workspace' },
          { id: 'commands', label: 'Commands', ic: 'terminal', group: null },
        ];
        let html = '<div class="settings-nav">';
        let lastGroup = '';
        for (const item of items) {
          if (item.group && item.group !== lastGroup) {
            html += \`<div class="nav-section-lbl">\${item.group}</div>\`;
            lastGroup = item.group;
          }
          html += \`<div class="nav-item \${settingsSection === item.id ? 'active' : ''}" onclick="switchSettingsSection('\${item.id}')">\${icon(item.ic)}\${item.label}</div>\`;
        }
        html += '</div>';
        return html;
      }

      function renderSettingsSection() {
        switch (settingsSection) {
          case 'providers': return renderProvidersSection();
          case 'profiles':  return renderProfilesSection();
          case 'general':   return renderGeneralSection();
          case 'safety':    return renderSafetySection();
          case 'snippets':  return renderSnippetsMgmtSection();
          case 'commands':  return renderCommandsSection();
          default:          return '';
        }
      }

      // providers screen
      function renderProvidersSection() {
        const profile = state.profile;
        const providers = state.providers || [];
        const cards = providers.map(p => {
          const cfg = profile.providers.find(c => c.id === p.id);
          const enabled = cfg?.enabled ?? false;
          if (p.comingSoon) {
            return \`<div class="provider-card">
              <div class="prov-hdr">
                <div class="prov-icon">\${icon('hexagon')}</div>
                <div class="prov-info"><div class="prov-name">\${p.name}</div><div class="prov-desc">\${p.description || ''}</div></div>
                <span class="prov-soon">soon</span>
              </div>
              <div class="coming-soon-msg">\${(p.tabs||[]).map(t=>t.label).join(' · ')} — coming soon</div>
            </div>\`;
          }
          const tabRows = (p.tabs || []).map(t => {
            const visible = profile.visibleTabs.includes(t.id);
            return \`<div class="tab-row">
              \${icon('terminal2')}
              <span class="tab-row-name">\${t.label}</span>
              <span class="toggle tab-toggle \${visible ? 'on' : ''}" onclick="toggleTabVisible('\${t.id}',\${visible})"></span>
            </div>\`;
          }).join('');
          const provIcon = p.id === 'kubernetes' ? icon('hexagon') : icon('docker');
          // Extra settings rows per provider
          let extraSettings = '';
          if (p.id === 'kubernetes' && enabled) {
            const ns = cfg?.settings?.namespace || 'default';
            extraSettings = \`<div style="padding:6px 9px;border-top:1px solid var(--vscode-sideBarSectionHeader-border);">
              <div style="font-size:9px;color:var(--vscode-descriptionForeground);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;">Namespace</div>
              <input class="form-input" style="font-size:11px;" value="\${ns.replace(/"/g,'&quot;')}"
                placeholder="default"
                onchange="saveProviderSetting('kubernetes','namespace',this.value)"
                title="Active Kubernetes namespace">
            </div>\`;
          }
          return \`<div class="provider-card \${enabled ? 'enabled' : ''}">
            <div class="prov-hdr">
              <div class="prov-icon \${p.id === 'kubernetes' ? 'k8s' : ''}">\${provIcon}</div>
              <div class="prov-info"><div class="prov-name">\${p.name}</div><div class="prov-desc">\${p.description || ''}</div></div>
              <span class="toggle \${enabled ? 'on' : ''}" onclick="toggleProvider('\${p.id}',\${enabled})"></span>
            </div>
            \${enabled ? \`<div class="prov-body">\${tabRows}</div>\${extraSettings}\` : ''}
          </div>\`;
        }).join('');
        const communityCard = \`<div style="border:1px solid var(--vscode-sideBarSectionHeader-border);border-radius:6px;overflow:hidden;margin:8px 8px 0;">
          <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--vscode-sideBarSectionHeader-background);">
            <span style="font-size:15px;flex-shrink:0;">🌐</span>
            <div>
              <div style="font-size:11px;font-weight:500;color:var(--vscode-foreground);">Community providers</div>
              <div style="font-size:9px;color:var(--vscode-descriptionForeground);">Build your own or install from the community</div>
            </div>
          </div>
          <div style="padding:8px 10px 10px;font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6;">
            Wheelhouse has an open provider API. Anyone can build a provider for Podman, Nomad, Fly.io or any other runtime. Implement <code style="font-family:monospace;font-size:10px;background:var(--wh-bg-neutral);padding:1px 4px;border-radius:3px;">IProvider</code> and register your tabs.
            <br><span class="hint-act" onclick="post('openLink',{url:'https://github.com/ryanjames85/wheelhouse'})">View provider API docs →</span>
          </div>
        </div>\`;

        return cards + communityCard + '<div style="height:8px"></div>';
      }

      // profiles screen
      function renderProfilesSection() {
        const profiles = state.config.profiles || [];
        const activeId = state.profile.id;
        const cards = profiles.map(p => renderProfileCard(p, p.id === activeId)).join('');
        const newForm = newProfileDraft ? renderNewProfileForm(newProfileDraft) : \`
          <button class="add-profile-btn" onclick="startNewProfile()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;flex-shrink:0;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New profile
          </button>\`;
        return cards + newForm + '<div style="height:8px"></div>';
      }

      function renderProfileCard(p, isActive) {
        const isEditing = editingProfileId === p.id;
        const allTabIds = (state.providers || []).flatMap(pr => (pr.tabs||[]).map(t => t.id));
        const providerPills = (state.providers || []).map(pr => {
          const cfg = p.providers.find(c => c.id === pr.id);
          const on = cfg?.enabled ?? false;
          return \`<span class="pill \${on?'on':''}">\${pr.name}</span>\`;
        }).join('');
        const tabPills = allTabIds.map(tid => {
          const label = getTabLabel(tid);
          const on = p.visibleTabs.includes(tid);
          return \`<span class="pill \${on?'on':''}">\${label}</span>\`;
        }).join('');
        const editForm = isEditing ? renderEditProfileForm(p) : '';
        return \`<div class="profile-card \${isActive ? 'active-card' : ''}">
          <div class="prof-hdr">
            <span class="prof-dot" style="background:\${p.colour}"></span>
            <span class="prof-name">\${p.name}</span>
            \${isActive ? '<span class="prof-active-badge">active</span>' : ''}
            <button class="icon-btn" style="margin-left:auto" onclick="startEditProfile('\${p.id}')" title="Edit">\${icon('pencil')}</button>
          </div>
          \${!isEditing ? \`<div class="prof-body">
            <div class="p-row"><span class="p-lbl">Providers</span><div class="pills">\${providerPills}</div></div>
            <div class="p-row"><span class="p-lbl">Tabs</span><div class="pills">\${tabPills}</div></div>
            <div class="p-row"><span class="p-lbl">Activate</span><span class="p-val">\${p.activation}</span></div>
            <div class="p-row"><span class="p-lbl">Refresh</span><span class="p-val">\${p.refreshInterval/1000}s</span></div>
          </div>
          <div class="prof-actions">
            \${!isActive ? \`<button class="btn-primary" onclick="activateProfileFromSettings('\${p.id}')">Activate</button>\` : ''}
            \${state.config.profiles.length > 1 ? \`<button class="btn-secondary" onclick="deleteProfile('\${p.id}')">Delete</button>\` : ''}
          </div>\` : editForm}
        </div>\`;
      }

      function renderEditProfileForm(p) {
        const swatches = PRESET_COLOURS.map(c =>
          \`<span class="swatch \${p.colour===c?'selected':''}" style="background:\${c}" onclick="editProfileColour('\${p.id}','\${c}')"></span>\`
        ).join('');
        return \`<div class="inline-form">
          <div class="form-row"><label class="form-label">Name</label>
            <input class="form-input" id="prof-edit-name-\${p.id}" value="\${escHtml(p.name)}" placeholder="Profile name">
          </div>
          <div class="form-row"><label class="form-label">Colour</label>
            <div class="colour-swatches">\${swatches}</div>
          </div>
          <div class="form-row"><label class="form-label">Activate when</label>
            <select class="form-select" id="prof-edit-activation-\${p.id}">
              <option value="always" \${p.activation==='always'?'selected':''}>Always</option>
              <option value="compose_file" \${p.activation==='compose_file'?'selected':''}>Compose file found</option>
              <option value="kubeconfig" \${p.activation==='kubeconfig'?'selected':''}>Kubeconfig found</option>
              <option value="never" \${p.activation==='never'?'selected':''}>Never (manual only)</option>
            </select>
          </div>
          <div class="form-row"><label class="form-label">Refresh (ms)</label>
            <input class="form-input" id="prof-edit-refresh-\${p.id}" type="number" value="\${p.refreshInterval}" placeholder="5000">
          </div>
          <div class="form-actions">
            <button class="btn-secondary" onclick="cancelEditProfile()">Cancel</button>
            <button class="btn-primary" onclick="saveEditProfile('\${p.id}')">Save</button>
          </div>
        </div>\`;
      }

      function renderNewProfileForm(draft) {
        const swatches = PRESET_COLOURS.map(c =>
          \`<span class="swatch \${draft.colour===c?'selected':''}" style="background:\${c}" onclick="newProfileColour('\${c}')"></span>\`
        ).join('');
        return \`<div style="border:1px solid var(--vscode-sideBarSectionHeader-border);border-radius:5px;overflow:hidden;margin:8px 8px 0;">
          <div class="prof-hdr"><span class="prof-dot" style="background:\${draft.colour}"></span><span class="prof-name">New profile</span></div>
          <div class="inline-form">
            <div class="form-row"><label class="form-label">Name</label>
              <input class="form-input" id="prof-new-name" value="\${escHtml(draft.name||'')}" placeholder="Profile name">
            </div>
            <div class="form-row"><label class="form-label">Colour</label>
              <div class="colour-swatches">\${swatches}</div>
            </div>
            <div class="form-row"><label class="form-label">Activate when</label>
              <select class="form-select" id="prof-new-activation">
                <option value="always" \${(draft.activation||'')==='always'?'selected':''}>Always</option>
                <option value="compose_file" \${(draft.activation||'')==='compose_file'?'selected':''}>Compose file found</option>
                <option value="never" \${(draft.activation||'')==='never'?'selected':''}>Never (manual only)</option>
              </select>
            </div>
            <div class="form-actions">
              <button class="btn-secondary" onclick="cancelNewProfile()">Cancel</button>
              <button class="btn-primary" onclick="saveNewProfile()">Create</button>
            </div>
          </div>
        </div>\`;
      }

      // general screen
      function renderGeneralSection() {
        const s = state.config.settings;
        return \`
          <div class="settings-group-lbl">Display</div>
          \${settingsToggleRow('Always show actions', 'Show action buttons without hovering', 'alwaysShowActions', s.alwaysShowActions)}
          \${settingsToggleRow('Tab badges', 'Show resource count badges on tabs', 'showTabBadges', s.showTabBadges)}
          \${settingsToggleRow('Show uptime', 'Show container uptime in expanded view', 'showUptime', s.showUptime)}
          \${settingsToggleRow('Show image tag', 'Show full image tag in resource rows', 'showImageTag', s.showImageTag)}
          <div class="settings-group-lbl">Hints &amp; Tips</div>
          \${settingsToggleRow('Proactive hints', 'Contextual tips based on your infrastructure state', 'proactiveHintsEnabled', s.proactiveHintsEnabled)}
          <div class="settings-row">
            <div>
              <div class="settings-row-lbl">Reset dismissed hints</div>
              <div class="settings-row-desc">Restore all previously dismissed hints</div>
            </div>
            <button class="btn-secondary" style="font-size:11px;padding:3px 8px;" onclick="post('resetHints')" title="Reset all dismissed hints">Reset</button>
          </div>
          <div class="settings-group-lbl">Data</div>
          <div class="settings-import-export">
            <button class="btn-secondary" onclick="post('exportSettings')" style="display:flex;align-items:center;gap:5px;">\${icon('download')} Export</button>
            <button class="btn-secondary" onclick="post('importSettings')" style="display:flex;align-items:center;gap:5px;">\${icon('upload')} Import</button>
          </div>
        \`;
      }

      // safety screen
      function renderSafetySection() {
        const s = state.config.settings;
        return \`
          <div class="settings-group-lbl">Confirmations</div>
          \${settingsToggleRow('Confirm before remove', 'Ask before removing containers, images, volumes', 'confirmBeforeRemove', s.confirmBeforeRemove)}
          \${settingsToggleRow('Confirm before prune', 'Ask before prune operations', 'confirmBeforePrune', s.confirmBeforePrune)}
          \${settingsToggleRow('Confirm compose down', 'Ask before docker compose down', 'confirmComposeDown', s.confirmComposeDown)}
          <div class="settings-group-lbl">Performance</div>
          \${settingsToggleRow('Check port conflicts', 'Detect host port collisions before starting services (adds ~100ms per service on refresh)', 'checkPortConflicts', s.checkPortConflicts)}
        \`;
      }

      function settingsToggleRow(label, desc, key, value) {
        return \`<div class="settings-row">
          <div>
            <div class="settings-row-lbl">\${label}</div>
            <div class="settings-row-desc">\${desc}</div>
          </div>
          <span class="toggle \${value?'on':''}" onclick="toggleSetting('\${key}',\${value})"></span>
        </div>\`;
      }

      // snippets management screen (in settings)
      function renderSnippetsMgmtSection() {
        return '<div style="padding:8px">' + renderSnippetsTab(state.snippets) + '</div>';
      }

      // commands cheat sheet
      function renderCommandsSection() {
        const svcs = ((state.tabData||[]).find(td=>td.tabId==='compose')?.resources||[]).map(r=>r.name);
        const s1 = svcs[0] || '<service>';
        const s2 = svcs[1] || svcs[0] || '<service>';
        const hlSvc = (s) => \`<span class="cmd-svc">\${s}</span>\`;

        const groups = [
          { label: 'Compose', cmds: [
            { label: 'Start all services', cmd: \`docker compose up -d\` },
            { label: 'Stop all services', cmd: \`docker compose down\` },
            { label: \`Restart \${s1}\`, cmd: \`docker compose restart \${s1}\`, svc: s1 },
            { label: \`Follow logs for \${s1}\`, cmd: \`docker compose logs -f \${s1}\`, svc: s1 },
            { label: 'Rebuild after code change', cmd: \`docker compose up -d --build\` },
            { label: \`Open shell in \${s1}\`, cmd: \`docker compose exec \${s1} bash\`, svc: s1 },
          ]},
          { label: 'Containers', cmds: [
            { label: 'List all containers', cmd: \`docker ps -a\` },
            { label: 'Tail logs', cmd: \`docker logs -f <name>\` },
            { label: 'Open a shell', cmd: \`docker exec -it <name> bash\` },
            { label: 'Remove a container', cmd: \`docker rm -f <name>\` },
          ]},
          { label: 'Images', cmds: [
            { label: 'List images', cmd: \`docker images\` },
            { label: 'Pull an image', cmd: \`docker pull <image>\` },
            { label: 'Remove an image', cmd: \`docker rmi <image>\` },
            { label: 'Remove unused images', cmd: \`docker image prune\` },
          ]},
          { label: 'Volumes', cmds: [
            { label: 'List volumes', cmd: \`docker volume ls\` },
            { label: 'Remove a volume', cmd: \`docker volume rm <name>\` },
            { label: 'Remove orphaned', cmd: \`docker volume prune\` },
          ]},
          { label: 'Cleanup', cmds: [
            { label: 'Remove all unused', cmd: \`docker system prune\` },
            { label: 'Remove including volumes', cmd: \`docker system prune --volumes\` },
            { label: 'Disk usage', cmd: \`docker system df\` },
          ]},
        ];

        const filter = cmdFilter.toLowerCase();
        let html = \`<input class="cmd-search" placeholder="Search commands…" oninput="cmdFilter=this.value;render()" value="\${cmdFilter.replace(/"/g,'&quot;')}">\`;

        let cmdIdx = 0;
        for (const g of groups) {
          const rows = g.cmds.filter(c =>
            !filter || c.label.toLowerCase().includes(filter) || c.cmd.toLowerCase().includes(filter)
          );
          if (!rows.length) { cmdIdx += g.cmds.length; continue; }
          html += \`<div class="cmd-group-lbl">\${g.label}</div>\`;
          for (const c of rows) {
            const cmdDisplay = c.svc
              ? c.cmd.replace(c.svc, \`\${hlSvc(c.svc)}\`)
              : c.cmd;
            const copyId = \`cp-\${cmdIdx++}\`;
            html += \`<div class="cmd-row">
              <span class="cmd-label">\${c.label}</span>
              <span class="cmd-code">\${cmdDisplay}</span>
              <button class="cmd-copy" id="\${copyId}" data-cmd="\${c.cmd.replace(/"/g,'&quot;')}" onclick="copyCmd(this.dataset.cmd,'\${copyId}')" title="Copy command">copy</button>
            </div>\`;
          }
        }

        html += \`<div class="cmd-note">Commands highlighted in <span style="color:var(--wh-text-success);font-weight:500;">green</span> use your actual service names from the compose file.</div>\`;
        return html;
      }

      function copyCmd(cmd, btnId) {
        navigator.clipboard.writeText(cmd).then(() => {
          const btn = document.getElementById(btnId);
          if (btn) {
            btn.textContent = '✓';
            btn.classList.add('cmd-copied');
            setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('cmd-copied'); }, 1500);
          }
        });
      }

      // ── interactions ────────────────────────────────────────────────────────
      function switchTab(tabId) {
        activeTab = tabId;
        profilePickerOpen = false;
        render();
      }

      function toggleProfilePicker(e) {
        e.stopPropagation();
        profilePickerOpen = !profilePickerOpen;
        render();
        if (profilePickerOpen) {
          document.addEventListener('click', outsidePickerHandler, { once: true });
        }
      }

      function activateProfile(profileId) {
        profilePickerOpen = false;
        post('activateProfile', { profileId });
      }

      function activateProfileFromSettings(profileId) {
        post('activateProfile', { profileId });
      }

      function openSettings(section) {
        settingsOpen = true;
        settingsSection = section || 'providers';
        render();
      }

      function closeSettings() {
        settingsOpen = false;
        editingProfileId = null;
        editingSnippetId = null;
        newProfileDraft = null;
        newSnippetDraft = null;
        render();
      }

      function switchSettingsSection(section) {
        settingsSection = section;
        editingProfileId = null;
        editingSnippetId = null;
        newProfileDraft = null;
        newSnippetDraft = null;
        render();
      }

      function maybeDismissMoment3(resourceId) {
        if (state?.onboarding?.moment3) return;
        const allResources = (state?.tabData || []).flatMap(td => td.resources || []);
        if (allResources.find(r => r.id === resourceId)?.status === 'unhealthy') {
          if (!state.onboarding) state.onboarding = {};
          state.onboarding.moment3 = true;
          post('markOnboarding', { moment: 'moment3' });
          render();
        }
      }

      function toggleResource(id) {
        const children = document.getElementById('rc-' + id);
        const chev = document.getElementById('chev-' + id);
        if (children) children.classList.toggle('open');
        if (chev) chev.classList.toggle('open');
        if (expandedResources.has(id)) expandedResources.delete(id);
        else expandedResources.add(id);
        maybeDismissMoment3(id);
      }

      function toggleSnippet(id) {
        const el = document.getElementById('sc-' + id);
        if (!el) return;
        el.classList.toggle('open');
        if (expandedSnippets.has(id)) expandedSnippets.delete(id);
        else expandedSnippets.add(id);
      }

      function execAction(tabId, resourceId, actionId) {
        if (actionId === 'restart') maybeDismissMoment3(resourceId);
        pendingActions.set(resourceId, { tabId, actionId });
        render();
        post('action', { tabId, resourceId, actionId });
      }

      function runSnippet(command, runMode) {
        post('runSnippet', { command, runMode: runMode || 'terminal' });
      }

      function toggleProvider(providerId, currentlyEnabled) {
        post('saveProviderEnabled', { providerId, enabled: !currentlyEnabled });
      }

      function toggleTabVisible(tabId, currentlyVisible) {
        post('saveTabVisible', { tabId, visible: !currentlyVisible });
      }

      function saveProviderSetting(providerId, key, value) {
        const profile = JSON.parse(JSON.stringify(state.profile));
        let cfg = profile.providers.find(p => p.id === providerId);
        if (!cfg) { cfg = { id: providerId, enabled: false, settings: {} }; profile.providers.push(cfg); }
        cfg.settings = cfg.settings || {};
        cfg.settings[key] = value;
        post('saveProfile', { profile });
      }

      function toggleSetting(key, currentValue) {
        const settings = {};
        settings[key] = !currentValue;
        post('saveSettings', { settings });
      }

      // profile editing
      function startEditProfile(profileId) {
        editingProfileId = editingProfileId === profileId ? null : profileId;
        render();
      }

      function cancelEditProfile() {
        editingProfileId = null;
        render();
      }

      function editProfileColour(profileId, colour) {
        // update the draft in state temporarily for re-render
        const p = state.config.profiles.find(x => x.id === profileId);
        if (p) { p.colour = colour; render(); }
      }

      function saveEditProfile(profileId) {
        const p = state.config.profiles.find(x => x.id === profileId);
        if (!p) return;
        const nameEl = document.getElementById('prof-edit-name-' + profileId);
        const activationEl = document.getElementById('prof-edit-activation-' + profileId);
        const refreshEl = document.getElementById('prof-edit-refresh-' + profileId);
        const updated = {
          ...p,
          name: nameEl?.value || p.name,
          activation: activationEl?.value || p.activation,
          refreshInterval: parseInt(refreshEl?.value || String(p.refreshInterval)) || p.refreshInterval,
        };
        editingProfileId = null;
        post('saveProfile', { profile: updated });
      }

      function startNewProfile() {
        newProfileDraft = { name: '', colour: PRESET_COLOURS[0], activation: 'always' };
        render();
      }

      function cancelNewProfile() {
        newProfileDraft = null;
        render();
      }

      function newProfileColour(colour) {
        if (newProfileDraft) { newProfileDraft.colour = colour; render(); }
      }

      function saveNewProfile() {
        const nameEl = document.getElementById('prof-new-name');
        const activationEl = document.getElementById('prof-new-activation');
        const name = nameEl?.value?.trim();
        if (!name) { nameEl?.focus(); return; }
        const activeProfile = state.profile;
        const newProfile = {
          id: 'profile-' + Date.now(),
          name,
          colour: newProfileDraft.colour,
          providers: [...activeProfile.providers],
          visibleTabs: [...activeProfile.visibleTabs],
          activation: activationEl?.value || 'always',
          refreshInterval: activeProfile.refreshInterval,
          snippetScope: activeProfile.snippetScope,
          snippetRunMode: activeProfile.snippetRunMode,
        };
        newProfileDraft = null;
        post('saveProfile', { profile: newProfile });
      }

      function deleteProfile(profileId) {
        post('deleteProfile', { profileId });
      }

      // snippet editing
      function startEditSnippet(snippetId) {
        editingSnippetId = editingSnippetId === snippetId ? null : snippetId;
        render();
      }

      function cancelEditSnippet() {
        editingSnippetId = null;
        render();
      }

      function saveEditSnippet(snippetId, originalScope) {
        const nameEl = document.getElementById('snip-edit-name');
        const cmdEl = document.getElementById('snip-edit-cmd');
        const scopeEl = document.getElementById('snip-edit-scope');
        const snippet = {
          id: snippetId,
          name: nameEl?.value || '',
          command: cmdEl?.value || '',
          scope: scopeEl?.value || originalScope,
          icon: 'terminal',
          runMode: 'terminal',
        };
        editingSnippetId = null;
        post('saveSnippet', { snippet });
      }

      function startNewSnippet() {
        newSnippetDraft = { name: '', command: '', scope: 'workspace' };
        render();
      }

      function cancelNewSnippet() {
        newSnippetDraft = null;
        render();
      }

      function saveNewSnippet() {
        const nameEl = document.getElementById('snip-new-name');
        const cmdEl = document.getElementById('snip-new-cmd');
        const scopeEl = document.getElementById('snip-new-scope');
        const name = nameEl?.value?.trim();
        const command = cmdEl?.value?.trim();
        if (!name || !command) { (name ? cmdEl : nameEl)?.focus(); return; }
        const snippet = {
          id: 'snip-' + Date.now(),
          name,
          command,
          scope: scopeEl?.value || 'workspace',
          icon: 'terminal',
          runMode: 'terminal',
        };
        newSnippetDraft = null;
        post('saveSnippet', { snippet });
      }

      function deleteSnippet(snippetId, scope) {
        post('deleteSnippet', { snippetId, scope });
      }

      // ── helpers ─────────────────────────────────────────────────────────────
      function getTabLabel(tabId) {
        for (const p of (state.providers || [])) {
          const t = (p.tabs || []).find(t => t.id === tabId);
          if (t) return t.label;
        }
        return tabId;
      }

      function escHtml(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      function escJs(str) {
        return String(str).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/"/g,'\\\\"').replace(/\\n/g,'\\\\n');
      }

      post('ready');
    `;
  }
}
