import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, Settings, SkillVersion, Task } from '../packages/contracts.js';
import { SkillService } from '../apps/server/skills.js';
import { Store } from '../apps/server/store.js';

const stores: Store[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function sharedStores(): Promise<[Store, Store]> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-skill-security-'));
  roots.push(root);
  const filename = path.join(root, 'siteops.sqlite');
  const pair: [Store, Store] = [new Store(filename), new Store(filename)];
  stores.push(...pair);
  return pair;
}

const now = () => new Date('2026-10-23T02:00:00Z');
const settings: Settings = {
  timezone: 'Asia/Taipei', scheduleEnabled: false, dailyTime: '09:00', weeklyTime: 'Mon 09:30',
  maxOpportunities: 10, maxWeeklyProposals: 3, maxPendingTasks: 10, maxAgentRunsPerDay: 10,
};
const completedTask = (): Task => ({
  id: 'completed-task', postId: 101, title: 'Evidence', status: 'completed', stage: 'done',
  createdAt: now().toISOString(), updatedAt: now().toISOString(), skillVersion: 'siteops-editor-v1', snapshotId: 'snapshot',
});

describe('durable skill claims', () => {
  it('rejects an unsafe persisted cap or malformed counter before any reflection or claim mutation', async () => {
    const [store] = await sharedStores();
    store.put('settings', 'current', { ...settings, maxAgentRunsPerDay: 11 });
    store.put('task', 'completed-task', completedTask());
    const reflect = vi.fn(async () => ({
      content: 'Preserve facts and add one bounded reader-facing improvement supported by the supplied evidence only.',
      rationale: 'This must never run with an invalid quota state.',
    }));
    const service = new SkillService(store, { agent: { run: vi.fn() } as unknown as AgentAdapter, mode: 'live', reflect, now });
    await expect(service.propose()).rejects.toMatchObject({ code: 'daily_agent_limit' });
    expect(reflect).not.toHaveBeenCalled();
    expect(store.get('skill_reflection', 'lastAttempt')).toBeUndefined();
    expect(store.get('skill_calls', '2026-10-23')).toBeUndefined();

    store.put('settings', 'current', settings);
    for (const invalidCounter of [-1, '1']) {
      store.put('skill_calls', '2026-10-23', invalidCounter);
      await expect(service.propose()).rejects.toMatchObject({ code: 'daily_agent_limit' });
      expect(reflect).not.toHaveBeenCalled();
      expect(store.get('skill_reflection', 'lastAttempt')).toBeUndefined();
      expect(store.get('skill_calls', '2026-10-23')).toBe(invalidCounter);
    }
    store.remove('skill_calls', '2026-10-23');
    store.put('operator_job', 'weekly-skill:2026-10-16', { status: 'running' });
    await expect(service.propose()).rejects.toMatchObject({ code: 'weekly_skill_running' });
    expect(reflect).not.toHaveBeenCalled();
    expect(store.get('skill_reflection', 'lastAttempt')).toBeUndefined();
  });

  it('allows only one weekly reflection across two Store instances and reserves its call atomically', async () => {
    const [first, second] = await sharedStores();
    first.put('settings', 'current', settings);
    first.put('task', 'completed-task', completedTask());
    const reflect = vi.fn(async () => ({
      content: 'Preserve facts and add one bounded reader-facing improvement supported by the supplied evidence only.',
      rationale: 'This candidate is derived from completed task evidence and retains the existing safety boundaries.',
    }));
    const unusedAgent = { run: vi.fn() } as unknown as AgentAdapter;
    const one = new SkillService(first, { agent: unusedAgent, mode: 'live', reflect, now });
    const two = new SkillService(second, { agent: unusedAgent, mode: 'live', reflect, now });

    const results = await Promise.allSettled([one.propose(), two.propose()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(reflect).toHaveBeenCalledTimes(1);
    expect(first.get('skill_reflection', 'lastAttempt')).toBe(now().toISOString());
    expect(first.get('skill_calls', '2026-10-23')).toBe(1);
  });

  it('allows only one replay across two Store instances and counts task plus replay calls once', async () => {
    const [first, second] = await sharedStores();
    first.put('settings', 'current', settings);
    first.put('task', 'completed-task', completedTask());
    const candidate: SkillVersion = {
      id: 'candidate-v2', version: 2, status: 'candidate', createdAt: now().toISOString(),
      content: 'Preserve supported facts and make a bounded evidence-grounded improvement that helps the reader understand the page.',
      rationale: 'Candidate for atomic replay claim testing.',
    };
    first.put('skill', candidate.id, candidate);
    const run = vi.fn<AgentAdapter['run']>(async ({ input }) => ({
      bodyHtml: `${input.page.bodyHtml}<p>Evidence-grounded clarification for the reader.</p>`,
      summary: 'Adds a bounded clarification.', evidenceIds: input.opportunity.evidenceIds, skillVersion: input.skillVersion,
    }));
    const agent: AgentAdapter = { run };
    const one = new SkillService(first, { agent, mode: 'demo', now });
    const two = new SkillService(second, { agent, mode: 'demo', now });

    const results = await Promise.allSettled([one.evaluate(candidate.id), two.evaluate(candidate.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(3);
    expect(first.get('skill_replay', candidate.id)).toEqual({ startedAt: now().toISOString() });
    expect(first.get('skill_calls', '2026-10-23')).toBe(3);
    expect(first.list<Task>('task')).toHaveLength(1);
  });
});
