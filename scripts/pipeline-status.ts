import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hasBlockingWeeklyJob, readAgentRunLimit, readSkillCallCount } from '../apps/server/pipeline-guards.js';

type JsonRecord = Record<string, unknown>;
const TASK_STATUSES = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'review_required'] as const;
const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'applied', 'rolled_back', 'review_required', 'verified_transformed'] as const;
const SKILL_STATUSES = ['candidate', 'evaluated', 'active', 'retired'] as const;
const SAFE_FAILURE_CODES = new Set([
  'output_schema', 'skill_version_mismatch', 'duplicate_evidence', 'ungrounded_evidence', 'html_policy',
  'summary_policy', 'block_structure', 'block_preservation', 'agent_timeout', 'agent_protocol',
  'agent_security', 'agent_turn', 'task_input_stale', 'wordpress_state_drift', 'task_reservation_expired',
  'internal_error', 'daily_agent_limit', 'weekly_skill_failed', 'precondition_changed',
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = [...value].map(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  }).join('').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function canonicalDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

function knownTimeZone(value: unknown): 'America/Los_Angeles' | 'Asia/Taipei' | 'unknown' {
  return value === 'America/Los_Angeles' || value === 'Asia/Taipei' ? value : 'unknown';
}

function coverageProjection(source: string, complete: boolean): string {
  if (!complete) return '資料不完整；數值不納入分析。';
  if (source === 'gsc') return 'Search Console 頁面彙總與有界查詢樣本。';
  if (source === 'ga4') return 'GA4 自然搜尋落地頁彙總。';
  if (source === 'wordpress') return 'WordPress 文章盤點證據。';
  return 'unknown';
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function taipeiParts(now: Date): { date: string; weekKey: string } {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  const date = shifted.toISOString().slice(0, 10);
  const weekday = shifted.getUTCDay();
  const weekKey = new Date(Date.parse(`${date}T00:00:00Z`) - ((weekday + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  return { date, weekKey };
}

function taipeiDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? taipeiParts(parsed).date : undefined;
}

function readOne(db: DatabaseSync, kind: string, id: string): unknown {
  const row = db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id) as { value: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value) as unknown; } catch { return undefined; }
}

function readKind(db: DatabaseSync, kind: string): unknown[] {
  return (db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid').all(kind) as Array<{ value: string }>).flatMap(row => {
    try { return [JSON.parse(row.value) as unknown]; } catch { return []; }
  });
}

function countBy<T extends readonly string[]>(records: unknown[], statuses: T): Record<T[number], number> {
  const result = Object.fromEntries(statuses.map(status => [status, 0])) as Record<T[number], number>;
  for (const record of records) {
    if (!isRecord(record) || typeof record.status !== 'string'
      || !(statuses as readonly string[]).includes(record.status)) continue;
    result[record.status as T[number]] += 1;
  }
  return result;
}

function pickedRun(value: unknown, key: string): { key: string; status: string; at?: string } | null {
  if (!isRecord(value) || !['running', 'completed', 'failed'].includes(String(value.status))) return null;
  const at = canonicalTimestamp(value.at);
  return { key, status: String(value.status), ...(at ? { at } : {}) };
}

export interface PipelineStatusOptions { databasePath: string; now?: Date }

export function inspectPipelineStatus({ databasePath, now = new Date() }: PipelineStatusOptions): JsonRecord {
  const current = taipeiParts(now);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const version = db.prepare('SELECT version FROM schema_version').get() as { version?: unknown } | undefined;
    if (version?.version !== 1) throw new Error('unsupported_schema');
    const settings = readOne(db, 'settings', 'current');
    const snapshot = readOne(db, 'snapshot', 'current');
    const schedulerHealth = readOne(db, 'scheduler_health', 'current');
    const tasks = readKind(db, 'task');
    const proposals = readKind(db, 'proposal');
    const skills = readKind(db, 'skill');
    const skillCallsRaw = readOne(db, 'skill_calls', current.date);
    const connections = ['wordpress', 'gsc', 'ga4', 'codex'].map(id => {
      const value = readOne(db, 'connection', id);
      const status = isRecord(value) && ['ready', 'unconfigured', 'error', 'checking'].includes(String(value.status))
        ? String(value.status) : 'unknown';
      const checkedAt = isRecord(value) ? canonicalTimestamp(value.checkedAt) : undefined;
      return { id, status, ...(checkedAt ? { checkedAt } : {}) };
    });
    const evidence = isRecord(snapshot) && Array.isArray(snapshot.evidence) ? snapshot.evidence.filter(isRecord) : [];
    const completeGscIds = new Set(evidence.filter(item => item.complete === true && item.source === 'gsc' && typeof item.id === 'string').map(item => String(item.id)));
    const completeGa4Ids = new Set(evidence.filter(item => item.complete === true && item.source === 'ga4' && typeof item.id === 'string').map(item => String(item.id)));
    const coverage = evidence.slice(0, 8).map(item => {
      const source = ['gsc', 'ga4', 'wordpress'].includes(String(item.source)) ? String(item.source) : 'unknown';
      const complete = item.complete === true;
      return {
        source, startDate: canonicalDate(item.startDate) ?? 'unknown', endDate: canonicalDate(item.endDate) ?? 'unknown',
        timeZone: knownTimeZone(item.timeZone), complete, coverage: coverageProjection(source, complete),
      };
    });
    const search = isRecord(snapshot) && Array.isArray(snapshot.search) ? snapshot.search.filter(isRecord) : [];
    const pageMetrics = isRecord(snapshot) && Array.isArray(snapshot.pageMetrics) ? snapshot.pageMetrics.filter(isRecord) : [];
    const analytics = isRecord(snapshot) && Array.isArray(snapshot.analytics) ? snapshot.analytics.filter(isRecord) : [];
    const pageIds = new Set<number>();
    const liveSnapshot = isRecord(snapshot) && snapshot.mode === 'live';
    const demoSnapshot = isRecord(snapshot) && snapshot.mode === 'demo';
    const metricSource = liveSnapshot ? pageMetrics : demoSnapshot ? [...search, ...pageMetrics] : [];
    for (const row of metricSource) {
      const postId = safeInteger(row.postId);
      if (postId && typeof row.evidenceId === 'string' && completeGscIds.has(row.evidenceId)) pageIds.add(postId);
    }
    const pages = [...pageIds].sort((a, b) => a - b).slice(0, 100).flatMap(postId => {
      const totals = pageMetrics.find(row => row.postId === postId && typeof row.evidenceId === 'string' && completeGscIds.has(row.evidenceId));
      const rows = search.filter(row => row.postId === postId && typeof row.evidenceId === 'string' && completeGscIds.has(row.evidenceId));
      const validRows = rows.flatMap(row => {
        const clicks = safeNumber(row.clicks); const previousClicks = safeNumber(row.previousClicks);
        const impressions = safeNumber(row.impressions); const position = safeNumber(row.position);
        return clicks === undefined || previousClicks === undefined || impressions === undefined || position === undefined
          ? [] : [{ clicks, previousClicks, impressions, position }];
      });
      const totalClicks = safeNumber(totals?.clicks); const totalPrevious = safeNumber(totals?.previousClicks);
      const totalImpressions = safeNumber(totals?.impressions); const totalPosition = safeNumber(totals?.position);
      const hasValidTotals = totalClicks !== undefined && totalPrevious !== undefined
        && totalImpressions !== undefined && totalPosition !== undefined;
      if (liveSnapshot && !hasValidTotals) return [];
      if (!hasValidTotals && (validRows.length === 0 || validRows.length !== rows.length)) return [];
      const clicks = hasValidTotals ? totalClicks : validRows.reduce((sum, row) => sum + row.clicks, 0);
      const previousClicks = hasValidTotals ? totalPrevious : validRows.reduce((sum, row) => sum + row.previousClicks, 0);
      const impressions = hasValidTotals ? totalImpressions : validRows.reduce((sum, row) => sum + row.impressions, 0);
      const position = hasValidTotals ? totalPosition
        : (impressions! > 0 ? validRows.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions! : undefined);
      if (clicks === undefined || previousClicks === undefined || impressions === undefined || position === undefined) return [];
      return [{ postId, clicks, previousClicks, impressions, position }];
    });
    const opportunityLimit = isRecord(settings) && safeInteger(settings.maxOpportunities) !== undefined
      ? Math.min(10, safeInteger(settings.maxOpportunities)!) : 10;
    const opportunities = pages.flatMap(page => {
      const decay = page.previousClicks >= 20 && page.clicks <= page.previousClicks * 0.8;
      if (page.impressions < 100 || (!decay && !(page.position >= 4 && page.position <= 20))) return [];
      const queries = [...new Set(search.filter(row => row.postId === page.postId && typeof row.evidenceId === 'string'
        && completeGscIds.has(row.evidenceId) && safeNumber(row.impressions) !== undefined)
        .sort((a, b) => safeNumber(b.impressions)! - safeNumber(a.impressions)!)
        .map(row => safeText(row.query, 120)).filter((query): query is string => Boolean(query)))].slice(0, 10);
      const measured = analytics.some(row => row.postId === page.postId && row.measurementValid === true
        && typeof row.evidenceId === 'string' && completeGa4Ids.has(row.evidenceId)
        && safeNumber(row.sessions) !== undefined && safeNumber(row.engagedSessions) !== undefined);
      return [{ ...page, kind: decay ? 'decay' : 'position', queries,
        audienceHypothesis: queries[0] ? `假設：讀者可能正在尋找「${queries[0]}」相關解答，需以內容與後續完整量測驗證。` : 'unknown',
        adjacentKeywordHypotheses: queries.slice(1, 4).map(query => `假設：${query}`),
        measurementQuality: measured ? 'available' : 'unknown' }];
    }).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'decay' ? -1 : 1)
      || b.impressions - a.impressions || b.clicks - a.clicks || a.postId - b.postId).slice(0, opportunityLimit);
    const taskCounts = countBy(tasks, TASK_STATUSES);
    const proposalCounts = countBy(proposals, PROPOSAL_STATUSES);
    const skillCounts = countBy(skills, SKILL_STATUSES);
    const failureCodes: Record<string, number> = {};
    for (const task of tasks) {
      const code = isRecord(task) && typeof task.errorCode === 'string' && SAFE_FAILURE_CODES.has(task.errorCode) ? task.errorCode : undefined;
      if (code) failureCodes[code] = (failureCodes[code] ?? 0) + 1;
    }
    const sameDayTasks = tasks.filter(task => isRecord(task) && taipeiDate(task.createdAt) === current.date).length;
    const skillCallsValue = readSkillCallCount(skillCallsRaw);
    const skillCalls = skillCallsValue ?? 'unknown';
    const maxRuns = readAgentRunLimit(settings);
    const weeklyJobValue = readOne(db, 'operator_job', `weekly-skill:${current.weekKey}`);
    const weeklyJob = isRecord(weeklyJobValue) && ['running', 'completed', 'failed'].includes(String(weeklyJobValue.status))
      ? { key: `weekly-skill:${current.weekKey}`, status: String(weeklyJobValue.status),
          failureCode: typeof weeklyJobValue.failureCode === 'string' && SAFE_FAILURE_CODES.has(weeklyJobValue.failureCode)
            ? weeklyJobValue.failureCode : undefined }
      : null;
    const blockingWeeklyRun = hasBlockingWeeklyJob(db);
    const createdAt = isRecord(snapshot) ? canonicalTimestamp(snapshot.createdAt) : undefined;
    const snapshotDate = taipeiDate(createdAt);
    const snapshotTime = createdAt ? Date.parse(createdAt) : Number.NaN;
    const hasCompleteAnalysisEvidence = completeGscIds.size > 0 && evidence.length > 0
      && evidence.every(item => item.complete === true);
    const state = !isRecord(snapshot) || (!liveSnapshot && !demoSnapshot) || !createdAt
      || !Number.isFinite(snapshotTime) || snapshotTime > now.getTime()
      || !hasCompleteAnalysisEvidence ? 'unavailable' : snapshotDate === current.date ? 'fresh' : 'stale';
    const healthStatus = isRecord(schedulerHealth) && ['ready', 'ok', 'error'].includes(String(schedulerHealth.status))
      ? String(schedulerHealth.status) : 'unknown';
    const healthAt = isRecord(schedulerHealth) ? canonicalTimestamp(schedulerHealth.at) : undefined;
    const result = {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      state,
      period: { snapshotCreatedAt: createdAt ?? 'unknown', coverage },
      connections,
      gsc: { pages, opportunities },
      ga4: {
        measurementValidPages: analytics.filter(row => row.measurementValid === true && typeof row.evidenceId === 'string'
          && completeGa4Ids.has(row.evidenceId) && safeNumber(row.sessions) !== undefined
          && safeNumber(row.engagedSessions) !== undefined).length,
        limitation: 'GA4 數字僅在 measurementValid=true 且證據完整時可用；其餘一律 unknown。',
      },
      scheduler: {
        daily: pickedRun(readOne(db, 'schedule', `daily:${current.date}`), `daily:${current.date}`),
        weekly: pickedRun(readOne(db, 'schedule', `weekly:${current.weekKey}`), `weekly:${current.weekKey}`),
        health: { status: healthStatus, ...(healthAt ? { at: healthAt } : {}) },
      },
      tasks: { total: tasks.length, counts: taskCounts, failureCodes },
      proposals: { total: proposals.length, counts: proposalCounts,
        pendingHumanConfirmation: proposalCounts.pending + proposalCounts.approved + proposalCounts.review_required },
      skills: { total: skills.length, counts: skillCounts, activeCount: skillCounts.active },
      quota: { date: current.date, maxAgentRuns: maxRuns ?? 'unknown', taskRuns: sameDayTasks, skillCalls,
        remaining: maxRuns === undefined || skillCalls === 'unknown' ? 'unknown' : Math.max(0, maxRuns - sameDayTasks - skillCalls) },
      weeklyJob,
      blockingWeeklyRun,
      failureCode: null,
    };
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* read-only rollback best effort */ }
    throw error;
  } finally { db.close(); }
}

