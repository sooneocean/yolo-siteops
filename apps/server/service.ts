import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type {
  AgentAdapter, AppState, ChangeProposal, Connection, Experiment, Settings, SkillVersion, Snapshot, Task, TaskEvent, TaskFailureCode,
} from '../../packages/contracts.js';
import {
  AgentBlockError,
  AgentOutputError,
  AgentProtocolError,
  AgentSecurityError,
  AgentTimeoutError,
  AgentTurnError,
} from './agent/index.js';
import type { DataProvider } from './data/provider.js';
import { rankOpportunities } from './opportunities.js';
import { HARD_AGENT_RUN_CAP, hasBlockingWeeklyJob, readAgentRunLimit, readSkillCallCount } from './pipeline-guards.js';
import { assertSafeProposalHtml } from './security/html.js';
import { Store } from './store.js';
import { nextSearchDate, observeExperiment } from './experiments.js';
import { hashPostState } from './writer/hash.js';
import { WriterService, WriterServiceError } from './writer/service.js';
import type { ReconciliationAcceptance, WordPressAdapter, WriterReceipt } from './writer/types.js';
import type { ReconciliationReview } from '../../packages/contracts.js';
import { SQLiteWriterStorage } from './writer-store.js';

const SETTINGS_ID = 'current';
const SNAPSHOT_ID = 'current';

export interface SkillSource {
  list(): SkillVersion[];
  active(): SkillVersion;
  propose?(): Promise<SkillVersion>;
  evaluate?(id: string): Promise<SkillVersion>;
  activate?(id: string): SkillVersion | Promise<SkillVersion>;
}

export class StoreSkillSource implements SkillSource {
  constructor(private readonly store: Store, private readonly now: () => Date = () => new Date()) {
    if (!this.store.list<SkillVersion>('skill').length) {
      const skill: SkillVersion = {
        id: 'siteops-editor-v1', version: 1, status: 'active', createdAt: this.now().toISOString(),
        content: 'Preserve supported facts and useful existing content. Make one bounded, evidence-grounded editorial improvement for the reader.',
        rationale: 'Built-in initial skill for bounded local proposals.',
      };
      this.store.put('skill', skill.id, skill);
    }
  }
  list(): SkillVersion[] { return this.store.list<SkillVersion>('skill'); }
  active(): SkillVersion {
    const active = this.list().filter((skill) => skill.status === 'active');
    if (active.length !== 1) throw new SiteOpsError('active_skill_required', 'Exactly one active skill is required.', 409);
    return active[0];
  }
}

export interface SiteOpsServiceOptions {
  mode: 'demo' | 'live';
  siteUrl: string;
  store: Store;
  provider: DataProvider;
  wordpress: WordPressAdapter;
  writerStorage: SQLiteWriterStorage;
  writer: WriterService;
  agent: AgentAdapter;
  agentMode: 'demo' | 'codex';
  skills: SkillSource;
  now?: () => Date;
}

export class SiteOpsError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 409) {
    super(message);
    this.name = 'SiteOpsError';
  }
}

const defaultSettings = (): Settings => ({
  timezone: 'Asia/Taipei',
  scheduleEnabled: false,
  dailyTime: '09:00',
  weeklyTime: 'Mon 09:30',
  maxOpportunities: 10,
  maxWeeklyProposals: 3,
  maxPendingTasks: 10,
  maxAgentRunsPerDay: 10,
});

function taipeiDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export class SiteOpsService {
  private readonly emitter = new EventEmitter();
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private running = false;
  private readonly now: () => Date;

  constructor(private readonly options: SiteOpsServiceOptions) {
    this.now = options.now ?? (() => new Date());
    if (options.mode === 'live' && options.agentMode !== 'codex') {
      throw new SiteOpsError('live_codex_required', 'Live mode requires the Codex agent; demo fallback is forbidden.', 500);
    }
  }

  async initialize(): Promise<void> {
    if (!this.options.store.get<Settings>('settings', SETTINGS_ID)) {
      this.options.store.put('settings', SETTINGS_ID, defaultSettings());
    }
    this.options.writerStorage.reconcileConsumedApprovals();
    for (const proposal of this.options.writerStorage.listProposals()) {
      if (proposal.status === 'review_required') this.finishProposalTask(proposal, 'review_required', proposal.error ?? 'Write outcome requires manual review.');
      if (proposal.status === 'verified_transformed') await this.repairReconciliation(proposal);
    }
    for (const task of this.options.store.list<Task>('task')) {
      if (task.status === 'queued' || task.status === 'running') {
        this.saveTask({ ...task, status: 'failed', stage: 'Interrupted by server restart', updatedAt: this.now().toISOString(), error: 'The task was interrupted before a durable result.', errorCode: 'internal_error' });
        this.emitEvent(task.id, 'task.interrupted', 'Task was interrupted by server restart and was not resumed.');
      }
    }
    if (this.options.mode === 'demo') {
      if (!this.currentSnapshot()) await this.sync();
      if (!this.options.store.list<Connection>('connection').length) await this.checkConnections();
    }
  }

  state(): AppState {
    const snapshot = this.currentSnapshot();
    const settings = this.settings();
    return {
      mode: this.options.mode,
      siteUrl: this.options.siteUrl,
      connections: this.options.store.list<Connection>('connection'),
      ...(snapshot ? { snapshot } : {}),
      opportunities: snapshot ? rankOpportunities(snapshot, settings.maxOpportunities) : [],
      tasks: this.options.store.list<Task>('task').sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      proposals: this.options.writerStorage.listProposals().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      experiments: this.options.store.list<Experiment>('experiment').sort((a, b) => b.startDate.localeCompare(a.startDate)),
      skills: this.options.skills.list(),
      settings,
    };
  }

  async checkConnections(): Promise<Connection[]> {
    const connections = await this.options.provider.check();
    const checkedAt = this.now().toISOString();
    connections.push(this.options.agentMode === 'demo'
      ? { id: 'codex', label: 'Codex', status: 'unconfigured', checkedAt, message: 'Demo mode uses the deterministic local proposal adapter.' }
      : { id: 'codex', label: 'Codex', status: 'unconfigured', checkedAt, message: 'Codex is checked fail-closed when a proposal task runs.' });
    for (const connection of connections) this.options.store.put('connection', connection.id, connection);
    return connections;
  }

  async sync(): Promise<Snapshot> {
    const snapshot = await this.options.provider.sync();
    this.options.store.put('snapshot', SNAPSHOT_ID, snapshot);
    this.options.store.put('snapshot', snapshot.id, snapshot);
    for (const experiment of this.options.store.list<Experiment>('experiment')) {
      this.options.store.put('experiment', experiment.proposalId, observeExperiment(experiment, snapshot));
    }
    return snapshot;
  }

  async createTask(postId: number): Promise<Task> {
    const task = this.options.store.transaction(() => {
      const snapshot = this.requireSnapshot();
      const settings = this.settings();
      const opportunity = rankOpportunities(snapshot, settings.maxOpportunities).find((item) => item.postId === postId);
      if (!opportunity) throw new SiteOpsError('opportunity_not_found', 'No current eligible opportunity exists for this post.', 404);
      const active = this.options.store.list<Task>('task').filter((item) => ['queued', 'running', 'waiting_approval'].includes(item.status));
      if (active.some((item) => item.postId === postId)) throw new SiteOpsError('duplicate_active_task', 'An active task already exists for this post.');
      if (this.options.writerStorage.listProposals().some((proposal) => proposal.postId === postId && proposal.status === 'review_required')) {
        throw new SiteOpsError('post_review_required', 'This post has an unresolved write outcome and cannot accept another task.');
      }
      if (active.length >= settings.maxPendingTasks) throw new SiteOpsError('pending_task_limit', 'The pending task limit has been reached.', 429);
      if (hasBlockingWeeklyJob(this.options.store.db)) {
        throw new SiteOpsError('weekly_skill_running', 'Weekly skill evaluation is running; task creation is temporarily unavailable.', 409);
      }
      const timestamp = this.now().toISOString();
      const today = taipeiDate(new Date(timestamp));
      const todayRuns = this.options.store.list<Task>('task').filter((item) => taipeiDate(new Date(item.createdAt)) === today).length;
      const limit = readAgentRunLimit(settings);
      const skillCalls = readSkillCallCount(this.options.store.get<unknown>('skill_calls', today));
      if (limit === undefined || skillCalls === undefined || todayRuns + skillCalls >= limit) {
        throw new SiteOpsError('daily_agent_limit', 'The daily combined agent run limit has been reached.', 429);
      }
      const skill = this.options.skills.active();
      const queued: Task = {
        id: crypto.randomUUID(), postId, title: opportunity.title, status: 'queued', stage: 'Queued for proposal generation',
        createdAt: timestamp, updatedAt: timestamp, skillVersion: skill.id, snapshotId: snapshot.id,
      };
      this.saveTask(queued);
      return queued;
    });
    this.emitEvent(task.id, 'task.queued', 'Proposal task queued.');
    this.queue.push(task.id);
    queueMicrotask(() => void this.drain());
    return task;
  }

  async cancelTask(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (!['queued', 'running', 'waiting_approval'].includes(task.status)) return task;
    this.controllers.get(taskId)?.abort();
    if (task.status === 'waiting_approval' && task.proposalId) {
      await this.options.writer.reject({ proposalId: task.proposalId, reason: 'Task cancelled by operator' });
    }
    const cancelled = { ...task, status: 'cancelled' as const, stage: 'Cancelled by operator', updatedAt: this.now().toISOString(), error: undefined, errorCode: undefined };
    this.saveTask(cancelled);
    this.emitEvent(taskId, 'task.cancelled', 'Task cancellation accepted.');
    return cancelled;
  }

  events(taskId: string, after = 0): TaskEvent[] {
    this.requireTask(taskId);
    return this.options.store.events(taskId, after);
  }

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    this.requireTask(taskId);
    const key = `task:${taskId}`;
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  async approveProposal(proposalId: string, sessionId: string, expectedPatchHash: string): Promise<string> {
    const approval = await this.options.writer.approve({ proposalId, sessionId, expectedPatchHash });
    return approval.id;
  }

  async applyProposal(proposalId: string, sessionId: string, approvalId: string): Promise<WriterReceipt> {
    const before = await this.requireProposal(proposalId);
    const receipt = await this.options.writer.apply({ proposalId, sessionId, approvalId });
    const proposal = await this.requireProposal(proposalId);
    if (proposal.status === 'verified_transformed' || proposal.status === before.status) return receipt;
    if (receipt.status === 'applied' && proposal.status === 'applied') {
      this.createExperiment(proposal);
      this.finishProposalTask(proposal, 'completed', 'WordPress write verified; technical task completed.');
    } else if (receipt.status === 'review_required' && proposal.status === 'review_required') {
      this.finishProposalTask(proposal, 'review_required', 'Write outcome requires manual review.');
      this.confoundExperiment(proposalId, 'Write outcome is unknown.');
    } else {
      throw new SiteOpsError('apply_state_conflict', 'Apply receipt does not match the current proposal state.', 409);
    }
    return receipt;
  }

  async prepareReconciliation(proposalId: string, sessionId: string): Promise<ReconciliationReview> {
    return this.options.writer.prepareReconciliation({ proposalId, sessionId });
  }

  async acceptReconciliation(proposalId: string, sessionId: string, reviewId: string, reviewedActualHash: string): Promise<ReconciliationAcceptance> {
    return this.options.writer.acceptReconciliation({ proposalId, sessionId, reviewId, reviewedActualHash });
  }

  async reconcileProposal(proposalId: string, sessionId: string, acceptanceId: string): Promise<WriterReceipt> {
    const receipt = await this.options.writer.reconcile({ proposalId, sessionId, acceptanceId });
    const proposal = await this.requireProposal(proposalId);
    await this.repairReconciliation(proposal);
    return receipt;
  }

  async rejectProposal(proposalId: string, reason = 'Rejected by operator'): Promise<ChangeProposal> {
    const proposal = await this.options.writer.reject({ proposalId, reason });
    this.finishProposalTask(proposal, 'cancelled', 'Proposal rejected by operator.');
    return proposal;
  }

  async approveRollback(proposalId: string, sessionId: string): Promise<string> {
    const approval = await this.options.writer.approveRollback({ proposalId, sessionId });
    return approval.id;
  }

  async rollbackProposal(proposalId: string, sessionId: string, approvalId: string): Promise<WriterReceipt> {
    try {
      const receipt = await this.options.writer.rollback({ proposalId, sessionId, approvalId });
      this.confoundExperiment(proposalId, receipt.status === 'rolled_back' ? 'Content was rolled back.' : 'Rollback outcome requires manual review.');
      const proposal = await this.requireProposal(proposalId);
      if (receipt.status === 'review_required') this.finishProposalTask(proposal, 'review_required', 'Rollback outcome requires manual review.');
      return receipt;
    } catch (error) {
      this.confoundExperiment(proposalId, 'Rollback was blocked by state drift or conflict.');
      throw error;
    }
  }

  updateSettings(value: unknown): Settings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SiteOpsError('invalid_settings', 'Settings patch must be an object.', 400);
    const patch = value as Record<string, unknown>;
    const allowed = new Set(['scheduleEnabled', 'dailyTime', 'weeklyTime', 'maxOpportunities', 'maxWeeklyProposals', 'maxPendingTasks', 'maxAgentRunsPerDay']);
    if (Object.keys(patch).some((key) => !allowed.has(key))) throw new SiteOpsError('invalid_settings_key', 'Settings patch contains an unsupported field.', 400);
    const next = { ...this.settings() };
    if ('scheduleEnabled' in patch) {
      if (typeof patch.scheduleEnabled !== 'boolean') throw new SiteOpsError('invalid_settings', 'scheduleEnabled must be boolean.', 400);
      next.scheduleEnabled = patch.scheduleEnabled;
    }
    for (const key of ['dailyTime', 'weeklyTime'] as const) {
      if (key in patch) {
        const value = patch[key];
        const valid = typeof value === 'string' && (key === 'dailyTime'
          ? /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
          : /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([01]\d|2[0-3]):[0-5]\d$/.test(value));
        if (!valid) throw new SiteOpsError('invalid_settings', `${key} is invalid.`, 400);
        next[key] = value as string;
      }
    }
    for (const key of ['maxOpportunities', 'maxWeeklyProposals', 'maxPendingTasks', 'maxAgentRunsPerDay'] as const) {
      if (key in patch) {
        const cap = key === 'maxOpportunities' ? 10 : key === 'maxWeeklyProposals' ? 3
          : key === 'maxAgentRunsPerDay' ? HARD_AGENT_RUN_CAP : 100;
        if (!Number.isInteger(patch[key]) || (patch[key] as number) < 1 || (patch[key] as number) > cap) throw new SiteOpsError('invalid_settings', `${key} must be an integer from 1 to ${cap}.`, 400);
        next[key] = patch[key] as number;
      }
    }
    if (readAgentRunLimit(next) === undefined) {
      throw new SiteOpsError('invalid_settings', `maxAgentRunsPerDay must be an integer from 1 to ${HARD_AGENT_RUN_CAP}.`, 400);
    }
    this.options.store.put('settings', SETTINGS_ID, next);
    return next;
  }

  async proposeSkill(): Promise<SkillVersion> {
    if (!this.options.skills.propose) throw new SiteOpsError('skill_service_unavailable', 'Skill proposal service is unavailable.', 503);
    return this.options.skills.propose();
  }

  async evaluateSkill(id: string): Promise<SkillVersion> {
    if (!this.options.skills.evaluate) throw new SiteOpsError('skill_service_unavailable', 'Skill evaluation service is unavailable.', 503);
    return this.options.skills.evaluate(id);
  }

  async activateSkill(id: string): Promise<SkillVersion> {
    if (!this.options.skills.activate) throw new SiteOpsError('skill_service_unavailable', 'Skill activation service is unavailable.', 503);
    return this.options.skills.activate(id);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        if (!id) continue;
        const task = this.options.store.get<Task>('task', id);
        if (!task || task.status !== 'queued') continue;
        await this.runTask(task);
      }
    } finally {
      this.running = false;
    }
  }

  private async runTask(task: Task): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const running = { ...task, status: 'running' as const, stage: 'Generating grounded proposal', updatedAt: this.now().toISOString() };
    this.saveTask(running);
    this.emitEvent(task.id, 'task.running', 'Proposal generation started.');
    try {
      // Daily reservations are made when tasks are created; never spend a prior
      // day's queued reservation in a new day's budget.
      if (taipeiDate(new Date(task.createdAt)) !== taipeiDate(this.now())) throw new SiteOpsError('task_reservation_expired', 'The task daily reservation expired before execution.');
      const snapshot = this.requireSnapshot(task.snapshotId);
      const page = snapshot.pages.find((item) => item.postId === task.postId);
      const opportunity = rankOpportunities(snapshot, this.settings().maxOpportunities).find((item) => item.postId === task.postId);
      const skill = this.options.skills.list().find((item) => item.id === task.skillVersion);
      if (!page || !opportunity || !skill) throw new SiteOpsError('task_input_stale', 'Pinned task inputs are no longer available.');
      const fresh = await this.options.wordpress.getPostForEdit(task.postId);
      if (hashPostState(fresh) !== page.protectedHash) throw new SiteOpsError('wordpress_state_drift', 'Private WordPress state changed after the snapshot.');
      const result = await this.options.agent.run({
        taskId: task.id,
        input: {
          page,
          opportunity,
          evidence: snapshot.evidence.filter((item) => opportunity.evidenceIds.includes(item.id)),
          relatedPages: snapshot.pages.filter((item) => item.postId !== page.postId).map(({ postId, url, title }) => ({ postId, url, title })),
          skillContent: skill.content,
          skillVersion: skill.id,
        },
        signal: controller.signal,
        onEvent: (type, message) => {
          this.emitEvent(task.id, type, message);
          if (this.options.agentMode === 'codex' && type === 'agent.running') this.options.store.put<Connection>('connection', 'codex', {
            id: 'codex', label: 'Codex', status: 'checking', checkedAt: this.now().toISOString(), message: '安全預檢通過，正在產生提案。',
          });
        },
      });
      if (controller.signal.aborted) throw Object.assign(new Error('Task cancelled'), { name: 'AbortError' });
      assertSafeProposalHtml(result.bodyHtml);
      if (result.skillVersion !== task.skillVersion) throw new SiteOpsError('skill_version_mismatch', 'Agent result did not retain the pinned skill version.');
      if (result.bodyHtml === fresh.bodyHtml) throw new SiteOpsError('no_op_proposal', 'Agent result did not change the WordPress body.');
      if (!result.evidenceIds.length || result.evidenceIds.some((id) => !opportunity.evidenceIds.includes(id))) {
        throw new SiteOpsError('ungrounded_agent_result', 'Agent result did not retain approved evidence references.');
      }
      const proposal: ChangeProposal = {
        id: crypto.randomUUID(), taskId: task.id, postId: page.postId, title: page.title, url: fresh.url,
        beforeHtml: fresh.bodyHtml, afterHtml: result.bodyHtml, summary: result.summary, evidenceIds: result.evidenceIds,
        baseHash: hashPostState(fresh), patchHash: hashPostState({ ...fresh, bodyHtml: result.bodyHtml }),
        status: 'pending', createdAt: this.now().toISOString(),
      };
      await this.options.writerStorage.saveProposal(proposal);
      const waiting: Task = { ...running, status: 'waiting_approval', stage: 'Proposal ready for human approval', proposalId: proposal.id, updatedAt: this.now().toISOString() };
      if (this.options.agentMode === 'codex') this.options.store.put<Connection>('connection', 'codex', {
        id: 'codex', label: 'Codex', status: 'ready', checkedAt: this.now().toISOString(), message: '最近一次真實推理已完成，提案已通過本機驗證。',
      });
      this.saveTask(waiting);
      this.emitEvent(task.id, 'task.waiting_approval', 'Proposal is ready for human approval.');
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      if (this.options.agentMode === 'codex') this.options.store.put<Connection>('connection', 'codex', {
        id: 'codex', label: 'Codex', status: cancelled ? 'unconfigured' : 'error', checkedAt: this.now().toISOString(),
        message: cancelled ? '操作已取消；尚未完成推理驗證。' : '任務未完成；請檢查本機 Agent 的版本、登入與執行限制。',
      });
      const failed: Task = {
        ...running,
        status: cancelled ? 'cancelled' : 'failed',
        stage: cancelled ? 'Cancelled by operator' : 'Proposal generation failed',
        updatedAt: this.now().toISOString(),
        error: cancelled ? undefined : 'Task execution failed without producing a proposal.',
        errorCode: cancelled ? undefined : taskFailureCodeFor(error),
      };
      this.saveTask(failed);
      this.emitEvent(task.id, cancelled ? 'task.cancelled' : 'task.failed', cancelled ? 'Task cancelled.' : 'Task failed without a durable proposal.');
    } finally {
      this.controllers.delete(task.id);
    }
  }

  private createExperiment(proposal: ChangeProposal): void {
    const task = this.options.store.get<Task>('task', proposal.taskId);
    const snapshot = task ? this.options.store.get<Snapshot>('snapshot', task.snapshotId) : undefined;
    const pageMetrics = snapshot?.pageMetrics?.find((row) => row.postId === proposal.postId);
    const baselineClicks = pageMetrics?.clicks ?? snapshot?.search.filter((row) => row.postId === proposal.postId).reduce((sum, row) => sum + row.clicks, 0) ?? 0;
    const baselineSessions = snapshot?.analytics.find((row) => row.postId === proposal.postId)?.sessions;
    const start = proposal.reconciledAt ? new Date(proposal.reconciledAt) : this.now();
    const startDate = nextSearchDate(start);
    const baselineEvidence = snapshot?.evidence.find(item => item.id === pageMetrics?.evidenceId);
    const experiment: Experiment = {
      id: `experiment:${proposal.id}`, proposalId: proposal.id, postId: proposal.postId,
      startDate, dueDate: new Date(Date.parse(`${startDate}T00:00:00Z`) + 27 * 86400000).toISOString().slice(0, 10),
      status: 'observing', baselineClicks, ...(baselineSessions === undefined ? {} : { baselineSessions }),
      ...(baselineEvidence ? { baselineEvidence } : {}), expectedPostHash: proposal.afterHash ?? proposal.patchHash,
      note: proposal.status === 'verified_transformed'
        ? 'The accepted WordPress formatting transformation was verified without another write; impact requires a complete observation window.'
        : 'Technical write verification passed; impact requires a complete observation window.',
    };
    const existing = this.options.store.get<Experiment>('experiment', proposal.id);
    if (existing) {
      const incompatible = existing.id !== experiment.id || existing.proposalId !== experiment.proposalId
        || existing.postId !== experiment.postId || existing.startDate !== experiment.startDate
        || existing.dueDate !== experiment.dueDate || existing.baselineClicks !== experiment.baselineClicks
        || existing.baselineSessions !== experiment.baselineSessions || existing.expectedPostHash !== experiment.expectedPostHash
        || JSON.stringify(existing.baselineEvidence) !== JSON.stringify(experiment.baselineEvidence);
      if (incompatible) {
        throw new SiteOpsError('experiment_repair_conflict', 'Existing experiment conflicts with the immutable proposal reconciliation receipt.', 500);
      }
      return;
    }
    for (const other of this.options.store.list<Experiment>('experiment')) {
      if (other.postId === proposal.postId && ['observing', 'insufficient'].includes(other.status)) this.confoundExperiment(other.proposalId, '觀察期間套用了另一個提案。');
    }
    this.options.store.put('experiment', proposal.id, experiment);
  }

  private async repairReconciliation(proposal: ChangeProposal): Promise<void> {
    const receipt = await this.options.writerStorage.getReceipt('reconcile', proposal.id);
    if (!receipt || receipt.status !== 'verified_transformed' || receipt.proposalId !== proposal.id
      || receipt.afterHash !== proposal.afterHash || receipt.createdAt !== proposal.reconciledAt) {
      throw new SiteOpsError('reconciliation_repair_conflict', 'Verified transformation is missing its immutable reconciliation receipt.', 500);
    }
    const task = this.options.store.get<Task>('task', proposal.taskId);
    const snapshot = task ? this.options.store.get<Snapshot>('snapshot', task.snapshotId) : undefined;
    if (!task || task.postId !== proposal.postId || task.proposalId !== proposal.id || !snapshot) {
      throw new SiteOpsError('reconciliation_repair_conflict', 'Verified transformation cannot be matched to its immutable task snapshot.', 500);
    }
    if (task.status !== 'completed' || task.stage !== 'WordPress format transformation accepted' || task.error) {
      this.saveTask({ ...task, status: 'completed', stage: 'WordPress format transformation accepted', updatedAt: proposal.reconciledAt ?? receipt.createdAt, error: undefined });
    }
    this.createExperiment(proposal);
  }

  private confoundExperiment(proposalId: string, note: string): void {
    const experiment = this.options.store.get<Experiment>('experiment', proposalId);
    if (experiment) this.options.store.put('experiment', proposalId, { ...experiment, status: 'confounded', note });
  }

  private finishProposalTask(proposal: ChangeProposal, status: Task['status'], stage: string): void {
    const task = this.options.store.get<Task>('task', proposal.taskId);
    if (!task) return;
    this.saveTask({ ...task, status, stage, updatedAt: this.now().toISOString(), ...(status === 'review_required' ? { error: stage } : {}) });
    this.emitEvent(task.id, `task.${status}`, stage);
  }

  private async requireProposal(id: string): Promise<ChangeProposal> {
    const proposal = await this.options.writerStorage.getProposal(id);
    if (!proposal) throw new SiteOpsError('proposal_not_found', 'Proposal was not found.', 404);
    return proposal;
  }
  private settings(): Settings { return this.options.store.get<Settings>('settings', SETTINGS_ID) ?? defaultSettings(); }
  private currentSnapshot(): Snapshot | undefined { return this.options.store.get<Snapshot>('snapshot', SNAPSHOT_ID); }
  private requireSnapshot(id?: string): Snapshot {
    const snapshot = id ? this.options.store.get<Snapshot>('snapshot', id) : this.currentSnapshot();
    if (!snapshot) throw new SiteOpsError('snapshot_required', 'A pinned snapshot is required.', 409);
    return snapshot;
  }
  private requireTask(id: string): Task {
    const task = this.options.store.get<Task>('task', id);
    if (!task) throw new SiteOpsError('task_not_found', 'Task was not found.', 404);
    return task;
  }
  private saveTask(task: Task): void { this.options.store.put('task', task.id, task); }
  private emitEvent(taskId: string, type: string, message: string): TaskEvent {
    const event = this.options.store.event(taskId, type, message);
    this.emitter.emit(`task:${taskId}`, event);
    return event;
  }
}

export function httpStatusFor(error: unknown): number {
  if (error instanceof SiteOpsError || error instanceof WriterServiceError) return error.httpStatus;
  return 500;
}

export function errorCodeFor(error: unknown): string {
  if (error instanceof SiteOpsError || error instanceof WriterServiceError) return error.code;
  return 'internal_error';
}

const taskSiteOpsFailureCodes = new Set<TaskFailureCode>([
  'task_input_stale',
  'wordpress_state_drift',
  'task_reservation_expired',
]);

export function taskFailureCodeFor(error: unknown): TaskFailureCode {
  if (error instanceof AgentOutputError) return error.code;
  if (error instanceof AgentBlockError) return error.code;
  if (error instanceof AgentSecurityError) return 'agent_security';
  if (error instanceof AgentTurnError) return 'agent_turn';
  if (error instanceof AgentProtocolError) return 'agent_protocol';
  if (error instanceof AgentTimeoutError) return 'agent_timeout';
  if (error instanceof SiteOpsError && taskSiteOpsFailureCodes.has(error.code as TaskFailureCode)) {
    return error.code as TaskFailureCode;
  }
  return 'internal_error';
}
