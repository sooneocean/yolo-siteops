import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, ChangeProposal, Experiment, Snapshot, Task } from '../packages/contracts.js';
import { createApp } from '../apps/server/app.js';
import { createSessionSecurity } from '../apps/server/security/session.js';
import { SiteOpsService } from '../apps/server/service.js';
import { Store } from '../apps/server/store.js';
import { SQLiteWriterStorage } from '../apps/server/writer-store.js';
import { hashPostState } from '../apps/server/writer/hash.js';
import { WriterService } from '../apps/server/writer/service.js';
import type { PublicReadback, WordPressAdapter, WordPressPostSnapshot, WriterBackup, WriterReceipt } from '../apps/server/writer/types.js';
import { normalizeHtmlText } from '../apps/server/security/html.js';

let root = '';
let store: Store;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-reconcile-'));
  store = new Store(path.join(root, 'state.sqlite'));
});
afterEach(async () => { store.close(); await fs.rm(root, { recursive: true, force: true }); });

const protectedFields = {
  slug: 'article', title: 'Article', excerpt: 'Excerpt', categories: [1], tags: [2],
  featured_media: 3, meta: { stable: true },
};

function setup(actualBodyHtml = 'FirstSecond', publicMatches = true) {
  const storage = new SQLiteWriterStorage(store);
  const before: WordPressPostSnapshot = {
    postId: 42, url: 'https://example.test/article/', bodyHtml: '<p>Before</p>', status: 'publish',
    modified: '2026-10-23T00:00:00Z', protectedFields: structuredClone(protectedFields),
  };
  const afterHtml = '<p>First</p><p>Second</p>';
  const proposal: ChangeProposal = {
    id: 'proposal-1', taskId: 'task-1', postId: 42, title: 'Article', url: before.url,
    beforeHtml: before.bodyHtml, afterHtml, summary: 'Update', evidenceIds: ['e-1'],
    baseHash: hashPostState(before), patchHash: hashPostState({ ...before, bodyHtml: afterHtml }),
    status: 'review_required', createdAt: '2026-10-23T00:00:00Z', error: 'Authenticated read-back differed after apply.',
  };
  const backup: WriterBackup = {
    id: 'backup-1', proposalId: proposal.id, post: before, stateHash: proposal.baseHash,
    createdAt: '2026-10-23T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
  };
  const originalReceipt: WriterReceipt = {
    id: 'apply-review-1', sessionId: 'session-1', operation: 'apply', proposalId: proposal.id, postId: 42,
    status: 'review_required', beforeHash: proposal.baseHash, createdAt: '2026-10-23T00:01:00Z',
    message: proposal.error,
  };
  const actual: WordPressPostSnapshot = { ...before, bodyHtml: actualBodyHtml, modified: '2026-10-23T00:01:00Z' };
  let updates = 0;
  const adapter: WordPressAdapter = {
    async getPostForEdit() { return structuredClone(actual); },
    async updateBody(_postId, bodyHtml) { updates += 1; actual.bodyHtml = bodyHtml; },
    async checkPublicReadback(post): Promise<PublicReadback> {
      return { visibility: 'public', statusCode: 200, url: post.url,
        normalizedText: publicMatches ? normalizeHtmlText(post.bodyHtml) : 'mismatch' };
    },
  };
  storage.saveProposal(proposal);
  storage.saveBackup(backup);
  storage.putReceipt(originalReceipt);
  let now = new Date('2026-10-23T00:02:00Z');
  const writer = new WriterService({ storage, adapter, siteOrigin: 'https://example.test', lockPath: path.join(root, 'lock'), now: () => now });
  return { storage, proposal, backup, originalReceipt, actual, adapter, writer, get updates() { return updates; }, setNow(value: string) { now = new Date(value); } };
}

