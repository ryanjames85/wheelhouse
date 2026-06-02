import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DockerProvider } from '../providers/docker/DockerProvider';
import { DockerCLI } from '../providers/docker/DockerCLI';

class TestableProvider extends DockerProvider {
  // Named differently to avoid shadowing and infinite recursion
  pub(p: unknown): number | undefined {
    return (this as never as { getPublishedPort(p: unknown): number | undefined }).getPublishedPort(p);
  }

  injectCLI(cli: DockerCLI, composeDir = '/test', daemonAvailable = true) {
    (this as unknown as { cli: DockerCLI }).cli = cli;
    (this as unknown as { composeDir: string }).composeDir = composeDir;
    (this as unknown as { daemonAvailable: boolean }).daemonAvailable = daemonAvailable;
  }
}

function makeMockCLI(): Partial<DockerCLI> & Record<string, ReturnType<typeof vi.fn>> {
  return {
    composeUp: vi.fn().mockResolvedValue(undefined),
    composeDown: vi.fn().mockResolvedValue(undefined),
    composeRestart: vi.fn().mockResolvedValue(undefined),
    composeRestartAll: vi.fn().mockResolvedValue(undefined),
    composeStop: vi.fn().mockResolvedValue(undefined),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    restartContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    removeVolume: vi.fn().mockResolvedValue(undefined),
    removeImage: vi.fn().mockResolvedValue(undefined),
    removeNetwork: vi.fn().mockResolvedValue(undefined),
    pullImage: vi.fn().mockResolvedValue(undefined),
    getOrCreateLogChannel: vi.fn().mockReturnValue({ appendLine: vi.fn(), clear: vi.fn(), show: vi.fn() }),
    streamLogs: vi.fn(),
    openShell: vi.fn(),
    getVolumes: vi.fn().mockResolvedValue([]),
    getContainers: vi.fn().mockResolvedValue([]),
  };
}

describe('DockerProvider.getPublishedPort', () => {
  const p = new TestableProvider();

  it('returns undefined for a port string with no host binding', () => {
    expect(p.pub('80')).toBeUndefined();
  });

  it('extracts host port from "host:container" string', () => {
    expect(p.pub('3306:3306')).toBe(3306);
    expect(p.pub('8080:80')).toBe(8080);
  });

  it('returns the number directly for a bare number', () => {
    expect(p.pub(5432)).toBe(5432);
  });

  it('reads published from an object', () => {
    expect(p.pub({ published: 9200, target: 9200 })).toBe(9200);
  });

  it('returns undefined when object has no published field', () => {
    expect(p.pub({ target: 80 })).toBeUndefined();
  });

  it('returns undefined for unrecognised input', () => {
    expect(p.pub(null)).toBeUndefined();
  });
});

