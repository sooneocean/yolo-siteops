import { describe, expect, it, vi } from 'vitest';
import type { AgentInput, AgentResult } from '../packages/contracts.js';
import { CodexAgentAdapter } from '../apps/server/agent/codex-adapter.js';
import { AgentBlockError, AgentOutputError } from '../apps/server/agent/errors.js';
import {
  applyBlockParagraphEdit,
  prepareBlockParagraphEdit,
  selectBlockParagraph,
} from '../apps/server/agent/blocks.js';

const sourceText = 'This original paragraph contains enough grounded reader context for a bounded editorial improvement.';

function input(bodyHtml: string): AgentInput {
  return {
    page: {
      postId: 54158,
      url: 'https://example.test/article',
      title: 'Article',
      bodyHtml,
      status: 'publish',
      modified: '2026-10-23T00:00:00.000Z',
      protectedHash: 'hash',
    },
    opportunity: {
      id: 'snapshot:54158', postId: 54158, title: 'Article', url: 'https://example.test/article',
      kind: 'decay', clicks: 10, previousClicks: 20, impressions: 200, position: 8,
      queries: ['query'], evidenceIds: ['evidence-1'], quality: 'available', reason: 'Reason',
      audienceHypothesis: 'Audience', keywordHypotheses: ['query'],
    },
    evidence: [{
      id: 'evidence-1', source: 'gsc', property: 'https://example.test/', startDate: '2026-10-01',
      endDate: '2026-10-22', timeZone: 'Asia/Taipei', fetchedAt: '2026-10-23T00:00:00.000Z',
      complete: true, coverage: 'Complete',
    }],
    relatedPages: [],
    skillContent: 'Preserve evidence and useful content.',
    skillVersion: 'skill-v1',
  };
}

function result(bodyHtml: string): AgentResult {
  return { bodyHtml, summary: 'Bounded paragraph edit', evidenceIds: ['evidence-1'], skillVersion: 'skill-v1' };
}

function synthetic67BlockBody(): string {
  const blocks = [
    '<!-- wp:heading --><h2>Heading preserved</h2><!-- /wp:heading -->',
    '<!-- wp:image {"id":7} /-->',
    '<!-- wp:custom/wrapper {"mode":"dynamic"} --><!-- wp:paragraph --><p>Nested paragraph has enough text but must never be selected for editing.</p><!-- /wp:paragraph --><!-- /wp:custom/wrapper -->',
    '<!-- wp:list --><ul><!-- wp:list-item --><li>List item preserved</li><!-- /wp:list-item --></ul><!-- /wp:list -->',
    '<!-- wp:table --><figure><table><tbody><tr><td>Cell</td></tr></tbody></table></figure><!-- /wp:table -->',
    '<!-- wp:paragraph {"className":"lead"} --><p class="lead">Attributed paragraph is deliberately ineligible.</p><!-- /wp:paragraph -->',
    `<!-- wp:paragraph -->\n<p>${sourceText}</p>\n<!-- /wp:paragraph -->`,
  ];
  while ((blocks.join('').split('<!-- wp:').length - 1) < 67) {
    const index = blocks.length;
    blocks.unshift(`<!-- wp:custom/block-${index} {"index":${index}} /-->`);
  }
  return blocks.join('\n');
}

function blockComments(bodyHtml: string): string[] {
  const comments: string[] = [];
  let cursor = 0;
  while (cursor < bodyHtml.length) {
    const start = bodyHtml.indexOf('<!--', cursor);
    if (start < 0) break;
    const end = bodyHtml.indexOf('-->', start + 4);
    if (end < 0) break;
    comments.push(bodyHtml.slice(start, end + 3));
    cursor = end + 3;
  }
  return comments;
}

