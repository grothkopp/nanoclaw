/**
 * Per-instance data file resolution.
 * Checks data/{instanceName}/{filename} first, falls back to data/{filename}.
 * This allows credentials and configs to be overridden per channel instance.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

/**
 * Resolve a data file path, checking per-instance override first.
 * Returns the full path to the file (instance-specific if it exists, global otherwise).
 * Returns null if neither exists.
 */
export function resolveDataFile(
  instanceName: string | undefined,
  filename: string,
): string | null {
  if (instanceName) {
    const instancePath = path.join(DATA_DIR, instanceName, filename);
    if (fs.existsSync(instancePath)) return instancePath;
  }
  const globalPath = path.join(DATA_DIR, filename);
  if (fs.existsSync(globalPath)) return globalPath;
  return null;
}

/**
 * Read a data file as trimmed string, checking per-instance override first.
 * Returns null if the file doesn't exist in either location.
 */
export function readDataFile(
  instanceName: string | undefined,
  filename: string,
): string | null {
  const filePath = resolveDataFile(instanceName, filename);
  if (!filePath) return null;
  return fs.readFileSync(filePath, 'utf-8').trim();
}

/**
 * Extract instance name from a JID.
 * "wa:personal:number@g.us" → "personal"
 * "slack:xsg:C123" → "xsg"
 * "legacy@g.us" → undefined
 */
export function instanceNameFromJid(jid: string): string | undefined {
  const match = jid.match(/^(?:wa|slack):([^:]+):/);
  return match?.[1];
}

/**
 * Migrate global data files to per-instance directory.
 * Copies (not moves) files from data/ to data/{instanceName}/ so that
 * the global fallback still works for other instances.
 */
export function migrateDataFiles(instanceName: string): void {
  const instanceDir = path.join(DATA_DIR, instanceName);
  const filesToMigrate = [
    'github-token',
    'groq-token',
    'gws-credentials.json',
    'ha-token',
  ];

  // Only migrate if instance dir doesn't exist yet
  if (fs.existsSync(instanceDir)) return;

  const hasFiles = filesToMigrate.some((f) =>
    fs.existsSync(path.join(DATA_DIR, f)),
  );
  if (!hasFiles) return;

  fs.mkdirSync(instanceDir, { recursive: true });

  for (const filename of filesToMigrate) {
    const src = path.join(DATA_DIR, filename);
    const dst = path.join(instanceDir, filename);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
    }
  }

  // Clean up stale data/env directory
  const staleEnvDir = path.join(DATA_DIR, 'env');
  if (fs.existsSync(staleEnvDir)) {
    fs.rmSync(staleEnvDir, { recursive: true, force: true });
  }
}
