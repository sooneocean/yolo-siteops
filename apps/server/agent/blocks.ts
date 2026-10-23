import type { AgentInput, AgentResult } from '../../../packages/contracts.js';
import { assertSafeProposalHtml } from '../security/html.js';
import { AgentBlockError } from './errors.js';
import { validateAgentResult } from './validation.js';

const MAX_BODY_LENGTH = 300_000;
const MAX_PARAGRAPH_CODEPOINTS = 4_000;
const MIN_SOURCE_CODEPOINTS = 40;

interface BlockFrame {
  name: string;
  candidateStart?: number;
}

interface BlockDelimiter {
  kind: 'open' | 'close' | 'self';
  name: string;
  raw: string;
}

export interface BlockParagraphSelection {
  bodyHtml: string;
  text: string;
  textStart: number;
  textEnd: number;
}

export interface BlockParagraphEdit {
  input: AgentInput;
  selection: BlockParagraphSelection;
}

function structureError(): AgentBlockError {
  return new AgentBlockError('block_structure', 'WordPress block structure is malformed');
}

function preservationError(): AgentBlockError {
  return new AgentBlockError('block_preservation', 'WordPress block proposal did not preserve the bounded paragraph contract');
}

function validNamePart(value: string): boolean {
  if (value.length === 0 || value.startsWith('-') || value.endsWith('-')) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (!((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || character === '-')) return false;
  }
  return true;
}

function validBlockName(value: string): boolean {
  const parts = value.split('/');
  return parts.length <= 2 && parts.every(validNamePart);
}

