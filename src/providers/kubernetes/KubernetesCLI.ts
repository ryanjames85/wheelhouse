import { spawn } from 'child_process';
import * as vscode from 'vscode';

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  age: string;
  nodeName: string;
}

export interface DeploymentInfo {
  name: string;
  namespace: string;
  ready: string;
  upToDate: number;
  available: number;
  age: string;
}

export interface ServiceInfo {
  name: string;
  namespace: string;
  type: string;
  clusterIp: string;
  externalIp: string;
  ports: string;
  age: string;
}

export interface NamespaceInfo {
  name: string;
  status: string;
  age: string;
}

export class KubernetesCLI {
  private logChannels = new Map<string, vscode.OutputChannel>();

  constructor(
    private readonly kubeBin: string = 'kubectl',
  ) {}

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.kubeBin, args, { shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code: number | null) => {
        if (code !== 0) reject(new Error(stderr.trim() || `kubectl exited with code ${code}`));
        else resolve(stdout.trim());
      });
      proc.on('error', (err: Error) => reject(err));
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(['cluster-info', '--request-timeout=3s']);
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentContext(): Promise<string> {
    try {
      return await this.run(['config', 'current-context']);
    } catch {
      return '';
    }
  }

  async getPods(namespace: string): Promise<PodInfo[]> {
    try {
      const out = await this.run(['get', 'pods', '-n', namespace, '-o', 'json']);
      const parsed = JSON.parse(out) as { items: Record<string, unknown>[] };
      return (parsed.items || []).map((item) => {
        const meta = item['metadata'] as Record<string, unknown>;
        const spec = item['spec'] as Record<string, unknown>;
        const status = item['status'] as Record<string, unknown>;
        const conditions = (status['conditions'] as Record<string, unknown>[] | undefined) ?? [];
        const containerStatuses = (status['containerStatuses'] as Record<string, unknown>[] | undefined) ?? [];
        const restarts = containerStatuses.reduce((sum, cs) => sum + ((cs['restartCount'] as number) || 0), 0);
        const readyCount = containerStatuses.filter(cs => cs['ready']).length;
        const totalCount = containerStatuses.length;
        const phase = String(status['phase'] || 'Unknown');
        const podReady = conditions.find(c => c['type'] === 'Ready');
        const isReady = podReady ? String(podReady['status']) === 'True' : false;
        const podStatus = phase === 'Running' && !isReady ? 'NotReady' : phase;
        return {
          name: String(meta['name'] || ''),
          namespace: String(meta['namespace'] || namespace),
          status: podStatus,
          ready: `${readyCount}/${totalCount}`,
          restarts,
          age: this.calcAge(String(meta['creationTimestamp'] || '')),
          nodeName: String(spec['nodeName'] || ''),
        };
      });
    } catch {
      return [];
    }
  }

  async getDeployments(namespace: string): Promise<DeploymentInfo[]> {
    try {
      const out = await this.run(['get', 'deployments', '-n', namespace, '-o', 'json']);
      const parsed = JSON.parse(out) as { items: Record<string, unknown>[] };
      return (parsed.items || []).map((item) => {
        const meta = item['metadata'] as Record<string, unknown>;
        const status = item['status'] as Record<string, unknown>;
        const spec = item['spec'] as Record<string, unknown>;
        const replicas = Number(spec['replicas'] || 0);
        const readyReplicas = Number(status['readyReplicas'] || 0);
        return {
          name: String(meta['name'] || ''),
          namespace: String(meta['namespace'] || namespace),
          ready: `${readyReplicas}/${replicas}`,
          upToDate: Number(status['updatedReplicas'] || 0),
          available: Number(status['availableReplicas'] || 0),
          age: this.calcAge(String(meta['creationTimestamp'] || '')),
        };
      });
    } catch {
      return [];
    }
  }

  async getServices(namespace: string): Promise<ServiceInfo[]> {
    try {
      const out = await this.run(['get', 'services', '-n', namespace, '-o', 'json']);
      const parsed = JSON.parse(out) as { items: Record<string, unknown>[] };
      return (parsed.items || []).map((item) => {
        const meta = item['metadata'] as Record<string, unknown>;
        const spec = item['spec'] as Record<string, unknown>;
        const ports = (spec['ports'] as Record<string, unknown>[] | undefined) ?? [];
        const portStr = ports.map(p => {
          const nodePort = p['nodePort'] ? `:${p['nodePort']}` : '';
          return `${p['port']}${nodePort}/${p['protocol'] || 'TCP'}`;
        }).join(', ');
        const extIps = (spec['externalIPs'] as string[] | undefined) ?? [];
        const lbIngress = ((item['status'] as Record<string, unknown>)?.['loadBalancer'] as Record<string, unknown>)?.['ingress'] as Record<string, unknown>[] | undefined;
        const externalIp = extIps[0] || lbIngress?.[0]?.['ip'] as string || lbIngress?.[0]?.['hostname'] as string || '<none>';
        return {
          name: String(meta['name'] || ''),
          namespace: String(meta['namespace'] || namespace),
          type: String(spec['type'] || 'ClusterIP'),
          clusterIp: String(spec['clusterIP'] || '<none>'),
          externalIp,
          ports: portStr || '<none>',
          age: this.calcAge(String(meta['creationTimestamp'] || '')),
        };
      });
    } catch {
      return [];
    }
  }

  async getNamespaces(): Promise<NamespaceInfo[]> {
    try {
      const out = await this.run(['get', 'namespaces', '-o', 'json']);
      const parsed = JSON.parse(out) as { items: Record<string, unknown>[] };
      return (parsed.items || []).map((item) => {
        const meta = item['metadata'] as Record<string, unknown>;
        const status = item['status'] as Record<string, unknown>;
        return {
          name: String(meta['name'] || ''),
          status: String(status['phase'] || 'Active'),
          age: this.calcAge(String(meta['creationTimestamp'] || '')),
        };
      });
    } catch {
      return [];
    }
  }

  async deletePod(name: string, namespace: string): Promise<void> {
    await this.run(['delete', 'pod', name, '-n', namespace]);
  }

  async rolloutRestart(deploymentName: string, namespace: string): Promise<void> {
    await this.run(['rollout', 'restart', `deployment/${deploymentName}`, '-n', namespace]);
  }

  async deleteDeployment(name: string, namespace: string): Promise<void> {
    await this.run(['delete', 'deployment', name, '-n', namespace]);
  }

  openShell(podName: string, namespace: string): void {
    const terminal = vscode.window.createTerminal(`Shell: ${podName}`);
    terminal.sendText(`${this.kubeBin} exec -it ${podName} -n ${namespace} -- sh -c "command -v bash && exec bash || exec sh"`);
    terminal.show();
  }

  streamLogs(podName: string, namespace: string): void {
    const key = `${namespace}/${podName}`;
    if (!this.logChannels.has(key)) {
      this.logChannels.set(key, vscode.window.createOutputChannel(`Wheelhouse: ${podName}`));
    }
    const ch = this.logChannels.get(key)!;
    ch.clear();
    ch.show(true);
    ch.appendLine(`[Wheelhouse] Streaming logs: ${podName}\n`);

    const proc = spawn(this.kubeBin, ['logs', '-f', '--tail=200', podName, '-n', namespace], {
      shell: false,
      windowsHide: true,
    });
    proc.stdout.on('data', (d: Buffer) => ch.append(d.toString()));
    proc.stderr.on('data', (d: Buffer) => ch.append(d.toString()));
    proc.on('close', (code: number | null) => ch.appendLine(`\n[Wheelhouse] Log stream ended (exit ${code})`));
  }

  streamToCallback(
    podName: string,
    namespace: string,
    onLine: (line: string) => void,
    onEnd: () => void
  ): () => void {
    const proc = spawn(this.kubeBin, ['logs', '-f', '--tail=200', podName, '-n', namespace], {
      shell: false,
      windowsHide: true,
    });
    let buf = '';
    const flush = (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach(onLine);
    };
    proc.stdout.on('data', flush);
    proc.stderr.on('data', flush);
    proc.on('close', () => { if (buf) onLine(buf); onEnd(); });
    return () => { try { proc.kill(); } catch { /* already dead */ } };
  }

  private calcAge(timestamp: string): string {
    if (!timestamp) return '—';
    const diff = Date.now() - new Date(timestamp).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  }

  dispose(): void {
    for (const ch of this.logChannels.values()) ch.dispose();
    this.logChannels.clear();
  }
}
