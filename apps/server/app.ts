import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { SessionSecurity } from './security/session.js';
import { errorCodeFor, httpStatusFor, SiteOpsError, type SiteOpsService } from './service.js';

export interface CreateAppOptions {
  service: SiteOpsService;
  security: SessionSecurity;
  staticDir?: string;
}

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { void handler(req, res).catch(next); };

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new SiteOpsError('invalid_request', `${name} is required.`, 400);
  return value;
}

function proposalId(req: Request): string {
  return stringField(req.params.id, 'proposal id');
}

function sessionId(req: Request): string {
  if (!req.session?.id) throw new SiteOpsError('session_required', 'An authenticated session is required.', 401);
  return req.session.id;
}

export function createApp(options: CreateAppOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '1mb', strict: true }));

  // Bootstrap exchange must be mounted before the guard; every other API route is session protected.
  app.use('/api/session', options.security.sessionRouter);
  app.use('/api', options.security.requireApiSession);

  app.get('/api/state', (_req, res) => res.json(options.service.state()));
  app.post('/api/connections/check', asyncRoute(async (_req, res) => { res.json(await options.service.checkConnections()); }));
  app.post('/api/sync', asyncRoute(async (_req, res) => { res.json(await options.service.sync()); }));
  app.post('/api/tasks', asyncRoute(async (req, res) => {
    const postId = req.body?.postId;
    if (!Number.isSafeInteger(postId) || postId <= 0) throw new SiteOpsError('invalid_request', 'postId must be a positive integer.', 400);
    res.status(202).json(await options.service.createTask(postId));
  }));
  app.post('/api/tasks/:id/cancel', asyncRoute(async (req, res) => { res.json(await options.service.cancelTask(stringField(req.params.id, 'task id'))); }));
  app.get('/api/tasks/:id/events', (req, res, next) => {
    try {
      const taskId = stringField(req.params.id, 'task id');
      const header = req.get('last-event-id');
      const after = header && /^\d+$/.test(header) ? Number(header) : 0;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const write = (event: ReturnType<SiteOpsService['events']>[number]) => {
        res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      for (const event of options.service.events(taskId, after)) write(event);
      const unsubscribe = options.service.subscribe(taskId, write);
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25_000);
      req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
    } catch (error) { next(error); }
  });

  app.post('/api/proposals/:id/approve', asyncRoute(async (req, res) => {
    const approvalId = await options.service.approveProposal(proposalId(req), sessionId(req), stringField(req.body?.patchHash, 'patchHash'));
    res.status(201).json({ approvalId });
  }));
  app.post('/api/proposals/:id/apply', asyncRoute(async (req, res) => {
    const receipt = await options.service.applyProposal(proposalId(req), sessionId(req), stringField(req.body?.approvalId, 'approvalId'));
    res.json({ receipt });
  }));
  app.post('/api/proposals/:id/reject', asyncRoute(async (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason ? req.body.reason : 'Rejected by operator';
    res.json(await options.service.rejectProposal(proposalId(req), reason));
  }));
  app.post('/api/proposals/:id/rollback-approve', asyncRoute(async (req, res) => {
    const approvalId = await options.service.approveRollback(proposalId(req), sessionId(req));
    res.status(201).json({ approvalId });
  }));
  app.post('/api/proposals/:id/rollback', asyncRoute(async (req, res) => {
    const receipt = await options.service.rollbackProposal(proposalId(req), sessionId(req), stringField(req.body?.approvalId, 'approvalId'));
    res.json({ receipt });
  }));
  app.patch('/api/settings', (req, res) => res.json(options.service.updateSettings(req.body)));
  app.post('/api/skills/propose', asyncRoute(async (_req, res) => { res.status(201).json(await options.service.proposeSkill()); }));
  app.post('/api/skills/:id/evaluate', asyncRoute(async (req, res) => { res.json(await options.service.evaluateSkill(stringField(req.params.id, 'skill id'))); }));
  app.post('/api/skills/:id/activate', asyncRoute(async (req, res) => { res.json(await options.service.activateSkill(stringField(req.params.id, 'skill id'))); }));

  const staticDir = path.resolve(options.staticDir ?? 'dist/web');
  if (existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, fallthrough: true }));
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(staticDir, 'index.html'), (error) => error ? next(error) : undefined);
    });
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'API route was not found.' } }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = httpStatusFor(error);
    const code = errorCodeFor(error);
    const message = status < 500 && error instanceof Error ? error.message : 'Internal server error.';
    res.status(status).json({ error: { code, message } });
  });
  return app;
}
