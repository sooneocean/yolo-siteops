import crypto from 'node:crypto';
import { z } from 'zod';
import type { AgentAdapter, AgentInput, ChangeProposal, Settings, SkillVersion, Task } from '../../packages/contracts.js';
import { makeDemoSnapshot } from './demo.js';
import { rankOpportunities } from './opportunities.js';
import { HARD_AGENT_RUN_CAP, hasBlockingWeeklyJob, readAgentRunLimit, readSkillCallCount } from './pipeline-guards.js';
import { assertSafeProposalHtml } from './security/html.js';
import { SiteOpsError, StoreSkillSource } from './service.js';
import { Store } from './store.js';

export interface ReflectionEvidence {
  active: Pick<SkillVersion, 'id' | 'content'>;
  tasks: Array<Pick<Task, 'status'>>;
  proposals: Array<Pick<ChangeProposal, 'status'>>;
}
export type SkillReflector = (evidence: ReflectionEvidence, signal: AbortSignal) => Promise<{ content: string; rationale: string }>;
const candidateSchema = z.object({ content: z.string().min(40).max(8000), rationale: z.string().min(10).max(2000) }).strict();
const dayKey = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(date);

interface StoredSkillReservation {
  kind: 'weekly-skill-v1';
  jobId: string;
  date: string;
  status: 'running' | 'completed' | 'failed';
  reflectionRemaining: number;
  replayRemaining: number;
}

interface PrepaidState { store: Store; reservationId: string }
const prepaidStates = new WeakMap<object, PrepaidState>();
export interface PrepaidSkillCapability { readonly reservationId: string }

/** Creates an unforgeable, process-local handle only after verifying a durable DB reservation. */
export function loadPrepaidSkillCapability(store: Store, reservationId: string): PrepaidSkillCapability {
  const reservation = store.get<StoredSkillReservation>('skill_reservation', reservationId);
  const job = store.get<{ kind?: unknown; status?: unknown }>('operator_job', reservationId);
  if (!reservation || reservation.kind !== 'weekly-skill-v1' || reservation.status !== 'running'
    || reservation.reflectionRemaining !== 1 || reservation.replayRemaining !== 3
    || job?.kind !== 'weekly-skill-v1' || job.status !== 'running') {
    throw new SiteOpsError('invalid_skill_reservation', 'The prepaid skill reservation is not valid.');
  }
  const capability = Object.freeze({ reservationId });
  prepaidStates.set(capability, { store, reservationId });
  return capability;
}

