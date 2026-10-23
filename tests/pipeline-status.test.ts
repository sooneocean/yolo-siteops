import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../apps/server/store.js';
import { inspectPipelineStatus, runPipelineStatusCli } from '../scripts/pipeline-status.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function recordsHash(store: Store): string {
  const rows = store.db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function fixture(): Promise<{ root: string; databasePath: string; before: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-status-')));
  roots.push(root);
  const databasePath = path.join(root, 'siteops.sqlite');
  const store = new Store(databasePath);
  const at = '2026-10-26T02:30:00.000Z';
  store.put('settings', 'current', { maxAgentRunsPerDay: 10, secret: 'CANARY_SETTINGS_EXTRA' });
  store.put('connection', 'wordpress', { id: 'wordpress', status: 'ready', checkedAt: 'CANARY_CHECKED_AT', message: 'CANARY_CONNECTION_MESSAGE' });
  store.put('connection', 'gsc', { id: 'gsc', status: 'ready', checkedAt: at, message: 'CANARY_GSC_MESSAGE' });
  store.put('connection', 'ga4', { id: 'ga4', status: 'ready', checkedAt: at, message: 'CANARY_GA4_MESSAGE' });
  store.put('connection', 'codex', { id: 'codex', status: 'ready', checkedAt: at, message: 'CANARY_CODEX_MESSAGE' });
  store.put('snapshot', 'current', {
    id: 'snapshot', createdAt: at, mode: 'live', warnings: ['CANARY_SNAPSHOT_WARNING'],
    evidence: [
      { id: 'gsc-complete', source: 'gsc', startDate: 'CANARY_START_DATE', endDate: '2026-10-23', timeZone: 'CANARY_TIMEZONE', complete: true, coverage: 'CANARY_COVERAGE' },
      { id: 'ga4-complete', source: 'ga4', startDate: '2026-09-25', endDate: '2026-10-23', timeZone: 'Asia/Taipei', complete: true, coverage: 'valid landing page totals' },
    ],
    pages: [{ postId: 1, title: 'CANARY_PAGE_TITLE', url: 'https://private/CANARY_URL', bodyHtml: 'CANARY_BODY', protectedHash: 'CANARY_HASH' }],
    search: [
      { postId: 1, query: 'bounded query', clicks: 10, previousClicks: 30, impressions: 500, position: 8, evidenceId: 'gsc-complete' },
      { postId: 1, query: 'CANARY_PARTIAL_QUERY', clicks: 9999, previousClicks: 0, impressions: 9999, position: 1, evidenceId: 'gsc-partial' },
    ],
    pageMetrics: [{ postId: 1, clicks: 10, previousClicks: 30, impressions: 500, position: 8, evidenceId: 'gsc-complete' }],
    analytics: [{ postId: 1, sessions: 20, engagedSessions: 12, measurementValid: true, evidenceId: 'ga4-complete' }],
  });
  store.put('task', 'task-1', { status: 'failed', createdAt: at, errorCode: 'agent_timeout', title: 'CANARY_TASK_TITLE', error: 'CANARY_TASK_ERROR' });
  store.put('proposal', 'proposal-1', { status: 'pending', beforeHtml: 'CANARY_BEFORE', afterHtml: 'CANARY_AFTER', summary: 'CANARY_SUMMARY', title: 'CANARY_PROPOSAL_TITLE', url: 'CANARY_PROPOSAL_URL', error: 'CANARY_PROPOSAL_ERROR' });
  store.put('skill', 'skill-1', { status: 'active', content: 'CANARY_SKILL_CONTENT', rationale: 'CANARY_RATIONALE', evaluation: { failures: ['CANARY_FAILURE'] } });
  store.put('skill', 'malformed-status', { status: 'constructor', content: 'CANARY_MALFORMED_SKILL' });
  store.put('schedule', 'daily:2026-10-26', { status: 'completed', at: 'CANARY_SCHEDULE_AT' });
  store.put('schedule', 'weekly:2026-10-26', { status: 'completed', at });
  store.put('scheduler_health', 'current', { status: 'ok', at: 'CANARY_HEALTH_AT', error: 'CANARY_SCHEDULER_ERROR' });
  store.put('private_wp_snapshot', '1', { bodyHtml: 'CANARY_PRIVATE_SNAPSHOT' });
  store.put('writer_backup', '1', { bodyHtml: 'CANARY_WRITER_BACKUP' });
  store.put('writer_receipt', '1', { message: 'CANARY_WRITER_RECEIPT' });
  store.db.prepare("INSERT INTO records(kind,id,value) VALUES('proposal','malformed','CANARY_MALFORMED_RAW')").run();
  store.db.prepare("INSERT INTO records(kind,id,value) VALUES('operator_job','weekly-skill:2026-10-19','CANARY_WEEKLY_RAW')").run();
  const before = recordsHash(store);
  store.close();
  return { root, databasePath, before };
}

