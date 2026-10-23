import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentAdapter, ChangeProposal, Task } from '../packages/contracts.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../apps/server/app.js';
import { DemoAgentAdapter } from '../apps/server/agent/index.js';
import { DemoDataProvider, DemoWordPressAdapter } from '../apps/server/demo-wordpress.js';
import { createSessionSecurity } from '../apps/server/security/session.js';
import { SiteOpsService } from '../apps/server/service.js';
import { SkillService } from '../apps/server/skills.js';
import { Store } from '../apps/server/store.js';
import { hashPostState } from '../apps/server/writer/hash.js';
import { WriterService } from '../apps/server/writer/service.js';
import type { ApprovalRecord } from '../apps/server/writer/types.js';
import { SQLiteWriterStorage } from '../apps/server/writer-store.js';

interface Fixture {
  origin: string;
  server: http.Server;
  store: Store;
  writerStorage: SQLiteWriterStorage;
  service: SiteOpsService;
  wordpress: DemoWordPressAdapter;
}

let tempRoot = '';
const fixtures: Fixture[] = [];

beforeEach(async () => { tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-app-test-')); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    fixture.store.close();
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function makeFixture(agent: AgentAdapter = new DemoAgentAdapter()): Promise<Fixture> {
  const now = () => new Date('2026-10-23T02:00:00Z');
  const store = new Store(':memory:');
  const wordpress = new DemoWordPressAdapter(store, now);
  const provider = new DemoDataProvider(wordpress, now);
  const writerStorage = new SQLiteWriterStorage(store);
  const writer = new WriterService({
    storage: writerStorage, adapter: wordpress, siteOrigin: 'https://example.test',
    lockPath: path.join(tempRoot, 'writer.lock'), now,
  });
  const service = new SiteOpsService({
    mode: 'demo', siteUrl: 'https://example.test', store, provider, wordpress, writerStorage, writer,
    agent, agentMode: 'demo', skills: new SkillService(store, { agent, mode: 'demo', now }), now,
  });
  await service.initialize();

  const appHolder: { current?: ReturnType<typeof createApp> } = {};
  const server = http.createServer((req, res) => {
    if (!appHolder.current) { res.statusCode = 503; res.end(); return; }
    appHolder.current(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const security = createSessionSecurity({ appOrigin: origin, bootstrapCode: 'app-test-bootstrap' });
  appHolder.current = createApp({ service, security, staticDir: path.join(tempRoot, 'missing-static') });
  const fixture = { origin, server, store, writerStorage, service, wordpress };
  fixtures.push(fixture);
  return fixture;
}

async function login(origin: string): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${origin}/api/session`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ bootstrap: 'app-test-bootstrap' }),
  });
  expect(response.status).toBe(201);
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const { csrf } = await response.json() as { csrf: string };
  return { cookie, csrf };
}

async function api(origin: string, auth: { cookie: string; csrf: string }, route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('cookie', auth.cookie);
  headers.set('origin', origin);
  if (init.body) headers.set('content-type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('x-csrf-token', auth.csrf);
  return fetch(`${origin}${route}`, { ...init, headers });
}

async function waitForProposal(fixture: Fixture): Promise<ChangeProposal> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const proposal = fixture.service.state().proposals[0];
    if (proposal) return proposal;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('proposal was not created');
}

describe('SiteOps HTTP integration', () => {
  it('completes the demo task, approval, write verification, and experiment flow', async () => {
    const fixture = await makeFixture();
    const auth = await login(fixture.origin);
    const stateResponse = await api(fixture.origin, auth, '/api/state');
    expect(stateResponse.status).toBe(200);
    const initial = await stateResponse.json() as ReturnType<SiteOpsService['state']>;
    expect(initial.snapshot?.pages[0].protectedHash).toHaveLength(64);

    const create = await api(fixture.origin, auth, '/api/tasks', {
      method: 'POST', body: JSON.stringify({ postId: initial.opportunities[0].postId }),
    });
    expect(create.status).toBe(202);
    const task = await create.json() as Task;
    expect(task.status).toBe('queued');

    const proposal = await waitForProposal(fixture);
    const approve = await api(fixture.origin, auth, `/api/proposals/${proposal.id}/approve`, {
      method: 'POST', body: JSON.stringify({ patchHash: proposal.patchHash }),
    });
    expect(approve.status).toBe(201);
    const { approvalId } = await approve.json() as { approvalId: string };
    const apply = await api(fixture.origin, auth, `/api/proposals/${proposal.id}/apply`, {
      method: 'POST', body: JSON.stringify({ approvalId }),
    });
    expect(apply.status).toBe(200);
    expect((await apply.json() as { receipt: { status: string } }).receipt.status).toBe('applied');

    const finalState = fixture.service.state();
    expect(finalState.tasks.find((item) => item.id === task.id)?.status).toBe('completed');
    expect(finalState.experiments).toMatchObject([{ proposalId: proposal.id, status: 'observing' }]);
    expect(hashPostState(await fixture.wordpress.getPostForEdit(proposal.postId))).toBe(proposal.patchHash);
  });

  it('serves resumable SSE events and rejects settings outside the allowlist', async () => {
    const fixture = await makeFixture();
    const auth = await login(fixture.origin);
    const postId = fixture.service.state().opportunities[0].postId;
    const taskResponse = await api(fixture.origin, auth, '/api/tasks', { method: 'POST', body: JSON.stringify({ postId }) });
    const task = await taskResponse.json() as Task;
    await waitForProposal(fixture);
    const events = fixture.service.events(task.id);
    expect(events.length).toBeGreaterThan(1);

    const sse = await api(fixture.origin, auth, `/api/tasks/${task.id}/events`, {
      headers: { 'last-event-id': String(events[0].sequence) },
    });
    expect(sse.status).toBe(200);
    const reader = sse.body?.getReader();
    const chunk = await reader?.read();
    await reader?.cancel();
    expect(new TextDecoder().decode(chunk?.value)).toContain(`id: ${events[1].sequence}`);

    const badSettings = await api(fixture.origin, auth, '/api/settings', {
      method: 'PATCH', body: JSON.stringify({ scheduleEnabled: true, secretPath: '/tmp/nope' }),
    });
    expect(badSettings.status).toBe(400);
    expect(await badSettings.json()).toEqual({ error: { code: 'invalid_settings_key', message: 'Settings patch contains an unsupported field.' } });

    for (const patch of [{ dailyTime: '9:00' }, { weeklyTime: 'Monday 09:30' }, { maxOpportunities: 11 }, { maxWeeklyProposals: 4 }]) {
      const invalid = await api(fixture.origin, auth, '/api/settings', { method: 'PATCH', body: JSON.stringify(patch) });
      expect(invalid.status).toBe(400);
    }
  });

  it('rejects a waiting proposal when its task is cancelled and blocks unresolved posts', async () => {
    const fixture = await makeFixture();
    const auth = await login(fixture.origin);
    const postId = fixture.service.state().opportunities[0].postId;
    const created = await api(fixture.origin, auth, '/api/tasks', { method: 'POST', body: JSON.stringify({ postId }) });
    const task = await created.json() as Task;
    const proposal = await waitForProposal(fixture);
    const cancelled = await api(fixture.origin, auth, `/api/tasks/${task.id}/cancel`, { method: 'POST', body: '{}' });
    expect(cancelled.status).toBe(200);
    expect(fixture.service.state().proposals.find((item) => item.id === proposal.id)?.status).toBe('rejected');
    const approve = await api(fixture.origin, auth, `/api/proposals/${proposal.id}/approve`, {
      method: 'POST', body: JSON.stringify({ patchHash: proposal.patchHash }),
    });
    expect(approve.status).toBe(409);

    const otherPost = fixture.service.state().opportunities[1].postId;
    const page = fixture.service.state().snapshot!.pages.find((item) => item.postId === otherPost)!;
    await fixture.writerStorage.saveProposal({
      ...proposal, id: 'unknown-write', taskId: 'unknown-task', postId: otherPost, title: page.title, url: page.url,
      status: 'review_required', error: 'unknown write',
    });
    const blocked = await api(fixture.origin, auth, '/api/tasks', { method: 'POST', body: JSON.stringify({ postId: otherPost }) });
    expect(blocked.status).toBe(409);
    expect((await blocked.json() as { error: { code: string } }).error.code).toBe('post_review_required');
  });

  it('counts skill calls against the daily task limit, retains snapshots by ID, and rejects no-op agent output', async () => {
    const noOpAgent: AgentAdapter = {
      run: async ({ input }) => ({ bodyHtml: input.page.bodyHtml, summary: 'No change', evidenceIds: input.opportunity.evidenceIds, skillVersion: input.skillVersion }),
    };
    const fixture = await makeFixture(noOpAgent);
    const firstSnapshot = fixture.service.state().snapshot!;
    await fixture.service.sync();
    expect(fixture.store.get('snapshot', firstSnapshot.id)).toEqual(firstSnapshot);

    const task = await fixture.service.createTask(fixture.service.state().opportunities[0].postId);
    for (let attempt = 0; attempt < 50 && fixture.service.state().tasks.find((item) => item.id === task.id)?.status !== 'failed'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fixture.service.state().tasks.find((item) => item.id === task.id)?.status).toBe('failed');
    expect(fixture.service.state().proposals).toHaveLength(0);

    fixture.store.put('skill_calls', '2026-10-23', 10);
    await expect(fixture.service.createTask(fixture.service.state().opportunities[1].postId)).rejects.toMatchObject({ code: 'daily_agent_limit' });
  });
});

describe('restart recovery', () => {
  it('marks consumed approvals without receipts review_required and never infers success', async () => {
    const store = new Store(':memory:');
    const storage = new SQLiteWriterStorage(store);
    const post = {
      postId: 5, url: 'https://example.test/five', bodyHtml: '<p>before</p>', status: 'publish', modified: 'now',
      protectedFields: { slug: 'five', title: 'Five', excerpt: '', categories: [], tags: [], featured_media: 0, meta: {} },
    };
    const proposal: ChangeProposal = {
      id: 'proposal-crash', taskId: 'task-crash', postId: 5, title: 'Five', url: post.url,
      beforeHtml: post.bodyHtml, afterHtml: '<p>after</p>', summary: 'test', evidenceIds: ['e'],
      baseHash: hashPostState(post), patchHash: hashPostState({ ...post, bodyHtml: '<p>after</p>' }),
      status: 'approved', createdAt: '2026-10-23T00:00:00Z',
    };
    await storage.saveProposal(proposal);
    const approval: ApprovalRecord = {
      id: 'approval-crash', sessionId: 'session', kind: 'apply', proposalId: proposal.id,
      baseHash: proposal.baseHash, patchHash: proposal.patchHash, createdAt: '2026-10-23T00:00:00Z',
      expiresAt: '2026-10-23T03:00:00Z',
    };
    await storage.insertApproval(approval);
    expect(await storage.consumeApproval(approval.id, '2026-10-23T01:00:00Z')).toBe(true);
    expect(storage.reconcileConsumedApprovals()).toBe(1);
    expect((await storage.getProposal(proposal.id))?.status).toBe('review_required');
    store.close();
  });
});
