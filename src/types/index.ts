/**
 * types/index.ts
 *
 * Shared TypeScript types for the entire extension.
 *
 * Covers: provider status and config, tab definitions, resources and their actions,
 * profiles, snippets, webview message shapes, and the top-level WheelhouseConfig.
 * Everything is exported from here — no other types file.
 */
export type ProviderStatus = 'connected' | 'disconnected' | 'error' | 'coming_soon';
export type ResourceStatus = 'running' | 'stopped' | 'restarting' | 'unhealthy' | 'unknown' | 'exited' | 'orphaned' | 'in_use';
export type SnippetScope = 'workspace' | 'global';
export type SnippetRunMode = 'terminal' | 'clipboard' | 'shell';
export type ProfileActivation = 'always' | 'compose_file' | 'kubeconfig' | 'never';

export interface WheelhouseConfig {
  profiles: Profile[];
  activeProfileId: string;
  globalSnippets: Snippet[];
  settings: GlobalSettings;
}

export interface Profile {
  id: string;
  name: string;
  colour: string;
  providers: ProviderConfig[];
  visibleTabs: string[];
  activation: ProfileActivation;
  activationFile?: string;
  refreshInterval: number;
  snippetScope: 'workspace' | 'global' | 'both';
  snippetRunMode: SnippetRunMode;
}

export interface ProviderConfig {
  id: string;
  enabled: boolean;
  settings: Record<string, string>;
}

export interface GlobalSettings {
  alwaysShowActions: boolean;
  showTabBadges: boolean;
  showUptime: boolean;
  showImageTag: boolean;
  confirmBeforeRemove: boolean;
  confirmBeforePrune: boolean;
  confirmComposeDown: boolean;
  proactiveHintsEnabled: boolean;
  checkPortConflicts: boolean;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  icon: string;
  scope: SnippetScope;
  runMode: SnippetRunMode;
  providerId?: string;
}

export interface TabDefinition {
  id: string;
  label: string;
  icon: string;
  providerId: string;
  order: number;
}

export interface ResourceAction {
  id: string;
  label: string;
  icon: string;
  command: string;
  dangerous?: boolean;
  condition?: (status: ResourceStatus) => boolean;
}

export interface Resource {
  id: string;
  name: string;
  status: ResourceStatus;
  meta: Record<string, string>;
  actions: ResourceAction[];
  children?: ResourceChild[];
}

export interface ResourceChild {
  label: string;
  value: string;
  type: 'ok' | 'warn' | 'err' | 'dim';
}

export interface ProviderTabData {
  tabId: string;
  badge?: number;
  badgeType?: 'ok' | 'warn' | 'neutral';
  resources: Resource[];
  sectionLabel?: string;
  v1Syntax?: boolean;
  missingEnvFile?: boolean;
}

export interface WebviewMessage {
  type: string;
  payload?: unknown;
}

export const DEFAULT_PROFILE: Profile = {
  id: 'default',
  name: 'Default',
  colour: '#378add',
  providers: [
    { id: 'docker',     enabled: true,  settings: {} },
    { id: 'kubernetes', enabled: false, settings: { namespace: 'default' } },
  ],
  visibleTabs: ['compose', 'containers', 'images', 'volumes', 'networks', 'snippets'],
  activation: 'always',
  refreshInterval: 5000,
  snippetScope: 'both',
  snippetRunMode: 'terminal',
};

export const DEFAULT_SETTINGS: GlobalSettings = {
  alwaysShowActions: true,
  showTabBadges: true,
  showUptime: true,
  showImageTag: false,
  confirmBeforeRemove: true,
  confirmBeforePrune: true,
  confirmComposeDown: true,
  proactiveHintsEnabled: true,
  checkPortConflicts: true,
};

export const DEFAULT_CONFIG: WheelhouseConfig = {
  profiles: [DEFAULT_PROFILE],
  activeProfileId: 'default',
  globalSnippets: [],
  settings: DEFAULT_SETTINGS,
};
