import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { CodexAgentAdapter, DemoAgentAdapter } from './agent/index.js';
import { loadConfig, type Config } from './config.js';
import { LiveDataProvider, type DataProvider } from './data/provider.js';
import { DemoDataProvider, DemoWordPressAdapter } from './demo-wordpress.js';
import { createSessionSecurity } from './security/session.js';
import { runScheduledTick } from './scheduler.js';
import { SiteOpsService } from './service.js';
import { SkillService } from './skills.js';
import { Store } from './store.js';
import { WriterService } from './writer/service.js';
import type { WordPressAdapter } from './writer/types.js';
import { HttpWordPressAdapter } from './writer/wordpress-adapter.js';
import { SQLiteWriterStorage } from './writer-store.js';

export interface RunningSiteOps {
  server: http.Server;
  service: SiteOpsService;
  store: Store;
  launchUrl: string;
  close(): Promise<void>;
}

export async function startSiteOps(config: Config = loadConfig()): Promise<RunningSiteOps> {
  if (config.mode === 'live' && (!config.live || config.agent !== 'codex')) {
    throw new Error('Live mode requires complete live configuration and the Codex agent.');
  }
  const store = new Store(path.join(config.dataDir, 'siteops.sqlite'));
  const now = () => new Date();
  let wordpress: WordPressAdapter;
  let provider: DataProvider;
  let siteUrl: string;

  if (config.mode === 'demo') {
    const demoWordPress = new DemoWordPressAdapter(store, now);
    wordpress = demoWordPress;
    provider = new DemoDataProvider(demoWordPress, now);
    siteUrl = 'https://example.test';
  } else {
    const live = config.live!;
    wordpress = new HttpWordPressAdapter({ siteOrigin: live.siteUrl, username: live.username, applicationPassword: live.appPassword });
    provider = new LiveDataProvider(live, wordpress, (post) => store.put('private_wp_snapshot', String(post.postId), post));
    siteUrl = live.siteUrl;
  }

  const writerStorage = new SQLiteWriterStorage(store);
  const yololabProduction = config.mode === 'live' && siteUrl === 'https://yololab.net';
  const siteLock = config.mode === 'live' && !yololabProduction
    ? (config.live?.writerLockPath ?? `/tmp/yolo-siteops-${crypto.createHash('sha256').update(siteUrl).digest('hex').slice(0, 16)}.lock`)
    : path.join(config.dataDir, 'wordpress-writer.lock');
  const writer = new WriterService({
    storage: writerStorage,
    adapter: wordpress,
    siteOrigin: siteUrl,
    production: yololabProduction,
    ...(yololabProduction ? {} : { lockPath: siteLock }),
    now,
  });
  const codex = config.agent === 'codex' ? new CodexAgentAdapter({
    cwd: process.cwd(),
    ...(config.codexCommand ? { command: config.codexCommand } : {}),
  }) : undefined;
  const agent = codex ?? new DemoAgentAdapter();
  const skills = new SkillService(store, {
    agent,
    mode: config.mode,
    now,
    ...(config.mode === 'live' && codex ? {
      reflect: (evidence) => codex.reflect(evidence, AbortSignal.timeout(120_000)),
    } : {}),
  });
  const service = new SiteOpsService({
    mode: config.mode,
    siteUrl,
    store,
    provider,
    wordpress,
    writerStorage,
    writer,
    agent,
    agentMode: config.agent,
    skills,
    now,
  });
  await service.initialize();

  const appOrigin = `http://127.0.0.1:${config.port}`;
  const security = createSessionSecurity({
    appOrigin,
    production: config.mode === 'live',
    ...(config.mode === 'demo' && process.env.SITEOPS_BOOTSTRAP ? { bootstrapCode: process.env.SITEOPS_BOOTSTRAP } : {}),
  });
  const app = createApp({ service, security, staticDir: path.resolve('dist/web') });
  const server = http.createServer(app);
  const scheduler = setInterval(() => {
    void runScheduledTick({ store, service }).catch(() => {
      try {
        store.put('scheduler_health', 'current', { status: 'error', at: now().toISOString() });
      } catch {
        // Keep a storage failure from becoming an unhandled background rejection.
      }
    });
  }, 30_000);
  scheduler.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const launchUrl = security.launchUrl('/');
  return {
    server,
    service,
    store,
    launchUrl,
    close: async () => {
      clearInterval(scheduler);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
    },
  };
}

async function main(): Promise<void> {
  const running = await startSiteOps();
  // The one-time bootstrap remains only in this process output and the browser URL fragment.
  console.log(`YOLO SiteOps: ${running.launchUrl}`);
  const stop = async () => {
    await running.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'YOLO SiteOps failed to start.');
  process.exitCode = 1;
});
