import { describe, expect, it } from 'vitest';
import type { Experiment } from '../packages/contracts.js';
import { makeDemoSnapshot } from '../apps/server/demo.js';
import { nextSearchDate, observeExperiment } from '../apps/server/experiments.js';

function fixture() {
  const snapshot = makeDemoSnapshot(new Date('2026-02-05T00:00:00Z'));
  snapshot.evidence[0] = { ...snapshot.evidence[0], startDate: '2026-01-04', endDate: '2026-01-31' };
  snapshot.pageMetrics = snapshot.search.map(({ query: _query, ...row }) => row);
  const experiment: Experiment = { id: 'e1', proposalId: 'p1', postId: 1, startDate: '2026-01-04', dueDate: '2026-01-31',
    status: 'observing', baselineClicks: 100, expectedPostHash: snapshot.pages[0].protectedHash,
    baselineEvidence: { ...snapshot.evidence[0], startDate: '2025-12-01', endDate: '2025-12-28' }, note: 'Observing' };
  return { snapshot, experiment };
}

describe('observation windows', () => {
  it('starts with the next full Search Console day in Los Angeles', () => {
    expect(nextSearchDate(new Date('2026-01-04T01:00:00Z'))).toBe('2026-01-04');
  });
  it('does not report a result until a complete post-change 28-day window exists', () => {
    const { snapshot, experiment } = fixture();
    snapshot.evidence[0].endDate = '2026-01-30';
    expect(observeExperiment(experiment, snapshot).status).toBe('observing');
    snapshot.evidence[0].endDate = '2026-01-31';
    const observed = observeExperiment(experiment, snapshot);
    expect(observed.status).toBe('measured');
    expect(observed.currentClicks).toBe(62);
    expect(observed.note).toContain('不能證明因果');
  });
  it('marks missing pages insufficient and another content change confounded', () => {
    const { snapshot, experiment } = fixture();
    snapshot.pages = [];
    expect(observeExperiment(experiment, snapshot).status).toBe('insufficient');
    const fresh = fixture();
    fresh.snapshot.pages[0].protectedHash = 'another-editor-change';
    expect(observeExperiment(fresh.experiment, fresh.snapshot).status).toBe('confounded');
  });
  it('rejects incomplete or incompatible measurement instead of inventing zero traffic', () => {
    const { snapshot, experiment } = fixture();
    snapshot.evidence[0].complete = false;
    const result = observeExperiment(experiment, snapshot);
    expect(result.status).toBe('insufficient');
    expect(result.currentClicks).toBeUndefined();
  });
});
