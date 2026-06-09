/**
 * IProvider.ts
 *
 * Provider interface and BaseProvider base class.
 *
 * IProvider is the contract every provider must implement: connect, disconnect, getTabData, executeAction.
 * BaseProvider supplies the shared fields (id, name, status, config) and a no-op default for executeAction.
 * Adding a new provider means extending BaseProvider and registering it in ProviderRegistry.
 */
import { TabDefinition, ProviderTabData, ProviderStatus, ProviderConfig } from '../../types';

export interface IProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly comingSoon: boolean;
  readonly tabs: TabDefinition[];

  status: ProviderStatus;

  configure(config: ProviderConfig): void;
  connect(): Promise<void>;
  disconnect(): void;
  getTabData(tabId: string): Promise<ProviderTabData>;
  executeAction(tabId: string, resourceId: string, actionId: string): Promise<void>;
  isAvailable(): Promise<boolean>;
  dispose(): void;
}

export abstract class BaseProvider implements IProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly version: string;
  abstract readonly comingSoon: boolean;
  abstract readonly tabs: TabDefinition[];

  status: ProviderStatus = 'disconnected';
  protected config: ProviderConfig = { id: '', enabled: false, settings: {} };

  configure(config: ProviderConfig): void {
    this.config = config;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  abstract getTabData(tabId: string): Promise<ProviderTabData>;
  abstract executeAction(tabId: string, resourceId: string, actionId: string): Promise<void>;
  abstract isAvailable(): Promise<boolean>;

  dispose(): void {
    this.disconnect();
  }
}
