import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DockerProvider } from '../providers/docker/DockerProvider';
import { DockerCLI } from '../providers/docker/DockerCLI';

const COMPOSE_YAML = `services:
  web:
    image: nginx
    ports:
      - "8080:80"
  db:
    image: postgres
`;

class TestableProvider extends DockerProvider {
  findWorkspaceWithComposePublic() {
    return (this as never as { findWorkspaceWithCompose(): string | undefined }).findWorkspaceWithCompose();
  }
  findComposeDirPublic(root: string) {
    return (this as never as { findComposeDir(root: string): string | undefined }).findComposeDir(root);
  }
  getComposeDirPublic() {
    return (this as unknown as { composeDir: string }).composeDir;
  }
  getStatusPublic() { return this.status; }

  injectState(cli: Partial<DockerCLI>, composeDir = '', status: 'connected' | 'disconnected' | 'error' = 'connected') {
    (this as unknown as { cli: DockerCLI }).cli = cli as DockerCLI;
    (this as unknown as { composeDir: string }).composeDir = composeDir;
    this.status = status;
  }

  async callGetComposeData(tabId = 'compose') {
    return (this as never as { getComposeData(t: string): Promise<unknown> }).getComposeData(tabId);
  }
}

function makeCLI(daemonUp = true): Partial<DockerCLI> {
  return {
    isAvailable: vi.fn().mockResolvedValue(daemonUp),
    getComposeServices: vi.fn().mockResolvedValue([]),
    isPortInUse: vi.fn().mockResolvedValue(false),
    getContainers: vi.fn().mockResolvedValue([]),
    dispose: vi.fn(),
  };
}

