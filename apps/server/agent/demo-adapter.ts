import type { AgentAdapter, AgentResult } from '../../../packages/contracts.js';
import { abortError } from './errors.js';
import { allowedEvidenceIds, escapeHtml, parseAgentInput, validateAgentResult } from './validation.js';

export class DemoAgentAdapter implements AgentAdapter {
  async run(args: Parameters<AgentAdapter['run']>[0]): Promise<AgentResult> {
    if (args.signal.aborted) throw abortError();
    const input = parseAgentInput(args.input);
    args.onEvent('agent.started', 'Demo proposal generation started.');

    const relatedPage = input.relatedPages[0];
    const addition = [
      '<section>',
      '<h2>審閱內容提案時要確認什麼？</h2>',
      '<p>先核對提案引用的證據是否支持文章主題，再確認新增內容保留原意。資訊不足時，應交由人工審閱，不直接套用。</p>',
      relatedPage
        ? `<p>延伸閱讀：<a href="${escapeHtml(relatedPage.url)}">${escapeHtml(relatedPage.title)}</a></p>`
        : '',
      '</section>',
    ].join('');
    const separator = input.page.bodyHtml.length > 0 ? '\n' : '';
    const result = validateAgentResult({
      bodyHtml: `${input.page.bodyHtml}${separator}${addition}`,
      summary: relatedPage
        ? '補充內容提案的審閱步驟，並加入已存在的相關文章內鏈。'
        : '補充內容提案的審閱步驟。',
      evidenceIds: allowedEvidenceIds(input),
      skillVersion: input.skillVersion,
    }, input);

    if (args.signal.aborted) throw abortError();
    args.onEvent('agent.completed', 'Demo proposal generation completed.');
    return result;
  }
}
