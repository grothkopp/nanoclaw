/**
 * Per-instance data file resolution.
 *
 * Directory layout:
 *   data/secrets/              — global fallback credentials
 *   data/{instance}/secrets/   — per-instance credentials (checked first)
 *   data/{instance}/skills/    — per-instance skills overlay
 *   data/{instance}/commands/  — per-instance slash commands
 *
 * Legacy layout (migrated automatically):
 *   data/github-token          → data/secrets/github-token
 *   data/{instance}/ha-token   → data/{instance}/secrets/ha-token
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const SECRET_FILES = [
  'github-token',
  'groq-token',
  'gws-credentials.json',
  'ha-token',
];

/**
 * Resolve a secret file path, checking per-instance override first.
 * Lookup order: data/{instance}/secrets/{file} > data/secrets/{file}
 * Returns the full path or null.
 */
export function resolveSecretFile(
  instanceName: string | undefined,
  filename: string,
): string | null {
  if (instanceName) {
    const instancePath = path.join(DATA_DIR, instanceName, 'secrets', filename);
    if (fs.existsSync(instancePath)) return instancePath;
  }
  const globalPath = path.join(DATA_DIR, 'secrets', filename);
  if (fs.existsSync(globalPath)) return globalPath;
  return null;
}

/**
 * Read a secret file as trimmed string, checking per-instance override first.
 * Returns null if the file doesn't exist in either location.
 */
export function readSecretFile(
  instanceName: string | undefined,
  filename: string,
): string | null {
  const filePath = resolveSecretFile(instanceName, filename);
  if (!filePath) return null;
  return fs.readFileSync(filePath, 'utf-8').trim();
}

/**
 * Get the skills directory for an instance.
 * Returns data/{instance}/skills/ if it exists, otherwise undefined.
 */
export function getInstanceSkillsDir(
  instanceName: string | undefined,
): string | undefined {
  if (!instanceName) return undefined;
  const dir = path.join(DATA_DIR, instanceName, 'skills');
  return fs.existsSync(dir) ? dir : undefined;
}

/**
 * Get the commands directory for an instance.
 * Returns data/{instance}/commands/ if it exists, otherwise undefined.
 */
export function getInstanceCommandsDir(
  instanceName: string | undefined,
): string | undefined {
  if (!instanceName) return undefined;
  const dir = path.join(DATA_DIR, instanceName, 'commands');
  return fs.existsSync(dir) ? dir : undefined;
}

/**
 * Extract instance name from a JID.
 * "wa:personal:number@g.us" → "personal"
 * "slack:xsg:C123" → "xsg"
 * "legacy@g.us" → undefined
 */
export function instanceNameFromJid(jid: string): string | undefined {
  const match = jid.match(/^(?:wa|slack|teams):([^:]+):/);
  return match?.[1];
}

/**
 * Move a file if source exists and destination doesn't.
 */
function moveFile(src: string, dst: string): boolean {
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return true;
  }
  return false;
}

/**
 * Migrate data files to the new layout with secrets/ subdirectories.
 *
 * Phase 1: Global secrets — data/{file} → data/secrets/{file}
 * Phase 2: Instance secrets — data/{instance}/{file} → data/{instance}/secrets/{file}
 * Phase 3: If no instance dir exists, copy global secrets into it
 * Phase 4: Clean up stale data/env directory
 */
export function migrateDataFiles(instanceName: string): void {
  let migrated = 0;

  // Phase 1: Move global secret files into data/secrets/
  for (const filename of SECRET_FILES) {
    const src = path.join(DATA_DIR, filename);
    const dst = path.join(DATA_DIR, 'secrets', filename);
    if (moveFile(src, dst)) migrated++;
  }

  // Phase 2: Move instance-level secret files into secrets/ subdir
  const instanceDir = path.join(DATA_DIR, instanceName);
  if (fs.existsSync(instanceDir)) {
    for (const filename of SECRET_FILES) {
      const src = path.join(instanceDir, filename);
      const dst = path.join(instanceDir, 'secrets', filename);
      if (moveFile(src, dst)) migrated++;
    }
  }

  // Phase 3: If instance secrets dir doesn't exist, copy from global
  const instanceSecretsDir = path.join(instanceDir, 'secrets');
  const globalSecretsDir = path.join(DATA_DIR, 'secrets');
  if (!fs.existsSync(instanceSecretsDir) && fs.existsSync(globalSecretsDir)) {
    fs.mkdirSync(instanceSecretsDir, { recursive: true });
    for (const filename of SECRET_FILES) {
      const src = path.join(globalSecretsDir, filename);
      const dst = path.join(instanceSecretsDir, filename);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        migrated++;
      }
    }
  }

  // Phase 4: Clean up stale data/env directory
  const staleEnvDir = path.join(DATA_DIR, 'env');
  if (fs.existsSync(staleEnvDir)) {
    fs.rmSync(staleEnvDir, { recursive: true, force: true });
    migrated++;
  }

  if (migrated > 0) {
    logger.info(
      { instanceName, migrated },
      'Migrated data files to new layout',
    );
  }
}