function setWorkspace(paths: string[]) {
  (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders =
    paths.map((p) => ({ uri: { fsPath: p }, name: path.basename(p), index: 0 }));
}

function clearWorkspace() {
  (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = undefined;
}

// Each test group that touches the filesystem gets its own temp dir
let tempDir: string;

function setupTempDir() {
  tempDir = mkdtempSync(path.join(tmpdir(), 'wh-test-'));
}

function teardownTempDir() {
  rmSync(tempDir, { recursive: true, force: true });
}

function writeCompose(filename = 'docker-compose.yml', content = COMPOSE_YAML) {
  writeFileSync(path.join(tempDir, filename), content, 'utf8');
}

describe('DockerProvider.findComposeDir', () => {
  let p: TestableProvider;

  beforeEach(() => { setupTempDir(); p = new TestableProvider(); });
  afterEach(() => teardownTempDir());

  it('returns the directory when docker-compose.yml is present', () => {
    writeCompose('docker-compose.yml');
    expect(p.findComposeDirPublic(tempDir)).toBe(tempDir);
  });

  it('returns the directory when compose.yml is present', () => {
    writeCompose('compose.yml');
    expect(p.findComposeDirPublic(tempDir)).toBe(tempDir);
  });

  it('returns the directory when docker-compose.yaml is present', () => {
    writeCompose('docker-compose.yaml');
    expect(p.findComposeDirPublic(tempDir)).toBe(tempDir);
  });

  it('returns the directory when compose.yaml is present', () => {
    writeCompose('compose.yaml');
    expect(p.findComposeDirPublic(tempDir)).toBe(tempDir);
  });

  it('returns undefined when no compose file variant is present', () => {
    expect(p.findComposeDirPublic(tempDir)).toBeUndefined();
  });
});

describe('DockerProvider.findWorkspaceWithCompose', () => {
  let p: TestableProvider;

  beforeEach(() => { setupTempDir(); p = new TestableProvider(); });
  afterEach(() => { teardownTempDir(); clearWorkspace(); });

  it('returns the workspace folder that contains a compose file', () => {
    writeCompose();
    setWorkspace([tempDir]);
    expect(p.findWorkspaceWithComposePublic()).toBe(tempDir);
  });

  it('returns undefined when workspace folders are not set', () => {
    clearWorkspace();
    expect(p.findWorkspaceWithComposePublic()).toBeUndefined();
  });

  it('returns undefined when no workspace folder has a compose file', () => {
    setWorkspace([tempDir]); // tempDir exists but has no compose file
    expect(p.findWorkspaceWithComposePublic()).toBeUndefined();
  });

  it('skips a folder without compose and returns the one that has it', () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'wh-test2-'));
    try {
      writeFileSync(path.join(dir2, 'docker-compose.yml'), COMPOSE_YAML, 'utf8');
      setWorkspace([tempDir, dir2]); // tempDir has no compose, dir2 does
      expect(p.findWorkspaceWithComposePublic()).toBe(dir2);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('returns the first workspace folder when it is the one with a compose file', () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'wh-test2-'));
    try {
      writeCompose(); // compose in tempDir (first)
      setWorkspace([tempDir, dir2]);
      expect(p.findWorkspaceWithComposePublic()).toBe(tempDir);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe('DockerProvider.getComposeData', () => {
  let p: TestableProvider;

  beforeEach(() => { setupTempDir(); vi.resetAllMocks(); p = new TestableProvider(); setWorkspace([tempDir]); });
  afterEach(() => { teardownTempDir(); clearWorkspace(); });

  it('returns "No compose file found" when workspace has no compose file', async () => {
    p.injectState(makeCLI(false));
    const data = await p.callGetComposeData() as { sectionLabel: string };
    expect(data.sectionLabel).toBe('No compose file found in workspace root');
  });

  it('returns services parsed from YAML when daemon is offline', async () => {
    writeCompose();
    p.injectState(makeCLI(false), tempDir);
    const data = await p.callGetComposeData() as { resources: Array<{ name: string }> };
    expect(data.resources.map((r) => r.name)).toEqual(['web', 'db']);
  });

  it('all services show stopped when daemon is offline', async () => {
    writeCompose();
    p.injectState(makeCLI(false), tempDir);
    const data = await p.callGetComposeData() as { resources: Array<{ status: string }> };
    expect(data.resources.every((r) => r.status === 'stopped')).toBe(true);
  });

  it('includes "daemon offline" in sectionLabel when daemon is not available', async () => {
    writeCompose();
    p.injectState(makeCLI(false), tempDir);
    const data = await p.callGetComposeData() as { sectionLabel: string };
    expect(data.sectionLabel).toContain('daemon offline');
  });

  it('does NOT set provider status to error when daemon is offline', async () => {
    writeCompose();
    p.injectState(makeCLI(false), tempDir);
    await p.callGetComposeData();
    expect(p.getStatusPublic()).toBe('connected');
  });

  it('returns live running status when daemon is available', async () => {
    const cli = makeCLI(true);
    (cli.getComposeServices as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'web', state: 'running', image: 'nginx' },
      { name: 'db', state: 'exited', image: 'postgres' },
    ]);
    writeCompose();
    p.injectState(cli, tempDir);
    const data = await p.callGetComposeData() as { resources: Array<{ name: string; status: string }> };
    expect(data.resources.find((r) => r.name === 'web')?.status).toBe('running');
    expect(data.resources.find((r) => r.name === 'db')?.status).toBe('stopped');
  });

  it('service actions are empty when daemon is offline', async () => {
    writeCompose();
    p.injectState(makeCLI(false), tempDir);
    const data = await p.callGetComposeData() as { resources: Array<{ actions: unknown[] }> };
    expect(data.resources.every((r) => r.actions.length === 0)).toBe(true);
  });

  it('discovers composeDir from workspace when it starts empty', async () => {
    writeCompose();
    p.injectState(makeCLI(false), ''); // empty composeDir
    await p.callGetComposeData();
    expect(p.getComposeDirPublic()).toBe(tempDir);
  });
});

describe('DockerProvider status isolation between tabs', () => {
  let p: TestableProvider;

  beforeEach(() => { setupTempDir(); vi.resetAllMocks(); p = new TestableProvider(); setWorkspace([tempDir]); });
  afterEach(() => { teardownTempDir(); clearWorkspace(); });

  it('containers tab sets status to error when daemon is offline', async () => {
    p.injectState(makeCLI(false), tempDir);
    await p.getTabData('containers');
    expect(p.getStatusPublic()).toBe('error');
  });

  it('compose tab does not change status to error when daemon is offline', async () => {
    writeCompose();
    p.injectState(makeCLI(false), tempDir);
    await p.getTabData('compose');
    expect(p.getStatusPublic()).toBe('connected');
  });

  it('compose tab returns services even after containers tab set status to error', async () => {
    writeCompose();
    p.injectState(makeCLI(false), tempDir);

    await p.getTabData('containers');
    expect(p.getStatusPublic()).toBe('error');

    const data = await p.getTabData('compose') as { resources: Array<unknown>; sectionLabel: string };
    expect(data.resources).toHaveLength(2);
    expect(data.sectionLabel).toContain('daemon offline');
    expect(p.getStatusPublic()).toBe('error'); // compose leaves status alone
  });
});
