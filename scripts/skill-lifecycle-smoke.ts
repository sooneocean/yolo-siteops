import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, SkillVersion, Task } from '../packages/contracts.js';
import {
  AgentProtocolError,
  AgentSecurityError,
  AgentTimeoutError,
  AgentTurnError,
  CodexAgentAdapter,
} from '../apps/server/agent/index.js';
import { SiteOpsError } from '../apps/server/service.js';
import { SkillService } from '../apps/server/skills.js';
import { Store } from '../apps/server/store.js';

const command = process.env.SITEOPS_CODEX_COMMAND;
if (!command || !path.isAbsolute(command)) {
  throw new Error('SITEOPS_CODEX_COMMAND must be an explicit absolute path');
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(repositoryRoot, 'work');
const runId = crypto.randomUUID();
const outputPath = path.join(outputDirectory, `skill-lifecycle-smoke-${runId}.json`);
const nowValue = new Date();
const now = (): Date => new Date(nowValue);
const digest = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

function statusCounts(skills: SkillVersion[]): Record<string, number> {
  return skills.reduce<Record<string, number>>((counts, skill) => {
    counts[skill.status] = (counts[skill.status] ?? 0) + 1;
    return counts;
  }, {});
}

function safeFailureCode(error: unknown): string {
  if (error instanceof AgentSecurityError) return 'agent_security';
  if (error instanceof AgentProtocolError) return 'agent_protocol';
  if (error instanceof AgentTimeoutError) return 'agent_timeout';
  if (error instanceof AgentTurnError) return 'agent_turn';
  if (error instanceof SiteOpsError) return 'skill_lifecycle';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'lifecycle_failed';
}

await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await fs.chmod(outputDirectory, 0o700);

const store = new Store(':memory:');
let modelCalls = 0;
const adapter = new CodexAgentAdapter({ command, cwd: repositoryRoot, timeoutMs: 120_000 });
const boundedCall = (): void => {
  modelCalls += 1;
  if (modelCalls > 4) throw new Error('Lifecycle model call bound exceeded');
};
const replayAgent: AgentAdapter = {
  run: async (args) => {
    boundedCall();
    return await adapter.run(args);
  },
};

try {
  const timestamp = now().toISOString();
  const completedTask: Task = {
    id: 'fake-completed-task',
    postId: 1,
    title: 'Synthetic lifecycle evidence',
    status: 'completed',
    stage: 'synthetic-complete',
    createdAt: timestamp,
    updatedAt: timestamp,
    skillVersion: 'siteops-editor-v1',
    snapshotId: 'synthetic-snapshot',
  };
  store.put('task', completedTask.id, completedTask);

  const skills = new SkillService(store, {
    agent: replayAgent,
    mode: 'live',
    now,
    reflect: async (evidence) => {
      boundedCall();
      return await adapter.reflect(evidence, AbortSignal.timeout(120_000));
    },
  });

  const baseline = skills.active();
  const candidate = await skills.propose();
  assert.equal(candidate.status, 'candidate');

  const evaluated = await skills.evaluate(candidate.id);
  assert.equal(evaluated.status, 'evaluated');
  assert.deepEqual(evaluated.evaluation, { passed: true, cases: 3, failures: [] });
  assert.equal(modelCalls, 4);

  const activated = skills.activate(candidate.id);
  assert.equal(activated.id, candidate.id);
  assert.equal(skills.active().id, candidate.id);

  const restored = skills.activate(baseline.id);
  const finalSkills = skills.list();
  assert.equal(restored.id, baseline.id);
  assert.equal(skills.active().id, baseline.id);
  assert.equal(finalSkills.filter(skill => skill.status === 'active').length, 1);

  const evidence = {
    runId,
    status: 'completed',
    modelCalls: { reflection: 1, replay: 3, total: modelCalls },
    skillIds: {
      baseline: baseline.id,
      candidate: candidate.id,
      activated: activated.id,
      restored: restored.id,
    },
    candidateHashes: {
      contentSha256: digest(candidate.content),
      rationaleSha256: digest(candidate.rationale),
    },
    evaluation: {
      passed: evaluated.evaluation?.passed === true,
      cases: evaluated.evaluation?.cases ?? 0,
      failureCount: evaluated.evaluation?.failures.length ?? 0,
    },
    finalSkillStatusCounts: statusCounts(finalSkills),
    exactlyOneActive: finalSkills.filter(skill => skill.status === 'active').length === 1,
    baselineRestored: skills.active().id === baseline.id,
    productionReads: 0,
    productionWrites: 0,
    rawOutputStored: false,
    at: new Date().toISOString(),
  };
  await fs.writeFile(outputPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: evidence.status, evidencePath: outputPath }));
} catch (error) {
  const evidence = {
    runId,
    status: 'failed',
    failureCode: safeFailureCode(error),
    modelCalls: { total: modelCalls, maximum: 4 },
    productionReads: 0,
    productionWrites: 0,
    rawOutputStored: false,
    at: new Date().toISOString(),
  };
  await fs.writeFile(outputPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.error(JSON.stringify({ status: evidence.status, evidencePath: outputPath }));
  process.exitCode = 1;
} finally {
  store.close();
}
