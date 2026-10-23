import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import express from 'express';

interface SessionRecord {
  id: string;
  tokenHash: Buffer;
  csrfToken: string;
  expiresAt: number;
}

export interface SessionSecurityOptions {
  appOrigin: string;
  production?: boolean;
  allowMissingOriginForCli?: boolean;
  cookieName?: string;
  sessionTtlMs?: number;
  bootstrapCode?: string;
}

export interface SessionSecurity {
  readonly bootstrapCode: string;
  readonly sessionRouter: Router;
  readonly requireApiSession: RequestHandler;
  launchUrl(path?: string): string;
}

declare global {
  // Express uses namespace merging for request augmentation.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: { id: string };
    }
  }
}

function secret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEqual(left: string, expectedHash: Buffer): boolean {
  const actualHash = digest(left);
  return actualHash.length === expectedHash.length && crypto.timingSafeEqual(actualHash, expectedHash);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try {
      cookies.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // An invalid cookie is treated as absent.
    }
  }
  return cookies;
}

function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export function createSessionSecurity(options: SessionSecurityOptions): SessionSecurity {
  const origin = new URL(options.appOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('appOrigin must be an exact HTTP(S) origin without credentials or a path');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) {
    throw new Error('Session security may only bind to a localhost origin');
  }

  const production = options.production ?? false;
  const cookieName = options.cookieName ?? (origin.protocol === 'https:' ? '__Host-yolo_siteops' : 'yolo_siteops');
  const ttlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookieName)) throw new Error('cookieName is invalid');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1000) throw new Error('sessionTtlMs must be between zero and 24 hours');
  const bootstrapCode = options.bootstrapCode ?? secret();
  const bootstrapHash = digest(bootstrapCode);
  const sessions = new Map<string, SessionRecord>();
  let bootstrapConsumed = false;

  function validateRequestOrigin(req: Request): string | null {
    if (req.get('host') !== origin.host) return 'Host header does not match the configured localhost origin';
    const requestOrigin = req.get('origin');
    if (!requestOrigin) {
      if (!production && options.allowMissingOriginForCli === true) return null;
      return 'Origin header is required';
    }
    if (requestOrigin !== origin.origin) return 'Origin header does not match the configured localhost origin';
    return null;
  }

  function lookupSession(req: Request): SessionRecord | undefined {
    const rawToken = parseCookies(req.get('cookie')).get(cookieName);
    if (!rawToken) return undefined;
    const key = digest(rawToken).toString('hex');
    const record = sessions.get(key);
    if (!record || record.expiresAt <= Date.now() || !constantTimeEqual(rawToken, record.tokenHash)) {
      sessions.delete(key);
      return undefined;
    }
    return record;
  }

  function authenticate(req: Request, res: Response, next: NextFunction): void {
    const session = lookupSession(req);
    if (!session) {
      res.status(401).json({ error: 'session_required' });
      return;
    }

    if (isMutation(req.method)) {
      const requestError = validateRequestOrigin(req);
      if (requestError) {
        res.status(403).json({ error: 'invalid_request_origin', message: requestError });
        return;
      }
      const csrf = req.get('x-csrf-token');
      if (!csrf || !constantTimeEqual(csrf, digest(session.csrfToken))) {
        res.status(403).json({ error: 'csrf_required' });
        return;
      }
    }
    req.session = { id: session.id };
    next();
  }

  const sessionRouter = express.Router();
  sessionRouter.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  sessionRouter.post('/', (req, res) => {
    const requestError = validateRequestOrigin(req);
    if (requestError) {
      res.status(403).json({ error: 'invalid_request_origin', message: requestError });
      return;
    }
    if (bootstrapConsumed) {
      res.status(410).json({ error: 'bootstrap_consumed' });
      return;
    }
    const submitted = typeof req.body?.bootstrap === 'string' ? req.body.bootstrap : '';
    if (!constantTimeEqual(submitted, bootstrapHash)) {
      res.status(401).json({ error: 'invalid_bootstrap' });
      return;
    }

    bootstrapConsumed = true;
    const token = secret();
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      tokenHash: digest(token),
      csrfToken: secret(),
      expiresAt: Date.now() + ttlMs,
    };
    sessions.set(record.tokenHash.toString('hex'), record);
    const attributes = [
      `${cookieName}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${Math.floor(ttlMs / 1000)}`,
    ];
    if (origin.protocol === 'https:') attributes.push('Secure');
    res.setHeader('Set-Cookie', attributes.join('; '));
    res.status(201).json({ csrf: record.csrfToken, expiresAt: new Date(record.expiresAt).toISOString() });
  });
  sessionRouter.get('/', authenticate, (req, res) => {
    const session = lookupSession(req);
    if (!session) {
      res.status(401).json({ error: 'session_required' });
      return;
    }
    res.json({ csrf: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  return {
    bootstrapCode,
    sessionRouter,
    requireApiSession: authenticate,
    launchUrl(path = '/') {
      const launch = new URL(path, origin);
      if (launch.origin !== origin.origin) throw new Error('Launch path must remain on the configured localhost origin');
      launch.hash = `token=${encodeURIComponent(bootstrapCode)}`;
      return launch.toString();
    },
  };
}
