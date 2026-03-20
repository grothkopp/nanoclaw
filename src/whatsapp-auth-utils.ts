/**
 * Shared utilities for WhatsApp authentication.
 * Separated from whatsapp-auth.ts to allow clean testing without
 * triggering the module-level authenticate() call.
 */
import fs from 'fs';
import path from 'path';

/**
 * Resolve the auth directory name from CLI args.
 * Priority: --auth-dir > --instance (looks up whatsapp-instances.json) > default "auth"
 */
export function resolveAuthDir(argv: string[]): string {
  // Explicit --auth-dir flag
  const authDirIdx = argv.indexOf('--auth-dir');
  if (authDirIdx !== -1 && argv[authDirIdx + 1]) {
    return argv[authDirIdx + 1];
  }

  // --instance flag: look up authDir from whatsapp-instances.json
  const instanceIdx = argv.indexOf('--instance');
  if (instanceIdx !== -1 && argv[instanceIdx + 1]) {
    const instanceName = argv[instanceIdx + 1];
    const configPath = path.join(process.cwd(), 'data', 'whatsapp-instances.json');
    if (fs.existsSync(configPath)) {
      try {
        const instances = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (Array.isArray(instances)) {
          const instance = instances.find(
            (i: { name?: string }) => i.name === instanceName,
          );
          if (instance?.authDir) {
            return instance.authDir;
          }
          // Default for instance without explicit authDir
          return `auth-${instanceName}`;
        }
      } catch {
        // Fall through to default
      }
    }
    // Instance not found in config, use convention
    return `auth-${instanceName}`;
  }

  // Default: "auth" (legacy single-instance)
  return 'auth';
}
