/**
 * DockerProvider.ts
 *
 * Docker provider — serves tab data for Compose, Containers, Images, Volumes, and Networks.
 *
 * The Compose tab is file-based: it parses docker-compose.yml with js-yaml and overlays live state
 * from the daemon when available. It works without a running daemon (shows services as stopped).
 * All other tabs require a live daemon and set status = 'error' when the daemon is unreachable.
 *
 * Compose file discovery: scans all open workspace folders for docker-compose.yml / compose.yml
 * variants on every getComposeData() call, so it picks up the right project automatically.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { BaseProvider } from '../base/IProvider';
import { TabDefinition, ProviderTabData, Resource, ResourceStatus, ResourceChild, ResourceAction } from '../../types';
import { DockerCLI } from './DockerCLI';

const RUNNING_ACTIONS: ResourceAction[] = [
  { id: 'restart', label: 'Restart', icon: 'refresh', command: 'restart' },
  { id: 'stop', label: 'Stop', icon: 'stop', command: 'stop' },
  { id: 'shell', label: 'Open shell', icon: 'terminal', command: 'shell' },
  { id: 'logs', label: 'Tail logs', icon: 'logs', command: 'logs' },
  { id: 'remove', label: 'Remove', icon: 'trash', command: 'remove', dangerous: true },
];

const STOPPED_ACTIONS: ResourceAction[] = [
  { id: 'start', label: 'Start', icon: 'play', command: 'start' },
  { id: 'logs', label: 'Tail logs', icon: 'logs', command: 'logs' },
  { id: 'remove', label: 'Remove', icon: 'trash', command: 'remove', dangerous: true },
];

const INSPECT_ACTION: ResourceAction[] = [
  { id: 'inspect', label: 'Inspect', icon: 'info', command: 'inspect' },
];

export class DockerProvider extends BaseProvider {
  readonly id = 'docker';
  readonly name = 'Docker';
  readonly description = 'Compose, containers, images, volumes, networks';
  readonly version = '1.0.0';
  readonly comingSoon = false;

  readonly tabs: TabDefinition[] = [
    { id: 'compose', label: 'Compose', icon: 'stack-2', providerId: 'docker', order: 0 },
    { id: 'containers', label: 'Containers', icon: 'box', providerId: 'docker', order: 1 },
    { id: 'images', label: 'Images', icon: 'photo', providerId: 'docker', order: 2 },
    { id: 'volumes', label: 'Volumes', icon: 'database', providerId: 'docker', order: 3 },
    { id: 'networks', label: 'Networks', icon: 'network', providerId: 'docker', order: 4 },
  ];

  private cli!: DockerCLI;
  private composeDir: string = '';
  private daemonAvailable: boolean = false;

  get isDaemonAvailable(): boolean { return this.daemonAvailable; }
  get isComposeFileFound(): boolean { return !!this.findComposeFile(); }
  get composeFilePath(): string | undefined { return this.findComposeFile(); }

  private checkPortConflicts: boolean = true;

  configureGlobal(settings: { checkPortConflicts?: boolean }): void {
    this.checkPortConflicts = settings.checkPortConflicts !== false;
  }

  async connect(): Promise<void> {
    const bin = this.config.settings['dockerBin'] || 'docker';
    const workspaceRoot = this.findWorkspaceWithCompose() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.composeDir = this.findComposeDir(workspaceRoot) ?? workspaceRoot;
    this.cli = new DockerCLI(bin, this.composeDir);
    this.daemonAvailable = await this.cli.isAvailable();
    // Always mark connected — file-based tabs work without the daemon
    this.status = 'connected';
  }

  disconnect(): void {
    this.cli?.dispose();
    this.status = 'disconnected';
  }

  async isAvailable(): Promise<boolean> {
    return this.cli?.isAvailable() ?? false;
  }

  private findWorkspaceWithCompose(): string | undefined {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (this.findComposeDir(folder.uri.fsPath)) return folder.uri.fsPath;
    }
    return undefined;
  }

  private findComposeDir(root: string): string | undefined {
    const names = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const name of names) {
      if (fs.existsSync(path.join(root, name))) return root;
    }
    return undefined;
  }

  private findComposeFile(): string | undefined {
    const names = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const name of names) {
      const p = path.join(this.composeDir, name);
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }

  async getTabData(tabId: string): Promise<ProviderTabData> {
    if (tabId === 'compose') return this.getComposeData(tabId);

    // All other tabs require a live daemon — re-check on every call so status reflects reality
    this.daemonAvailable = await this.cli?.isAvailable() ?? false;
    this.status = this.daemonAvailable ? 'connected' : 'error';
    if (!this.daemonAvailable) {
      return { tabId, resources: [], sectionLabel: 'Docker daemon not reachable' };
    }

    switch (tabId) {
      case 'containers': return this.getContainersData(tabId);
      case 'images': return this.getImagesData(tabId);
      case 'volumes': return this.getVolumesData(tabId);
      case 'networks': return this.getNetworksData(tabId);
      default: return { tabId, resources: [] };
    }
  }

  private formatPort(p: unknown): string {
    if (typeof p === 'string' || typeof p === 'number') return String(p);
    if (typeof p === 'object' && p !== null) {
      const o = p as Record<string, unknown>;
      const pub = o['published'] ?? o['target'];
      const tgt = o['target'];
      if (pub && tgt && pub !== tgt) return `${pub}:${tgt}`;
      if (tgt) return String(tgt);
    }
    return String(p);
  }

  private getPublishedPort(p: unknown): number | undefined {
    if (typeof p === 'number') return p;
    if (typeof p === 'string') {
      const m = p.match(/^(\d+):/);
      return m ? parseInt(m[1], 10) : undefined;
    }
    if (typeof p === 'object' && p !== null) {
      const pub = (p as Record<string, unknown>)['published'];
      if (pub !== undefined) return parseInt(String(pub), 10);
    }
    return undefined;
  }

  private formatVolume(v: unknown): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null) {
      const o = v as Record<string, unknown>;
      const src = o['source'];
      const tgt = o['target'];
      if (src && tgt) return `${src}:${tgt}`;
      if (tgt) return String(tgt);
    }
    return String(v);
  }

  private async getComposeData(tabId: string): Promise<ProviderTabData> {
    const workspaceRoot = this.findWorkspaceWithCompose() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      const found = this.findComposeDir(workspaceRoot);
      if (found) this.composeDir = found;
    }

    const composeFile = this.findComposeFile();
    if (!composeFile) {
      return { tabId, resources: [], sectionLabel: 'No compose file found in workspace root' };
    }

    // Parse the YAML — always available regardless of daemon
    let servicesRaw: Record<string, unknown> = {};
    let v1Syntax = false;
    let missingEnvFile = false;
    try {
      const composeRaw = yaml.load(fs.readFileSync(composeFile, 'utf8')) as Record<string, unknown>;
      servicesRaw = (composeRaw['services'] as Record<string, unknown>) ?? {};
      v1Syntax = 'version' in composeRaw;
      const servicesStr = JSON.stringify(servicesRaw);
      const refsEnvVars = /\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*/.test(servicesStr);
      missingEnvFile = refsEnvVars && !fs.existsSync(path.join(this.composeDir, '.env'));
    } catch {
      return { tabId, resources: [], sectionLabel: 'Could not parse compose file' };
    }

    // Try to get live state from daemon — refresh availability each call
    // Do NOT update this.status here; compose is file-based and must work regardless of daemon state.
    // Daemon-dependent tabs (containers, images, etc.) own the status field.
    this.daemonAvailable = await this.cli.isAvailable();
    const liveServices = this.daemonAvailable
      ? await this.cli.getComposeServices(composeFile, this.composeDir)
      : [];

    const resources: Resource[] = await Promise.all(Object.keys(servicesRaw).map(async (name) => {
      const svc = (servicesRaw[name] as Record<string, unknown>) ?? {};
      const live = liveServices.find((s) => s.name === name);
      const status = this.parseServiceStatus(live?.state.toLowerCase() ?? 'stopped');

      const image = String(svc['image'] ?? live?.image ?? '—');
      const portsRaw = (svc['ports'] as unknown[]) ?? [];
      const envFile = (svc['env_file'] as string | string[] | undefined);
      const volumesRaw = (svc['volumes'] as unknown[]) ?? [];

      // Check port conflicts only for stopped services and only when the setting is on
      const portConflicts = new Set<number>();
      if (this.checkPortConflicts && status !== 'running') {
        const checks = await Promise.all(
          portsRaw.map(async (p) => {
            const port = this.getPublishedPort(p);
            if (port && await this.cli.isPortInUse(port)) return port;
            return undefined;
          })
        );
        checks.forEach(p => p !== undefined && portConflicts.add(p));
      }

      const children: ResourceChild[] = [
        { label: 'image', value: image, type: 'dim' },
        ...portsRaw.map((p) => {
          const port = this.getPublishedPort(p);
          const conflict = port !== undefined && portConflicts.has(port);
          const formatted = this.formatPort(p);
          return { label: 'ports', value: conflict ? `${formatted}  ⚠ port ${port} in use` : formatted, type: conflict ? 'warn' as const : 'dim' as const };
        }),
        ...volumesRaw.map((v) => ({ label: 'volume', value: this.formatVolume(v), type: 'dim' as const })),
        ...(envFile ? [{ label: 'env', value: Array.isArray(envFile) ? envFile.join(', ') : String(envFile), type: 'dim' as const }] : []),
      ];

      const actions = !this.daemonAvailable
        ? []
        : status === 'running' ? RUNNING_ACTIONS : STOPPED_ACTIONS;

      return { id: name, name, status, meta: { image, composeDir: this.composeDir }, actions, children };
    }));

    const running = resources.filter(r => r.status === 'running').length;
    const unhealthy = resources.filter(r => r.status === 'unhealthy').length;
    const daemonNote = this.daemonAvailable ? '' : ' · daemon offline';

    return {
      tabId,
      badge: unhealthy > 0 ? unhealthy : running || undefined,
      badgeType: unhealthy > 0 ? 'warn' : 'ok',
      resources,
      sectionLabel: `${path.basename(composeFile)} · ${resources.length} services${daemonNote}`,
      v1Syntax,
      missingEnvFile,
    };
  }

  streamServiceLogs(serviceId: string, onLine: (line: string) => void, onEnd: () => void): () => void {
    return this.cli.streamToCallback(serviceId, true, this.composeDir, onLine, onEnd);
  }

  private async getContainersData(tabId: string): Promise<ProviderTabData> {
    const containers = await this.cli.getContainers(true);
    const running = containers.filter((c) => c.state === 'running').length;

    const resources: Resource[] = containers.map((c) => {
      const status = this.parseContainerState(c.state || c.status || '');
      return {
        id: c.id || c.name,
        name: (c.name || 'unknown').replace(/^\//, ''),
        status,
        meta: { image: c.image || '', created: c.created || '' },
        actions: status === 'running' ? RUNNING_ACTIONS : STOPPED_ACTIONS,
        children: [
          { label: 'id', value: c.id.substring(0, 12), type: 'dim' },
          { label: 'image', value: c.image || '—', type: 'dim' },
          { label: 'ports', value: c.ports || '—', type: 'dim' },
          { label: 'status', value: c.status || '—', type: 'dim' },
        ],
      };
    });

    const exited = resources.filter((r) => r.status === 'exited' || r.status === 'stopped').length;
    return {
      tabId,
      badge: running,
      badgeType: running > 0 ? 'ok' : 'neutral',
      resources,
      sectionLabel: `${running} running · ${exited} exited`,
    };
  }

  private async getImagesData(tabId: string): Promise<ProviderTabData> {
    const images = await this.cli.getImages();
    const resources: Resource[] = images.map((img) => ({
      id: img.id || img.repository,
      name: img.repository || 'unknown',
      status: 'unknown' as ResourceStatus,
      meta: { tag: img.tag || '', size: img.size || '', created: img.created || '' },
      actions: [
        { id: 'pull', label: 'Pull latest', icon: 'download', command: 'pull' },
        { id: 'remove', label: 'Remove', icon: 'trash', command: 'remove', dangerous: true },
      ],
      children: [
        { label: 'tag', value: img.tag || 'latest', type: 'dim' },
        { label: 'size', value: img.size || '—', type: 'dim' },
        { label: 'created', value: img.created || '—', type: 'dim' },
      ],
    }));

    return { tabId, badge: resources.length, badgeType: 'neutral', resources, sectionLabel: `${resources.length} images` };
  }

  private async getVolumesData(tabId: string): Promise<ProviderTabData> {
    const volumes = await this.cli.getVolumes();
    const containers = await this.cli.getContainers(true);
    // mounts field contains comma-separated volume names for containers that are running
    const mountedNames = new Set(
      containers.flatMap((c) => c.mounts.split(',').map((m) => m.trim()).filter(Boolean))
    );

    const resources: Resource[] = volumes.map((v) => {
      const inUse = mountedNames.has(v.name);
      const status: ResourceStatus = inUse ? 'in_use' : 'orphaned';
      return {
        id: v.name,
        name: v.name || 'unknown',
        status,
        meta: { driver: v.driver || 'local' },
        actions: inUse
          ? [{ id: 'inspect', label: 'Inspect', icon: 'info', command: 'inspect' }]
          : [{ id: 'remove', label: 'Remove', icon: 'trash', command: 'remove', dangerous: true }],
        children: [
          { label: 'driver', value: v.driver || 'local', type: 'dim' },
          { label: 'mount', value: v.mountpoint || '—', type: 'dim' },
          { label: 'status', value: inUse ? 'in use' : 'orphaned — safe to remove', type: inUse ? 'ok' : 'warn' },
        ],
      };
    });

    const orphaned = resources.filter((r) => r.status === 'orphaned').length;
    return {
      tabId,
      badge: orphaned > 0 ? orphaned : resources.length,
      badgeType: orphaned > 0 ? 'warn' : 'neutral',
      resources,
      sectionLabel: `${resources.length} volumes · ${orphaned} orphaned`,
    };
  }

  private async getNetworksData(tabId: string): Promise<ProviderTabData> {
    const networks = await this.cli.getNetworks();
    const resources: Resource[] = networks.map((n) => ({
      id: n.id,
      name: n.name || 'unknown',
      status: 'unknown' as ResourceStatus,
      meta: { driver: n.driver || '', scope: n.scope || '' },
      actions: [
        { id: 'inspect', label: 'Inspect', icon: 'info', command: 'inspect' },
        { id: 'remove', label: 'Remove', icon: 'trash', command: 'remove', dangerous: true },
      ],
      children: [
        { label: 'driver', value: n.driver || '—', type: 'dim' },
        { label: 'scope', value: n.scope || '—', type: 'dim' },
      ],
    }));

    return { tabId, badge: resources.length, badgeType: 'neutral', resources, sectionLabel: `${resources.length} networks` };
  }

  async executeAction(tabId: string, resourceId: string, actionId: string): Promise<void> {
    switch (actionId) {
      case 'up': await this.cli.composeUp(this.composeDir, resourceId === '__all__' ? undefined : resourceId); break;
      case 'down': await this.cli.composeDown(this.composeDir); break;
      case 'start': await this.cli.startContainer(resourceId); break;
      case 'stop':
        if (tabId === 'compose') await this.cli.composeStop(this.composeDir, resourceId);
        else await this.cli.stopContainer(resourceId);
        break;
      case 'restart':
        if (tabId === 'compose') {
          if (resourceId === '__all__') await this.cli.composeRestartAll(this.composeDir);
          else await this.cli.composeRestart(this.composeDir, resourceId);
        } else await this.cli.restartContainer(resourceId);
        break;
      case 'remove':
        if (tabId === 'volumes') await this.cli.removeVolume(resourceId);
        else if (tabId === 'images') await this.cli.removeImage(resourceId);
        else if (tabId === 'networks') await this.cli.removeNetwork(resourceId);
        else await this.cli.removeContainer(resourceId);
        break;
      case 'logs': {
        const ch = this.cli.getOrCreateLogChannel(resourceId);
        this.cli.streamLogs(resourceId, ch, tabId === 'compose', this.composeDir);
        break;
      }
      case 'shell': this.cli.openShell(resourceId); break;
      case 'pull': await this.cli.pullImage(resourceId); break;
    }
  }

  private parseServiceStatus(raw: string): ResourceStatus {
    if (raw.includes('running')) return 'running';
    if (raw.includes('restarting')) return 'restarting';
    if (raw.includes('unhealthy')) return 'unhealthy';
    if (raw.includes('exited') || raw.includes('stopped') || raw === '') return 'stopped';
    return 'unknown';
  }

  private parseContainerState(raw: string): ResourceStatus {
    const s = raw.toLowerCase();
    if (s === 'running') return 'running';
    if (s === 'restarting') return 'restarting';
    if (s === 'exited') return 'exited';
    if (s === 'paused') return 'stopped';
    return 'unknown';
  }
}
