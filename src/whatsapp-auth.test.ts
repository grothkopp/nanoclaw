import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// Mock fs for config file reads
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
    },
  };
});

// Import from the utils module (not whatsapp-auth.ts which calls
// authenticate() at module level and would try to connect to WhatsApp)
import { resolveAuthDir } from './whatsapp-auth-utils.js';

describe('resolveAuthDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns "auth" when no flags are provided', () => {
    const result = resolveAuthDir(['node', 'script.js']);
    expect(result).toBe('auth');
  });

  it('returns explicit --auth-dir value', () => {
    const result = resolveAuthDir([
      'node',
      'script.js',
      '--auth-dir',
      'auth-work',
    ]);
    expect(result).toBe('auth-work');
  });

  it('--auth-dir takes precedence over --instance', () => {
    const result = resolveAuthDir([
      'node',
      'script.js',
      '--instance',
      'personal',
      '--auth-dir',
      'custom-dir',
    ]);
    expect(result).toBe('custom-dir');
  });

  it('looks up authDir from whatsapp-instances.json for --instance', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        { name: 'personal', authDir: 'auth' },
        { name: 'work', authDir: 'auth-work-custom' },
      ]),
    );

    const result = resolveAuthDir([
      'node',
      'script.js',
      '--instance',
      'work',
    ]);
    expect(result).toBe('auth-work-custom');
  });

  it('falls back to auth-{instance} when instance not in config', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([{ name: 'personal', authDir: 'auth' }]),
    );

    const result = resolveAuthDir([
      'node',
      'script.js',
      '--instance',
      'unknown',
    ]);
    expect(result).toBe('auth-unknown');
  });

  it('falls back to auth-{instance} when config file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = resolveAuthDir([
      'node',
      'script.js',
      '--instance',
      'work',
    ]);
    expect(result).toBe('auth-work');
  });

  it('falls back to auth-{instance} when config file is malformed', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not json');

    const result = resolveAuthDir([
      'node',
      'script.js',
      '--instance',
      'work',
    ]);
    expect(result).toBe('auth-work');
  });

  it('uses default auth-{instance} when instance has no authDir field', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([{ name: 'minimal' }]),
    );

    const result = resolveAuthDir([
      'node',
      'script.js',
      '--instance',
      'minimal',
    ]);
    expect(result).toBe('auth-minimal');
  });

  it('ignores --instance when no value follows', () => {
    const result = resolveAuthDir(['node', 'script.js', '--instance']);
    expect(result).toBe('auth');
  });

  it('ignores --auth-dir when no value follows', () => {
    const result = resolveAuthDir(['node', 'script.js', '--auth-dir']);
    expect(result).toBe('auth');
  });
});
