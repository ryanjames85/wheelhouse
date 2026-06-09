/**
 * KubernetesProvider.ts
 *
 * Kubernetes provider stub — declares the K8s tab set and returns empty data for all tabs.
 *
 * Tabs declared: pods, deployments, services, namespaces.
 * comingSoon = true until the kubectl integration is implemented.
 *
 * To implement: add KubectlCLI.ts, wire up getTabData() per tab, add executeAction()
 * for pod shell / logs / scale / restart, then set comingSoon = false.
 */
import { BaseProvider } from '../base/IProvider';
import { TabDefinition, ProviderTabData, Resource, ResourceStatus, ResourceAction } from '../../types';
import { KubernetesCLI } from './KubernetesCLI';

const POD_RUNNING_ACTIONS: ResourceAction[] = [
  { id: 'logs',    label: 'Tail logs',     icon: 'logs',     command: 'logs' },
  { id: 'shell',   label: 'Open shell',    icon: 'terminal', command: 'shell' },
  { id: 'restart', label: 'Restart',       icon: 'refresh',  command: 'restart' },
  { id: 'remove',  label: 'Remove',        icon: 'trash',    command: 'remove', dangerous: true },
];

const POD_STOPPED_ACTIONS: ResourceAction[] = [
  { id: 'logs',   label: 'Tail logs', icon: 'logs',  command: 'logs' },
  { id: 'remove', label: 'Remove',    icon: 'trash', command: 'remove', dangerous: true },
];

const DEPLOY_ACTIONS: ResourceAction[] = [
  { id: 'restart', label: 'Rollout restart', icon: 'refresh', command: 'restart' },
  { id: 'remove',  label: 'Remove',          icon: 'trash',   command: 'remove', dangerous: true },
];

export class KubernetesProvider extends BaseProvider {
  readonly id = 'kubernetes';
  readonly name = 'Kubernetes';
  readonly description = 'Pods, deployments, services, namespaces';
  readonly version = '1.0.0';
  readonly comingSoon = false;

  readonly tabs: TabDefinition[] = [
    { id: 'pods',        label: 'Pods',        icon: 'hexagon',      providerId: 'kubernetes', order: 0 },
    { id: 'deployments', label: 'Deployments', icon: 'layout-grid',  providerId: 'kubernetes', order: 1 },
    { id: 'services',    label: 'Services',    icon: 'network',      providerId: 'kubernetes', order: 2 },
    { id: 'namespaces',  label: 'Namespaces',  icon: 'folder',       providerId: 'kubernetes', order: 3 },
  ];

  private cli!: KubernetesCLI;
  private clusterAvailable: boolean = false;
  private currentContext: string = '';

  get isClusterAvailable(): boolean { return this.clusterAvailable; }
  get activeContext(): string { return this.currentContext; }

  private get namespace(): string {
    return this.config.settings['namespace'] || 'default';
  }

  async connect(): Promise<void> {
    const bin = this.config.settings['kubeBin'] || 'kubectl';
    this.cli = new KubernetesCLI(bin);
    this.clusterAvailable = await this.cli.isAvailable();
    this.currentContext = await this.cli.getCurrentContext();
    this.status = this.clusterAvailable ? 'connected' : 'error';
  }

  disconnect(): void {
    this.cli?.dispose();
    this.clusterAvailable = false;
    this.currentContext = '';
    this.status = 'disconnected';
  }

  async isAvailable(): Promise<boolean> {
    return this.cli?.isAvailable() ?? false;
  }

  async getTabData(tabId: string): Promise<ProviderTabData> {
    if (!this.clusterAvailable) {
      this.clusterAvailable = await this.cli?.isAvailable() ?? false;
      if (!this.clusterAvailable) {
        return { tabId, resources: [], sectionLabel: 'Cluster not reachable' };
      }
    }

    switch (tabId) {
      case 'pods':        return this.getPodsData(tabId);
      case 'deployments': return this.getDeploymentsData(tabId);
      case 'services':    return this.getServicesData(tabId);
      case 'namespaces':  return this.getNamespacesData(tabId);
      default:            return { tabId, resources: [] };
    }
  }

  private async getPodsData(tabId: string): Promise<ProviderTabData> {
    const pods = await this.cli.getPods(this.namespace);
    const resources: Resource[] = pods.map((pod) => {
      const status = this.parsePodStatus(pod.status);
      const isRunning = status === 'running';
      return {
        id: pod.name,
        name: pod.name,
        status,
        meta: { namespace: pod.namespace, node: pod.nodeName },
        actions: isRunning ? POD_RUNNING_ACTIONS : POD_STOPPED_ACTIONS,
        children: [
          { label: 'ns',       value: pod.namespace,  type: 'dim' },
          { label: 'ready',    value: pod.ready,       type: 'dim' },
          { label: 'restarts', value: String(pod.restarts), type: pod.restarts > 0 ? 'warn' : 'dim' },
          { label: 'node',     value: pod.nodeName || '—', type: 'dim' },
          { label: 'age',      value: pod.age,         type: 'dim' },
        ],
      };
    });

    const running = resources.filter(r => r.status === 'running').length;
    const unhealthy = resources.filter(r => ['unhealthy', 'restarting'].includes(r.status)).length;
    return {
      tabId,
      badge: unhealthy > 0 ? unhealthy : running || undefined,
      badgeType: unhealthy > 0 ? 'warn' : 'ok',
      resources,
      sectionLabel: `${this.namespace} · ${pods.length} pods`,
    };
  }

