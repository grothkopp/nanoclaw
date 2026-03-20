/**
 * Shared utilities for WhatsApp authentication.
 * Separated from whatsapp-auth.ts to allow clean testing without
 * triggering the module-level authenticate() call.
 *
 * Auth directory convention: store/auth/{instanceName}/
 * All auth files (credentials, status, QR data, pairing code) live
 * inside the instance subdirectory. No configuration needed — the
 * instance name determines the path.
 */
import fs from 'fs';
import path from 'path';

/**
 * Resolve the instance name from CLI args.
 * Returns the --instance value, or the first instance name from
 * whatsapp-instances.json, or "default" as final fallback.
 */
export function resolveInstanceName(argv: string[]): string {
  const idx = argv.indexOf('--instance');
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1];
  }

  // Fall back to first configured instance
  const configPath = path.join(process.cwd(), 'data', 'whatsapp-instances.json');
  if (fs.existsSync(configPath)) {
    try {
      const instances = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(instances) && instances.length > 0 && instances[0].name) {
        return instances[0].name;
      }
    } catch {
      // Fall through
    }
  }

  return 'default';
}

/**
 * Get the auth directory path for an instance.
 * Convention: store/auth/{instanceName}/
 */
export function getAuthDir(instanceName: string): string {
  return path.join('store', 'auth', instanceName);
}

/**
 * Get the status file path for an instance.
 */
export function getStatusFile(instanceName: string): string {
  return path.join('store', 'auth', instanceName, 'auth-status.txt');
}

/**
 * Get the QR data file path for an instance.
 */
export function getQrFile(instanceName: string): string {
  return path.join('store', 'auth', instanceName, 'qr-data.txt');
}

/**
 * Get the pairing code file path for an instance.
 */
export function getPairingCodeFile(instanceName: string): string {
  return path.join('store', 'auth', instanceName, 'pairing-code.txt');
}

/**
 * Migrate legacy auth directory layout to the new convention.
 * Moves store/auth/ (if it contains creds.json directly) to store/auth/{instanceName}/
 * Also cleans up stale root-level status files.
 */
export function migrateAuthDir(instanceName: string): void {
  const authBase = path.join('store', 'auth');
  const targetDir = path.join(authBase, instanceName);
  const credsFile = path.join(authBase, 'creds.json');

  // Only migrate if creds.json is directly in store/auth/ (legacy layout)
  if (fs.existsSync(credsFile) && !fs.existsSync(targetDir)) {
    // Create target and move all files from store/auth/ into store/auth/{instance}/
    const tempDir = path.join('store', `auth-migrate-${Date.now()}`);
    fs.renameSync(authBase, tempDir);
    fs.mkdirSync(targetDir, { recursive: true });

    for (const file of fs.readdirSync(tempDir)) {
      fs.renameSync(path.join(tempDir, file), path.join(targetDir, file));
    }
    fs.rmdirSync(tempDir);
  }

  // Clean up stale root-level status files
  const staleFiles = [
    'store/auth-status.txt',
    'store/pairing-code.txt',
    'store/qr-data.txt',
  ];
  // Also clean instance-specific files from old layout (store/auth-status-auth.txt etc.)
  try {
    for (const f of fs.readdirSync('store')) {
      if (f.startsWith('auth-status-') || f.startsWith('qr-data-') || f.startsWith('pairing-code')) {
        staleFiles.push(path.join('store', f));
      }
    }
  } catch { /* store/ might not exist */ }

  for (const f of staleFiles) {
    try { fs.unlinkSync(f); } catch { /* ok */ }
  }
}
