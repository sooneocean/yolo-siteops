import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../packages/contracts.js';
import { DemoAgentAdapter } from '../apps/server/agent/index.js';
import { DemoDataProvider, DemoWordPressAdapter } from '../apps/server/demo-wordpress.js';
import { runScheduledTick } from '../apps/server/scheduler.js';
import { SiteOpsService } from '../apps/server/service.js';
import { SkillService } from '../apps/server/skills.js';
import { Store } from '../apps/server/store.js';
import { WriterService } from '../apps/server/writer/service.js';
import { SQLiteWriterStorage } from '../apps/server/writer-store.js';
import { executeLifecycleWithAdapter, runWeeklySkill, type WeeklyDependencies } from '../scripts/weekly-skill.js';
import { inspectPipelineStatus } from '../scripts/pipeline-status.js';

// Readiness unit: SITEOPS-PIPELINE-20261023-01. No external calls or real model.
const monday = new Date('2026-10-26T02:30:00Z');
const now = () => new Date(monday);
const stores: Store[] = [];
const roots: string[] = [];
afterEach(async () => {
  stores.splice(0).forEach(store => store.close());
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-pipeline-')));
  roots.push(root);
  const databasePath = path.join(root, 'siteops.sqlite');
  const store = new Store(databasePath);
  stores.push(store);
  const wordpress = new DemoWordPressAdapter(store, now);
  const mutation = vi.spyOn(wordpress, 'updateBody');
  const provider = new DemoDataProvider(wordpress, now);
  const sync = vi.spyOn(provider, 'sync');
  const agent = new DemoAgentAdapter();
  const runs = vi.spyOn(agent, 'run');
  const writerStorage = new SQLiteWriterStorage(store);
  const writer = new WriterService({ storage: writerStorage, adapter: wordpress,
    siteOrigin: 'https://example.test', lockPath: path.join(root, 'writer.lock'), now });
  const skills = new SkillService(store, { agent, mode: 'demo', now });
  const service = new SiteOpsService({ mode: 'demo', siteUrl: 'https://example.test', store,
    provider, wordpress, writerStorage, writer, agent, agentMode: 'demo', skills, now });
  const forbidden = [
    vi.spyOn(service, 'approveProposal'), vi.spyOn(service, 'applyProposal'),
    vi.spyOn(service, 'approveRollback'), vi.spyOn(service, 'rollbackProposal'),
    vi.spyOn(service, 'prepareReconciliation'), vi.spyOn(service, 'acceptReconciliation'),
    vi.spyOn(service, 'reconcileProposal'), vi.spyOn(service, 'activateSkill'),
    vi.spyOn(skills, 'activate'),
  ];
  await service.initialize();
  const baselineId = skills.active().id;
  const privateBefore = JSON.stringify(store.list('private_wp_snapshot'));
  sync.mockClear();
  service.updateSettings({ scheduleEnabled: true });
  // Reflection learns from earlier terminal evidence, not from approving new articles.
  store.put<Task>('task', 'previous-terminal', { id: 'previous-terminal', postId: 999,
    title: 'Synthetic earlier failure', status: 'failed', stage: 'Finished',
    createdAt: '2026-10-18T02:00:00Z', updatedAt: '2026-10-18T02:00:01Z',
    skillVersion: baselineId, snapshotId: 'previous-snapshot' });
  return { root, databasePath, store, service, wordpress, mutation, sync, runs,
    agent, skills, baselineId, privateBefore, forbidden };
}

async function settle(service: SiteOpsService) {
  await vi.waitFor(() => {
    expect(service.state().tasks.some(task => ['running', 'queued'].includes(task.status))).toBe(false);
  }, { timeout: 5_000, interval: 5 });
}

describe('complete proposal-only operations pipeline', () => {
  it('runs daily analysis, weekly proposals and prepaid Skill replay once with no article mutations', async () => {
    const f = await fixture();
    await runScheduledTick({ store: f.store, service: f.service, now: monday });
    await settle(f.service);
    expect(f.sync).toHaveBeenCalledTimes(1);
    expect(f.runs).toHaveBeenCalledTimes(3);
    expect(f.service.state().proposals).toHaveLength(3);
    expect(f.service.state().proposals.every(proposal => proposal.status === 'pending')).toBe(true);
    expect(f.service.state().tasks.filter(task => task.status === 'waiting_approval')).toHaveLength(3);
    expect(f.service.state().opportunities).toHaveLength(3);

    const reflect = vi.fn(async () => {
      expect(f.store.get('skill_calls', '2026-10-26')).toBe(4);
      return { content: 'Preserve the evidence boundary and original facts. Improve one supported explanation and retain existing useful content for human review.',
        rationale: 'A synthetic reflection on earlier terminal tasks; no traffic outcome is inferred.' };
    });
    const deps: WeeklyDependencies = { databasePath: f.databasePath, now,
      appHealthy: async () => true, codexCommandReady: async () => true,
      lifecycle: async (store, time, capability, signal) => {
        return executeLifecycleWithAdapter(store, time, { run: f.agent.run.bind(f.agent), reflect }, capability, signal);
      },
    };
    const checked = await runWeeklySkill('check', deps);
    expect(checked.eligible).toBe(true);
    const result = await runWeeklySkill('run', deps);
    expect(result.status).toBe('completed');
    expect(result.evaluationStatus).toBe('passed');
    expect(result.modelCalls).toBe(4);
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(f.runs).toHaveBeenCalledTimes(6);
    expect(f.skills.active().id).toBe(f.baselineId);
    expect(f.skills.list().filter(skill => skill.status === 'evaluated')).toHaveLength(1);
    expect(f.store.get('skill_calls', '2026-10-26')).toBe(4);

    const beforeInspection = f.store.db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all();
    await inspectPipelineStatus({ databasePath: f.databasePath, now: monday });
    expect(f.store.db.prepare('SELECT kind,id,value FROM records ORDER BY kind,id').all()).toEqual(beforeInspection);
    await runScheduledTick({ store: f.store, service: f.service, now: monday });
    expect((await runWeeklySkill('run', deps)).claimed).toBe(false);
    expect(f.sync).toHaveBeenCalledTimes(1);
    expect(f.runs).toHaveBeenCalledTimes(6);
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(f.service.state().proposals).toHaveLength(3);
    expect(JSON.stringify(f.store.list('private_wp_snapshot'))).toBe(f.privateBefore);
    expect(f.mutation).not.toHaveBeenCalled();
    f.forbidden.forEach(spy => expect(spy).not.toHaveBeenCalled());
    for (const kind of ['writer_approval', 'writer_backup', 'writer_receipt', 'writer_reconciliation_review', 'writer_reconciliation_acceptance']) {
      expect(f.store.list(kind)).toEqual([]);
    }
  });
});
