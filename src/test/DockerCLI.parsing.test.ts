import { describe, it, expect } from 'vitest';

// Test parseJsonOutput and field logic by subclassing DockerCLI
// and exposing the private methods.
import { DockerCLI } from '../providers/docker/DockerCLI';

class TestableCLI extends DockerCLI {
  parseJson(output: string) { return (this as never as { parseJsonOutput(o: string): unknown[] }).parseJsonOutput(output); }
  getField(e: Record<string, unknown>, ...keys: string[]) { return (this as never as { field(e: Record<string, unknown>, ...k: string[]): string }).field(e, ...keys); }
}

const cli = new TestableCLI();

describe('DockerCLI.parseJsonOutput', () => {
  it('returns empty array for empty string', () => {
    expect(cli.parseJson('')).toEqual([]);
  });

  it('parses a JSON array', () => {
    const input = JSON.stringify([{ ID: 'abc', Names: 'web' }]);
    const result = cli.parseJson(input);
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, string>).ID).toBe('abc');
  });

  it('parses newline-delimited JSON (NDJSON)', () => {
    const input = `{"ID":"a","Names":"web"}\n{"ID":"b","Names":"db"}`;
    const result = cli.parseJson(input);
    expect(result).toHaveLength(2);
  });

  it('skips malformed NDJSON lines', () => {
    const input = `{"ID":"a"}\nnot json\n{"ID":"b"}`;
    expect(cli.parseJson(input)).toHaveLength(2);
  });

  it('handles NDJSON with leading/trailing whitespace', () => {
    const input = `  {"ID":"a"}  \n  {"ID":"b"}  `;
    expect(cli.parseJson(input)).toHaveLength(2);
  });

  it('falls through to NDJSON when JSON array parse fails', () => {
    // Starts with [ but is malformed as array — not valid JSON
    const input = `[broken\n{"ID":"a"}`;
    expect(cli.parseJson(input)).toHaveLength(1);
  });

  it('returns empty for whitespace-only input', () => {
    expect(cli.parseJson('   \n  ')).toEqual([]);
  });
});

describe('DockerCLI.field', () => {
  it('returns first matching key', () => {
    expect(cli.getField({ ID: 'abc123' }, 'ID', 'Id', 'id')).toBe('abc123');
  });

  it('tries keys in order', () => {
    expect(cli.getField({ id: 'lower' }, 'ID', 'Id', 'id')).toBe('lower');
  });

  it('returns empty string when no key matches', () => {
    expect(cli.getField({ foo: 'bar' }, 'ID', 'Id')).toBe('');
  });

  it('skips null values and tries next key', () => {
    expect(cli.getField({ ID: null, id: 'fallback' } as never, 'ID', 'id')).toBe('fallback');
  });

  it('skips undefined values and tries next key', () => {
    expect(cli.getField({ id: 'found' }, 'ID', 'id')).toBe('found');
  });

  it('coerces numbers to string', () => {
    expect(cli.getField({ ID: 42 } as never, 'ID')).toBe('42');
  });
});

describe('DockerCLI.getContainers (field normalization)', () => {
  it('normalises PascalCase container fields', () => {
    const rows = cli.parseJson(JSON.stringify([{
      ID: 'abc123def456',
      Names: '/web,/web_alt',
      Image: 'nginx:latest',
      Status: 'Up 2 hours',
      State: 'running',
      Ports: '0.0.0.0:80->80/tcp',
      CreatedAt: '2024-01-01',
      Mounts: 'data',
    }]));
    // Simulate what getContainers does with field()
    const e = rows[0] as Record<string, unknown>;
    const name = cli.getField(e, 'Names', 'Name', 'name').replace(/^\//, '').split(',')[0];
    expect(name).toBe('web');
    expect(cli.getField(e, 'ID', 'Id', 'id')).toBe('abc123def456');
  });

  it('normalises camelCase container fields', () => {
    const rows = cli.parseJson(JSON.stringify([{
      id: 'aabbcc',
      name: 'mycontainer',
      image: 'redis',
      status: 'Up',
      state: 'running',
      ports: '',
      created: '2024-01-01',
      mounts: '',
    }]));
    const e = rows[0] as Record<string, unknown>;
    expect(cli.getField(e, 'ID', 'Id', 'id')).toBe('aabbcc');
    expect(cli.getField(e, 'Names', 'Name', 'name')).toBe('mycontainer');
  });
});
