import crypto from 'node:crypto';
import sanitizeHtml from 'sanitize-html';

const ACTIVE_TAGS = new Set([
  'applet',
  'base',
  'embed',
  'form',
  'frame',
  'frameset',
  'iframe',
  'input',
  'link',
  'math',
  'meta',
  'object',
  'script',
  'style',
  'svg',
]);

const DANGEROUS_SCHEMES = /^(?:javascript|vbscript|data\s*:\s*text\/html)/i;

export class UnsafeHtmlError extends Error {
  readonly code = 'unsafe_html';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeHtmlError';
  }
}

function compactAttributeValue(value: string): string {
  return [...value]
    .filter((character) => character.charCodeAt(0) > 0x20 && character.charCodeAt(0) !== 0x7f)
    .join('')
    .replace(/\s+/g, '');
}

/**
 * Validates proposal HTML without rewriting it. WordPress block comments are
 * therefore retained byte-for-byte and the approval hash remains meaningful.
 */
export function assertSafeProposalHtml(html: string): string {
  if (typeof html !== 'string') {
    throw new UnsafeHtmlError('Proposal HTML must be a string');
  }

  // These raw checks cover malformed markup that the parser could otherwise
  // discard while recovering.
  if (/<\s*\/?\s*(?:script|embed|object|iframe|frame|frameset|svg|math|applet|base|meta|link|form|input|style)\b/i.test(html)) {
    throw new UnsafeHtmlError('Proposal HTML contains an active content element');
  }
  if (/\bon[a-z0-9_-]+\s*=/i.test(html)) {
    throw new UnsafeHtmlError('Proposal HTML contains an event handler');
  }
  if (/(?:javascript|vbscript)\s*(?::|&#0*58;|&#x0*3a;|&colon;)/i.test(html)) {
    throw new UnsafeHtmlError('Proposal HTML contains an executable URL scheme');
  }

  try {
    sanitizeHtml(html, {
      allowedTags: false,
      allowedAttributes: false,
      allowVulnerableTags: true,
      parser: { decodeEntities: true },
      transformTags: {
        '*': (tagName, attribs) => {
          const normalizedTag = tagName.toLowerCase();
          if (ACTIVE_TAGS.has(normalizedTag)) {
            throw new UnsafeHtmlError(`Proposal HTML contains forbidden <${normalizedTag}> content`);
          }

          for (const [rawName, rawValue] of Object.entries(attribs)) {
            const name = rawName.toLowerCase();
            const value = compactAttributeValue(rawValue);
            if (name.startsWith('on') || name === 'srcdoc') {
              throw new UnsafeHtmlError(`Proposal HTML contains forbidden ${name} attribute`);
            }
            if (DANGEROUS_SCHEMES.test(value)) {
              throw new UnsafeHtmlError(`Proposal HTML contains a dangerous ${name} URL`);
            }
            if (name === 'style' && /(?:expression|url\([^)]*(?:javascript|vbscript)|-moz-binding)/i.test(value)) {
              throw new UnsafeHtmlError('Proposal HTML contains executable CSS');
            }
          }
          return { tagName, attribs };
        },
      },
    });
  } catch (error) {
    if (error instanceof UnsafeHtmlError) throw error;
    throw new UnsafeHtmlError('Proposal HTML could not be parsed safely');
  }

  return html;
}

export function hashExactHtml(html: string): string {
  return crypto.createHash('sha256').update(html, 'utf8').digest('hex');
}

const TEXT_BOUNDARY_TAGS = [
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'wbr',
] as const;

const TEXT_BOUNDARY_MARKUP = new RegExp(`</?(?:${TEXT_BOUNDARY_TAGS.join('|')})(?:\\s*/?)?>`, 'giu');

export function normalizeHtmlText(html: string): string {
  // Keep only semantic boundary elements while parsing. The serializer emits
  // these tags in a controlled form, which can then become separators without
  // splitting inline content such as A<strong>B</strong>C.
  return sanitizeHtml(html, {
    allowedTags: [...TEXT_BOUNDARY_TAGS],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'head', 'template'],
    parser: { decodeEntities: true },
  })
    .replace(TEXT_BOUNDARY_MARKUP, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ParsedHtmlNode {
  tag: string;
  attribs: Record<string, string>;
  children: Array<ParsedHtmlNode | string>;
}

const TOC_TITLES = new Set(['文章目錄', 'Table of Contents', 'Contents']);
const INLINE_TOC_TAGS = new Set(['span', 'strong', 'em', 'b', 'i', 'code']);

function classTokens(node: ParsedHtmlNode): string[] {
  return (node.attribs.class ?? '').split(/\s+/u).filter(Boolean);
}

function elementChildren(node: ParsedHtmlNode): ParsedHtmlNode[] {
  return node.children.filter((child): child is ParsedHtmlNode => typeof child !== 'string');
}

function directText(node: ParsedHtmlNode): string {
  return node.children.filter((child): child is string => typeof child === 'string').join('');
}

function descendantText(node: ParsedHtmlNode, excluded?: ParsedHtmlNode): string {
  return node.children.map((child) => {
    if (child === excluded) return '';
    return typeof child === 'string' ? child : descendantText(child, excluded);
  }).join('');
}

function parseHtmlTree(html: string): { root: ParsedHtmlNode; valid: boolean } {
  const root: ParsedHtmlNode = { tag: '#root', attribs: {}, children: [] };
  const stack = [root];
  let valid = true;
  sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    parser: { decodeEntities: true },
    onOpenTag: (tag, attribs) => {
      const node: ParsedHtmlNode = { tag: tag.toLowerCase(), attribs: { ...attribs }, children: [] };
      stack.at(-1)?.children.push(node);
      stack.push(node);
    },
    onCloseTag: (tag) => {
      const node = stack.pop();
      if (!node || node === root || node.tag !== tag.toLowerCase()) valid = false;
    },
    textFilter: (text) => {
      stack.at(-1)?.children.push(text);
      return text;
    },
  });
  if (stack.length !== 1) valid = false;
  return { root, valid };
}

