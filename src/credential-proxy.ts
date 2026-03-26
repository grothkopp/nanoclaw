/**
 * Universal credential proxy for container isolation.
 *
 * All container credentials flow through this proxy — containers never see
 * real secrets. Three endpoint types:
 *
 *   /_cred/:name          Token/file server — returns raw credential values.
 *   /_proxy/:name/*       Reverse proxy — forwards with injected auth headers.
 *   /* (default)          Anthropic reverse proxy (backward compatible).
 *
 * Anthropic auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges placeholder token for a temp API key
 *             via /api/oauth/claude_cli/create_api_key. Proxy injects real
 *             OAuth token on that exchange request.
 */
import fs from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import {
  CredentialService,
  loadServiceConfig,
} from './credential-proxy-config.js';
import { readEnvFile } from './env.js';
import { readSecretFile, resolveSecretFile } from './instance-data.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

function resolveCredential(
  service: CredentialService,
  instanceName: string | undefined,
): string | null {
  if (service.secret.type === 'file' && service.secret.filename) {
    if (service.type === 'file-server') {
      // Return full file contents (may be multi-line JSON)
      const filePath = resolveSecretFile(instanceName, service.secret.filename);
      if (!filePath) return null;
      return fs.readFileSync(filePath, 'utf-8');
    }
    return readSecretFile(instanceName, service.secret.filename);
  }
  if (service.secret.type === 'env' && service.secret.keys) {
    const values = readEnvFile(service.secret.keys);
    for (const key of service.secret.keys) {
      if (values[key]) return values[key];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function stripHopByHop(
  headers: Record<string, string | number | string[] | undefined>,
): void {
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
}

function forwardRequest(
  upstreamUrl: URL,
  reqPath: string,
  method: string,
  headers: Record<string, string | number | string[] | undefined>,
  body: Buffer,
  res: ServerResponse,
): void {
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const upstream = makeRequest(
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: reqPath,
      method,
      headers,
    } as RequestOptions,
    (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    logger.error({ err, path: reqPath }, 'Credential proxy upstream error');
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  upstream.write(body);
  upstream.end();
}

// ---------------------------------------------------------------------------
// Instance resolution
// ---------------------------------------------------------------------------

/** Extract instance name from query param or X-NanoClaw-Instance header. */
function resolveInstance(req: IncomingMessage, url: URL): string | undefined {
  return (
    url.searchParams.get('instance') ||
    (req.headers['x-nanoclaw-instance'] as string) ||
    undefined
  );
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** /_cred/:name — serve raw credential values */
function handleCredEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  services: CredentialService[],
): void {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const credName = url.pathname.replace(/^\/_cred\//, '');
  const instanceName = resolveInstance(req, url);

  const service = services.find((s) => s.name === credName);
  if (
    !service ||
    (service.type !== 'token-server' && service.type !== 'file-server')
  ) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const value = resolveCredential(service, instanceName);
  if (!value) {
    res.writeHead(404);
    res.end('Credential not configured');
    return;
  }

  const contentType =
    service.type === 'file-server' && service.name.endsWith('.json')
      ? 'application/json'
      : 'text/plain';

  res.writeHead(200, { 'Content-Type': contentType });
  res.end(value);
}

/** /_proxy/:name/* — reverse proxy with credential injection */
async function handleProxyEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  services: CredentialService[],
): Promise<void> {
  // Extract service name and optional instance: /_proxy/{name}[@{instance}]/rest/of/path
  const match = req.url!.match(/^\/_proxy\/([^/@]+)(?:@([^/]+))?(\/.*)?$/);
  if (!match) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const serviceName = match[1];
  const pathInstance = match[2]; // from @{instance} in URL
  const remainingPath = match[3] || '/';

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const instanceName = pathInstance || resolveInstance(req, url);

  const service = services.find(
    (s) => s.name === serviceName && s.type === 'reverse-proxy',
  );
  if (!service || !service.upstream) {
    res.writeHead(404);
    res.end('Service not found');
    return;
  }

  const credential = resolveCredential(service, instanceName);
  if (!credential) {
    res.writeHead(502);
    res.end('Credential not configured for service');
    return;
  }

  const body = await collectBody(req);
  const upstreamUrl = new URL(service.upstream);

  const headers: Record<string, string | number | string[] | undefined> = {
    ...(req.headers as Record<string, string>),
    host: upstreamUrl.host,
    'content-length': body.length,
  };

  stripHopByHop(headers);

  // Strip internal proxy headers before forwarding to upstream
  delete headers['x-nanoclaw-instance'];

  // Strip any headers the service config specifies
  if (service.stripHeaders) {
    for (const h of service.stripHeaders) {
      delete headers[h.toLowerCase()];
    }
  }

  // Inject the credential header
  if (service.header && service.headerFormat) {
    const headerName = service.header.toLowerCase();
    delete headers[headerName];
    headers[headerName] = service.headerFormat.replace('{value}', credential);
  }

  // Build upstream path: remaining path + original query string (minus instance param)
  url.searchParams.delete('instance');
  const queryString = url.searchParams.toString();
  const upstreamPath = remainingPath + (queryString ? `?${queryString}` : '');

  forwardRequest(upstreamUrl, upstreamPath, req.method!, headers, body, res);
}

// ---------------------------------------------------------------------------
// Main proxy server
// ---------------------------------------------------------------------------

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const envSecrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = envSecrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    envSecrets.CLAUDE_CODE_OAUTH_TOKEN || envSecrets.ANTHROPIC_AUTH_TOKEN;

  const anthropicUpstream = new URL(
    envSecrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );

  const services = loadServiceConfig();
  logger.info(
    { services: services.map((s) => s.name) },
    'Credential proxy services loaded',
  );

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reqUrl = req.url || '/';

      try {
        // /_cred/:name — credential server
        if (reqUrl.startsWith('/_cred/')) {
          handleCredEndpoint(req, res, services);
          return;
        }

        // /_proxy/:name/* — reverse proxy with auth injection
        if (reqUrl.startsWith('/_proxy/')) {
          await handleProxyEndpoint(req, res, services);
          return;
        }

        // Default: Anthropic reverse proxy (backward compatible)
        const body = await collectBody(req);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: anthropicUpstream.host,
            'content-length': body.length,
          };

        stripHopByHop(headers);

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = envSecrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        forwardRequest(
          anthropicUpstream,
          reqUrl,
          req.method!,
          headers,
          body,
          res,
        );
      } catch (err) {
        logger.error({ err, url: reqUrl }, 'Credential proxy error');
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      }
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, services: services.map((s) => s.name) },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
