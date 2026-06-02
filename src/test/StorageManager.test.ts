import { describe, it, expect, beforeEach } from 'vitest';
import { StorageManager } from '../storage/StorageManager';
import { ExtensionContext_ } from './__mocks__/vscode';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS } from '../types';

function makeStorage() {
  return new StorageManager(new ExtensionContext_() as never);
}

describe('StorageManager', () => {
  describe('initial state', () => {
    it('returns the default profile when nothing stored', () => {
      const s = makeStorage();
      const p = s.getActiveProfile();
      expect(p.id).toBe('default');
      expect(p.name).toBe(DEFAULT_PROFILE.name);
    });

    it('returns default settings', () => {
      const s = makeStorage();
      expect(s.getConfig().settings).toMatchObject(DEFAULT_SETTINGS);
    });
  });

  describe('saveProfile / getActiveProfile', () => {
    it('saves a new profile and can retrieve it', async () => {
      const s = makeStorage();
      await s.saveProfile({ ...DEFAULT_PROFILE, id: 'work', name: 'Work' });
      const profiles = s.getConfig().profiles;
      expect(profiles.find(p => p.id === 'work')?.name).toBe('Work');
    });

    it('updates an existing profile in place', async () => {
      const s = makeStorage();
      await s.saveProfile({ ...DEFAULT_PROFILE, name: 'Renamed' });
      expect(s.getConfig().profiles).toHaveLength(1);
      expect(s.getActiveProfile().name).toBe('Renamed');
    });
  });

  describe('setActiveProfile', () => {
    it('switches the active profile', async () => {
      const s = makeStorage();
      await s.saveProfile({ ...DEFAULT_PROFILE, id: 'work', name: 'Work' });
      await s.setActiveProfile('work');
      expect(s.getActiveProfile().id).toBe('work');
    });
  });

  describe('deleteProfile', () => {
    it('removes the profile', async () => {
      const s = makeStorage();
      await s.saveProfile({ ...DEFAULT_PROFILE, id: 'work', name: 'Work' });
      await s.deleteProfile('work');
      expect(s.getConfig().profiles.find(p => p.id === 'work')).toBeUndefined();
    });

    it('falls back to first remaining profile when active is deleted', async () => {
      const s = makeStorage();
      await s.saveProfile({ ...DEFAULT_PROFILE, id: 'work', name: 'Work' });
      await s.setActiveProfile('work');
      await s.deleteProfile('work');
      expect(s.getActiveProfile().id).toBe('default');
    });

    it('restores default profile when last profile is deleted', async () => {
      const s = makeStorage();
      await s.deleteProfile('default');
      expect(s.getConfig().profiles).toHaveLength(1);
      const active = s.getActiveProfile();
      expect(active).toBeDefined();
      expect(active.id).toBe('default');
    });
  });

  describe('snippets', () => {
    it('saves and retrieves global snippets', async () => {
      const s = makeStorage();
      const snip = { id: '1', name: 'My snippet', command: 'echo hi', icon: 'terminal', scope: 'global' as const, runMode: 'terminal' as const };
      await s.saveGlobalSnippet(snip);
      expect(s.getGlobalSnippets()).toHaveLength(1);
      expect(s.getGlobalSnippets()[0].command).toBe('echo hi');
    });

    it('updates an existing global snippet', async () => {
      const s = makeStorage();
      const snip = { id: '1', name: 'Old', command: 'echo old', icon: 'terminal', scope: 'global' as const, runMode: 'terminal' as const };
      await s.saveGlobalSnippet(snip);
      await s.saveGlobalSnippet({ ...snip, command: 'echo new' });
      expect(s.getGlobalSnippets()).toHaveLength(1);
      expect(s.getGlobalSnippets()[0].command).toBe('echo new');
    });

    it('deletes a global snippet', async () => {
      const s = makeStorage();
      const snip = { id: '1', name: 'x', command: 'x', icon: 'terminal', scope: 'global' as const, runMode: 'terminal' as const };
      await s.saveGlobalSnippet(snip);
      await s.deleteGlobalSnippet('1');
      expect(s.getGlobalSnippets()).toHaveLength(0);
    });

    it('getAllSnippets returns only global when scope=global', async () => {
      const s = makeStorage();
      const snip = { id: '1', name: 'g', command: 'g', icon: 'terminal', scope: 'global' as const, runMode: 'terminal' as const };
      await s.saveGlobalSnippet(snip);
      expect(s.getAllSnippets('global')).toHaveLength(1);
      expect(s.getAllSnippets('workspace')).toHaveLength(0);
    });
  });

  describe('updateSettings', () => {
    it('merges partial settings', async () => {
      const s = makeStorage();
      await s.updateSettings({ confirmBeforeRemove: false });
      expect(s.getConfig().settings.confirmBeforeRemove).toBe(false);
      expect(s.getConfig().settings.confirmBeforePrune).toBe(true);
    });
  });

  describe('exportConfig / importConfig', () => {
    it('round-trips config through export/import', async () => {
      const s = makeStorage();
      await s.saveProfile({ ...DEFAULT_PROFILE, id: 'work', name: 'Work' });
      const json = await s.exportConfig();

      const s2 = makeStorage();
      await s2.importConfig(json);
      expect(s2.getConfig().profiles.find(p => p.id === 'work')?.name).toBe('Work');
    });

    it('throws on invalid JSON', async () => {
      const s = makeStorage();
      await expect(s.importConfig('not json')).rejects.toThrow('Failed to import config');
    });
  });

  describe('hints', () => {
    it('returns empty dismissed hints by default', () => {
      expect(makeStorage().getDismissedHints()).toEqual([]);
    });

    it('dismisses a hint and retrieves it', async () => {
      const s = makeStorage();
      await s.dismissHint('orphaned-vols');
      expect(s.getDismissedHints()).toContain('orphaned-vols');
    });

    it('does not duplicate dismissed hints', async () => {
      const s = makeStorage();
      await s.dismissHint('orphaned-vols');
      await s.dismissHint('orphaned-vols');
      expect(s.getDismissedHints().filter(h => h === 'orphaned-vols')).toHaveLength(1);
    });

    it('resets dismissed hints', async () => {
      const s = makeStorage();
      await s.dismissHint('orphaned-vols');
      await s.resetDismissedHints();
      expect(s.getDismissedHints()).toHaveLength(0);
    });
  });

  describe('onboarding', () => {
    it('returns all false flags by default', () => {
      const ob = makeStorage().getOnboardingFlags();
      expect(ob).toEqual({ moment1: false, moment2: false, moment3: false });
    });

    it('sets individual flags', async () => {
      const s = makeStorage();
      await s.setOnboardingFlag('moment1');
      const ob = s.getOnboardingFlags();
      expect(ob.moment1).toBe(true);
      expect(ob.moment2).toBe(false);
      expect(ob.moment3).toBe(false);
    });

    it('sets multiple flags independently', async () => {
      const s = makeStorage();
      await s.setOnboardingFlag('moment1');
      await s.setOnboardingFlag('moment3');
      const ob = s.getOnboardingFlags();
      expect(ob.moment1).toBe(true);
      expect(ob.moment2).toBe(false);
      expect(ob.moment3).toBe(true);
    });
  });

  describe('proactiveHintsEnabled default', () => {
    it('defaults to true', () => {
      expect(makeStorage().getConfig().settings.proactiveHintsEnabled).toBe(true);
    });
  });

  describe('getAllSnippets scope', () => {
    it('returns both global and workspace snippets when scope is both', async () => {
      const s = makeStorage();
      const global = { id: 'g1', name: 'global', command: 'echo g', icon: 'terminal', scope: 'global' as const, runMode: 'terminal' as const };
      await s.saveGlobalSnippet(global);
      // workspace snippets require a real filesystem; verify global count at minimum
      const all = s.getAllSnippets('both');
      expect(all.some(sn => sn.id === 'g1')).toBe(true);
    });

    it('returns no snippets when scope is workspace and none are saved', () => {
      expect(makeStorage().getAllSnippets('workspace')).toHaveLength(0);
    });

    it('returns only global snippets when scope is global', async () => {
      const s = makeStorage();
      const snip = { id: '1', name: 'g', command: 'g', icon: 'terminal', scope: 'global' as const, runMode: 'terminal' as const };
      await s.saveGlobalSnippet(snip);
      const result = s.getAllSnippets('global');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });
  });

  describe('setActiveProfile edge cases', () => {
    it('falls back to first profile when active id does not match any profile', async () => {
      const s = makeStorage();
      await s.setActiveProfile('nonexistent');
      // getActiveProfile should fall back to first profile via the ?? profiles[0] guard
      expect(s.getActiveProfile()).toBeDefined();
      expect(s.getActiveProfile().id).toBe('default');
    });
  });

  describe('exportConfig / importConfig edge cases', () => {
    it('importConfig merges default settings for missing keys', async () => {
      const s = makeStorage();
      const minimal = JSON.stringify({ profiles: [DEFAULT_PROFILE], activeProfileId: 'default', globalSnippets: [], settings: {} });
      await s.importConfig(minimal);
      expect(s.getConfig().settings.confirmBeforeRemove).toBe(DEFAULT_SETTINGS.confirmBeforeRemove);
    });
  });
});