function validAttributes(value: string): boolean {
  if (!value.startsWith('{') || !value.endsWith('}')) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function parseNameAndAttributes(value: string): string {
  const space = value.indexOf(' ');
  const name = space < 0 ? value : value.slice(0, space);
  if (!validBlockName(name)) throw structureError();
  if (space >= 0) {
    const attributes = value.slice(space + 1);
    if (!validAttributes(attributes)) throw structureError();
  }
  return name;
}

function parseDelimiter(raw: string): BlockDelimiter {
  const content = raw.slice(4, -3);
  if (content.startsWith(' /wp:') && content.endsWith(' ')) {
    const name = content.slice(5, -1);
    if (!validBlockName(name)) throw structureError();
    return { kind: 'close', name, raw };
  }
  if (!content.startsWith(' wp:')) throw structureError();
  if (content.endsWith(' /')) {
    return { kind: 'self', name: parseNameAndAttributes(content.slice(4, -2)), raw };
  }
  if (!content.endsWith(' ')) throw structureError();
  return { kind: 'open', name: parseNameAndAttributes(content.slice(4, -1)), raw };
}

function isWhitespace(character: string): boolean {
  return character.trim().length === 0;
}

function paragraphSelection(bodyHtml: string, innerStart: number, innerEnd: number): BlockParagraphSelection | undefined {
  let start = innerStart;
  let end = innerEnd;
  while (start < end && isWhitespace(bodyHtml[start] as string)) start += 1;
  while (end > start && isWhitespace(bodyHtml[end - 1] as string)) end -= 1;
  if (!bodyHtml.startsWith('<p>', start) || bodyHtml.slice(end - 4, end) !== '</p>') return undefined;
  const textStart = start + 3;
  const textEnd = end - 4;
  const text = bodyHtml.slice(textStart, textEnd);
  const length = [...text].length;
  if (text.includes('<') || length < MIN_SOURCE_CODEPOINTS || length > MAX_PARAGRAPH_CODEPOINTS) return undefined;
  return { bodyHtml, text, textStart, textEnd };
}

function hasWordPressLikeComment(bodyHtml: string): boolean {
  let cursor = 0;
  while (cursor < bodyHtml.length) {
    const start = bodyHtml.indexOf('<!--', cursor);
    if (start < 0) return false;
    const endMarker = bodyHtml.indexOf('-->', start + 4);
    if (endMarker < 0) {
      if (bodyHtml.slice(start + 4).toLowerCase().includes('wp:')) throw structureError();
      return false;
    }
    if (bodyHtml.slice(start + 4, endMarker).toLowerCase().includes('wp:')) return true;
    cursor = endMarker + 3;
  }
  return false;
}

export function selectBlockParagraph(bodyHtml: string): BlockParagraphSelection | undefined {
  if (!hasWordPressLikeComment(bodyHtml)) return undefined;
  try { assertSafeProposalHtml(bodyHtml); }
  catch { throw structureError(); }
  const stack: BlockFrame[] = [];
  let cursor = 0;
  let sawWordPress = false;
  let selected: BlockParagraphSelection | undefined;
  while (cursor < bodyHtml.length) {
    const start = bodyHtml.indexOf('<!--', cursor);
    if (start < 0) break;
    const endMarker = bodyHtml.indexOf('-->', start + 4);
    if (endMarker < 0) {
      if (bodyHtml.slice(start + 4).toLowerCase().includes('wp:')) throw structureError();
      break;
    }
    const end = endMarker + 3;
    const raw = bodyHtml.slice(start, end);
    const content = raw.slice(4, -3);
    if (content.toLowerCase().includes('wp:')) {
      sawWordPress = true;
      const delimiter = parseDelimiter(raw);
      if (delimiter.kind === 'close') {
        const frame = stack.pop();
        if (!frame || frame.name !== delimiter.name) throw structureError();
        if (!selected && frame.candidateStart !== undefined && stack.length === 0) {
          selected = paragraphSelection(bodyHtml, frame.candidateStart, start);
        }
      } else if (delimiter.kind === 'open') {
        stack.push({
          name: delimiter.name,
          ...(stack.length === 0 && delimiter.raw === '<!-- wp:paragraph -->'
            ? { candidateStart: end }
            : {}),
        });
      }
    }
    cursor = end;
  }
  if (!sawWordPress) return undefined;
  if (stack.length !== 0) throw structureError();
  if (!selected) throw structureError();
  return selected;
}

export function prepareBlockParagraphEdit(input: AgentInput): BlockParagraphEdit | undefined {
  const selection = selectBlockParagraph(input.page.bodyHtml);
  if (!selection) return undefined;
  return {
    selection,
    input: {
      ...input,
      page: { ...input.page, bodyHtml: `<p>${selection.text}</p>` },
    },
  };
}

export function blockParagraphOutputGuidance(): string {
  return [
    'WORDPRESS_BLOCK_PARAGRAPH_RULES (trusted application policy):',
    'Edit only the text of the single supplied plain paragraph.',
    'Return exactly one <p>TEXT</p> value in bodyHtml with no inner markup, comments, links, or URLs.',
    'Preserve at least 80 percent of the original paragraph length and keep the result within 4000 Unicode code points.',
    'Do not add facts, links, images, or URLs beyond the supplied evidence and snapshot.',
  ].join('\n');
}

export function applyBlockParagraphEdit(edit: BlockParagraphEdit, value: unknown): AgentResult {
  const result = validateAgentResult(value, edit.input);
  if (!result.bodyHtml.startsWith('<p>') || !result.bodyHtml.endsWith('</p>')
    || result.bodyHtml.indexOf('</p>') !== result.bodyHtml.length - 4) throw preservationError();
  const text = result.bodyHtml.slice(3, -4);
  const codepoints = [...text].length;
  const minimum = Math.ceil([...edit.selection.text].length * 0.8);
  if (text.includes('<') || /(?:https?:\/\/|www\.|mailto:)/iu.test(text)
    || codepoints < minimum || codepoints > MAX_PARAGRAPH_CODEPOINTS) throw preservationError();
  const merged = edit.selection.bodyHtml.slice(0, edit.selection.textStart)
    + text
    + edit.selection.bodyHtml.slice(edit.selection.textEnd);
  if (merged.length > MAX_BODY_LENGTH) throw preservationError();
  try { assertSafeProposalHtml(merged); }
  catch { throw preservationError(); }
  return { ...result, bodyHtml: merged };
}
