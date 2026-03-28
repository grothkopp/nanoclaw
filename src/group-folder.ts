import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

// Cache singleGroupDir lookups
const singleGroupDirCache = new Map<string, string | undefined>();

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

/**
 * Look up singleGroupDir for an instance from whatsapp/slack instance configs.
 */
function getSingleGroupDir(instanceName: string): string | undefined {
  if (singleGroupDirCache.has(instanceName)) {
    return singleGroupDirCache.get(instanceName);
  }

  let result: string | undefined;
  for (const configFile of [
    'whatsapp-instances.json',
    'slack-instances.json',
    'teams-instances.json',
  ]) {
    const configPath = path.join(DATA_DIR, configFile);
    if (!fs.existsSync(configPath)) continue;
    try {
      const instances = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(instances)) {
        const inst = instances.find(
          (i: { name?: string }) => i.name === instanceName,
        );
        if (inst?.singleGroupDir) {
          result = path.resolve(inst.singleGroupDir);
          break;
        }
      }
    } catch {
      /* ignore parse errors */
    }
  }

  singleGroupDirCache.set(instanceName, result);
  return result;
}

/** Clear cache (for testing). */
export function _clearGroupDirCache(): void {
  singleGroupDirCache.clear();
}

/**
 * Resolve the group folder path.
 *
 * If the group's instance has singleGroupDir configured, returns that path
 * (all groups in the instance share it). Otherwise returns groups/{folder}.
 */
export function resolveGroupFolderPath(
  folder: string,
  instanceName?: string,
): string {
  assertValidGroupFolder(folder);

  if (instanceName) {
    const singleDir = getSingleGroupDir(instanceName);
    if (singleDir) {
      return singleDir;
    }
  }

  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

/**
 * Migrate group folders to instance-prefixed names.
 * Renames directories in groups/, data/sessions/, data/ipc/ and
 * updates DB records (registered_groups, scheduled_tasks, sessions).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrateGroupFolders(instanceName: string, db: any): void {
  const prefix = `${instanceName}-`;

  // Find folders that need migration (unprefixed folders belonging to this instance)
  const groups = db
    .prepare(
      `SELECT jid, folder FROM registered_groups WHERE folder NOT LIKE '${prefix}%'`,
    )
    .all() as Array<{ jid: string; folder: string }>;

  // Filter to groups that belong to this instance (by JID prefix)
  const instanceJidPrefixes = [
    `wa:${instanceName}:`,
    `slack:${instanceName}:`,
    `teams:${instanceName}:`,
  ];
  const toMigrate = (groups as Array<{ jid: string; folder: string }>).filter(
    (g) => instanceJidPrefixes.some((p) => g.jid.startsWith(p)),
  );

  if (toMigrate.length === 0) return;

  const txn = db.transaction(() => {
    db.prepare('PRAGMA foreign_keys = OFF').run();

    for (const { folder } of toMigrate) {
      const newFolder = `${prefix}${folder}`;

      // Update DB tables
      db.prepare(
        'UPDATE registered_groups SET folder = ? WHERE folder = ?',
      ).run(newFolder, folder);
      db.prepare(
        'UPDATE scheduled_tasks SET group_folder = ? WHERE group_folder = ?',
      ).run(newFolder, folder);
      db.prepare(
        'UPDATE sessions SET group_folder = ? WHERE group_folder = ?',
      ).run(newFolder, folder);

      // Rename filesystem directories
      for (const baseDir of [
        GROUPS_DIR,
        path.join(DATA_DIR, 'sessions'),
        path.join(DATA_DIR, 'ipc'),
      ]) {
        const oldPath = path.join(baseDir, folder);
        const newPath = path.join(baseDir, newFolder);
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
          fs.renameSync(oldPath, newPath);
        }
      }
    }

    db.prepare('PRAGMA foreign_keys = ON').run();
  });

  txn();

  logger.info(
    {
      instanceName,
      migrated: toMigrate.map((g) => `${g.folder} → ${prefix}${g.folder}`),
    },
    'Migrated group folders to instance-prefixed names',
  );
}