function findNodes(node: ParsedHtmlNode, predicate: (candidate: ParsedHtmlNode) => boolean): ParsedHtmlNode[] {
  const matches: ParsedHtmlNode[] = [];
  for (const child of elementChildren(node)) {
    if (predicate(child)) matches.push(child);
    matches.push(...findNodes(child, predicate));
  }
  return matches;
}

function findNodesExcluding(
  node: ParsedHtmlNode,
  excluded: ParsedHtmlNode,
  predicate: (candidate: ParsedHtmlNode) => boolean,
): ParsedHtmlNode[] {
  const matches: ParsedHtmlNode[] = [];
  for (const child of elementChildren(node)) {
    if (child === excluded) continue;
    if (predicate(child)) matches.push(child);
    matches.push(...findNodesExcluding(child, excluded, predicate));
  }
  return matches;
}

function hasOnlyWhitespaceText(node: ParsedHtmlNode): boolean {
  return normalizeHtmlText(directText(node)) === '';
}

function approvedHeadingLabels(body: ParsedHtmlNode): string[] | undefined {
  const labels = findNodes(body, (node) => node.tag === 'h2' || node.tag === 'h3')
    .map((node) => normalizeHtmlText(descendantText(node)));
  return labels.length > 0 && labels.every(Boolean) ? labels : undefined;
}

function publicHeadingId(node: ParsedHtmlNode, label: string): string | undefined {
  if (node.attribs.id) return node.attribs.id;
  const matchingSpans = findNodes(node, (candidate) => candidate.tag === 'span' && Boolean(candidate.attribs.id)
    && normalizeHtmlText(descendantText(candidate)) === label);
  return matchingSpans.length === 1 ? matchingSpans[0]?.attribs.id : undefined;
}

function publicHeadingRecords(
  page: ParsedHtmlNode,
  toc: ParsedHtmlNode,
  expectedLabels: string[],
): Array<{ id: string; label: string }> | undefined {
  const contentScopes = findNodesExcluding(page, toc, (node) => classTokens(node).includes('wp-block-post-content'));
  if (contentScopes.length > 1) return undefined;
  const headingNodes = findNodesExcluding(contentScopes[0] ?? page, toc, (node) => node.tag === 'h2' || node.tag === 'h3');
  const matches: ParsedHtmlNode[][] = [];
  for (let index = 0; index <= headingNodes.length - expectedLabels.length; index += 1) {
    const candidate = headingNodes.slice(index, index + expectedLabels.length);
    if (candidate.every((node, offset) => normalizeHtmlText(descendantText(node)) === expectedLabels[offset])) {
      matches.push(candidate);
    }
  }
  if (matches.length !== 1) return undefined;
  const selected = matches[0] as ParsedHtmlNode[];
  const records = selected.map((node, index) => ({
    label: expectedLabels[index] as string,
    id: publicHeadingId(node, expectedLabels[index] as string) ?? '',
  }));
  if (records.some((record) => !record.id) || new Set(records.map((record) => record.id)).size !== records.length) return undefined;
  return records;
}

function decodedFragment(href: string | undefined): string | undefined {
  if (!href?.startsWith('#') || href.length === 1) return undefined;
  try {
    const fragment = decodeURIComponent(href.slice(1));
    return fragment ? fragment : undefined;
  } catch {
    return undefined;
  }
}

