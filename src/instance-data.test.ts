import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
      rmSync: vi.fn(),
    },
  };
});

vi.mock('./config.js', () => ({
  DATA_DIR: '/data',
}));

import {
  resolveDataFile,
  readDataFile,
  instanceNameFromJid,
  migrateDataFiles,
} from './instance-data.js';

describe('resolveDataFile', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(fs.existsSync).mockReturnValue(false); });

  it('returns instance-specific path when it exists', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'personal', 'github-token'),
    );
    expect(resolveDataFile('personal', 'github-token')).toBe(
      path.join('/data', 'personal', 'github-token'),
    );
  });

  it('falls back to global path when instance file missing', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'github-token'),
    );
    expect(resolveDataFile('personal', 'github-token')).toBe(
      path.join('/data', 'github-token'),
    );
  });

  it('returns null when neither exists', () => {
    expect(resolveDataFile('personal', 'github-token')).toBeNull();
  });

  it('skips instance check when instanceName is undefined', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'ha-token'),
    );
    expect(resolveDataFile(undefined, 'ha-token')).toBe(
      path.join('/data', 'ha-token'),
    );
  });
});

describe('readDataFile', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(fs.existsSync).mockReturnValue(false); });

  it('reads and trims file content from instance path', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'work', 'groq-token'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('  tok123\n  ');
    expect(readDataFile('work', 'groq-token')).toBe('tok123');
  });

  it('returns null when file not found', () => {
    expect(readDataFile('work', 'groq-token')).toBeNull();
  });
});

describe('instanceNameFromJid', () => {
  it('extracts from WhatsApp JID', () => {
    expect(instanceNameFromJid('wa:personal:123@g.us')).toBe('personal');
  });

  it('extracts from Slack JID', () => {
    expect(instanceNameFromJid('slack:xsg:C123')).toBe('xsg');
  });

  it('returns undefined for legacy bare JID', () => {
    expect(instanceNameFromJid('123@g.us')).toBeUndefined();
  });

  it('returns undefined for unknown format', () => {
    expect(instanceNameFromJid('tg:123')).toBeUndefined();
  });
});

describe('migrateDataFiles', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(fs.existsSync).mockReturnValue(false); });

  it('copies credential files to instance dir on first run', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      // Instance dir does NOT exist yet
      if (s === path.join('/data', 'personal')) return false;
      // Global files exist
      if (s === path.join('/data', 'github-token')) return true;
      if (s === path.join('/data', 'ha-token')) return true;
      // Destination files don't exist
      if (s.startsWith(path.join('/data', 'personal'))) return false;
      // No stale env dir
      return false;
    });

    migrateDataFiles('personal');

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.join('/data', 'personal'),
      { recursive: true },
    );
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      path.join('/data', 'github-token'),
      path.join('/data', 'personal', 'github-token'),
    );
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      path.join('/data', 'ha-token'),
      path.join('/data', 'personal', 'ha-token'),
    );
  });

  it('skips migration when instance dir already exists', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === path.join('/data', 'personal'),
    );

    migrateDataFiles('personal');

    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.copyFileSync).not.toHaveBeenCalled();
  });

  it('skips migration when no global credential files exist', () => {
    migrateDataFiles('personal');
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it('cleans up stale data/env directory', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === path.join('/data', 'personal')) return false;
      if (s === path.join('/data', 'github-token')) return true;
      if (s === path.join('/data', 'env')) return true;
      return false;
    });

    migrateDataFiles('personal');

    expect(fs.rmSync).toHaveBeenCalledWith(path.join('/data', 'env'), {
      recursive: true,
      force: true,
    });
  });
});
