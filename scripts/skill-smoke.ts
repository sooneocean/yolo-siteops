import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CodexAgentAdapter } from '../apps/server/agent/index.js';

const command = process.env.SITEOPS_CODEX_COMMAND;
if (!command || !path.isAbsolute(command)) {
  throw new Error('SITEOPS_CODEX_COMMAND must be an explicit absolute path');
}

const repositoryRoot = process.cwd();
const runId = crypto.randomUUID();
const outputDirectory = path.join(repositoryRoot, 'work');
const outputPath = path.join(outputDirectory, `skill-smoke-${runId}.json`);
const hash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });

const adapter = new CodexAgentAdapter({ command, cwd: repositoryRoot, timeoutMs: 120_000 });
try {
  const result = await adapter.reflect({
    active: {
      id: 'fake-active-skill-v1',
      content: 'Preserve supported facts, keep edits bounded, and use reader-facing language.',
    },
    tasks: [{ status: 'completed' }, { status: 'review_required' }, { status: 'cancelled' }],
    proposals: [{ status: 'applied' }, { status: 'rejected' }, { status: 'rolled_back' }],
  }, AbortSignal.timeout(120_000));
  const evidence = {
    runId,
    status: 'completed',
    calls: 1,
    contentLength: result.content.length,
    contentSha256: hash(result.content),
    rationaleLength: result.rationale.length,
    rationaleSha256: hash(result.rationale),
    rawOutputStored: false,
    at: new Date().toISOString(),
  };
  await fs.writeFile(outputPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: evidence.status, evidencePath: outputPath }));
} catch (error) {
  const evidence = {
    runId,
    status: 'failed',
    calls: 1,
    errorType: error instanceof Error ? error.name : 'UnknownError',
    rawOutputStored: false,
    at: new Date().toISOString(),
  };
  await fs.writeFile(outputPath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.error(JSON.stringify({ status: evidence.status, evidencePath: outputPath }));
  process.exitCode = 1;
}
