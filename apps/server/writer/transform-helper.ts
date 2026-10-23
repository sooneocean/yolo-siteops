import sanitizeHtml from 'sanitize-html';
import type { ReconciliationTransform } from '../../../packages/contracts.js';

interface TransformDefinition {
  id: ReconciliationTransform;
  apply: (approved: string) => string;
  eligible: (approved: string) => boolean;
}

const ROOTS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol', 'blockquote']);
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function hasValidRawStack(line: string): boolean {
  const stack: string[] = [];
  const tagPattern = /<\/?([A-Za-z][\w:-]*)(?:\s[^<>]*?)?\s*\/?>/g;
  let match: RegExpExecArray | null;
  let matched = '';
  while ((match = tagPattern.exec(line))) {
    matched += match[0];
    const raw = match[0];
    const name = match[1].toLowerCase();
    if (raw.startsWith('</')) {
      if (stack.pop() !== name) return false;
    } else if (!raw.endsWith('/>') && !VOID_TAGS.has(name)) {
      stack.push(name);
    }
  }
  const remainder = line.replace(tagPattern, '');
  return stack.length === 0 && !/[<>]/.test(remainder) && matched.length > 0;
}

function hasSingleParsedRoot(line: string): boolean {
  let depth = 0;
  let roots = 0;
  let invalid = false;
  sanitizeHtml(line, {
    allowedTags: sanitizeHtml.defaults.allowedTags,
    allowedAttributes: sanitizeHtml.defaults.allowedAttributes,
    onOpenTag: (_name, attributes) => {
      if (depth === 0) roots += 1;
      if (depth === 0 && Object.keys(attributes).length > 0) invalid = true;
      depth += 1;
    },
    onCloseTag: (_name, implied) => {
      if (implied || depth <= 0) invalid = true;
      depth -= 1;
    },
    textFilter: (text) => {
      if (depth === 0 && text.length > 0) invalid = true;
      return text;
    },
  });
  return !invalid && roots === 1 && depth === 0;
}

export function isDoubleLfTransformEligible(approved: string): boolean {
  if (!approved.includes('\n') || approved.includes('\r') || approved.includes('<!--')) return false;
  if (/<\/?(?:pre|code|textarea)\b/i.test(approved) || /<[^>]+\sstyle\s*=/i.test(approved)) return false;
  return approved.split('\n').every((line) => {
    const envelope = line.match(/^<(p|h[1-6]|table|ul|ol|blockquote)>([\s\S]*)<\/\1>$/);
    return Boolean(envelope && ROOTS.has(envelope[1]) && hasValidRawStack(line) && hasSingleParsedRoot(line));
  });
}

const TRANSFORMS: readonly TransformDefinition[] = [
  { id: 'strip_bare_p_v1', apply: (approved) => approved.replace(/<\/?p>/g, ''), eligible: () => true },
  {
    id: 'strip_bare_p_double_lf_v1',
    apply: (approved) => approved.replace(/<\/?p>/g, '').replace(/\n/g, '\n\n'),
    eligible: isDoubleLfTransformEligible,
  },
];

export function isReconciliationTransform(value: unknown): value is ReconciliationTransform {
  return TRANSFORMS.some((definition) => definition.id === value);
}

export function applyReconciliationTransform(transform: ReconciliationTransform, approved: string): string {
  const definition = TRANSFORMS.find((candidate) => candidate.id === transform);
  if (!definition || !definition.eligible(approved)) throw new Error('Unsupported reconciliation transform');
  return definition.apply(approved);
}

export function matchingReconciliationTransforms(approved: string, actual: string): ReconciliationTransform[] {
  return TRANSFORMS.filter((definition) => definition.eligible(approved) && definition.apply(approved) === actual)
    .map((definition) => definition.id);
}
