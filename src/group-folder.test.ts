import path from 'path';

import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
  _clearGroupDirCache,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
    expect(isValidGroupFolder('personal-whatsapp_main')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });
});

describe('singleGroupDir', () => {
  beforeEach(() => _clearGroupDirCache());

  it('returns normal path when no singleGroupDir configured', () => {
    const resolved = resolveGroupFolderPath('personal-chat', 'personal');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}personal-chat`)).toBe(
      true,
    );
  });

  it('ignores instanceName for path when not configured', () => {
    const withInstance = resolveGroupFolderPath('personal-chat', 'personal');
    const without = resolveGroupFolderPath('personal-chat');
    expect(withInstance).toBe(without);
  });
});
