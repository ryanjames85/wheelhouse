import { describe, it, expect } from 'vitest';

// Access private helpers via subclass
import { DockerProvider } from '../providers/docker/DockerProvider';

class TestableProvider extends DockerProvider {
  port(p: unknown) { return (this as never as { formatPort(p: unknown): string }).formatPort(p); }
  vol(v: unknown) { return (this as never as { formatVolume(v: unknown): string }).formatVolume(v); }
  svcStatus(s: string) { return (this as never as { parseServiceStatus(s: string): string }).parseServiceStatus(s); }
  ctrState(s: string) { return (this as never as { parseContainerState(s: string): string }).parseContainerState(s); }
}

const p = new TestableProvider();

describe('DockerProvider.formatPort', () => {
  it('passes through string ports', () => {
    expect(p.port('3000:3000')).toBe('3000:3000');
  });

  it('passes through numeric ports', () => {
    expect(p.port(8080)).toBe('8080');
  });

  it('formats object with published and target', () => {
    expect(p.port({ published: 3306, target: 3306 })).toBe('3306');
  });

  it('formats object with different published and target', () => {
    expect(p.port({ published: 8080, target: 80 })).toBe('8080:80');
  });

  it('formats object with only target', () => {
    expect(p.port({ target: 5432 })).toBe('5432');
  });
});

describe('DockerProvider.formatVolume', () => {
  it('passes through string volumes', () => {
    expect(p.vol('./data:/var/lib/mysql')).toBe('./data:/var/lib/mysql');
  });

  it('formats object with source and target', () => {
    expect(p.vol({ source: 'mydata', target: '/var/lib/mysql' })).toBe('mydata:/var/lib/mysql');
  });

  it('formats object with only target (anonymous volume)', () => {
    expect(p.vol({ target: '/var/lib/mysql' })).toBe('/var/lib/mysql');
  });
});

describe('DockerProvider.parseServiceStatus', () => {
  it('returns running for running state', () => {
    expect(p.svcStatus('running')).toBe('running');
  });

  it('returns stopped for empty string (daemon offline)', () => {
    expect(p.svcStatus('')).toBe('stopped');
  });

  it('returns stopped for exited', () => {
    expect(p.svcStatus('exited')).toBe('stopped');
  });

  it('returns restarting', () => {
    expect(p.svcStatus('restarting')).toBe('restarting');
  });

  it('returns unhealthy', () => {
    expect(p.svcStatus('unhealthy')).toBe('unhealthy');
  });

  it('handles mixed case / extra text from compose ps', () => {
    expect(p.svcStatus('running(healthy)')).toBe('running');
  });
});

describe('DockerProvider.parseContainerState', () => {
  it('returns running', () => { expect(p.ctrState('running')).toBe('running'); });
  it('returns restarting', () => { expect(p.ctrState('restarting')).toBe('restarting'); });
  it('returns exited', () => { expect(p.ctrState('exited')).toBe('exited'); });
  it('returns stopped for paused', () => { expect(p.ctrState('paused')).toBe('stopped'); });
  it('returns unknown for unrecognised state', () => { expect(p.ctrState('dead')).toBe('unknown'); });
  it('is case insensitive', () => { expect(p.ctrState('Running')).toBe('running'); });
});
