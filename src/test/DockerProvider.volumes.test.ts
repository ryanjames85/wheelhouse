import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DockerProvider } from '../providers/docker/DockerProvider';
import { DockerCLI } from '../providers/docker/DockerCLI';
import { VolumeInfo, ContainerInfo } from '../providers/docker/DockerCLI';

class TestableProvider extends DockerProvider {
  injectCLI(cli: DockerCLI, composeDir = '/test', daemonAvailable = true) {
    (this as unknown as { cli: DockerCLI }).cli = cli;
    (this as unknown as { composeDir: string }).composeDir = composeDir;
    (this as unknown as { daemonAvailable: boolean }).daemonAvailable = daemonAvailable;
  }

  getVolumes(tabId: string) {
    return (this as never as { getVolumesData(t: string): Promise<unknown> }).getVolumesData(tabId);
  }
}

function makeVolume(name: string, driver = 'local', mountpoint = ''): VolumeInfo {
  return { name, driver, mountpoint };
}

function makeContainer(name: string, mounts: string): ContainerInfo {
  return { id: name, name, image: '', status: 'running', state: 'running', ports: '', created: '', mounts };
}

describe('DockerProvider volume orphan detection', () => {
  let provider: TestableProvider;
  let mockCLI: Partial<DockerCLI>;

  beforeEach(() => {
    provider = new TestableProvider();
    mockCLI = {
      getVolumes: vi.fn(),
      getContainers: vi.fn(),
    };
    provider.injectCLI(mockCLI as unknown as DockerCLI);
  });

  it('marks volumes that appear in container mounts as in_use', async () => {
    vi.mocked(mockCLI.getVolumes!).mockResolvedValue([makeVolume('mydata')]);
    vi.mocked(mockCLI.getContainers!).mockResolvedValue([makeContainer('web', 'mydata')]);

    const data = await provider.getVolumes('volumes') as { resources: Array<{ status: string }> };
    expect(data.resources[0].status).toBe('in_use');
  });

  it('marks volumes not in any container mounts as orphaned', async () => {
    vi.mocked(mockCLI.getVolumes!).mockResolvedValue([makeVolume('unused')]);
    vi.mocked(mockCLI.getContainers!).mockResolvedValue([makeContainer('web', 'mydata')]);

    const data = await provider.getVolumes('volumes') as { resources: Array<{ status: string }> };
    expect(data.resources[0].status).toBe('orphaned');
  });

  it('handles multiple comma-separated mounts per container', async () => {
    vi.mocked(mockCLI.getVolumes!).mockResolvedValue([
      makeVolume('db-data'),
      makeVolume('redis-data'),
      makeVolume('unused'),
    ]);
    vi.mocked(mockCLI.getContainers!).mockResolvedValue([
      makeContainer('app', 'db-data,redis-data'),
    ]);

    const data = await provider.getVolumes('volumes') as { resources: Array<{ name: string; status: string }> };
    const byName = Object.fromEntries(data.resources.map(r => [r.name, r.status]));
    expect(byName['db-data']).toBe('in_use');
    expect(byName['redis-data']).toBe('in_use');
    expect(byName['unused']).toBe('orphaned');
  });

  it('handles mounts with whitespace around commas', async () => {
    vi.mocked(mockCLI.getVolumes!).mockResolvedValue([makeVolume('mydata')]);
    vi.mocked(mockCLI.getContainers!).mockResolvedValue([
      makeContainer('web', ' mydata , othervol '),
    ]);

    const data = await provider.getVolumes('volumes') as { resources: Array<{ status: string }> };
    expect(data.resources[0].status).toBe('in_use');
  });

  it('returns empty resources when there are no volumes', async () => {
    vi.mocked(mockCLI.getVolumes!).mockResolvedValue([]);
    vi.mocked(mockCLI.getContainers!).mockResolvedValue([]);

    const data = await provider.getVolumes('volumes') as { resources: unknown[]; sectionLabel: string };
    expect(data.resources).toHaveLength(0);
    expect(data.sectionLabel).toContain('0 volumes');
  });

  it('counts orphaned volumes in the badge and sectionLabel', async () => {
    vi.mocked(mockCLI.getVolumes!).mockResolvedValue([makeVolume('a'), makeVolume('b'), makeVolume('c')]);
    vi.mocked(mockCLI.getContainers!).mockResolvedValue([makeContainer('web', 'a')]);

    const data = await provider.getVolumes('volumes') as { badge: number; badgeType: string; sectionLabel: string };
    expect(data.badge).toBe(2);
    expect(data.badgeType).toBe('warn');
    expect(data.sectionLabel).toContain('2 orphaned');
  });

  it('uses neutral badge when no volumes are orphaned', async () => {
    vi.mocked(mockCLI.getVolumes!).mockResolvedValue([makeVolume('a')]);
    vi.mocked(mockCLI.getContainers!).mockResolvedValue([makeContainer('web', 'a')]);

    const data = await provider.getVolumes('volumes') as { badge: number; badgeType: string };
    expect(data.badgeType).toBe('neutral');
    expect(data.badge).toBe(1);
  });
});
