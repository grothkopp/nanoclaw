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
      renameSync: vi.fn(),
      rmSync: vi.fn(),
    },
  };
});

vi.mock('./config.js', () => ({
  DATA_DIR: '/data',
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  resolveSecretFile,
  readSecretFile,
  getInstanceSkillsDir,
  getInstanceCommandsDir,
  instanceNameFromJid,
  migrateDataFiles,
} from './instance-data.js';

describe('resolveSecretFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns instance-specific path when it exists', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'personal', 'secrets', 'github-token'),
    );
    expect(resolveSecretFile('personal', 'github-token')).toBe(
      path.join('/data', 'personal', 'secrets', 'github-token'),
    );
  });

  it('falls back to global secrets path', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'secrets', 'github-token'),
    );
    expect(resolveSecretFile('personal', 'github-token')).toBe(
      path.join('/data', 'secrets', 'github-token'),
    );
  });

  it('returns null when neither exists', () => {
    expect(resolveSecretFile('personal', 'github-token')).toBeNull();
  });

  it('skips instance check when instanceName is undefined', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'secrets', 'ha-token'),
    );
    expect(resolveSecretFile(undefined, 'ha-token')).toBe(
      path.join('/data', 'secrets', 'ha-token'),
    );
  });
});

describe('readSecretFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('reads and trims file content', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'work', 'secrets', 'groq-token'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue('  tok123\n  ');
    expect(readSecretFile('work', 'groq-token')).toBe('tok123');
  });

  it('returns null when file not found', () => {
    expect(readSecretFile('work', 'groq-token')).toBeNull();
  });
});

describe('getInstanceSkillsDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns skills dir when it exists', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'personal', 'skills'),
    );
    expect(getInstanceSkillsDir('personal')).toBe(
      path.join('/data', 'personal', 'skills'),
    );
  });

  it('returns undefined when dir does not exist', () => {
    expect(getInstanceSkillsDir('personal')).toBeUndefined();
  });

  it('returns undefined when instanceName is undefined', () => {
    expect(getInstanceSkillsDir(undefined)).toBeUndefined();
  });
});

describe('getInstanceCommandsDir', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns commands dir when it exists', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join('/data', 'work', 'commands'),
    );
    expect(getInstanceCommandsDir('work')).toBe(
      path.join('/data', 'work', 'commands'),
    );
  });

  it('returns undefined when dir does not exist', () => {
    expect(getInstanceCommandsDir('work')).toBeUndefined();
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('moves global secrets from data/ to data/secrets/', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === path.join('/data', 'github-token')) return true;
      if (s === path.join('/data', 'ha-token')) return true;
      return false;
    });

    migrateDataFiles('personal');

    expect(fs.renameSync).toHaveBeenCalledWith(
      path.join('/data', 'github-token'),
      path.join('/data', 'secrets', 'github-token'),
    );
    expect(fs.renameSync).toHaveBeenCalledWith(
      path.join('/data', 'ha-token'),
      path.join('/data', 'secrets', 'ha-token'),
    );
  });

  it('moves instance secrets from data/{inst}/ to data/{inst}/secrets/', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === path.join('/data', 'personal')) return true;
      if (s === path.join('/data', 'personal', 'groq-token')) return true;
      return false;
    });

    migrateDataFiles('personal');

    expect(fs.renameSync).toHaveBeenCalledWith(
      path.join('/data', 'personal', 'groq-token'),
      path.join('/data', 'personal', 'secrets', 'groq-token'),
    );
  });

  it('copies global secrets to instance when instance secrets dir missing', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s === path.join('/data', 'secrets')) return true;
      if (s === path.join('/data', 'secrets', 'github-token')) return true;
      if (s === path.join('/data', 'personal')) return true;
      return false;
    });

    migrateDataFiles('personal');

    expect(fs.copyFileSync).toHaveBeenCalledWith(
      path.join('/data', 'secrets', 'github-token'),
      path.join('/data', 'personal', 'secrets', 'github-token'),
    );
  });

  it('cleans up stale data/env directory', () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === path.join('/data', 'env'),
    );

    migrateDataFiles('personal');

    expect(fs.rmSync).toHaveBeenCalledWith(path.join('/data', 'env'), {
      recursive: true,
      force: true,
    });
  });
});
