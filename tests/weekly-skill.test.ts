import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, Settings, SkillVersion, Snapshot, Task } from '../packages/contracts.js';
import type { ReflectionEvidence } from '../apps/server/skills.js';
import { Store } from '../apps/server/store.js';
import {
  executeLifecycleWithAdapter, loadWeeklyEnvironment, runWeeklySkill,
} from '../scripts/weekly-skill.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

const now = new Date('2026-10-26T02:30:00.000Z');
const settings: Settings = {
  timezone: 'Asia/Taipei', scheduleEnabled: true, dailyTime: '09:00', weeklyTime: 'Mon 09:30',
  maxOpportunities: 10, maxWeeklyProposals: 3, maxPendingTasks: 10, maxAgentRunsPerDay: 10,
};

async function fixture(): Promise<{ root: string; databasePath: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-weekly-')));
  roots.push(root);
  const databasePath = path.join(root, 'siteops.sqlite');
  const store = new Store(databasePath);
  const snapshot = {
    id: 'snapshot', createdAt: now.toISOString(),
    evidence: [{ id: 'gsc', source: 'gsc', complete: true }],
  } as Snapshot;
  const task: Task = {
    id: 'done', postId: 1, title: 'CANARY_PRIVATE_TITLE', status: 'completed', stage: 'done',
    createdAt: now.toISOString(), updatedAt: now.toISOString(), skillVersion: 'siteops-editor-v1', snapshotId: snapshot.id,
  };
  const skill: SkillVersion = {
    id: 'siteops-editor-v1', version: 1, status: 'active', createdAt: now.toISOString(),
    content: 'Preserve supported facts and useful existing content. Make one bounded improvement.',
    rationale: 'Baseline.',
  };
  store.put('settings', 'current', settings);
  store.put('schedule', 'daily:2026-10-26', { status: 'completed', at: now.toISOString() });
  store.put('schedule', 'weekly:2026-10-26', { status: 'completed', at: now.toISOString() });
  store.put('snapshot', 'current', snapshot);
  store.put('task', task.id, task);
  store.put('skill', skill.id, skill);
  for (const id of ['wordpress', 'gsc', 'ga4']) store.put('connection', id, { id, status: 'ready' });
  store.put('connection', 'codex', { id: 'codex', status: 'ready' });
  store.close();
  return { root, databasePath };
}

function successfulAdapter() {
  const run = vi.fn<AgentAdapter['run']>(async ({ input }) => ({
    bodyHtml: `${input.page.bodyHtml}<p>Evidence-grounded clarification for the reader.</p>`,
    summary: 'Adds one bounded clarification.', evidenceIds: input.opportunity.evidenceIds, skillVersion: input.skillVersion,
  }));
  const reflect = vi.fn(async (_evidence: ReflectionEvidence, _signal: AbortSignal) => ({
    content: 'Preserve facts and add one bounded reader-facing improvement supported by supplied evidence only.',
    rationale: 'Retains the fixed safety boundaries while clarifying editorial guidance.',
  }));
  return { run, reflect };
}

const dependencies = (databasePath: string) => ({
  databasePath, now: () => new Date(now), appHealthy: async () => true, codexCommandReady: async () => true,
});

