import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeDemoSnapshot } from '../apps/server/demo.js';
import { DemoDataProvider, DemoWordPressAdapter } from '../apps/server/demo-wordpress.js';
import { StoreSkillSource } from '../apps/server/service.js';
import { Store } from '../apps/server/store.js';
import type { Settings, Task } from '../packages/contracts.js';

// Readiness unit: SITEOPS-PIPELINE-20261023-01.
const monday = new Date('2026-10-26T02:30:00Z');
const children: ChildProcess[] = [];
const roots: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  children.splice(0).forEach(child => { if (child.exitCode === null) child.kill('SIGTERM'); });
  stores.splice(0).forEach(store => store.close());
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function sharedFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-process-race-')));
  roots.push(root);
  const databasePath = path.join(root, 'siteops.sqlite');
  const store = new Store(databasePath);
  stores.push(store);
  const settings: Settings = { timezone: 'Asia/Taipei', scheduleEnabled: true,
    dailyTime: '09:00', weeklyTime: 'Mon 09:30', maxOpportunities: 10,
    maxWeeklyProposals: 3, maxPendingTasks: 10, maxAgentRunsPerDay: 4 };
  store.put('settings', 'current', settings);
  const baseline = new StoreSkillSource(store, () => monday).active();
  const wordpress = new DemoWordPressAdapter(store, () => monday);
  const provider = new DemoDataProvider(wordpress, () => monday);
  const snapshot = await provider.sync();
  store.put('snapshot', 'current', snapshot);
  store.put('snapshot', snapshot.id, snapshot);
  store.put('schedule', 'daily:2026-10-26', { status: 'completed', at: monday.toISOString() });
  store.put('schedule', 'weekly:2026-10-26', { status: 'completed', at: monday.toISOString() });
  for (const id of ['wordpress', 'gsc', 'ga4', 'codex']) store.put('connection', id, { id, status: 'ready' });
  store.put<Task>('task', 'previous', { id: 'previous', postId: 999, status: 'failed', title: 'Synthetic earlier task',
    stage: 'Finished', createdAt: '2026-10-18T02:00:00Z', updatedAt: '2026-10-18T02:00:00Z',
    skillVersion: baseline.id, snapshotId: makeDemoSnapshot(monday).id });
  return { store, databasePath, baselineId: baseline.id };
}

function contender(databasePath: string, role: 'weekly' | 'task') {
  const child = fork(fileURLToPath(new URL('./fixtures/pipeline-race-child.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    env: { PATH: process.env.PATH, SITEOPS_FIXTURE_DB: databasePath, SITEOPS_FIXTURE_ROLE: role },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', data => { stderr += String(data); });
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', message => { if ((message as { type?: string }).type === 'ready') resolve(); });
    child.once('error', () => reject(new Error('race_child_failed')));
    child.once('exit', code => { if (code && code !== 0) reject(new Error('race_child_exited')); });
  });
  const result = new Promise<{ won: boolean; claimed: boolean }>((resolve, reject) => {
    child.on('message', message => {
      const value = message as { type?: string; won?: boolean; claimed?: boolean };
      if (value.type === 'result') resolve({ won: value.won === true, claimed: value.claimed === true });
    });
    child.once('error', () => reject(new Error('race_child_failed')));
    child.once('exit', code => { if (code && code !== 0) reject(new Error('race_child_exited')); });
  });
  return { child, ready, result, stderr: () => stderr };
}

describe('cross-process pipeline reservations', () => {
  it.each(['weekly', 'task'] as const)('serializes weekly versus %s at the same start barrier', async role => {
    const f = await sharedFixture();
    const first = contender(f.databasePath, 'weekly');
    const second = contender(f.databasePath, role);
    await Promise.all([first.ready, second.ready]);
    first.child.send('start');
    second.child.send('start');
    const results = await Promise.all([first.result, second.result]);
    expect(results.filter(result => result.won)).toHaveLength(1);
    expect(results.filter(result => result.claimed).length).toBeLessThanOrEqual(1);
    const tasksToday = f.store.list<Task>('task').filter(task => task.createdAt.startsWith('2026-10-26')).length;
    const calls = f.store.get<number>('skill_calls', '2026-10-26') ?? 0;
    expect(tasksToday + calls).toBeLessThanOrEqual(4);
    if (calls) expect(calls).toBe(4);
    expect(new StoreSkillSource(f.store).active().id).toBe(f.baselineId);
    expect(f.store.list('writer_approval')).toEqual([]);
    expect(f.store.list('writer_backup')).toEqual([]);
    expect(f.store.list('writer_receipt')).toEqual([]);
    expect(first.stderr() + second.stderr()).not.toContain('PRIVATE_CANARY');
  });
});
