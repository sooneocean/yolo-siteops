import type { Experiment, Snapshot } from '../../packages/contracts.js';

export function nextSearchDate(date: Date): string {
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

/** Observational before/after association; never a causal ranking/ROI claim. */
export function observeExperiment(experiment: Experiment, snapshot: Snapshot): Experiment {
  if (experiment.status === 'confounded' || experiment.status === 'measured') return experiment;
  const page = snapshot.pages.find(item => item.postId === experiment.postId);
  if (page && experiment.expectedPostHash && page.protectedHash !== experiment.expectedPostHash) {
    return { ...experiment, status: 'confounded', note: '文章在觀察期間另有變更，無法將結果歸因於這次提案。' };
  }
  const row = snapshot.pageMetrics?.find(item => item.postId === experiment.postId);
  const evidence = snapshot.evidence.find(item => item.id === row?.evidenceId && item.source === 'gsc');
  const latest = snapshot.evidence.find(item => item.source === 'gsc');
  if (!latest || latest.endDate < experiment.dueDate) return experiment;
  const days = evidence ? (Date.parse(evidence.endDate) - Date.parse(evidence.startDate)) / 86400000 + 1 : 0;
  if (!page || !row || !evidence?.complete || !experiment.baselineEvidence?.complete || days !== 28
      || evidence.startDate < experiment.startDate || evidence.property !== experiment.baselineEvidence.property
      || evidence.timeZone !== experiment.baselineEvidence.timeZone) {
    return { ...experiment, status: 'insufficient', note: '尚缺同一資源、完整的變更後 28 日頁面資料；缺值不視為零。' };
  }
  return { ...experiment, status: 'measured', currentClicks: row.clicks, measuredEvidence: evidence,
    note: '已記錄變更前後的 28 日搜尋點擊；這是觀察性比較，仍可能受季節、排名與其他因素影響，不能證明因果或收益。' };
}