function databaseFromEnvironment(env: NodeJS.ProcessEnv): string {
  const input = env.SITEOPS_DATA_DIR;
  if (!input || !path.isAbsolute(input) || path.normalize(input) !== input) throw new Error('invalid_environment');
  const dataDir = realpathSync(input);
  if (dataDir !== input || !lstatSync(dataDir).isDirectory()) throw new Error('invalid_environment');
  const databasePath = path.join(dataDir, 'siteops.sqlite');
  const info = lstatSync(databasePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid_environment');
  return databasePath;
}

export function runPipelineStatusCli(env: NodeJS.ProcessEnv = process.env): number {
  try {
    console.log(JSON.stringify(inspectPipelineStatus({ databasePath: databaseFromEnvironment(env) })));
    return 0;
  } catch {
    const now = new Date();
    const current = taipeiParts(now);
    console.error(JSON.stringify({
      schemaVersion: 1, generatedAt: now.toISOString(), state: 'unavailable',
      period: { snapshotCreatedAt: 'unknown', coverage: [] },
      connections: ['wordpress', 'gsc', 'ga4', 'codex'].map(id => ({ id, status: 'unknown' })),
      gsc: { pages: [], opportunities: [] },
      ga4: { measurementValidPages: 0, limitation: 'GA4 數字僅在 measurementValid=true 且證據完整時可用；其餘一律 unknown。' },
      scheduler: { daily: null, weekly: null, health: { status: 'unknown' } },
      tasks: { total: 0, counts: Object.fromEntries(TASK_STATUSES.map(status => [status, 0])), failureCodes: {} },
      proposals: { total: 0, counts: Object.fromEntries(PROPOSAL_STATUSES.map(status => [status, 0])), pendingHumanConfirmation: 0 },
      skills: { total: 0, counts: Object.fromEntries(SKILL_STATUSES.map(status => [status, 0])), activeCount: 0 },
      quota: { date: current.date, maxAgentRuns: 'unknown', taskRuns: 0, skillCalls: 'unknown', remaining: 'unknown' },
      weeklyJob: null,
      blockingWeeklyRun: 'unknown',
      failureCode: 'inspection_unavailable',
    }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPipelineStatusCli();
}