function collectTocEntries(list: ParsedHtmlNode): Array<{ id: string; label: string }> | undefined {
  if (list.tag !== 'ul' || !hasOnlyWhitespaceText(list)) return undefined;
  const entries: Array<{ id: string; label: string }> = [];
  for (const item of elementChildren(list)) {
    if (item.tag !== 'li' || !hasOnlyWhitespaceText(item)) return undefined;
    const children = elementChildren(item);
    const anchor = children[0];
    if (!anchor || anchor.tag !== 'a' || children.slice(1).some((child) => child.tag !== 'ul')) return undefined;
    const fragment = decodedFragment(anchor.attribs.href);
    const ordinalNodes = findNodes(anchor, (node) => node.tag === 'span' && classTokens(node).includes('toc_number'));
    if (!fragment || ordinalNodes.length !== 1) return undefined;
    const ordinal = ordinalNodes[0];
    if (!ordinal || !/^\d+(?:\.\d+)*\.?$/u.test(normalizeHtmlText(descendantText(ordinal)))) return undefined;
    if (elementChildren(ordinal).length > 0) return undefined;
    const nonOrdinalElements = findNodes(anchor, (node) => node !== ordinal);
    if (nonOrdinalElements.some((node) => !INLINE_TOC_TAGS.has(node.tag))) return undefined;
    const label = normalizeHtmlText(descendantText(anchor, ordinal));
    if (!label) return undefined;
    entries.push({ id: fragment, label });
    for (const nested of children.slice(1)) {
      const nestedEntries = collectTocEntries(nested);
      if (!nestedEntries) return undefined;
      entries.push(...nestedEntries);
    }
  }
  return entries.length > 0 ? entries : undefined;
}

function isValidGeneratedToc(candidate: ParsedHtmlNode, headings: Array<{ id: string; label: string }>): boolean {
  const roles = (candidate.attribs.role ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
  if (!roles.includes('navigation') || !Object.hasOwn(candidate.attribs, 'data-nosnippet') || !hasOnlyWhitespaceText(candidate)) return false;
  const children = elementChildren(candidate);
  if (children.length !== 2) return false;
  const [title, list] = children;
  if (!title || title.tag !== 'p' || !classTokens(title).includes('toc_title')
    || !TOC_TITLES.has(normalizeHtmlText(descendantText(title)))) return false;
  if (!list || list.tag !== 'ul' || !classTokens(list).includes('toc_list')) return false;
  const entries = collectTocEntries(list);
  return entries !== undefined && entries.length === headings.length
    && entries.every((entry, index) => entry.id === headings[index]?.id && entry.label === headings[index]?.label);
}

/** Normalizes a public page after removing one strictly validated generated TOC. */
export function normalizePublicPageText(expectedBodyHtml: string, pageHtml: string): string {
  const body = parseHtmlTree(expectedBodyHtml);
  const page = parseHtmlTree(pageHtml);
  if (!body.valid || !page.valid) return normalizeHtmlText(pageHtml);
  const expectedLabels = approvedHeadingLabels(body.root);
  if (!expectedLabels) return normalizeHtmlText(pageHtml);
  const candidates = findNodes(page.root, (node) => node.tag === 'div' && node.attribs.id === 'toc_container');
  if (candidates.length !== 1) return normalizeHtmlText(pageHtml);
  const candidate = candidates[0] as ParsedHtmlNode;
  const publicHeadings = publicHeadingRecords(page.root, candidate, expectedLabels);
  if (!publicHeadings || !isValidGeneratedToc(candidate, publicHeadings)) {
    return normalizeHtmlText(pageHtml);
  }
  const withoutToc = sanitizeHtml(pageHtml, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    parser: { decodeEntities: true },
    exclusiveFilter: (frame) => frame.tag === 'div' && frame.attribs.id === 'toc_container',
  });
  return normalizeHtmlText(withoutToc);
}

export function extractCanonicalHref(html: string): string | undefined {
  let canonical: string | undefined;
  sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    parser: { decodeEntities: true },
    transformTags: {
      link: (tagName, attribs) => {
        const rel = attribs.rel?.toLowerCase().split(/\s+/) ?? [];
        if (rel.includes('canonical') && typeof attribs.href === 'string' && canonical === undefined) canonical = attribs.href;
        return { tagName, attribs };
      },
    },
  });
  return canonical;
}

export interface SafePreview {
  beforeHtml: string;
  afterHtml: string;
  baseHash: string;
  patchHash: string;
}

export function createSafePreview(beforeHtml: string, proposedHtml: string): SafePreview {
  return {
    beforeHtml,
    afterHtml: assertSafeProposalHtml(proposedHtml),
    baseHash: hashExactHtml(beforeHtml),
    patchHash: hashExactHtml(proposedHtml),
  };
}

export function assertPreviewIntegrity(preview: SafePreview): void {
  assertSafeProposalHtml(preview.afterHtml);
  if (hashExactHtml(preview.beforeHtml) !== preview.baseHash || hashExactHtml(preview.afterHtml) !== preview.patchHash) {
    throw new UnsafeHtmlError('Proposal content no longer matches its approval hashes');
  }
}
