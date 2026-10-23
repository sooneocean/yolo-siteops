import { accessSync, constants as fsConstants, lstatSync, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { AgentAdapter, Settings, SkillVersion, Snapshot, Task } from '../packages/contracts.js';
import type { ReflectionEvidence, PrepaidSkillCapability } from '../apps/server/skills.js';
import type { Store } from '../apps/server/store.js';
import { hasBlockingWeeklyJob, readAgentRunLimit, readSkillCallCount } from '../apps/server/pipeline-guards.js';

const REQUIRED_CALLS = 4;
const REQUIRED_REPLAYS = 3;
const SEVEN_DAYS_MS = 7 * 86_400_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 600_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Mode = 'check' | 'run';
interface StatusRecord { status?: unknown }
interface ConnectionRecord { id?: unknown; status?: unknown }
interface OperatorJob { kind?: unknown; weekKey?: unknown; status?: unknown }
interface Reader { get<T>(kind: string, id: string): T | undefined; list<T>(kind: string): T[] }
interface ReflectionAdapter extends AgentAdapter {
  reflect(evidence: ReflectionEvidence, signal: AbortSignal): Promise<{ content: string; rationale: string }>;
}

export interface WeeklyEnvironment {
  dataDir: string;
  databasePath: string;
  port: number;
  codexCommand: string;
}

export interface PreflightSummary {
  eligible: boolean;
  date: string;
  weekKey: string;
  jobId: string;
  gates: {
    mondayAfterTen: boolean;
    scheduleEnabled: boolean;
    dailyCompleted: boolean;
    weeklyCompleted: boolean;
    snapshotFresh: boolean;
    completeGscEvidence: boolean;
    readinessHealthy: boolean;
    appHealthy: boolean;
    codexCommandReady: boolean;
    noRunningTasks: boolean;
    noUnevaluatedSkill: boolean;
    activeSkillReady: boolean;
    reflectionEvidenceReady: boolean;
    callCapacityReady: boolean;
    cooldownReady: boolean;
    noPriorWeeklyClaim: boolean;
    noBlockingWeeklyJob: boolean;
  };
  reasons: string[];
}

export interface WeeklyResult extends PreflightSummary {
  claimed?: boolean;
  status?: 'completed' | 'failed' | 'skipped';
  candidateId?: string;
  evaluationStatus?: 'passed' | 'failed';
  modelCalls?: number;
  failureCode?: string;
}

export interface WeeklyDependencies {
  databasePath?: string;
  port?: number;
  codexCommand?: string;
  now?: () => Date;
  appHealthy?: () => Promise<boolean>;
  codexCommandReady?: () => Promise<boolean>;
  overallTimeoutMs?: number;
  callTimeoutMs?: number;
  lifecycle?: (
    store: Store,
    now: Date,
    prepaidCapability: PrepaidSkillCapability,
    signal: AbortSignal,
  ) => Promise<{ candidateId: string; evaluationStatus: 'passed' | 'failed'; modelCalls: number }>;
}

function taipeiParts(now: Date): { date: string; minutes: number; weekday: number; weekKey: string } {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  const date = shifted.toISOString().slice(0, 10);
  const weekday = shifted.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const weekKey = new Date(Date.parse(`${date}T00:00:00Z`) - daysSinceMonday * 86_400_000).toISOString().slice(0, 10);
  return { date, minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(), weekday, weekKey };
}

function taipeiDate(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? taipeiParts(parsed).date : undefined;
}

function parseStoredJson<T>(raw: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new Error('invalid_record_json'); }
}

class SqlReader implements Reader {
  constructor(private readonly db: DatabaseSync) {}
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id) as { value: string } | undefined;
    return row ? parseStoredJson<T>(row.value) : undefined;
  }
  list<T>(kind: string): T[] {
    return (this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid').all(kind) as Array<{ value: string }>)
      .map(row => parseStoredJson<T>(row.value));
  }
}

function validateDatabase(databasePath: string): void {
  const info = lstatSync(databasePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid_database');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = db.prepare('SELECT version FROM schema_version').get() as { version?: unknown } | undefined;
    if (version?.version !== 1) throw new Error('invalid_schema');
    const records = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").get();
    if (!records) throw new Error('invalid_schema');
  } finally { db.close(); }
}