  private async getDeploymentsData(tabId: string): Promise<ProviderTabData> {
    const deployments = await this.cli.getDeployments(this.namespace);
    const resources: Resource[] = deployments.map((d) => {
      const [ready, total] = d.ready.split('/').map(Number);
      const status: ResourceStatus = ready === total && total > 0 ? 'running' : ready === 0 ? 'stopped' : 'restarting';
      return {
        id: d.name,
        name: d.name,
        status,
        meta: { namespace: d.namespace },
        actions: DEPLOY_ACTIONS,
        children: [
          { label: 'ns',        value: d.namespace,        type: 'dim' },
          { label: 'ready',     value: d.ready,            type: ready === total ? 'ok' : 'warn' },
          { label: 'up-to-date', value: String(d.upToDate), type: 'dim' },
          { label: 'available', value: String(d.available), type: 'dim' },
          { label: 'age',       value: d.age,              type: 'dim' },
        ],
      };
    });

    const running = resources.filter(r => r.status === 'running').length;
    return {
      tabId,
      badge: running || undefined,
      badgeType: 'ok',
      resources,
      sectionLabel: `${this.namespace} · ${deployments.length} deployments`,
    };
  }

  private async getServicesData(tabId: string): Promise<ProviderTabData> {
    const services = await this.cli.getServices(this.namespace);
    const resources: Resource[] = services.map((svc) => ({
      id: svc.name,
      name: svc.name,
      status: 'running' as ResourceStatus,
      meta: { namespace: svc.namespace, type: svc.type },
      actions: [],
      children: [
        { label: 'ns',       value: svc.namespace,  type: 'dim' },
        { label: 'type',     value: svc.type,        type: 'dim' },
        { label: 'cluster',  value: svc.clusterIp,   type: 'dim' },
        { label: 'external', value: svc.externalIp,  type: svc.externalIp !== '<none>' ? 'ok' : 'dim' },
        { label: 'ports',    value: svc.ports,        type: 'dim' },
        { label: 'age',      value: svc.age,          type: 'dim' },
      ],
    }));

    return {
      tabId,
      badge: resources.length,
      badgeType: 'neutral',
      resources,
      sectionLabel: `${this.namespace} · ${services.length} services`,
    };
  }

  private async getNamespacesData(tabId: string): Promise<ProviderTabData> {
    const namespaces = await this.cli.getNamespaces();
    const resources: Resource[] = namespaces.map((ns) => ({
      id: ns.name,
      name: ns.name,
      status: (ns.status.toLowerCase() === 'active' ? 'running' : 'stopped') as ResourceStatus,
      meta: {},
      actions: [],
      children: [
        { label: 'status', value: ns.status, type: ns.status.toLowerCase() === 'active' ? 'ok' : 'warn' },
        { label: 'age',    value: ns.age,    type: 'dim' },
      ],
    }));

    return {
      tabId,
      badge: resources.length,
      badgeType: 'neutral',
      resources,
      sectionLabel: `${resources.length} namespaces`,
    };
  }

  async executeAction(tabId: string, resourceId: string, actionId: string): Promise<void> {
    switch (actionId) {
      case 'logs':
        this.cli.streamLogs(resourceId, this.namespace);
        break;
      case 'shell':
        this.cli.openShell(resourceId, this.namespace);
        break;
      case 'restart':
        if (tabId === 'pods') await this.cli.deletePod(resourceId, this.namespace);
        else if (tabId === 'deployments') await this.cli.rolloutRestart(resourceId, this.namespace);
        break;
      case 'remove':
        if (tabId === 'pods') await this.cli.deletePod(resourceId, this.namespace);
        else if (tabId === 'deployments') await this.cli.deleteDeployment(resourceId, this.namespace);
        break;
    }
  }

  streamServiceLogs(podName: string, onLine: (line: string) => void, onEnd: () => void): () => void {
    return this.cli.streamToCallback(podName, this.namespace, onLine, onEnd);
  }

  private parsePodStatus(raw: string): ResourceStatus {
    const s = raw.toLowerCase();
    if (s === 'running')               return 'running';
    if (s === 'notready')              return 'unhealthy';
    if (s === 'crashloopbackoff')      return 'restarting';
    if (s === 'oomkilled')             return 'unhealthy';
    if (s === 'error')                 return 'unhealthy';
    if (s === 'pending')               return 'stopped';
    if (s === 'succeeded' || s === 'completed') return 'exited';
    if (s === 'terminating')           return 'stopped';
    return 'unknown';
  }
}
