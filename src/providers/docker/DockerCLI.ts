/**
 * DockerCLI.ts
 *
 * Thin wrapper around the docker CLI binary — no Docker SDK, no Docker Desktop dependency.
 *
 * All operations shell out via child_process. Works with any Docker-compatible daemon
 * (Docker Desktop, Colima, Podman, Rancher Desktop) as long as the docker binary is on PATH.
 *
 * Streaming operations (logs, shell) use spawn and write to a VS Code OutputChannel or terminal.
 * One-shot operations (ps, images, etc.) use exec and parse JSON output.
 */
import { spawn } from 'child_process';
import * as net from 'net';
import * as vscode from 'vscode';

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created: string;
  mounts: string;
}

export interface ImageInfo {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
}

export interface ComposeService {
  name: string;
  state: string;
  status: string;
  image?: string;
}

export class DockerCLI {
  private logChannels = new Map<string, vscode.OutputChannel>();

  constructor(
    private readonly dockerBin: string = 'docker',
    private readonly workDir: string = process.cwd()
  ) {}

  private run(args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.dockerBin, args, {
        cwd: cwd ?? this.workDir,
        shell: false,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code: number | null) => {
        if (code !== 0) reject(new Error(stderr.trim() || `docker exited with code ${code}`));
        else resolve(stdout.trim());
      });
      proc.on('error', (err: Error) => reject(err));
    });
  }

  // Long-running commands (compose up/down/restart) — streams output live to a channel so the
  // user sees progress as it happens. The header and footer make clear this is Docker output.
  private runToChannel(args: string[], cwd?: string): Promise<void> {
    const channel = this.getOrCreateLogChannel('docker');
    channel.clear();
    channel.show(true);
    channel.appendLine(`▶ ${this.dockerBin} ${args.join(' ')}`);
    channel.appendLine('─'.repeat(60));

    return new Promise((resolve, reject) => {
      const proc = spawn(this.dockerBin, args, {
        cwd: cwd ?? this.workDir,
        shell: false,
        windowsHide: true,
      });
      proc.stdout.on('data', (d: Buffer) => channel.append(d.toString()));
      proc.stderr.on('data', (d: Buffer) => channel.append(d.toString()));
      proc.on('close', (code: number | null) => {
        channel.appendLine('');
        if (code !== 0) {
          channel.appendLine(`─`.repeat(60));
          channel.appendLine(`✗ Docker exited with code ${code} — the error above is from Docker, not Wheelhouse.`);
          reject(new Error(`docker ${args[0]} exited with code ${code}`));
        } else {
          channel.appendLine(`─`.repeat(60));
          channel.appendLine(`✓ Done`);
          resolve();
        }
      });
      proc.on('error', (err: Error) => {
        channel.appendLine(`\n✗ Could not start Docker: ${err.message}`);
        reject(err);
      });
    });
  }

  // Parse a raw JSON entry from docker output, normalising PascalCase and camelCase field names
  private field(e: Record<string, unknown>, ...keys: string[]): string {
    for (const k of keys) {
      if (e[k] !== undefined && e[k] !== null) return String(e[k]);
    }
    return '';
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(['info', '--format', '{{.ServerVersion}}']);
      return true;
    } catch {
      return false;
    }
  }

  // Parse output that may be a JSON array OR newline-delimited JSON objects
  private parseJsonOutput(output: string): Record<string, unknown>[] {
    const trimmed = output.trim();
    if (!trimmed) return [];

    // JSON array (Docker Compose v2.20+ and newer docker ps in some modes)
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        return Array.isArray(arr) ? arr : [];
      } catch { /* fall through to NDJSON */ }
    }

    // Newline-delimited JSON objects
    return trimmed.split('\n')
      .filter(l => l.trim().startsWith('{'))
      .flatMap(line => {
        try { return [JSON.parse(line) as Record<string, unknown>]; }
        catch { return []; }
      });
  }

  async getContainers(all = true): Promise<ContainerInfo[]> {
    const args = ['ps', '--format', '{{json .}}'];
    if (all) args.push('-a');
    const output = await this.run(args);
    return this.parseJsonOutput(output).map(e => ({
      id:      this.field(e, 'ID', 'Id', 'id'),
      name:    this.field(e, 'Names', 'Name', 'name').replace(/^\//, '').split(',')[0],
      image:   this.field(e, 'Image', 'image'),
      status:  this.field(e, 'Status', 'status'),
      state:   this.field(e, 'State', 'state'),
      ports:   this.field(e, 'Ports', 'ports'),
      created: this.field(e, 'CreatedAt', 'Created', 'created'),
      mounts:  this.field(e, 'Mounts', 'mounts'),
    }));
  }

  async getImages(): Promise<ImageInfo[]> {
    const output = await this.run(['images', '--format', '{{json .}}']);
    return this.parseJsonOutput(output).map(e => ({
      id:         this.field(e, 'ID', 'Id', 'id'),
      repository: this.field(e, 'Repository', 'repository'),
      tag:        this.field(e, 'Tag', 'tag'),
      size:       this.field(e, 'Size', 'size'),
      created:    this.field(e, 'CreatedAt', 'CreatedSince', 'created'),
    }));
  }

  async getVolumes(): Promise<VolumeInfo[]> {
    const output = await this.run(['volume', 'ls', '--format', '{{json .}}']);
    return this.parseJsonOutput(output).map(e => ({
      name:       this.field(e, 'Name', 'name'),
      driver:     this.field(e, 'Driver', 'driver'),
      mountpoint: this.field(e, 'Mountpoint', 'mountpoint'),
    }));
  }

  async getNetworks(): Promise<NetworkInfo[]> {
    const output = await this.run(['network', 'ls', '--format', '{{json .}}']);
    return this.parseJsonOutput(output).map(e => ({
      id:     this.field(e, 'ID', 'Id', 'id'),
      name:   this.field(e, 'Name', 'name'),
      driver: this.field(e, 'Driver', 'driver'),
      scope:  this.field(e, 'Scope', 'scope'),
    }));
  }

  async getComposeServices(composeFile: string, cwd: string): Promise<ComposeService[]> {
    try {
      const output = await this.run(['compose', 'ps', '--format', 'json'], cwd);
      return this.parseJsonOutput(output).flatMap(e => {
        const name = this.field(e, 'Service', 'Name', 'name');
        if (!name || name === 'unknown') return [];
        return [{
          name,
          state:  this.field(e, 'State', 'state', 'Status', 'status'),
          status: this.field(e, 'Status', 'status'),
          image:  this.field(e, 'Image', 'image') || undefined,
        }];
      });
    } catch {
      return [];
    }
  }

  async startContainer(nameOrId: string): Promise<void> { await this.run(['start', nameOrId]); }
  async stopContainer(nameOrId: string): Promise<void> { await this.run(['stop', nameOrId]); }
  async restartContainer(nameOrId: string): Promise<void> { await this.run(['restart', nameOrId]); }
  async removeContainer(nameOrId: string): Promise<void> { await this.run(['rm', '-f', nameOrId]); }
  async removeImage(nameOrId: string): Promise<void> { await this.run(['rmi', nameOrId]); }
  async pullImage(name: string): Promise<void> { await this.run(['pull', name]); }
  async removeVolume(name: string): Promise<void> { await this.run(['volume', 'rm', name]); }
  async removeNetwork(name: string): Promise<void> { await this.run(['network', 'rm', name]); }

  async composeUp(cwd: string, service?: string): Promise<void> {
    const args = service ? ['compose', 'up', '-d', service] : ['compose', 'up', '-d'];
    await this.runToChannel(args, cwd);
  }

  async composeDown(cwd: string): Promise<void> { await this.runToChannel(['compose', 'down'], cwd); }
  async composeRestart(cwd: string, service: string): Promise<void> { await this.runToChannel(['compose', 'restart', service], cwd); }
  async composeRestartAll(cwd: string): Promise<void> { await this.runToChannel(['compose', 'restart'], cwd); }
  async composeStop(cwd: string, service: string): Promise<void> { await this.runToChannel(['compose', 'stop', service], cwd); }

  streamLogs(nameOrId: string, channel: vscode.OutputChannel, compose = false, cwd?: string): void {
    channel.clear();
    channel.show(true);
    channel.appendLine(`[Wheelhouse] Streaming logs: ${nameOrId}\n`);

    const args = compose
      ? ['compose', 'logs', '-f', '--tail=200', nameOrId]
      : ['logs', '-f', '--tail=200', nameOrId];

    const proc = spawn(this.dockerBin, args, {
      cwd: cwd ?? this.workDir,
      shell: false,
      windowsHide: true,
    });
    proc.stdout.on('data', (d: Buffer) => channel.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => channel.append(d.toString()));
    proc.on('close', (code: number | null) => channel.appendLine(`\n[Wheelhouse] Log stream ended (exit ${code})`));
  }

  openShell(nameOrId: string): void {
    const terminal = vscode.window.createTerminal(`Shell: ${nameOrId}`);
    terminal.sendText(`${this.dockerBin} exec -it "${nameOrId}" sh -c "command -v bash && exec bash || exec sh"`);
    terminal.show();
  }

  streamToCallback(
    nameOrId: string,
    isCompose: boolean,
    cwd: string,
    onLine: (line: string) => void,
    onEnd: () => void
  ): () => void {
    const args = isCompose
      ? ['compose', 'logs', '-f', '--tail=200', nameOrId]
      : ['logs', '-f', '--tail=200', nameOrId];

    const proc = spawn(this.dockerBin, args, { cwd, shell: false, windowsHide: true });
    let buf = '';
    let disposed = false;
    const flush = (data: Buffer) => {
      if (disposed) return;
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach(onLine);
    };
    proc.stdout.on('data', flush);
    proc.stderr.on('data', flush);
    proc.on('close', () => { if (!disposed && buf) onLine(buf); if (!disposed) onEnd(); });
    return () => { disposed = true; try { proc.kill(); } catch { /* already dead */ } };
  }

  async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        resolve(err.code === 'EADDRINUSE');
      });
      server.once('listening', () => {
        server.close(() => resolve(false));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  getOrCreateLogChannel(name: string): vscode.OutputChannel {
    if (!this.logChannels.has(name)) {
      this.logChannels.set(name, vscode.window.createOutputChannel(`Wheelhouse: ${name}`));
    }
    return this.logChannels.get(name)!;
  }

  dispose(): void {
    for (const ch of this.logChannels.values()) ch.dispose();
    this.logChannels.clear();
  }
}