/** Validate all trust-boundary inputs before a probe, write, or model spawn. */
export function loadWeeklyEnvironment(env: NodeJS.ProcessEnv = process.env): WeeklyEnvironment {
  const dataDirInput = env.SITEOPS_DATA_DIR;
  const portInput = env.SITEOPS_PORT;
  const commandInput = env.SITEOPS_CODEX_COMMAND;
  if (!dataDirInput || !portInput || !commandInput) throw new Error('invalid_environment');
  if (!path.isAbsolute(dataDirInput) || path.normalize(dataDirInput) !== dataDirInput) throw new Error('invalid_data_directory');
  const dataDir = realpathSync(dataDirInput);
  if (dataDir !== dataDirInput || !lstatSync(dataDir).isDirectory()) throw new Error('invalid_data_directory');
  const port = Number(portInput);
  if (!/^\d{1,5}$/u.test(portInput) || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid_port');
  const databasePath = path.join(dataDir, 'siteops.sqlite');
  validateDatabase(databasePath);
  if (!path.isAbsolute(commandInput)) throw new Error('invalid_codex_command');
  const commandPathInfo = lstatSync(commandInput);
  if (!commandPathInfo.isFile() && !commandPathInfo.isSymbolicLink()) throw new Error('invalid_codex_command');
  const codexCommand = realpathSync(commandInput);
  const target = statSync(codexCommand);
  const currentUid = process.getuid?.();
  if (!target.isFile() || (currentUid !== undefined && target.uid !== currentUid)
    || (target.mode & 0o022) !== 0) throw new Error('invalid_codex_command');
  accessSync(codexCommand, fsConstants.X_OK);
  return { dataDir, databasePath, port, codexCommand };
}

async function tcpHealth(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (healthy: boolean): void => { socket.destroy(); resolve(healthy); };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function commandHealth(command: string): boolean {
  try { accessSync(command, fsConstants.X_OK); return true; }
  catch { return false; }
}

function inspect(reader: Reader, now: Date, appHealthy: boolean, codexCommandReady: boolean, blockingWeeklyJob: boolean): PreflightSummary {
  const current = taipeiParts(now);
  const jobId = `weekly-skill:${current.weekKey}`;
  const settings = reader.get<Settings>('settings', 'current');
  const daily = reader.get<StatusRecord>('schedule', `daily:${current.date}`);
  const weekly = reader.get<StatusRecord>('schedule', `weekly:${current.weekKey}`);
  const snapshot = reader.get<Snapshot>('snapshot', 'current');
  const tasks = reader.list<Task>('task');
  const skills = reader.list<SkillVersion>('skill');
  const connections = ['wordpress', 'gsc', 'ga4'].map(id => ({ id, value: reader.get<ConnectionRecord>('connection', id) }));
  const codexConnection = reader.get<ConnectionRecord>('connection', 'codex');
  const priorReflection = reader.get<string>('skill_reflection', 'lastAttempt');
  const priorAt = typeof priorReflection === 'string' ? Date.parse(priorReflection) : Number.NaN;
  const usedSkillCalls = readSkillCallCount(reader.get<unknown>('skill_calls', current.date));
  const taskCount = tasks.filter(task => taipeiDate(task.createdAt) === current.date).length;
  const maxCalls = readAgentRunLimit(settings);
  const hasPriorClaim = reader.get<OperatorJob>('operator_job', jobId) !== undefined;
  const snapshotTime = snapshot?.createdAt ? Date.parse(snapshot.createdAt) : Number.NaN;
  const gscEvidence = Array.isArray(snapshot?.evidence) ? snapshot.evidence.filter(item => item.source === 'gsc') : [];
  const completeGscEvidence = gscEvidence.length > 0 && gscEvidence.every(item => item.complete === true)
    && (snapshot?.evidence ?? []).every(item => item.complete === true);
  const gates = {
    mondayAfterTen: current.weekday === 1 && current.minutes >= 10 * 60,
    scheduleEnabled: settings?.scheduleEnabled === true,
    dailyCompleted: daily?.status === 'completed',
    weeklyCompleted: weekly?.status === 'completed',
    snapshotFresh: taipeiDate(snapshot?.createdAt ?? '') === current.date
      && Number.isFinite(snapshotTime) && snapshotTime <= now.getTime(),
    completeGscEvidence,
    readinessHealthy: connections.every(({ id, value }) => value?.id === id && value.status === 'ready')
      && codexConnection?.id === 'codex'
      && (codexConnection.status === 'ready' || (codexConnection.status === 'unconfigured' && codexCommandReady)),
    appHealthy,
    codexCommandReady,
    noRunningTasks: !tasks.some(task => task.status === 'queued' || task.status === 'running'),
    noUnevaluatedSkill: !skills.some(skill => skill.status === 'candidate' || skill.status === 'evaluated'),
    activeSkillReady: skills.filter(skill => skill.status === 'active').length === 1,
    reflectionEvidenceReady: tasks.some(task => ['completed', 'cancelled', 'failed', 'review_required'].includes(task.status)),
    callCapacityReady: maxCalls !== undefined && usedSkillCalls !== undefined
      && taskCount + usedSkillCalls + REQUIRED_CALLS <= maxCalls,
    cooldownReady: priorReflection === undefined || (Number.isFinite(priorAt) && now.getTime() - priorAt >= SEVEN_DAYS_MS),
    noPriorWeeklyClaim: !hasPriorClaim,
    noBlockingWeeklyJob: !blockingWeeklyJob,
  };
  const reasons = Object.entries(gates).filter(([, ready]) => !ready).map(([name]) => name);
  return { eligible: reasons.length === 0, date: current.date, weekKey: current.weekKey, jobId, gates, reasons };
}

function readOnlyPreflight(databasePath: string, now: Date, appHealthy: boolean, codexCommandReady: boolean): PreflightSummary {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const result = inspect(new SqlReader(db), now, appHealthy, codexCommandReady, hasBlockingWeeklyJob(db));
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* read-only rollback best effort */ }
    throw error;
  } finally { db.close(); }
}

