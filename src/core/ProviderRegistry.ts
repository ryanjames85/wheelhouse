/**
 * ProviderRegistry.ts
 *
 * Owns the lifecycle of all registered providers and resolves tab visibility for the active profile.
 *
 * Providers are registered once at construction (Docker, Kubernetes).
 * connectEnabled() connects providers that are enabled in the given profile and disconnects the rest.
 * getVisibleTabs() returns the ordered tab list for the current profile, filtered to connected providers.
 */
import { IProvider } from '../providers/base/IProvider';
import { DockerProvider } from '../providers/docker/DockerProvider';
import { KubernetesProvider } from '../providers/kubernetes/KubernetesProvider';
import { Profile, TabDefinition } from '../types';

export class ProviderRegistry {
  private providers = new Map<string, IProvider>();

  constructor() {
    this.register(new DockerProvider());
    this.register(new KubernetesProvider());
  }

  register(provider: IProvider): void {
    this.providers.set(provider.id, provider);
  }

  getAll(): IProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): IProvider | undefined {
    return this.providers.get(id);
  }

  async connectEnabled(profile: Profile): Promise<void> {
    for (const providerCfg of profile.providers) {
      const provider = this.providers.get(providerCfg.id);
      if (!provider || provider.comingSoon) continue;

      provider.configure(providerCfg);
      if (providerCfg.enabled) {
        try {
          await provider.connect();
        } catch (err) {
          provider.status = 'error';
          console.error(`[Wheelhouse] Failed to connect provider ${providerCfg.id}:`, err);
        }
      } else {
        provider.disconnect();
      }
    }
  }

  getVisibleTabs(profile: Profile): TabDefinition[] {
    const allTabs: TabDefinition[] = [];

    for (const providerCfg of profile.providers) {
      if (!providerCfg.enabled) continue;
      const provider = this.providers.get(providerCfg.id);
      if (!provider) continue;
      allTabs.push(...provider.tabs);
    }

    return allTabs
      .filter((tab) => profile.visibleTabs.includes(tab.id))
      .sort((a, b) => a.order - b.order);
  }

  dispose(): void {
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
  }
}
