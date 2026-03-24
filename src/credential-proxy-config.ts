/**
 * Configuration for the universal credential proxy.
 *
 * Each service defines how its credentials are resolved and injected.
 * Three service types:
 *   - reverse-proxy:  Forwards requests to an upstream, injecting auth headers.
 *                     Accessed via /_proxy/{name}/* path prefix.
 *   - token-server:   Returns a raw credential value via /_cred/{name}.
 *   - file-server:    Returns file contents via /_cred/{name}.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export interface SecretSource {
  type: 'file' | 'env';
  /** For 'file': filename under data/[instance/]secrets/ (e.g. 'github-token') */
  filename?: string;
  /** For 'env': keys to try in order from .env (first non-empty wins) */
  keys?: string[];
}

export interface CredentialService {
  name: string;
  type: 'reverse-proxy' | 'token-server' | 'file-server';
  secret: SecretSource;
  /** For reverse-proxy: upstream base URL (e.g. 'http://localhost:8123') */
  upstream?: string;
  /** For reverse-proxy: header name to inject (e.g. 'Authorization') */
  header?: string;
  /** For reverse-proxy: header value format (e.g. 'Bearer {value}') */
  headerFormat?: string;
  /** For reverse-proxy: headers to strip from the request before forwarding */
  stripHeaders?: string[];
}

/**
 * Built-in service definitions. The Anthropic service is handled separately
 * (special dual-auth logic), so it's not in this list.
 */
export const DEFAULT_SERVICES: CredentialService[] = [
  {
    name: 'github',
    type: 'token-server',
    secret: { type: 'file', filename: 'github-token' },
  },
  {
    name: 'ha',
    type: 'reverse-proxy',
    secret: { type: 'file', filename: 'ha-token' },
    upstream: 'http://localhost:8123',
    header: 'Authorization',
    headerFormat: 'Bearer {value}',
  },
  {
    name: 'gws-credentials.json',
    type: 'file-server',
    secret: { type: 'file', filename: 'gws-credentials.json' },
  },
  {
    name: 'groq',
    type: 'token-server',
    secret: { type: 'file', filename: 'groq-token' },
  },
];

/**
 * Load service configuration: built-in defaults merged with optional
 * user overrides from data/credential-services.json.
 */
export function loadServiceConfig(): CredentialService[] {
  const services = [...DEFAULT_SERVICES];
  const userConfigPath = path.join(DATA_DIR, 'credential-services.json');

  if (fs.existsSync(userConfigPath)) {
    try {
      const raw = fs.readFileSync(userConfigPath, 'utf-8');
      const userServices = JSON.parse(raw) as CredentialService[];
      if (Array.isArray(userServices)) {
        for (const svc of userServices) {
          if (!svc.name || !svc.type || !svc.secret) {
            logger.warn(
              { service: svc },
              'Skipping invalid credential service config',
            );
            continue;
          }
          // Override built-in if same name, otherwise append
          const idx = services.findIndex((s) => s.name === svc.name);
          if (idx >= 0) {
            services[idx] = svc;
          } else {
            services.push(svc);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load credential-services.json');
    }
  }

  return services;
}
