import { describe, expect, it, vi } from 'vitest';
import type { AgentInput, AgentResult } from '../packages/contracts.js';
import { CodexAgentAdapter } from '../apps/server/agent/codex-adapter.js';
import {
  AgentOutputError,
  AgentSecurityError,
  type AgentOutputErrorCode,
} from '../apps/server/agent/errors.js';
import { proposalHtmlOutputGuidance, validateAgentResult } from '../apps/server/agent/validation.js';

const input: AgentInput = {
  page: {
    postId: 1,
    url: 'https://example.test/article',
    title: 'Article',
    bodyHtml: '<p>Before</p>',
    status: 'publish',
    modified: '2026-10-23T00:00:00.000Z',
    protectedHash: 'hash',
  },
  opportunity: {
    id: 'snapshot:1',
    postId: 1,
    title: 'Article',
    url: 'https://example.test/article',
    kind: 'decay',
    clicks: 1,
    previousClicks: 2,
    impressions: 10,
    position: 4,
    queries: ['query'],
    evidenceIds: ['evidence-1'],
    quality: 'available',
    reason: 'Reason',
    audienceHypothesis: 'Audience',
    keywordHypotheses: ['query'],
  },
  evidence: [{
    id: 'evidence-1',
    source: 'gsc',
    property: 'https://example.test/',
    startDate: '2026-10-01',
    endDate: '2026-10-22',
    timeZone: 'Asia/Taipei',
    fetchedAt: '2026-10-23T00:00:00.000Z',
    complete: true,
    coverage: 'Complete',
  }],
  relatedPages: [],
  skillContent: 'Use evidence and preserve factual claims.',
  skillVersion: 'skill-v1',
};

const validResult: AgentResult = {
  bodyHtml: '<p>Safe</p>',
  summary: 'Safe summary',
  evidenceIds: ['evidence-1'],
  skillVersion: 'skill-v1',
};

const cases: Array<[AgentOutputErrorCode, unknown]> = [
  ['output_schema', {}],
  ['skill_version_mismatch', { ...validResult, skillVersion: 'skill-v2' }],
  ['duplicate_evidence', { ...validResult, evidenceIds: ['evidence-1', 'evidence-1'] }],
  ['ungrounded_evidence', { ...validResult, evidenceIds: ['outside'] }],
  ['html_policy', { ...validResult, bodyHtml: '<script>unsafe()</script>' }],
  ['summary_policy', { ...validResult, summary: '<b>markup</b>' }],
];

describe('agent output diagnostics', () => {
  it.each(cases)('classifies %s without exposing parser details', (code, result) => {
    let caught: unknown;
    try {
      validateAgentResult(result, input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentOutputError);
    expect(caught).toBeInstanceOf(AgentSecurityError);
    expect((caught as AgentOutputError).code).toBe(code);
  });

  it('rejects invalid input before starting a model process', async () => {
    const spawnProcess = vi.fn();
    const adapter = new CodexAgentAdapter({ cwd: '/tmp', spawnProcess });
    const invalidInput = {
      ...input,
      opportunity: { ...input.opportunity, postId: 2 },
    };

    await expect(adapter.run({
      taskId: 'task-1',
      input: invalidInput,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).rejects.toBeInstanceOf(AgentSecurityError);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('accepts sanitizer-canonical HTML and retains exact-byte rejection', () => {
    const canonical = {
      ...validResult,
      bodyHtml: '<p>A &lt; B &amp; C &gt; D</p><a href="https://example.test/related?a=1&amp;b=2" rel="nofollow">Related</a><br /><img src="https://example.test/image.png" alt="A &amp; B" />',
    };
    expect(validateAgentResult(canonical, input)).toEqual(canonical);
    expect(() => validateAgentResult({ ...validResult, bodyHtml: '<p>A & B</p>' }, input))
      .toThrowError(expect.objectContaining({ code: 'html_policy' }));
    expect(() => validateAgentResult({ ...validResult, bodyHtml: '<p class="note">Unsafe</p>' }, input))
      .toThrowError(expect.objectContaining({ code: 'html_policy' }));
  });

  it('derives output guidance from the enforced policy', () => {
    const guidance = proposalHtmlOutputGuidance();
    expect(guidance).toContain('<p>');
    expect(guidance).toContain('<a>: href, title, target, rel');
    expect(guidance).toContain('http, https, mailto');
    expect(guidance).toContain('id, class, and style, are forbidden');
    expect(guidance).toContain('<br /> and <img ... />');
  });
});
