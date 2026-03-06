import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
    },
  };
});

import fs from 'fs';
import { readEnvFile } from './env.js';

const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockReadFileSync.mockReset();
});

describe('readEnvFile', () => {
  it('returns empty object when .env file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readEnvFile(['FOO'])).toEqual({});
  });

  it('returns empty object when key list is empty', () => {
    mockReadFileSync.mockReturnValue('FOO=bar\n');
    expect(readEnvFile([])).toEqual({});
  });

  it('returns only requested keys', () => {
    mockReadFileSync.mockReturnValue('FOO=foo\nBAR=bar\nBAZ=baz\n');
    expect(readEnvFile(['FOO', 'BAZ'])).toEqual({ FOO: 'foo', BAZ: 'baz' });
  });

  it('parses unquoted values', () => {
    mockReadFileSync.mockReturnValue('KEY=hello\n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'hello' });
  });

  it('strips double quotes from values', () => {
    mockReadFileSync.mockReturnValue('KEY="hello world"\n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'hello world' });
  });

  it('strips single quotes from values', () => {
    mockReadFileSync.mockReturnValue("KEY='hello world'\n");
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'hello world' });
  });

  it('does not strip mismatched quotes', () => {
    mockReadFileSync.mockReturnValue('KEY="mismatch\'\n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: '"mismatch\'' });
  });

  it('skips lines starting with #', () => {
    mockReadFileSync.mockReturnValue('# This is a comment\nKEY=value\n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'value' });
  });

  it('skips blank lines', () => {
    mockReadFileSync.mockReturnValue('\n\nKEY=value\n\n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'value' });
  });

  it('skips lines without = separator', () => {
    mockReadFileSync.mockReturnValue('NOTANASSIGNMENT\nKEY=value\n');
    expect(readEnvFile(['KEY', 'NOTANASSIGNMENT'])).toEqual({ KEY: 'value' });
  });

  it('trims whitespace around key name', () => {
    mockReadFileSync.mockReturnValue('  KEY  =value\n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'value' });
  });

  it('trims whitespace around value', () => {
    mockReadFileSync.mockReturnValue('KEY=  value  \n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'value' });
  });

  it('skips entries with empty value after trimming', () => {
    mockReadFileSync.mockReturnValue('KEY=\n');
    expect(readEnvFile(['KEY'])).toEqual({});
  });

  it('skips entries with whitespace-only value', () => {
    mockReadFileSync.mockReturnValue('KEY=   \n');
    expect(readEnvFile(['KEY'])).toEqual({});
  });

  it('handles = sign in value (takes only first = as separator)', () => {
    mockReadFileSync.mockReturnValue('KEY=a=b=c\n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'a=b=c' });
  });

  it('handles CRLF line endings', () => {
    mockReadFileSync.mockReturnValue('KEY=value\r\n');
    // CRLF: value ends with \r but trimmed
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'value' });
  });

  it('handles file with no trailing newline', () => {
    mockReadFileSync.mockReturnValue('KEY=value');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'value' });
  });

  it('returns multiple keys from same file', () => {
    mockReadFileSync.mockReturnValue('A=1\nB=2\nC=3\n');
    expect(readEnvFile(['A', 'B', 'C'])).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('does not return keys not present in file', () => {
    mockReadFileSync.mockReturnValue('A=1\n');
    const result = readEnvFile(['A', 'MISSING']);
    expect(result).toEqual({ A: '1' });
    expect('MISSING' in result).toBe(false);
  });

  it('inline comment is not stripped (value includes #)', () => {
    // env.ts does not strip inline comments — # mid-line is part of value
    mockReadFileSync.mockReturnValue('KEY=value # comment\n');
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'value # comment' });
  });
});