function unavailablePreflight(now: Date): WeeklyResult {
  const current = taipeiParts(now);
  const gates = {
    mondayAfterTen: false, scheduleEnabled: false, dailyCompleted: false, weeklyCompleted: false,
    snapshotFresh: false, completeGscEvidence: false, readinessHealthy: false, appHealthy: false, codexCommandReady: false,
    noRunningTasks: false, noUnevaluatedSkill: false, activeSkillReady: false,
    reflectionEvidenceReady: false, callCapacityReady: false, cooldownReady: false, noPriorWeeklyClaim: false,
    noBlockingWeeklyJob: false,
  };
  return { eligible: false, date: current.date, weekKey: current.weekKey, jobId: `weekly-skill:${current.weekKey}`,
    gates, reasons: ['preflightUnavailable'], claimed: false, status: 'failed', failureCode: 'preflight_unavailable' };
}

function safeFailureCode(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AgentTimeoutError' || name === 'TimeoutError' || name === 'AbortError') return 'agent_timeout';
  if (name === 'AgentSecurityError') return 'agent_security';
  if (name === 'AgentProtocolError') return 'agent_protocol';
  if (name === 'AgentTurnError') return 'agent_turn';
  return 'weekly_skill_failed';
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  void operation.catch(() => undefined);
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

export async function executeLifecycleWithAdapter(
  store: Store,
  now: Date,
  adapter: ReflectionAdapter,
  prepaidCapability: PrepaidSkillCapability,
  signal: AbortSignal,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): Promise<{ candidateId: string; evaluationStatus: 'passed' | 'failed'; modelCalls: number }> {
  const { SkillService, replayInputs } = await import('../apps/server/skills.js');
  if (signal.aborted) throw signal.reason;
  let modelCalls = 0;
  const boundedCall = (): void => {
    if (signal.aborted) throw signal.reason;
    modelCalls += 1;
    if (modelCalls > REQUIRED_CALLS) throw new Error('model_call_bound');
  };
  const agent: AgentAdapter = { run: async (args) => { boundedCall(); return await adapter.run(args); } };
  const service = new SkillService(store, {
    agent, mode: 'live', now: () => new Date(now), prepaid: prepaidCapability, signal,
    callTimeoutMs, stopOnAgentFailure: true,
    reflect: async (evidence, callSignal) => { boundedCall(); return await adapter.reflect(evidence, callSignal); },
  });
  if (replayInputs(service.active()).length !== REQUIRED_REPLAYS) throw new Error('replay_input_count');
  const candidate = await service.propose();
  if (replayInputs(candidate).length !== REQUIRED_REPLAYS) throw new Error('replay_input_count');
  const evaluated = await service.evaluate(candidate.id);
  if (modelCalls !== REQUIRED_CALLS || evaluated.evaluation?.cases !== REQUIRED_REPLAYS) throw new Error('model_call_count');
  return { candidateId: candidate.id, evaluationStatus: evaluated.evaluation?.passed === true ? 'passed' : 'failed', modelCalls };
}

async function productionLifecycle(
  store: Store,
  now: Date,
  capability: PrepaidSkillCapability,
  signal: AbortSignal,
  command: string,
  callTimeoutMs: number,
): Promise<{ candidateId: string; evaluationStatus: 'passed' | 'failed'; modelCalls: number }> {
  const { CodexAgentAdapter } = await import('../apps/server/agent/codex-adapter.js');
  if (signal.aborted) throw signal.reason;
  const adapter = new CodexAgentAdapter({ command, cwd: PROJECT_ROOT, timeoutMs: callTimeoutMs });
  return await executeLifecycleWithAdapter(store, now, adapter, capability, signal, callTimeoutMs);
}

export async function runWeeklySkill(mode: Mode, dependencies: WeeklyDependencies = {}): Promise<WeeklyResult> {
  if (!dependencies.databasePath) throw new Error('database_path_required');
  const databasePath = dependencies.databasePath;
  const now = dependencies.now?.() ?? new Date();
  let appHealthy = false;
  let codexReady = false;
  let summary: PreflightSummary;
  try {
    appHealthy = await (dependencies.appHealthy ?? (() => tcpHealth(dependencies.port!)))();
    codexReady = await (dependencies.codexCommandReady ?? (async () => commandHealth(dependencies.codexCommand!)))();
    summary = readOnlyPreflight(databasePath, now, appHealthy, codexReady);
  } catch { return unavailablePreflight(now); }
  if (mode === 'check') return summary;
  if (!summary.eligible) return { ...summary, claimed: false, status: 'skipped' };

  const { Store } = await import('../apps/server/store.js');
  const { loadPrepaidSkillCapability } = await import('../apps/server/skills.js');
  const store = new Store(databasePath);
  const reservationId = summary.jobId;
  let claimed = false;
  try {
    const rechecked = store.transaction(() => {
      const current = inspect(store, now, appHealthy, codexReady, hasBlockingWeeklyJob(store.db));
      if (!current.eligible) return current;
      const limit = readAgentRunLimit(store.get<Settings>('settings', 'current'));
      const used = readSkillCallCount(store.get<unknown>('skill_calls', current.date));
      const taskCount = store.list<Task>('task').filter(task => taipeiDate(task.createdAt) === current.date).length;
      if (limit === undefined || used === undefined || taskCount + used + REQUIRED_CALLS > limit) {
        throw new Error('invalid_agent_quota');
      }
      store.put('skill_calls', current.date, used + REQUIRED_CALLS);
      store.put('skill_reflection', 'lastAttempt', now.toISOString());
      store.put('skill_reservation', reservationId, {
        kind: 'weekly-skill-v1', jobId: current.jobId, date: current.date, status: 'running',
        reflectionRemaining: 1, replayRemaining: 3,
      });
      store.put('operator_job', current.jobId, {
        kind: 'weekly-skill-v1', weekKey: current.weekKey, status: 'running', at: now.toISOString(),
      });
      claimed = true;
      return current;
    });
    if (!claimed) return { ...rechecked, claimed: false, status: 'skipped' };
    const capability = loadPrepaidSkillCapability(store, reservationId);
    const overallSignal = AbortSignal.timeout(dependencies.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS);
    const lifecycle = dependencies.lifecycle
      ?? ((db, at, prepaid, signal) => productionLifecycle(db, at, prepaid, signal, dependencies.codexCommand!, dependencies.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS));
    const result = await abortable(lifecycle(store, now, capability, overallSignal), overallSignal);
    store.transaction(() => {
      const reservation = store.get<Record<string, unknown>>('skill_reservation', reservationId);
      store.put('skill_reservation', reservationId, { ...reservation, status: 'completed' });
      store.put('operator_job', summary.jobId, {
        kind: 'weekly-skill-v1', weekKey: summary.weekKey, status: 'completed', at: now.toISOString(),
        candidateId: result.candidateId, evaluationStatus: result.evaluationStatus, modelCalls: result.modelCalls,
      });
    });
    return { ...rechecked, claimed: true, status: 'completed', ...result };
  } catch (error) {
    const failureCode = safeFailureCode(error);
    if (claimed) {
      store.transaction(() => {
        const reservation = store.get<Record<string, unknown>>('skill_reservation', reservationId);
        if (reservation) store.put('skill_reservation', reservationId, { ...reservation, status: 'failed' });
        store.put('operator_job', summary.jobId, {
          kind: 'weekly-skill-v1', weekKey: summary.weekKey, status: 'failed', at: now.toISOString(), failureCode,
        });
      });
    }
    return { ...summary, claimed, status: 'failed', failureCode };
  } finally { store.close(); }
}

export async function runWeeklySkillCli(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const option = process.argv[2];
  if (option !== '--check' && option !== '--run') {
    console.error(JSON.stringify({ status: 'failed', failureCode: 'usage' }));
    return 2;
  }
  try {
    const trusted = loadWeeklyEnvironment(env);
    const result = await runWeeklySkill(option === '--check' ? 'check' : 'run', trusted);
    console.log(JSON.stringify(result));
    return result.status === 'failed' ? 1 : 0;
  } catch {
    console.error(JSON.stringify({ status: 'failed', failureCode: 'invalid_environment' }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runWeeklySkillCli();
}
