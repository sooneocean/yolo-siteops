import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, Task, TaskFailureCode } from '../packages/contracts.js';
import { taskFailureMessage, taskFailureMessages } from '../packages/task-errors.js';
import {
  AgentBlockError,
  AgentOutputError,
  AgentProtocolError,
  AgentSecurityError,
  AgentTimeoutError,
  AgentTurnError,
} from '../apps/server/agent/index.js';
import { abortError } from '../apps/server/agent/errors.js';
import { DemoDataProvider, DemoWordPressAdapter } from '../apps/server/demo-wordpress.js';
import { SiteOpsError, SiteOpsService, StoreSkillSource } from '../apps/server/service.js';
import { Store } from '../apps/server/store.js';
import { WriterService } from '../apps/server/writer/service.js';
import { SQLiteWriterStorage } from '../apps/server/writer-store.js';

const failureCodes = [
  'output_schema',
  'skill_version_mismatch',
  'duplicate_evidence',
  'ungrounded_evidence',
  'html_policy',
  'summary_policy',
  'block_structure',
  'block_preservation',
  'agent_timeout',
  'agent_protocol',
  'agent_security',
  'agent_turn',
  'task_input_stale',
  'wordpress_state_drift',
  'task_reservation_expired',
  'internal_error',
] as const satisfies readonly TaskFailureCode[];

const stores: Store[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function makeService(agent: AgentAdapter): Promise<{ service: SiteOpsService; store: Store }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-task-errors-'));
  tempRoots.push(root);
  const now = () => new Date('2026-10-23T02:00:00Z');
  const store = new Store(':memory:');
  stores.push(store);
  const wordpress = new DemoWordPressAdapter(store, now);
  const provider = new DemoDataProvider(wordpress, now);
  const writerStorage = new SQLiteWriterStorage(store);
  const writer = new WriterService({
    storage: writerStorage,
    adapter: wordpress,
    siteOrigin: 'https://example.test',
    lockPath: path.join(root, 'writer.lock'),
    now,
  });
  const service = new SiteOpsService({
    mode: 'demo',
    siteUrl: 'https://example.test',
    store,
    provider,
    wordpress,
    writerStorage,
    writer,
    agent,
    agentMode: 'demo',
    skills: new StoreSkillSource(store, now),
    now,
  });
  await service.initialize();
  return { service, store };
}

async function waitForTask(service: SiteOpsService, id: string, status: Task['status']): Promise<Task> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = service.state().tasks.find((item) => item.id === id);
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${id} did not reach ${status}`);
}

describe('task failure messages', () => {
  it('covers every closed failure code with a fixed safe message', () => {
    expect(Object.keys(taskFailureMessages).sort()).toEqual([...failureCodes].sort());
    for (const code of failureCodes) {
      expect(taskFailureMessage(code)).toBe(taskFailureMessages[code]);
      expect(taskFailureMessage(code)).not.toContain(code);
    }
  });

  it('uses the generic message for old tasks and untrusted runtime values', () => {
    expect(taskFailureMessage(undefined)).toBe('任務失敗，請重新同步後再試。');
    expect(taskFailureMessage('raw database payload' as TaskFailureCode)).toBe('任務失敗，請重新同步後再試。');
  });
});

describe('proposal task failure classification', () => {
  const rawSecret = 'PRIVATE exception details and stack';
  const cases: Array<[TaskFailureCode, unknown]> = [
    ['output_schema', new AgentOutputError('output_schema', rawSecret)],
    ['skill_version_mismatch', new AgentOutputError('skill_version_mismatch', rawSecret)],
    ['duplicate_evidence', new AgentOutputError('duplicate_evidence', rawSecret)],
    ['ungrounded_evidence', new AgentOutputError('ungrounded_evidence', rawSecret)],
    ['html_policy', new AgentOutputError('html_policy', rawSecret)],
    ['summary_policy', new AgentOutputError('summary_policy', rawSecret)],
    ['block_structure', new AgentBlockError('block_structure', rawSecret)],
    ['block_preservation', new AgentBlockError('block_preservation', rawSecret)],
    ['agent_timeout', new AgentTimeoutError(rawSecret)],
    ['agent_protocol', new AgentProtocolError(rawSecret)],
    ['agent_security', new AgentSecurityError(rawSecret)],
    ['agent_turn', new AgentTurnError({ status: 'failed', codexErrorInfo: 'unknown', messageCategory: 'redacted' })],
    ['task_input_stale', new SiteOpsError('task_input_stale', rawSecret)],
    ['wordpress_state_drift', new SiteOpsError('wordpress_state_drift', rawSecret)],
    ['task_reservation_expired', new SiteOpsError('task_reservation_expired', rawSecret)],
    ['internal_error', new SiteOpsError('attacker_controlled_code', rawSecret)],
  ];

  for (const [expectedCode, failure] of cases) {
    it(`persists ${expectedCode} without raw exception data`, async () => {
      const agent: AgentAdapter = { run: async () => { throw failure; } };
      const { service, store } = await makeService(agent);
      const task = await service.createTask(service.state().opportunities[0].postId);
      const failed = await waitForTask(service, task.id, 'failed');

      expect(failed).toMatchObject({
        status: 'failed',
        errorCode: expectedCode,
        error: 'Task execution failed without producing a proposal.',
      });
      expect(JSON.stringify(store.get<Task>('task', task.id))).not.toContain(rawSecret);
      expect(JSON.stringify(service.events(task.id))).not.toContain(rawSecret);
    });
  }

  it('classifies unknown thrown values as internal_error without persisting them', async () => {
    const agent: AgentAdapter = { run: async () => { throw { message: rawSecret, issues: [rawSecret], stack: rawSecret }; } };
    const { service, store } = await makeService(agent);
    const task = await service.createTask(service.state().opportunities[0].postId);
    const failed = await waitForTask(service, task.id, 'failed');

    expect(failed.errorCode).toBe('internal_error');
    expect(JSON.stringify(store.get<Task>('task', task.id))).not.toContain(rawSecret);
    expect(JSON.stringify(service.events(task.id))).not.toContain(rawSecret);
  });

  it('keeps cancelled tasks free of failure fields', async () => {
    const agent: AgentAdapter = {
      run: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(abortError('PRIVATE cancellation detail')), { once: true });
      }),
    };
    const { service } = await makeService(agent);
    const task = await service.createTask(service.state().opportunities[0].postId);
    await waitForTask(service, task.id, 'running');
    await service.cancelTask(task.id);
    const cancelled = await waitForTask(service, task.id, 'cancelled');

    expect(cancelled).not.toHaveProperty('errorCode');
    expect(cancelled).not.toHaveProperty('error');
  });
});
