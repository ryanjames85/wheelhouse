import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WheelhouseConfig, Snippet, Profile, DEFAULT_CONFIG, SnippetScope } from '../types';

const GLOBAL_KEY = 'wheelhouse.config';
const HINTS_KEY = 'wheelhouse.dismissedHints';
const ONBOARDING_KEY = 'wheelhouse.onboarding';
const WORKSPACE_SNIPPETS_FILE = '.wheelhouse/snippets.json';

type OnboardingFlags = { moment1: boolean; moment2: boolean; moment3: boolean };

export class StorageManager {
  private config: WheelhouseConfig;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.config = this.load();
  }

  private load(): WheelhouseConfig {
    const stored = this.context.globalState.get<WheelhouseConfig>(GLOBAL_KEY);
    if (!stored) {
      return {
        ...DEFAULT_CONFIG,
        profiles: DEFAULT_CONFIG.profiles.map(p => ({ ...p })),
        globalSnippets: [],
        settings: { ...DEFAULT_CONFIG.settings },
      };
    }
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      globalSnippets: Array.isArray(stored.globalSnippets) ? [...stored.globalSnippets] : [],
      settings: { ...DEFAULT_CONFIG.settings, ...stored.settings },
    };
  }

  private async save(): Promise<void> {
    await this.context.globalState.update(GLOBAL_KEY, this.config);
  }

  getConfig(): WheelhouseConfig {
    return this.config;
  }

  getActiveProfile(): Profile {
    return (
      this.config.profiles.find((p) => p.id === this.config.activeProfileId) ??
      this.config.profiles[0]
    );
  }

  async setActiveProfile(profileId: string): Promise<void> {
    this.config.activeProfileId = profileId;
    await this.save();
  }

  async saveProfile(profile: Profile): Promise<void> {
    const idx = this.config.profiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) {
      this.config.profiles[idx] = profile;
    } else {
      this.config.profiles.push(profile);
    }
    await this.save();
  }

  async deleteProfile(profileId: string): Promise<void> {
    this.config.profiles = this.config.profiles.filter((p) => p.id !== profileId);
    if (!this.config.profiles.length) {
      this.config.profiles = DEFAULT_CONFIG.profiles.map(p => ({ ...p }));
    }
    if (!this.config.profiles.find((p) => p.id === this.config.activeProfileId)) {
      this.config.activeProfileId = this.config.profiles[0].id;
    }
    await this.save();
  }

  getGlobalSnippets(): Snippet[] {
    return this.config.globalSnippets;
  }

  getWorkspaceSnippets(): Snippet[] {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];

    const snippetsPath = path.join(root, WORKSPACE_SNIPPETS_FILE);
    if (!fs.existsSync(snippetsPath)) return [];

    try {
      const raw = fs.readFileSync(snippetsPath, 'utf8');
      return JSON.parse(raw) as Snippet[];
    } catch {
      return [];
    }
  }

  async saveWorkspaceSnippets(snippets: Snippet[]): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return;

    const dir = path.join(root, '.wheelhouse');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, 'snippets.json'), JSON.stringify(snippets, null, 2), 'utf8');
  }

  async saveGlobalSnippet(snippet: Snippet): Promise<void> {
    const idx = this.config.globalSnippets.findIndex((s) => s.id === snippet.id);
    if (idx >= 0) {
      this.config.globalSnippets[idx] = snippet;
    } else {
      this.config.globalSnippets.push(snippet);
    }
    await this.save();
  }

  async deleteGlobalSnippet(snippetId: string): Promise<void> {
    this.config.globalSnippets = this.config.globalSnippets.filter((s) => s.id !== snippetId);
    await this.save();
  }

  getAllSnippets(scope: 'workspace' | 'global' | 'both'): Snippet[] {
    const ws = scope !== 'global' ? this.getWorkspaceSnippets() : [];
    const global = scope !== 'workspace' ? this.getGlobalSnippets() : [];
    return [...ws, ...global];
  }

  async updateSettings(settings: Partial<WheelhouseConfig['settings']>): Promise<void> {
    this.config.settings = { ...this.config.settings, ...settings };
    await this.save();
  }

  async exportConfig(): Promise<string> {
    return JSON.stringify(
      {
        ...this.config,
        workspaceSnippets: this.getWorkspaceSnippets(),
      },
      null,
      2
    );
  }

  getDismissedHints(): string[] {
    return this.context.globalState.get<string[]>(HINTS_KEY) ?? [];
  }

  async dismissHint(hintId: string): Promise<void> {
    const current = this.getDismissedHints();
    if (!current.includes(hintId)) {
      await this.context.globalState.update(HINTS_KEY, [...current, hintId]);
    }
  }

  async resetDismissedHints(): Promise<void> {
    await this.context.globalState.update(HINTS_KEY, []);
  }

  getOnboardingFlags(): OnboardingFlags {
    return this.context.globalState.get<OnboardingFlags>(ONBOARDING_KEY) ?? { moment1: false, moment2: false, moment3: false };
  }

  async setOnboardingFlag(moment: keyof OnboardingFlags): Promise<void> {
    const current = this.getOnboardingFlags();
    await this.context.globalState.update(ONBOARDING_KEY, { ...current, [moment]: true });
  }

  async importConfig(json: string): Promise<void> {
    try {
      const imported = JSON.parse(json) as WheelhouseConfig & { workspaceSnippets?: Snippet[] };
      if (imported.workspaceSnippets) {
        await this.saveWorkspaceSnippets(imported.workspaceSnippets);
        delete (imported as unknown as Record<string, unknown>)["workspaceSnippets"];
      }
      this.config = {
        ...DEFAULT_CONFIG,
        ...imported,
        globalSnippets: Array.isArray(imported.globalSnippets) ? [...imported.globalSnippets] : [],
        settings: { ...DEFAULT_CONFIG.settings, ...imported.settings },
      };
      await this.save();
    } catch (err) {
      throw new Error(`Failed to import config: ${String(err)}`);
    }
  }
}