function signalFor(overall: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return overall ? AbortSignal.any([overall, timeout]) : timeout;
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

/** Fixed synthetic replay inputs never contain production articles or credentials. */
export function replayInputs(skill: SkillVersion): AgentInput[] {
  const snapshot = makeDemoSnapshot(new Date('2026-01-31T00:00:00Z'));
  return rankOpportunities(snapshot).map(opportunity => ({
    page: snapshot.pages.find(page => page.postId === opportunity.postId)!, opportunity,
    evidence: snapshot.evidence.filter(item => opportunity.evidenceIds.includes(item.id)),
    relatedPages: snapshot.pages.filter(page => page.postId !== opportunity.postId).map(({ postId, url, title }) => ({ postId, url, title })),
    skillContent: skill.content, skillVersion: skill.id,
  }));
}

export class SkillService extends StoreSkillSource {
  private busy = false;
  constructor(private readonly database: Store, private readonly options: {
    agent: AgentAdapter; mode: 'demo' | 'live'; reflect?: SkillReflector; now?: () => Date;
    prepaid?: PrepaidSkillCapability; signal?: AbortSignal; callTimeoutMs?: number; stopOnAgentFailure?: boolean;
  }) { super(database, options.now); }
  private time(): Date { return this.options.now?.() ?? new Date(); }

  private usePrepaid<T>(phase: 'reflection' | 'replay', count: 1 | 3, claim: () => T): T {
    const state = this.options.prepaid && prepaidStates.get(this.options.prepaid);
    if (!state || state.store !== this.database || state.reservationId !== this.options.prepaid?.reservationId) {
      throw new SiteOpsError('invalid_skill_reservation', 'The prepaid skill capability is not valid.');
    }
    return this.database.transaction(() => {
      const reservation = this.database.get<StoredSkillReservation>('skill_reservation', state.reservationId);
      const job = this.database.get<{ kind?: unknown; status?: unknown }>('operator_job', state.reservationId);
      const field = phase === 'reflection' ? 'reflectionRemaining' : 'replayRemaining';
      if (!reservation || reservation.kind !== 'weekly-skill-v1' || reservation.status !== 'running'
        || reservation.date !== dayKey(this.time()) || reservation.jobId !== state.reservationId
        || reservation[field] !== count || job?.kind !== 'weekly-skill-v1' || job.status !== 'running') {
        throw new SiteOpsError('invalid_skill_reservation', 'The prepaid skill reservation has already been consumed.');
      }
      const value = claim();
      this.database.put<StoredSkillReservation>('skill_reservation', state.reservationId, { ...reservation, [field]: 0 });
      return value;
    });
  }

  private claimCalls<T>(count: number, claim: () => T): T {
    const date = dayKey(this.time());
    return this.database.transaction(() => {
      if (hasBlockingWeeklyJob(this.database.db)) {
        throw new SiteOpsError('weekly_skill_running', 'Weekly skill evaluation is already running.');
      }
      const settings = this.database.get<Settings>('settings', 'current');
      // Standalone/demo SkillService keeps the fixed hard default; any persisted value must validate.
      const limit = settings === undefined ? HARD_AGENT_RUN_CAP : readAgentRunLimit(settings);
      const taskCount = this.database.list<Task>('task').filter(task => dayKey(new Date(task.createdAt)) === date).length;
      const used = readSkillCallCount(this.database.get<unknown>('skill_calls', date));
      if (limit === undefined || used === undefined || used + taskCount + count > limit) {
        throw new SiteOpsError('daily_agent_limit', 'The daily agent run limit has been reached.', 429);
      }
      const value = claim();
      this.database.put('skill_calls', date, used + count);
      return value;
    });
  }

  async propose(): Promise<SkillVersion> {
    if (this.busy) throw new SiteOpsError('skill_busy', 'A skill operation is already running.');
    if (this.options.mode === 'live' && !this.options.reflect) throw new SiteOpsError('reflection_unavailable', 'A verified live reflection runtime is required.', 503);
    if (this.options.signal?.aborted) throw this.options.signal.reason;
    this.busy = true;
    try {
      const now = this.time();
      const claim = () => {
        const eligible = this.database.list<Task>('task').filter(task => ['completed', 'cancelled', 'failed', 'review_required'].includes(task.status));
        if (!eligible.length) throw new SiteOpsError('reflection_evidence_required', 'Complete or reject a task before proposing a skill.');
        if (!this.options.prepaid) {
          const prior = this.database.get<string>('skill_reflection', 'lastAttempt');
          if (prior && now.getTime() - Date.parse(prior) < 7 * 86400000) throw new SiteOpsError('weekly_skill_limit', 'Only one reflection attempt is allowed per seven days.', 429);
          this.database.put('skill_reflection', 'lastAttempt', now.toISOString());
        }
        return eligible;
      };
      const tasks = this.options.prepaid ? this.usePrepaid('reflection', 1, claim) : this.claimCalls(1, claim);
      const current = this.active();
      const evidence: ReflectionEvidence = {
        active: { id: current.id, content: current.content },
        tasks: tasks.slice(-30).map(({ status }) => ({ status })),
        proposals: this.database.list<ChangeProposal>('proposal').slice(-30).map(({ status }) => ({ status })),
      };
      const reflectionSignal = signalFor(this.options.signal, this.options.callTimeoutMs ?? 120_000);
      const result = candidateSchema.parse(this.options.mode === 'live'
        ? await abortable(this.options.reflect!(evidence, reflectionSignal), reflectionSignal)
        : { content: `${current.content}\nBefore suggesting an internal link, verify the supplied destination exists and explain its relevance in reader-facing language. Keep analytics and optimization instructions out of the article.`, rationale: 'Synthetic demonstration of a candidate; no measured improvement is claimed.' });
      if (this.options.signal?.aborted) throw this.options.signal.reason;
      const candidate: SkillVersion = { id: crypto.randomUUID(), version: Math.max(...this.list().map(skill => skill.version)) + 1,
        status: 'candidate', createdAt: this.time().toISOString(), ...result };
      this.database.put('skill', candidate.id, candidate);
      return candidate;
    } finally { this.busy = false; }
  }

  async evaluate(id: string): Promise<SkillVersion> {
    if (this.busy) throw new SiteOpsError('replay_already_attempted', 'Replay is running or has already been attempted.');
    if (this.options.signal?.aborted) throw this.options.signal.reason;
    this.busy = true;
    try {
      const initial = this.database.get<SkillVersion>('skill', id);
      if (!initial || initial.status !== 'candidate') throw new SiteOpsError('candidate_required', 'A candidate skill is required.');
      const inputs = replayInputs(initial);
      const claim = () => {
        const current = this.database.get<SkillVersion>('skill', id);
        if (!current || current.status !== 'candidate') throw new SiteOpsError('candidate_required', 'A candidate skill is required.');
        if (this.database.get('skill_replay', id)) throw new SiteOpsError('replay_already_attempted', 'Replay is running or has already been attempted.');
        this.database.put('skill_replay', id, { startedAt: this.time().toISOString() });
        return current;
      };
      const skill = this.options.prepaid ? this.usePrepaid('replay', 3, claim) : this.claimCalls(inputs.length, claim);
      const failures: string[] = [];
      for (const [index, input] of inputs.entries()) {
        try {
          if (this.options.signal?.aborted) throw this.options.signal.reason;
          const callSignal = signalFor(this.options.signal, this.options.callTimeoutMs ?? 120_000);
          const result = await abortable(this.options.agent.run({ taskId: `replay-${id}-${index}`, input,
            signal: callSignal, onEvent: () => undefined }), callSignal);
          assertSafeProposalHtml(result.bodyHtml);
          if (result.skillVersion !== id || !result.evidenceIds.length || result.evidenceIds.some(ref => !input.opportunity.evidenceIds.includes(ref))) throw new Error('Invalid provenance');
          if (result.bodyHtml === input.page.bodyHtml || result.bodyHtml.length < input.page.bodyHtml.length * 0.8) throw new Error('Missing or destructive change');
        } catch (error) {
          if (this.options.stopOnAgentFailure || this.options.signal?.aborted) throw error;
          failures.push(`case-${index + 1}: safety, provenance, or execution check failed`);
        }
      }
      if (this.options.signal?.aborted) throw this.options.signal.reason;
      const evaluated: SkillVersion = { ...skill, status: 'evaluated', evaluation: { passed: failures.length === 0, cases: inputs.length, failures } };
      this.database.put('skill', id, evaluated);
      return evaluated;
    } finally { this.busy = false; }
  }

  activate(id: string): SkillVersion {
    const skill = this.database.get<SkillVersion>('skill', id);
    if (!skill || !['evaluated', 'retired'].includes(skill.status) || (skill.version !== 1 && !skill.evaluation?.passed)) throw new SiteOpsError('passed_replay_required', 'Activation requires a passed replay, or the original baseline.');
    this.database.transaction(() => {
      for (const old of this.list().filter(item => item.status === 'active')) this.database.put('skill', old.id, { ...old, status: 'retired' });
      this.database.put('skill', id, { ...skill, status: 'active' });
    });
    return this.active();
  }
}