describe('review-required reconciliation', () => {
  it('explicitly accepts an exact bare-p transformation without another WordPress write and replays its receipt', async () => {
    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-1',
    });
    const receipt = await fixture.writer.reconcile({ proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1' });

    expect(receipt.status).toBe('verified_transformed');
    expect(fixture.updates).toBe(0);
    expect(await fixture.storage.getReceipt('apply', fixture.proposal.id)).toEqual(fixture.originalReceipt);
    expect((await fixture.storage.getProposal(fixture.proposal.id))).toMatchObject({
      status: 'verified_transformed', afterHash: review.reviewedActualHash, originalApplyReceiptId: fixture.originalReceipt.id,
      originalPatchHash: fixture.proposal.patchHash, reconciliationTransform: 'strip_bare_p_v1',
    });
    expect(await fixture.writer.reconcile({ proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1' })).toEqual(receipt);
    await expect(fixture.writer.reconcile({ proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-2' }))
      .rejects.toMatchObject({ code: 'receipt_session_mismatch' });
    expect(fixture.updates).toBe(0);
  });

  it.each([
    ['byte difference', 'First Second'],
    ['remaining tag', '<strong>First</strong>Second'],
    ['paragraph attribute', '<p class="x">First</p>Second'],
  ])('rejects %s rather than treating normalized text as equivalent', async (_label, actual) => {
    const fixture = setup(actual);
    await expect(fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'unsupported_wordpress_transform' });
    expect(fixture.updates).toBe(0);
  });

  it('rejects public mismatch and wrong acceptance bindings', async () => {
    const mismatch = setup('FirstSecond', false);
    await expect(mismatch.writer.prepareReconciliation({ proposalId: mismatch.proposal.id, sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'public_readback_mismatch' });

    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    await expect(fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: 'wrong', sessionId: 'session-1',
    })).rejects.toMatchObject({ code: 'invalid_reconciliation_review' });
  });

  it.each([
    ['post identity', (post: WordPressPostSnapshot) => { post.postId = 43; }],
    ['URL', (post: WordPressPostSnapshot) => { post.url = 'https://example.test/other/'; }],
    ['status', (post: WordPressPostSnapshot) => { post.status = 'draft'; }],
    ['protected title', (post: WordPressPostSnapshot) => { post.protectedFields.title = 'Changed'; }],
  ])('rejects %s drift before an operator can accept the transformation', async (_label, mutate) => {
    const fixture = setup();
    mutate(fixture.actual);
    await expect(fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'reconciliation_identity_drift' });
    expect(fixture.updates).toBe(0);
  });

  it('binds review and acceptance to the authenticated session and immutable receipt', async () => {
    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    await expect(fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-2',
    })).rejects.toMatchObject({ code: 'invalid_reconciliation_review' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-1',
    });
    await expect(fixture.writer.reconcile({
      proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-2',
    })).rejects.toMatchObject({ code: 'invalid_reconciliation_acceptance' });

    await fixture.storage.putReceipt({ ...fixture.originalReceipt, id: 'replaced-receipt' });
    await expect(fixture.writer.reconcile({
      proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1',
    })).rejects.toThrow('Reconciliation acceptance bindings are no longer valid');
    expect((await fixture.storage.getReconciliationAcceptance(acceptance.id))?.consumedAt).toBeUndefined();
    expect(await fixture.storage.getReceipt('reconcile', fixture.proposal.id)).toBeUndefined();
    expect(fixture.updates).toBe(0);
  });

  it('rejects a tampered transform binding and leaves the acceptance unconsumed', async () => {
    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-1',
    });
    store.put('writer_reconciliation_acceptance', acceptance.id, { ...acceptance, transform: 'unknown_transform' });
    await expect(fixture.writer.reconcile({
      proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1',
    })).rejects.toMatchObject({ code: 'invalid_reconciliation_acceptance' });
    expect((await fixture.storage.getReconciliationAcceptance(acceptance.id))?.consumedAt).toBeUndefined();
    expect(fixture.updates).toBe(0);
  });

  it('expires and consumes acceptance once while preserving idempotent same-session receipt replay', async () => {
    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash,
      sessionId: 'session-1', expiresInMs: 1_000,
    });
    fixture.setNow('2026-10-23T00:03:01Z');
    await expect(fixture.writer.reconcile({ proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'invalid_reconciliation_acceptance' });
  });

  it('rejects fresh content drift after acceptance without consuming it', async () => {
    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-1',
    });
    fixture.actual.bodyHtml = `${fixture.actual.bodyHtml}!`;
    await expect(fixture.writer.reconcile({
      proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1',
    })).rejects.toMatchObject({ code: 'reconciliation_drift' });
    expect((await fixture.storage.getReconciliationAcceptance(acceptance.id))?.consumedAt).toBeUndefined();
    expect(fixture.updates).toBe(0);
  });

  it('rolls back when acceptance consumption persistence faults', async () => {
    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-1',
    });
    const originalPut = store.put.bind(store);
    store.put = ((kind: string, id: string, value: unknown) => {
      if (kind === 'writer_reconciliation_acceptance' && (value as { consumedAt?: string }).consumedAt) throw new Error('acceptance-fault');
      originalPut(kind, id, value);
    }) as typeof store.put;
    await expect(fixture.writer.reconcile({
      proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1',
    })).rejects.toThrow('acceptance-fault');
    expect((await fixture.storage.getReconciliationAcceptance(acceptance.id))?.consumedAt).toBeUndefined();
    expect(await fixture.storage.getReceipt('reconcile', fixture.proposal.id)).toBeUndefined();
    expect((await fixture.storage.getProposal(fixture.proposal.id))?.status).toBe('review_required');
  });

  it('rolls back acceptance consumption when insert-only receipt persistence faults', async () => {
    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-1',
    });
    store.db.exec(`CREATE TRIGGER fail_reconcile_receipt BEFORE INSERT ON records
      WHEN NEW.kind='writer_receipt' AND NEW.id='reconcile:proposal-1'
      BEGIN SELECT RAISE(ABORT, 'receipt-fault'); END;`);
    await expect(fixture.writer.reconcile({
      proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1',
    })).rejects.toThrow();
    expect((await fixture.storage.getReconciliationAcceptance(acceptance.id))?.consumedAt).toBeUndefined();
    expect(await fixture.storage.getReceipt('reconcile', fixture.proposal.id)).toBeUndefined();
    expect((await fixture.storage.getProposal(fixture.proposal.id))?.status).toBe('review_required');
  });

  it('rolls back every reconciliation persistence step when final proposal persistence faults', async () => {
    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-1',
    });
    const originalPut = store.put.bind(store);
    store.put = ((kind: string, id: string, value: unknown) => {
      if (kind === 'proposal' && id === fixture.proposal.id && (value as ChangeProposal).status === 'verified_transformed') throw new Error('fault');
      originalPut(kind, id, value);
    }) as typeof store.put;
    await expect(fixture.writer.reconcile({ proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1' }))
      .rejects.toThrow('fault');
    expect((await fixture.storage.getReconciliationAcceptance(acceptance.id))?.consumedAt).toBeUndefined();
    expect(await fixture.storage.getReceipt('reconcile', fixture.proposal.id)).toBeUndefined();
    expect((await fixture.storage.getProposal(fixture.proposal.id))?.status).toBe('review_required');
  });

  it('requires a separately approved rollback and blocks it after actual-content drift', async () => {
    const fixture = setup();
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-1',
    });
    await fixture.writer.reconcile({ proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1' });
    const rollbackApproval = await fixture.writer.approveRollback({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    fixture.actual.bodyHtml = `${fixture.actual.bodyHtml}!`;
    await expect(fixture.writer.rollback({
      proposalId: fixture.proposal.id, approvalId: rollbackApproval.id, sessionId: 'session-1',
    })).rejects.toMatchObject({ code: 'content_drift' });
    expect(fixture.updates).toBe(0);
  });

  it('repairs task and experiment deterministically after a crash following the atomic reconciliation commit', async () => {
    const fixture = setup();
    const snapshot: Snapshot = {
      id: 'snapshot-1', createdAt: '2026-10-22T00:00:00Z', mode: 'live',
      evidence: [{
        id: 'gsc-1', source: 'gsc', property: 'https://example.test', startDate: '2026-09-24', endDate: '2026-10-21',
        timeZone: 'America/Los_Angeles', fetchedAt: '2026-10-22T00:00:00Z', complete: true, coverage: 'test',
      }],
      pages: [{
        postId: fixture.proposal.postId, url: fixture.proposal.url, title: fixture.proposal.title,
        bodyHtml: fixture.actual.bodyHtml, status: fixture.actual.status, modified: fixture.actual.modified,
        protectedHash: hashPostState(fixture.actual),
      }],
      search: [], pageMetrics: [{
        postId: fixture.proposal.postId, clicks: 12, previousClicks: 18, impressions: 200, position: 7,
        evidenceId: 'gsc-1',
      }],
      analytics: [{ postId: fixture.proposal.postId, sessions: 9, engagedSessions: 5, measurementValid: true, evidenceId: 'ga-1' }],
      warnings: [],
    };
    const task: Task = {
      id: fixture.proposal.taskId, postId: fixture.proposal.postId, title: fixture.proposal.title,
      status: 'review_required', stage: 'Write outcome requires manual review.',
      createdAt: fixture.proposal.createdAt, updatedAt: fixture.proposal.createdAt,
      skillVersion: 'skill-v1', snapshotId: snapshot.id, proposalId: fixture.proposal.id,
      error: fixture.proposal.error,
    };
    store.put('snapshot', snapshot.id, snapshot);
    store.put('snapshot', 'current', snapshot);
    store.put('task', task.id, task);
    const review = await fixture.writer.prepareReconciliation({ proposalId: fixture.proposal.id, sessionId: 'session-1' });
    const acceptance = await fixture.writer.acceptReconciliation({
      proposalId: fixture.proposal.id, reviewId: review.id, reviewedActualHash: review.reviewedActualHash, sessionId: 'session-1',
    });
    const receipt = await fixture.writer.reconcile({
      proposalId: fixture.proposal.id, acceptanceId: acceptance.id, sessionId: 'session-1',
    });
    expect(store.get<Experiment>('experiment', fixture.proposal.id)).toBeUndefined();

    const skill = { id: 'skill-v1', version: 1, content: 'test', status: 'active' as const, createdAt: snapshot.createdAt, rationale: 'test' };
    const agent: AgentAdapter = { async run() { throw new Error('not used'); } };
    const service = new SiteOpsService({
      mode: 'live', siteUrl: 'https://example.test', store,
      provider: { async check() { throw new Error('not used'); }, async sync() { throw new Error('not used'); } },
      wordpress: fixture.adapter, writerStorage: fixture.storage, writer: fixture.writer,
      agent, agentMode: 'codex', skills: { list: () => [skill], active: () => skill },
      now: () => new Date('2026-10-24T00:00:00Z'),
    });
    await service.initialize();
    expect(store.get<Task>('task', task.id)).toMatchObject({
      status: 'completed', stage: 'WordPress format transformation accepted', updatedAt: receipt.createdAt,
    });
    expect(store.get<Experiment>('experiment', fixture.proposal.id)).toMatchObject({
      id: `experiment:${fixture.proposal.id}`, proposalId: fixture.proposal.id, postId: fixture.proposal.postId,
      expectedPostHash: review.reviewedActualHash, baselineClicks: 12, baselineSessions: 9,
      startDate: '2026-10-23', status: 'observing',
    });
    const beforeReplay = {
      proposal: JSON.stringify(await fixture.storage.getProposal(fixture.proposal.id)),
      task: JSON.stringify(store.get<Task>('task', task.id)),
      experiment: JSON.stringify(store.get<Experiment>('experiment', fixture.proposal.id)),
    };
    expect(await service.applyProposal(fixture.proposal.id, 'session-1', 'stale-approval')).toEqual(fixture.originalReceipt);
    expect({
      proposal: JSON.stringify(await fixture.storage.getProposal(fixture.proposal.id)),
      task: JSON.stringify(store.get<Task>('task', task.id)),
      experiment: JSON.stringify(store.get<Experiment>('experiment', fixture.proposal.id)),
    }).toEqual(beforeReplay);
    await expect(service.applyProposal(fixture.proposal.id, 'session-2', 'stale-approval'))
      .rejects.toMatchObject({ code: 'receipt_session_mismatch', httpStatus: 403 });
    expect(fixture.updates).toBe(0);
    await service.initialize();
    expect(store.list<Experiment>('experiment')).toHaveLength(1);
    expect(store.get<Experiment>('experiment', fixture.proposal.id)?.expectedPostHash).toBe(review.reviewedActualHash);
    const experiment = store.get<Experiment>('experiment', fixture.proposal.id)!;
    store.put('experiment', fixture.proposal.id, { ...experiment, expectedPostHash: 'conflicting-hash' });
    await expect(service.initialize()).rejects.toMatchObject({ code: 'experiment_repair_conflict' });
    expect(store.get<Experiment>('experiment', fixture.proposal.id)?.expectedPostHash).toBe('conflicting-hash');
    store.put('experiment', fixture.proposal.id, experiment);

    const rollbackApprovalId = await service.approveRollback(fixture.proposal.id, 'session-1');
    const rollbackReceipt = await service.rollbackProposal(fixture.proposal.id, 'session-1', rollbackApprovalId);
    expect(rollbackReceipt).toMatchObject({
      status: 'rolled_back', beforeHash: review.reviewedActualHash, afterHash: fixture.backup.stateHash,
    });
    expect(fixture.actual.bodyHtml).toBe(fixture.backup.post.bodyHtml);
    expect(await fixture.storage.getReceipt('apply', fixture.proposal.id)).toEqual(fixture.originalReceipt);
    const afterRollback = {
      proposal: JSON.stringify(await fixture.storage.getProposal(fixture.proposal.id)),
      task: JSON.stringify(store.get<Task>('task', task.id)),
      experiment: JSON.stringify(store.get<Experiment>('experiment', fixture.proposal.id)),
    };
    expect(await service.applyProposal(fixture.proposal.id, 'session-1', 'stale-approval')).toEqual(fixture.originalReceipt);
    await service.initialize();
    expect({
      proposal: JSON.stringify(await fixture.storage.getProposal(fixture.proposal.id)),
      task: JSON.stringify(store.get<Task>('task', task.id)),
      experiment: JSON.stringify(store.get<Experiment>('experiment', fixture.proposal.id)),
    }).toEqual(afterRollback);
    expect(fixture.updates).toBe(1);
  });
});

describe('reconciliation HTTP boundary', () => {
  it('requires the authenticated session and CSRF token and never accepts a client-supplied session id', async () => {
    const calls: Array<{ method: string; sessionId: string }> = [];
    const fakeService = {
      async prepareReconciliation(_proposalId: string, sessionId: string) {
        calls.push({ method: 'prepare', sessionId });
        return { id: 'review-1' };
      },
      async acceptReconciliation(_proposalId: string, sessionId: string) {
        calls.push({ method: 'accept', sessionId });
        return { id: 'acceptance-1' };
      },
      async reconcileProposal(_proposalId: string, sessionId: string) {
        calls.push({ method: 'reconcile', sessionId });
        return { id: 'receipt-1', status: 'verified_transformed' };
      },
    } as unknown as SiteOpsService;
    const holder: { app?: ReturnType<typeof createApp> } = {};
    const server = http.createServer((req, res) => holder.app?.(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      holder.app = createApp({
        service: fakeService,
        security: createSessionSecurity({ appOrigin: origin, bootstrapCode: 'reconcile-bootstrap' }),
        staticDir: path.join(root, 'missing-static'),
      });
      const unauthenticated = await fetch(`${origin}/api/proposals/proposal-1/reconcile-prepare`, {
        method: 'POST', headers: { origin },
      });
      expect(unauthenticated.status).toBe(401);

      const login = await fetch(`${origin}/api/session`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap: 'reconcile-bootstrap' }),
      });
      const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      const { csrf } = await login.json() as { csrf: string };
      const withoutCsrf = await fetch(`${origin}/api/proposals/proposal-1/reconcile-prepare`, {
        method: 'POST', headers: { origin, cookie },
      });
      expect(withoutCsrf.status).toBe(403);

      const request = (route: string, body?: object) => fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { origin, cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify({ ...body, sessionId: 'attacker-controlled' }) } : {}),
      });
      expect((await request('/api/proposals/proposal-1/reconcile-prepare')).status).toBe(200);
      expect((await request('/api/proposals/proposal-1/reconcile-accept', {
        reviewId: 'review-1', reviewedActualHash: 'a'.repeat(64),
      })).status).toBe(201);
      expect((await request('/api/proposals/proposal-1/reconcile', { acceptanceId: 'acceptance-1' })).status).toBe(200);
      expect(calls).toHaveLength(3);
      expect(new Set(calls.map((call) => call.sessionId)).size).toBe(1);
      expect(calls[0].sessionId).not.toBe('attacker-controlled');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