describe('weekly skill atomic reservation', () => {
  it('lets one of two independent callers reserve exactly four calls without activating the candidate', async () => {
    const { databasePath } = await fixture();
    const adapters = [successfulAdapter(), successfulAdapter()];
    const runs = adapters.map(adapter => runWeeklySkill('run', {
      ...dependencies(databasePath),
      lifecycle: (store, at, prepaid, signal) => executeLifecycleWithAdapter(store, at, adapter, prepaid, signal, 1000),
    }));
    const results = await Promise.all(runs);
    expect(results.filter(result => result.status === 'completed')).toHaveLength(1);
    expect(results.filter(result => result.status === 'skipped')).toHaveLength(1);
    const store = new Store(databasePath);
    expect(store.get('skill_calls', '2026-10-26')).toBe(4);
    expect(store.list<SkillVersion>('skill').filter(skill => skill.status === 'active').map(skill => skill.id)).toEqual(['siteops-editor-v1']);
    expect(store.list<SkillVersion>('skill').filter(skill => skill.status === 'evaluated')).toHaveLength(1);
    expect(store.get<{ status: string; reflectionRemaining: number; replayRemaining: number }>('skill_reservation', 'weekly-skill:2026-10-26'))
      .toMatchObject({ status: 'completed', reflectionRemaining: 0, replayRemaining: 0 });
    store.close();
    expect(adapters.reduce((total, adapter) => total + adapter.reflect.mock.calls.length + adapter.run.mock.calls.length, 0)).toBe(4);
  });

  it('stops after a hung reflection, retains the charge, and never reruns a failed weekly claim', async () => {
    const { databasePath } = await fixture();
    const run = vi.fn<AgentAdapter['run']>();
    const reflect = vi.fn(async (_evidence: ReflectionEvidence, _signal: AbortSignal) => await new Promise<never>(() => undefined));
    const adapter = { run, reflect };
    const startedAt = Date.now();
    const first = await runWeeklySkill('run', {
      ...dependencies(databasePath), callTimeoutMs: 10, overallTimeoutMs: 100,
      lifecycle: (store, at, prepaid, signal) => executeLifecycleWithAdapter(store, at, adapter, prepaid, signal, 10),
    });
    expect(first).toMatchObject({ claimed: true, status: 'failed', failureCode: 'agent_timeout' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    const second = await runWeeklySkill('run', dependencies(databasePath));
    expect(second).toMatchObject({ claimed: false, status: 'skipped' });
    const store = new Store(databasePath);
    expect(store.get('skill_calls', '2026-10-26')).toBe(4);
    expect(store.get<{ status: string }>('operator_job', 'weekly-skill:2026-10-26')?.status).toBe('failed');
    expect(store.list<SkillVersion>('skill')).toHaveLength(1);
    store.close();
  });

  it('does not continue to another replay after a replay call times out', async () => {
    const { databasePath } = await fixture();
    const good = successfulAdapter();
    good.run.mockImplementation(async () => await new Promise<never>(() => undefined));
    const startedAt = Date.now();
    const result = await runWeeklySkill('run', {
      ...dependencies(databasePath), callTimeoutMs: 10, overallTimeoutMs: 100,
      lifecycle: (store, at, prepaid, signal) => executeLifecycleWithAdapter(store, at, good, prepaid, signal, 10),
    });
    expect(result).toMatchObject({ claimed: true, status: 'failed', failureCode: 'agent_timeout' });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(good.reflect).toHaveBeenCalledTimes(1);
    expect(good.run).toHaveBeenCalledTimes(1);
    const store = new Store(databasePath);
    expect(store.list<SkillVersion>('skill').filter(skill => skill.status === 'evaluated')).toEqual([]);
    expect(store.get('skill_calls', '2026-10-26')).toBe(4);
    store.close();
  });

  it('does not persist a candidate when an adapter returns only after the overall deadline', async () => {
    const { databasePath } = await fixture();
    const run = vi.fn<AgentAdapter['run']>();
    const reflect = vi.fn(async (_evidence: ReflectionEvidence, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return {
        content: 'Preserve facts and add one bounded reader-facing improvement supported by supplied evidence only.',
        rationale: 'This late value must not cross the overall deadline boundary.',
      };
    });
    const result = await runWeeklySkill('run', {
      ...dependencies(databasePath), callTimeoutMs: 100, overallTimeoutMs: 10,
      lifecycle: (store, at, prepaid, signal) => executeLifecycleWithAdapter(store, at, { run, reflect }, prepaid, signal, 100),
    });
    expect(result).toMatchObject({ status: 'failed', failureCode: 'agent_timeout' });
    expect(run).not.toHaveBeenCalled();
    const store = new Store(databasePath);
    expect(store.list<SkillVersion>('skill')).toHaveLength(1);
    expect(store.get('skill_calls', '2026-10-26')).toBe(4);
    store.close();
  });

  it('rejects partial evidence, a future snapshot, and any legacy record at the weekly job key', async () => {
    const { databasePath } = await fixture();
    const store = new Store(databasePath);
    const snapshot = store.get<Record<string, unknown>>('snapshot', 'current')!;
    store.put('snapshot', 'current', { ...snapshot, createdAt: '2026-10-26T03:30:00.000Z', evidence: [{ id: 'gsc', source: 'gsc', complete: false }] });
    let check = await runWeeklySkill('check', dependencies(databasePath));
    expect(check.eligible).toBe(false);
    expect(check.reasons).toEqual(expect.arrayContaining(['snapshotFresh', 'completeGscEvidence']));
    store.put('snapshot', 'current', { ...snapshot, createdAt: now.toISOString(), evidence: [{ id: 'gsc', source: 'gsc', complete: true }] });
    store.put('operator_job', 'weekly-skill:2026-10-26', { status: 'failed' });
    store.close();
    check = await runWeeklySkill('check', dependencies(databasePath));
    expect(check.eligible).toBe(false);
    expect(check.reasons).toContain('noPriorWeeklyClaim');
  });

  it('blocks prior-week running or malformed jobs, but not prior terminal jobs', async () => {
    const { databasePath } = await fixture();
    const store = new Store(databasePath);
    store.put('operator_job', 'weekly-skill:2026-10-19', { status: 'running' });
    let check = await runWeeklySkill('check', dependencies(databasePath));
    expect(check.eligible).toBe(false);
    expect(check.reasons).toContain('noBlockingWeeklyJob');
    store.put('operator_job', 'weekly-skill:2026-10-19', { status: 'failed' });
    check = await runWeeklySkill('check', dependencies(databasePath));
    expect(check.eligible).toBe(true);
    store.db.prepare("UPDATE records SET value='not-json' WHERE kind='operator_job' AND id='weekly-skill:2026-10-19'").run();
    store.close();
    check = await runWeeklySkill('check', dependencies(databasePath));
    expect(check.eligible).toBe(false);
    expect(check.reasons).toContain('noBlockingWeeklyJob');
  });

  it.each([11, -1, '4'])('rejects invalid persisted quota state without a claim or model call: %s', async invalid => {
    const { databasePath } = await fixture();
    const store = new Store(databasePath);
    if (invalid === 11) {
      store.put('settings', 'current', { ...settings, maxAgentRunsPerDay: invalid });
    } else {
      store.put('skill_calls', '2026-10-26', invalid);
    }
    store.close();
    const lifecycle = vi.fn();
    const result = await runWeeklySkill('run', { ...dependencies(databasePath), lifecycle });
    expect(result).toMatchObject({ claimed: false, status: 'skipped' });
    expect(result.reasons).toContain('callCapacityReady');
    expect(lifecycle).not.toHaveBeenCalled();
    const readback = new Store(databasePath);
    expect(readback.get('operator_job', 'weekly-skill:2026-10-26')).toBeUndefined();
    expect(readback.get('skill_reflection', 'lastAttempt')).toBeUndefined();
    readback.close();
  });
});

describe('weekly CLI trust boundary', () => {
  it('requires canonical paths, schema v1, a strict port, and a safe executable target', async () => {
    const { root } = await fixture();
    const command = path.join(root, 'codex');
    await fs.writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const commandLink = path.join(root, 'codex-link');
    await fs.symlink(command, commandLink);
    expect(loadWeeklyEnvironment({ SITEOPS_DATA_DIR: root, SITEOPS_PORT: '4327', SITEOPS_CODEX_COMMAND: command }))
      .toMatchObject({ dataDir: root, port: 4327, codexCommand: command });
    expect(loadWeeklyEnvironment({ SITEOPS_DATA_DIR: root, SITEOPS_PORT: '4327', SITEOPS_CODEX_COMMAND: commandLink }).codexCommand).toBe(command);
    expect(() => loadWeeklyEnvironment({})).toThrow();
    expect(() => loadWeeklyEnvironment({ SITEOPS_DATA_DIR: root, SITEOPS_PORT: '0', SITEOPS_CODEX_COMMAND: command })).toThrow();
    expect(() => loadWeeklyEnvironment({ SITEOPS_DATA_DIR: `${root}/.`, SITEOPS_PORT: '4327', SITEOPS_CODEX_COMMAND: command })).toThrow();
    await fs.chmod(command, 0o722);
    expect(() => loadWeeklyEnvironment({ SITEOPS_DATA_DIR: root, SITEOPS_PORT: '4327', SITEOPS_CODEX_COMMAND: command })).toThrow();
    await fs.chmod(command, 0o700);
    const store = new Store(path.join(root, 'siteops.sqlite'));
    store.db.exec('UPDATE schema_version SET version=2');
    store.close();
    expect(() => loadWeeklyEnvironment({ SITEOPS_DATA_DIR: root, SITEOPS_PORT: '4327', SITEOPS_CODEX_COMMAND: command })).toThrow();
  });
});
