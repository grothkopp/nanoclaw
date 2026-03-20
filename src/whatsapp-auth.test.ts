import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock fs for config file reads and migration
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      rmdirSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

import {
  resolveInstanceName,
  getAuthDir,
  getStatusFile,
  getQrFile,
  getPairingCodeFile,
  migrateAuthDir,
} from './whatsapp-auth-utils.js';

// --- resolveInstanceName ---

describe('resolveInstanceName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns --instance value when provided', () => {
    const result = resolveInstanceName([
      'node',
      'script.js',
      '--instance',
      'work',
    ]);
    expect(result).toBe('work');
  });

  it('falls back to first configured instance from whatsapp-instances.json', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([{ name: 'personal' }, { name: 'work' }]),
    );

    const result = resolveInstanceName(['node', 'script.js']);
    expect(result).toBe('personal');
  });

  it('returns "default" when no --instance and no config', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = resolveInstanceName(['node', 'script.js']);
    expect(result).toBe('default');
  });

  it('returns "default" when config is malformed', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not json');
    const result = resolveInstanceName(['node', 'script.js']);
    expect(result).toBe('default');
  });

  it('returns "default" when config is empty array', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('[]');
    const result = resolveInstanceName(['node', 'script.js']);
    expect(result).toBe('default');
  });

  it('ignores --instance when no value follows', () => {
    const result = resolveInstanceName(['node', 'script.js', '--instance']);
    // No value after --instance, falls back to config or default
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(resolveInstanceName(['node', 'script.js', '--instance'])).toBe(
      'default',
    );
  });
});

// --- Path helpers ---

describe('path helpers', () => {
  it('getAuthDir returns store/auth/{instance}', () => {
    expect(getAuthDir('personal')).toBe(path.join('store', 'auth', 'personal'));
  });

  it('getStatusFile returns file inside auth dir', () => {
    expect(getStatusFile('work')).toBe(
      path.join('store', 'auth', 'work', 'auth-status.txt'),
    );
  });

  it('getQrFile returns file inside auth dir', () => {
    expect(getQrFile('work')).toBe(
      path.join('store', 'auth', 'work', 'qr-data.txt'),
    );
  });

  it('getPairingCodeFile returns file inside auth dir', () => {
    expect(getPairingCodeFile('work')).toBe(
      path.join('store', 'auth', 'work', 'pairing-code.txt'),
    );
  });
});

// --- migrateAuthDir ---

describe('migrateAuthDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('migrates legacy layout when creds.json is in store/auth/', () => {
    // creds.json exists at store/auth/creds.json (legacy)
    // target dir store/auth/personal/ does NOT exist
    vi.mocked(fs.existsSync)
      .mockReturnValueOnce(true) // store/auth/creds.json
      .mockReturnValueOnce(false) // store/auth/personal/
      .mockReturnValueOnce(false); // stale file checks

    vi.mocked(fs.readdirSync)
      .mockReturnValueOnce(['creds.json', 'keys.json'] as any) // files to move
      .mockReturnValueOnce([] as any); // stale store/ scan

    migrateAuthDir('personal');

    expect(fs.renameSync).toHaveBeenCalled();
    expect(fs.mkdirSync).toHaveBeenCalled();
  });

  it('skips migration when target dir already exists', () => {
    vi.mocked(fs.existsSync)
      .mockReturnValueOnce(true) // creds.json exists
      .mockReturnValueOnce(true); // target dir already exists

    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    migrateAuthDir('personal');

    // Should not rename (migration already done)
    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    expect(renameCalls.length).toBe(0);
  });

  it('skips migration when no legacy creds.json', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    migrateAuthDir('personal');

    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('cleans up stale root-level status files', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([
      'auth-status.txt',
      'auth-status-auth.txt',
      'qr-data-auth.txt',
      'pairing-code.txt',
      'messages.db',
    ] as any);

    migrateAuthDir('personal');

    // Should try to unlink stale files but not messages.db
    const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.map((c) => c[0]);
    expect(unlinkCalls).toContain('store/auth-status.txt');
    expect(unlinkCalls).toContain('store/pairing-code.txt');
    expect(
      unlinkCalls.some((f) => String(f).includes('auth-status-auth')),
    ).toBe(true);
    expect(unlinkCalls.some((f) => String(f).includes('messages.db'))).toBe(
      false,
    );
  });
});