describe('DockerProvider.executeAction', () => {
  let provider: TestableProvider;
  let cli: ReturnType<typeof makeMockCLI>;

  beforeEach(() => {
    provider = new TestableProvider();
    cli = makeMockCLI();
    provider.injectCLI(cli as unknown as DockerCLI);
  });

  describe('compose actions', () => {
    it('up — calls composeUp with serviceId for a specific service', async () => {
      await provider.executeAction('compose', 'web', 'up');
      expect(cli.composeUp).toHaveBeenCalledWith('/test', 'web');
    });

    it('up — calls composeUp with undefined when resourceId is __all__', async () => {
      await provider.executeAction('compose', '__all__', 'up');
      expect(cli.composeUp).toHaveBeenCalledWith('/test', undefined);
    });

    it('down — calls composeDown', async () => {
      await provider.executeAction('compose', '__all__', 'down');
      expect(cli.composeDown).toHaveBeenCalledWith('/test');
    });

    it('restart — calls composeRestart for a specific service', async () => {
      await provider.executeAction('compose', 'db', 'restart');
      expect(cli.composeRestart).toHaveBeenCalledWith('/test', 'db');
    });

    it('restart — calls composeRestartAll when resourceId is __all__', async () => {
      await provider.executeAction('compose', '__all__', 'restart');
      expect(cli.composeRestartAll).toHaveBeenCalledWith('/test');
    });

    it('stop — calls composeStop for compose tab', async () => {
      await provider.executeAction('compose', 'web', 'stop');
      expect(cli.composeStop).toHaveBeenCalledWith('/test', 'web');
    });
  });

  describe('container actions', () => {
    it('start — calls startContainer', async () => {
      await provider.executeAction('containers', 'abc123', 'start');
      expect(cli.startContainer).toHaveBeenCalledWith('abc123');
    });

    it('stop — calls stopContainer (not composeStop) for containers tab', async () => {
      await provider.executeAction('containers', 'abc123', 'stop');
      expect(cli.stopContainer).toHaveBeenCalledWith('abc123');
      expect(cli.composeStop).not.toHaveBeenCalled();
    });

    it('restart — calls restartContainer (not composeRestart) for containers tab', async () => {
      await provider.executeAction('containers', 'abc123', 'restart');
      expect(cli.restartContainer).toHaveBeenCalledWith('abc123');
      expect(cli.composeRestart).not.toHaveBeenCalled();
    });

    it('remove — calls removeContainer for containers tab', async () => {
      await provider.executeAction('containers', 'abc123', 'remove');
      expect(cli.removeContainer).toHaveBeenCalledWith('abc123');
    });

    it('shell — calls openShell', async () => {
      await provider.executeAction('containers', 'abc123', 'shell');
      expect(cli.openShell).toHaveBeenCalledWith('abc123');
    });

    it('pull — calls pullImage', async () => {
      await provider.executeAction('images', 'nginx:latest', 'pull');
      expect(cli.pullImage).toHaveBeenCalledWith('nginx:latest');
    });
  });

  describe('per-tab remove routing', () => {
    it('remove on volumes tab — calls removeVolume', async () => {
      await provider.executeAction('volumes', 'mydata', 'remove');
      expect(cli.removeVolume).toHaveBeenCalledWith('mydata');
      expect(cli.removeContainer).not.toHaveBeenCalled();
    });

    it('remove on images tab — calls removeImage', async () => {
      await provider.executeAction('images', 'sha256:abc', 'remove');
      expect(cli.removeImage).toHaveBeenCalledWith('sha256:abc');
      expect(cli.removeContainer).not.toHaveBeenCalled();
    });

    it('remove on networks tab — calls removeNetwork', async () => {
      await provider.executeAction('networks', 'mynet', 'remove');
      expect(cli.removeNetwork).toHaveBeenCalledWith('mynet');
      expect(cli.removeContainer).not.toHaveBeenCalled();
    });

    it('remove on compose tab — calls removeContainer as fallback', async () => {
      await provider.executeAction('compose', 'web_1', 'remove');
      expect(cli.removeContainer).toHaveBeenCalledWith('web_1');
    });
  });

  describe('logs action', () => {
    it('opens a log channel and streams logs', async () => {
      const fakeChannel = { appendLine: vi.fn(), clear: vi.fn(), show: vi.fn() };
      vi.mocked(cli.getOrCreateLogChannel!).mockReturnValue(fakeChannel as never);
      await provider.executeAction('containers', 'web', 'logs');
      expect(cli.getOrCreateLogChannel).toHaveBeenCalledWith('web');
      expect(cli.streamLogs).toHaveBeenCalledWith('web', fakeChannel, false, '/test');
    });

    it('passes compose=true when tab is compose', async () => {
      const fakeChannel = { appendLine: vi.fn(), clear: vi.fn(), show: vi.fn() };
      vi.mocked(cli.getOrCreateLogChannel!).mockReturnValue(fakeChannel as never);
      await provider.executeAction('compose', 'db', 'logs');
      expect(cli.streamLogs).toHaveBeenCalledWith('db', fakeChannel, true, '/test');
    });
  });
});
