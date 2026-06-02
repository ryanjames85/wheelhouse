import { describe, it, expect, vi } from 'vitest';
import { ProviderRegistry } from '../core/ProviderRegistry';
import { DEFAULT_PROFILE } from '../types';

describe('ProviderRegistry', () => {
  it('registers docker and kubernetes providers on construction', () => {
    const r = new ProviderRegistry();
    const ids = r.getAll().map(p => p.id);
    expect(ids).toContain('docker');
    expect(ids).toContain('kubernetes');
  });

  it('get returns the right provider', () => {
    const r = new ProviderRegistry();
    expect(r.get('docker')?.name).toBe('Docker');
    expect(r.get('kubernetes')?.name).toBe('Kubernetes');
    expect(r.get('nonexistent')).toBeUndefined();
  });

  describe('connectEnabled', () => {
    it('skips comingSoon providers', async () => {
      const r = new ProviderRegistry();
      const k8s = r.get('kubernetes')!;
      const connectSpy = vi.spyOn(k8s, 'connect');
      await r.connectEnabled(DEFAULT_PROFILE);
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('calls connect on enabled providers', async () => {
      const r = new ProviderRegistry();
      const docker = r.get('docker')!;
      const connectSpy = vi.spyOn(docker, 'connect').mockResolvedValue(undefined);
      await r.connectEnabled(DEFAULT_PROFILE);
      expect(connectSpy).toHaveBeenCalled();
    });

    it('calls disconnect on disabled providers', async () => {
      const r = new ProviderRegistry();
      const docker = r.get('docker')!;
      const disconnectSpy = vi.spyOn(docker, 'disconnect');
      const profile = { ...DEFAULT_PROFILE, providers: [{ id: 'docker', enabled: false, settings: {} }] };
      await r.connectEnabled(profile);
      expect(disconnectSpy).toHaveBeenCalled();
    });

    it('sets provider status to error and does not throw when connect fails', async () => {
      const r = new ProviderRegistry();
      const docker = r.get('docker')!;
      vi.spyOn(docker, 'connect').mockRejectedValue(new Error('daemon not running'));
      await expect(r.connectEnabled(DEFAULT_PROFILE)).resolves.toBeUndefined();
      expect(docker.status).toBe('error');
    });
  });

  describe('getVisibleTabs', () => {
    it('returns only tabs listed in profile.visibleTabs', async () => {
      const r = new ProviderRegistry();
      const docker = r.get('docker')!;
      vi.spyOn(docker, 'connect').mockResolvedValue(undefined);
      await r.connectEnabled(DEFAULT_PROFILE);

      const profile = { ...DEFAULT_PROFILE, visibleTabs: ['compose', 'containers'] };
      const tabs = r.getVisibleTabs(profile);
      expect(tabs.map(t => t.id)).toEqual(expect.arrayContaining(['compose', 'containers']));
      expect(tabs.find(t => t.id === 'images')).toBeUndefined();
    });

    it('returns no tabs for disabled providers', () => {
      const r = new ProviderRegistry();
      const profile = { ...DEFAULT_PROFILE, providers: [{ id: 'docker', enabled: false, settings: {} }] };
      expect(r.getVisibleTabs(profile)).toHaveLength(0);
    });

    it('tabs are sorted by order', async () => {
      const r = new ProviderRegistry();
      const docker = r.get('docker')!;
      vi.spyOn(docker, 'connect').mockResolvedValue(undefined);
      await r.connectEnabled(DEFAULT_PROFILE);
      const tabs = r.getVisibleTabs(DEFAULT_PROFILE);
      for (let i = 1; i < tabs.length; i++) {
        expect(tabs[i].order).toBeGreaterThanOrEqual(tabs[i - 1].order);
      }
    });
  });

  describe('dispose', () => {
    it('disposes all providers without throwing', () => {
      const r = new ProviderRegistry();
      expect(() => r.dispose()).not.toThrow();
    });
  });
});
