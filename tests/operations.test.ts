import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState, Task } from '../packages/contracts.js';
import { DemoAgentAdapter } from '../apps/server/agent/index.js';
import { makeDemoSnapshot } from '../apps/server/demo.js';
import { rankOpportunities } from '../apps/server/opportunities.js';
import { runScheduledTick } from '../apps/server/scheduler.js';
import { SkillService } from '../apps/server/skills.js';
import { Store } from '../apps/server/store.js';

const stores: Store[] = [];
const db = () => { const store = new Store(':memory:'); stores.push(store); return store; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('evidence boundaries', () => {
  it('uses independent page totals and does not guess live totals from visible queries', () => {
    const snapshot = makeDemoSnapshot();
    snapshot.mode = 'live';
    expect(rankOpportunities(snapshot)).toEqual([]);
    snapshot.pageMetrics = [{ ...snapshot.search[0], clicks: 400, impressions: 4000, previousClicks: 800 }];
    const ranked = rankOpportunities(snapshot);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].clicks).toBe(400);
    snapshot.evidence[0].complete = false;
    expect(rankOpportunities(snapshot)).toEqual([]);
  });
  it('keeps audience interpretation hypothetical and quality unknown without valid measurement', () => {
    const snapshot = makeDemoSnapshot();
    snapshot.analytics.forEach(row => { row.measurementValid = false; });
    const [opportunity] = rankOpportunities(snapshot);
    expect(opportunity.quality).toBe('unknown');
    expect(opportunity.audienceHypothesis).toContain('需以內容與後續觀察驗證');
    expect(opportunity.keywordHypotheses).toEqual([]);
  });
});

describe('skill lifecycle', () => {
  it('requires evidence, replays before activation, and can restore the original baseline', async () => {
    const store = db();
    const skills = new SkillService(store, { agent: new DemoAgentAdapter(), mode: 'demo' });
    const baseline = skills.active();
    await expect(skills.propose()).rejects.toThrow('Complete or reject');
    store.put('task', 'done', { status: 'completed', createdAt: new Date().toISOString() });
    const candidate = await skills.propose();
    expect(() => skills.activate(candidate.id)).toThrow('passed replay');
    const evaluated = await skills.evaluate(candidate.id);
    expect(evaluated.evaluation).toEqual({ passed: true, cases: 3, failures: [] });
    expect(skills.activate(candidate.id).id).toBe(candidate.id);
    expect(skills.activate(baseline.id).id).toBe(baseline.id);
    expect(skills.list().filter(item => item.status === 'active')).toHaveLength(1);
    await expect(skills.propose()).rejects.toThrow('seven days');
  });
  it('does not produce a live candidate without a verified reflector or activate failed replays', async () => {
    const store = db();
    const live = new SkillService(store, { agent: new DemoAgentAdapter(), mode: 'live' });
    await expect(live.propose()).rejects.toThrow('verified live');
    store.put('task', 'failed', { status: 'failed', createdAt: new Date().toISOString() });
    const broken = new SkillService(store, { agent: { run: async () => { throw new Error('runtime unavailable'); } }, mode: 'demo' });
    const candidate = await broken.propose();
    const evaluated = await broken.evaluate(candidate.id);
    expect(evaluated.evaluation?.passed).toBe(false);
    expect(() => broken.activate(candidate.id)).toThrow('passed replay');
    await expect(broken.evaluate(candidate.id)).rejects.toThrow('candidate');
  });
});

function scheduledFixture() {
  const store = db();
  const snapshot = makeDemoSnapshot();
  const settings = { timezone: 'Asia/Taipei' as const, scheduleEnabled: false, dailyTime: '09:00', weeklyTime: 'Mon 09:30', maxOpportunities: 10, maxWeeklyProposals: 3, maxPendingTasks: 10, maxAgentRunsPerDay: 10 };
  const state: AppState = { mode: 'demo', siteUrl: 'https://example.test', connections: [], snapshot, opportunities: rankOpportunities(snapshot), tasks: [], proposals: [], experiments: [], skills: [], settings };
  const service = { state: () => state, sync: vi.fn(async () => snapshot), createTask: vi.fn(async (postId: number) => ({ postId } as Task)) };
  return { store, service, state };
}

describe('bounded schedules', () => {
  it('stays off by default and catches up only once, without duplicating concurrent ticks', async () => {
    const fixture = scheduledFixture();
    const now = new Date('2026-10-23T02:00:00Z');
    await runScheduledTick({ ...fixture, now });
    expect(fixture.service.sync).not.toHaveBeenCalled();
    fixture.state.settings.scheduleEnabled = true;
    await Promise.all([runScheduledTick({ ...fixture, now }), runScheduledTick({ ...fixture, now })]);
    await runScheduledTick({ ...fixture, now });
    expect(fixture.service.sync).toHaveBeenCalledTimes(1);
    expect(fixture.service.createTask).toHaveBeenCalledTimes(3);
    expect(fixture.store.list('schedule')).toHaveLength(2);
  });
  it('does not retry a failed sync or generate proposals from stale data', async () => {
    const fixture = scheduledFixture();
    fixture.state.settings.scheduleEnabled = true;
    fixture.service.sync.mockRejectedValue(new Error('provider unavailable'));
    const now = new Date('2026-10-23T02:00:00Z');
    await runScheduledTick({ ...fixture, now });
    await runScheduledTick({ ...fixture, now });
    expect(fixture.service.sync).toHaveBeenCalledTimes(1);
    expect(fixture.service.createTask).not.toHaveBeenCalled();
  });
});