describe('read-only pipeline status', () => {
  it('returns the fixed allowlisted aggregate without private fields and does not mutate records', async () => {
    const { databasePath, before } = await fixture();
    const status = inspectPipelineStatus({ databasePath, now: new Date('2026-10-26T02:30:00.000Z') });
    expect(Object.keys(status)).toEqual([
      'schemaVersion', 'generatedAt', 'state', 'period', 'connections', 'gsc', 'ga4', 'scheduler',
      'tasks', 'proposals', 'skills', 'quota', 'weeklyJob', 'blockingWeeklyRun', 'failureCode',
    ]);
    expect(status.state).toBe('fresh');
    expect(status.blockingWeeklyRun).toBe(true);
    expect(status.gsc).toMatchObject({
      pages: [{ postId: 1, clicks: 10, previousClicks: 30, impressions: 500, position: 8 }],
      opportunities: [{ postId: 1, queries: ['bounded query'], measurementQuality: 'available' }],
    });
    expect(status.tasks).toMatchObject({ total: 1, counts: { failed: 1 }, failureCodes: { agent_timeout: 1 } });
    expect(status.proposals).toMatchObject({ total: 1, pendingHumanConfirmation: 1 });
    expect((status.period as { coverage: unknown[] }).coverage[0]).toEqual({
      source: 'gsc', startDate: 'unknown', endDate: '2026-10-23', timeZone: 'unknown',
      complete: true, coverage: 'Search Console 頁面彙總與有界查詢樣本。',
    });
    expect((status.connections as Array<Record<string, unknown>>).find(item => item.id === 'wordpress')).toEqual({ id: 'wordpress', status: 'ready' });
    expect(status.scheduler).toMatchObject({ daily: { key: 'daily:2026-10-26', status: 'completed' }, health: { status: 'ok' } });
    expect(Object.keys((status.skills as { counts: Record<string, number> }).counts)).toEqual([
      'candidate', 'evaluated', 'active', 'retired',
    ]);
    const output = JSON.stringify(status);
    for (const canary of [
      'CANARY_SETTINGS_EXTRA', 'CANARY_CHECKED_AT', 'CANARY_CONNECTION_MESSAGE', 'CANARY_GSC_MESSAGE', 'CANARY_GA4_MESSAGE',
      'CANARY_CODEX_MESSAGE', 'CANARY_SNAPSHOT_WARNING', 'CANARY_PAGE_TITLE', 'CANARY_URL', 'CANARY_BODY',
      'CANARY_HASH', 'CANARY_START_DATE', 'CANARY_TIMEZONE', 'CANARY_COVERAGE', 'CANARY_SCHEDULE_AT', 'CANARY_HEALTH_AT',
      'CANARY_PARTIAL_QUERY', 'CANARY_TASK_TITLE', 'CANARY_TASK_ERROR', 'CANARY_BEFORE',
      'CANARY_AFTER', 'CANARY_SUMMARY', 'CANARY_PROPOSAL_TITLE', 'CANARY_PROPOSAL_URL', 'CANARY_PROPOSAL_ERROR',
      'CANARY_SKILL_CONTENT', 'CANARY_RATIONALE', 'CANARY_FAILURE', 'CANARY_MALFORMED_SKILL', 'CANARY_SCHEDULER_ERROR',
      'CANARY_PRIVATE_SNAPSHOT', 'CANARY_WRITER_BACKUP', 'CANARY_WRITER_RECEIPT', 'CANARY_MALFORMED_RAW', 'CANARY_WEEKLY_RAW',
    ]) expect(output).not.toContain(canary);
    const reopened = new Store(databasePath);
    expect(recordsHash(reopened)).toBe(before);
    reopened.close();
  });

  it('fails without echoing an invalid private path', () => {
    const privatePath = '/private/CANARY_DO_NOT_ECHO';
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runPipelineStatusCli({ SITEOPS_DATA_DIR: privatePath })).toBe(1);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(privatePath);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(privatePath);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      schemaVersion: 1, state: 'unavailable', failureCode: 'inspection_unavailable',
      gsc: { pages: [], opportunities: [] }, weeklyJob: null, blockingWeeklyRun: 'unknown',
    });
  });

  it('fails closed for partial or future evidence, live snapshots without page totals, and malformed quota', async () => {
    const { databasePath } = await fixture();
    const store = new Store(databasePath);
    const snapshot = store.get<Record<string, unknown>>('snapshot', 'current')!;
    store.put('snapshot', 'current', { ...snapshot, pageMetrics: undefined });
    let status = inspectPipelineStatus({ databasePath, now: new Date('2026-10-26T02:30:00.000Z') });
    expect(status.gsc).toMatchObject({ pages: [], opportunities: [] });
    store.put('snapshot', 'current', { ...snapshot, mode: undefined, pageMetrics: undefined });
    status = inspectPipelineStatus({ databasePath, now: new Date('2026-10-26T02:30:00.000Z') });
    expect(status).toMatchObject({ state: 'unavailable', gsc: { pages: [], opportunities: [] } });
    store.put('snapshot', 'current', { ...snapshot, createdAt: '2026-10-26T03:30:00.000Z' });
    status = inspectPipelineStatus({ databasePath, now: new Date('2026-10-26T02:30:00.000Z') });
    expect(status.state).toBe('unavailable');
    store.put('snapshot', 'current', {
      ...snapshot,
      createdAt: 'CANARY_CREATED_AT',
      evidence: [{ id: 'partial', source: 'gsc', complete: false, coverage: 'partial' }],
    });
    store.put('skill_calls', '2026-10-26', 'malformed');
    store.put('settings', 'current', { maxAgentRunsPerDay: 11 });
    status = inspectPipelineStatus({ databasePath, now: new Date('2026-10-26T02:30:00.000Z') });
    expect(status.state).toBe('unavailable');
    expect(JSON.stringify(status)).not.toContain('CANARY_CREATED_AT');
    expect(status.gsc).toMatchObject({ pages: [], opportunities: [] });
    expect(status.quota).toMatchObject({ maxAgentRuns: 'unknown', skillCalls: 'unknown', remaining: 'unknown' });
    store.put('skill_calls', '2026-10-26', -1);
    status = inspectPipelineStatus({ databasePath, now: new Date('2026-10-26T02:30:00.000Z') });
    expect(status.quota).toMatchObject({ maxAgentRuns: 'unknown', skillCalls: 'unknown', remaining: 'unknown' });
    store.close();
  });
});