describe('block-preserving proposals', () => {
  it('selects one top-level plain paragraph from a synthetic 67-block document', () => {
    const body = synthetic67BlockBody();
    expect(body.split('<!-- wp:').length - 1).toBe(67);
    const selected = selectBlockParagraph(body);
    expect(selected?.text).toBe(sourceText);
  });

  it('sends only the selected paragraph and splices only its exact text offsets', () => {
    const body = synthetic67BlockBody();
    const edit = prepareBlockParagraphEdit(input(body));
    expect(edit?.input.page.bodyHtml).toBe(`<p>${sourceText}</p>`);
    expect(edit?.input.page.bodyHtml).not.toContain('Heading preserved');
    const replacement = 'This revised paragraph retains the grounded reader context while making the explanation clearer and more direct.';
    const merged = applyBlockParagraphEdit(edit!, result(`<p>${replacement}</p>`));
    const expected = body.slice(0, edit!.selection.textStart) + replacement + body.slice(edit!.selection.textEnd);
    expect(merged.bodyHtml).toBe(expected);
    expect(merged.bodyHtml.slice(0, edit!.selection.textStart)).toBe(body.slice(0, edit!.selection.textStart));
    expect(merged.bodyHtml.slice(edit!.selection.textStart + replacement.length)).toBe(body.slice(edit!.selection.textEnd));
    expect(blockComments(merged.bodyHtml)).toEqual(blockComments(body));
  });

  it.each([
    '<!-- /wp:paragraph -->',
    '<!-- wp:paragraph --><p>unterminated block has enough text to otherwise look selectable.</p>',
    '<!-- wp:paragraph --><p>mismatched block has enough text to otherwise look selectable.</p><!-- /wp:heading -->',
    '<!-- wp:paragraph [] --><p>invalid attributes have enough text to otherwise look selectable.</p><!-- /wp:paragraph -->',
    '<!--wp:paragraph --><p>noncanonical opening has enough text to otherwise look selectable.</p><!-- /wp:paragraph -->',
    '<!-- WP:paragraph --><p>wrong case opening has enough text to otherwise look selectable.</p><!-- /wp:paragraph -->',
    '<!-- wp:paragraph -- ><p>broken comment has enough text to otherwise look selectable.</p>',
  ])('rejects malformed block structure before starting a model: %s', async (body) => {
    const spawnProcess = vi.fn();
    const adapter = new CodexAgentAdapter({ spawnProcess });
    await expect(adapter.run({
      taskId: 'block-malformed', input: input(body), signal: new AbortController().signal, onEvent: vi.fn(),
    })).rejects.toMatchObject({ name: 'AgentBlockError', code: 'block_structure' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('classifies no eligible paragraph and unsafe original HTML as source structure failures before model start', async () => {
    for (const body of [
      '<!-- wp:paragraph {"className":"lead"} --><p class="lead">This attributed paragraph is long enough but cannot be selected.</p><!-- /wp:paragraph -->',
      `<!-- wp:paragraph --><p>${sourceText}<script>unsafe()</script></p><!-- /wp:paragraph -->`,
    ]) {
      const spawnProcess = vi.fn();
      const adapter = new CodexAgentAdapter({ spawnProcess });
      await expect(adapter.run({
        taskId: 'block-ineligible', input: input(body), signal: new AbortController().signal, onEvent: vi.fn(),
      })).rejects.toMatchObject({ name: 'AgentBlockError', code: 'block_structure' });
      expect(spawnProcess).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['multiple paragraphs', `<p>${sourceText}</p><p>Second</p>`],
    ['inner markup', `<p>${sourceText}<strong>extra</strong></p>`],
    ['link', `<p>${sourceText}<a href="https://example.test/">link</a></p>`],
    ['plain URL', `<p>${sourceText} https://example.test/new</p>`],
    ['too short', '<p>short</p>'],
    ['too long', `<p>${'x'.repeat(4_001)}</p>`],
  ])('rejects a %s block edit', (_label, bodyHtml) => {
    const edit = prepareBlockParagraphEdit(input(synthetic67BlockBody()));
    expect(() => applyBlockParagraphEdit(edit!, result(bodyHtml))).toThrow(AgentBlockError);
  });

  it('retains the existing typed output failure for malformed entities', () => {
    const edit = prepareBlockParagraphEdit(input(synthetic67BlockBody()));
    expect(() => applyBlockParagraphEdit(edit!, result(`<p>${sourceText} & broken</p>`)))
      .toThrow(AgentOutputError);
  });

  it('rejects a merged full body that exceeds the existing body limit', () => {
    const body = `<!-- wp:paragraph --><p>${sourceText}</p><!-- /wp:paragraph -->${'x'.repeat(299_800)}`;
    const edit = prepareBlockParagraphEdit(input(body));
    expect(() => applyBlockParagraphEdit(edit!, result(`<p>${'y'.repeat(4_000)}</p>`)))
      .toThrowError(expect.objectContaining({ code: 'block_preservation' }));
  });
});
