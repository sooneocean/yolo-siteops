import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';
import type { AgentInput, AgentResult } from '../../../packages/contracts.js';
import { AgentOutputError, AgentSecurityError } from './errors.js';

export interface ReflectionEvidenceInput {
  active: { id: string; content: string };
  tasks: Array<{ status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'review_required' }>;
  proposals: Array<{ status: 'pending' | 'approved' | 'rejected' | 'applied' | 'rolled_back' | 'review_required' | 'verified_transformed' }>;
}

export interface ReflectionResult {
  content: string;
  rationale: string;
}

const safeUrl = z.string().max(2_048).url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'Only HTTP(S) URLs are allowed');

const evidenceSchema = z.object({
  id: z.string().min(1).max(160),
  source: z.enum(['gsc', 'ga4', 'wordpress']),
  property: z.string().max(512),
  startDate: z.string().max(64),
  endDate: z.string().max(64),
  timeZone: z.string().max(80),
  fetchedAt: z.string().max(80),
  complete: z.boolean(),
  coverage: z.string().max(2_000),
}).strict();

const pageSchema = z.object({
  postId: z.number().int().nonnegative(),
  url: safeUrl,
  title: z.string().min(1).max(500),
  bodyHtml: z.string().max(300_000),
  status: z.string().max(80),
  modified: z.string().max(80),
  protectedHash: z.string().min(1).max(256),
}).strict();

const opportunitySchema = z.object({
  id: z.string().min(1).max(160),
  postId: z.number().int().nonnegative(),
  title: z.string().min(1).max(500),
  url: safeUrl,
  kind: z.enum(['decay', 'position']),
  clicks: z.number().finite().nonnegative(),
  previousClicks: z.number().finite().nonnegative(),
  impressions: z.number().finite().nonnegative(),
  position: z.number().finite().nonnegative(),
  queries: z.array(z.string().max(500)).max(100),
  evidenceIds: z.array(z.string().min(1).max(160)).min(1).max(100),
  quality: z.enum(['available', 'unknown']),
  engagementRate: z.number().finite().min(0).max(1).optional(),
  reason: z.string().max(5_000),
  audienceHypothesis: z.string().max(5_000),
  keywordHypotheses: z.array(z.string().max(500)).max(100),
}).strict();

const agentInputSchema = z.object({
  page: pageSchema,
  opportunity: opportunitySchema,
  evidence: z.array(evidenceSchema).min(1).max(200),
  relatedPages: z.array(z.object({
    postId: z.number().int().nonnegative(),
    url: safeUrl,
    title: z.string().min(1).max(500),
  }).strict()).max(100),
  skillContent: z.string().min(1).max(8_000),
  skillVersion: z.string().min(1).max(160),
}).strict();

const agentResultSchema = z.object({
  bodyHtml: z.string().min(1).max(300_000),
  summary: z.string().min(1).max(5_000),
  evidenceIds: z.array(z.string().min(1).max(160)).min(1).max(100),
  skillVersion: z.string().min(1).max(160),
}).strict();

const reflectionEvidenceSchema = z.object({
  active: z.object({
    id: z.string().min(1).max(160),
    content: z.string().min(1).max(8_000),
  }).strict(),
  tasks: z.array(z.object({
    status: z.enum(['queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'review_required']),
  }).strict()).max(30),
  proposals: z.array(z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'applied', 'rolled_back', 'review_required', 'verified_transformed']),
  }).strict()).max(30),
}).strict();

const reflectionResultSchema = z.object({
  content: z.string().min(40).max(8_000),
  rationale: z.string().min(10).max(2_000),
}).strict();

const htmlPolicy: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
    'strong', 'b', 'em', 'i', 's', 'blockquote', 'code', 'pre', 'a',
    'figure', 'figcaption', 'img', 'table', 'thead', 'tbody', 'tr', 'th',
    'td', 'section', 'aside', 'details', 'summary', 'time', 'sup', 'sub',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
    time: ['datetime'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  enforceHtmlBoundary: true,
};

export function proposalHtmlOutputGuidance(): string {
  const allowedTags = Array.isArray(htmlPolicy.allowedTags) ? htmlPolicy.allowedTags : [];
  const tags = allowedTags.map((tag) => `<${tag}>`).join(', ');
  const attributes = htmlPolicy.allowedAttributes === false
    ? 'none'
    : Object.entries(htmlPolicy.allowedAttributes ?? {}).map(([tag, values]) => {
        const names = values.map((value) => typeof value === 'string' ? value : value.name);
        return `<${tag}>: ${names.join(', ')}`;
      }).join('; ');
  const schemes = Array.isArray(htmlPolicy.allowedSchemes) ? htmlPolicy.allowedSchemes.join(', ') : 'none';
  return [
    'PROPOSAL_HTML_OUTPUT_RULES (trusted application policy):',
    `Allowed elements: ${tags}.`,
    `Allowed attributes by element: ${attributes}. All other attributes, including id, class, and style, are forbidden.`,
    `Allowed URL schemes: ${schemes}.`,
    'Return sanitizer-canonical HTML: use double-quoted attributes; encode &, <, and > in text and attribute values as HTML entities; and serialize void elements as <br /> and <img ... />.',
    'HTML comments and the <embed> element are forbidden.',
    'The summary must be plain text and should avoid the characters <, >, and &.',
    'An allowed element is available when needed; it is not a request to add that element.',
    'Do not add URLs, images, or factual claims that are not supported by the supplied snapshot and evidence.',
  ].join('\n');
}

export function parseAgentInput(input: AgentInput): AgentInput {
  const parsed = agentInputSchema.parse(input);
  if (parsed.page.postId !== parsed.opportunity.postId) {
    throw new AgentSecurityError('Opportunity postId does not match the supplied page');
  }
  const evidenceIds = new Set(parsed.evidence.map((item) => item.id));
  if (new Set(parsed.evidence.map((item) => item.id)).size !== parsed.evidence.length) {
    throw new AgentSecurityError('Duplicate evidence IDs are not allowed');
  }
  for (const id of parsed.opportunity.evidenceIds) {
    if (!evidenceIds.has(id)) {
      throw new AgentSecurityError('Opportunity references evidence outside the supplied snapshot');
    }
  }
  return parsed;
}

export function allowedEvidenceIds(input: AgentInput): string[] {
  const supplied = new Set(input.evidence.map((item) => item.id));
  return [...new Set(input.opportunity.evidenceIds.filter((id) => supplied.has(id)))];
}

export function validateAgentResult(value: unknown, input: AgentInput): AgentResult {
  let result: AgentResult;
  try {
    result = agentResultSchema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AgentOutputError('output_schema', 'Agent output did not match the required schema');
    }
    throw error;
  }
  if (result.skillVersion !== input.skillVersion) {
    throw new AgentOutputError('skill_version_mismatch', 'Agent changed the pinned skill version');
  }
  const allowedIds = new Set(allowedEvidenceIds(input));
  if (new Set(result.evidenceIds).size !== result.evidenceIds.length) {
    throw new AgentOutputError('duplicate_evidence', 'Agent returned duplicate evidence IDs');
  }
  for (const id of result.evidenceIds) {
    if (!allowedIds.has(id)) {
      throw new AgentOutputError('ungrounded_evidence', 'Agent cited evidence outside the approved opportunity snapshot');
    }
  }
  if (sanitizeHtml(result.bodyHtml, htmlPolicy) !== result.bodyHtml) {
    throw new AgentOutputError('html_policy', 'Agent returned HTML outside the proposal safety policy');
  }
  if (sanitizeHtml(result.summary, { allowedTags: [], allowedAttributes: {} }) !== result.summary) {
    throw new AgentOutputError('summary_policy', 'Agent summary must be plain text');
  }
  return result;
}

export function parseReflectionEvidence(value: unknown): ReflectionEvidenceInput {
  return reflectionEvidenceSchema.parse(value);
}

export function validateReflectionResult(value: unknown): ReflectionResult {
  return reflectionResultSchema.parse(value);
}

export function agentOutputSchema(input: AgentInput): Record<string, unknown> {
  const evidenceIds = allowedEvidenceIds(input);
  if (evidenceIds.length === 0) {
    throw new AgentSecurityError('No evidence is available for a grounded proposal');
  }
  return {
    type: 'object',
    properties: {
      // Keep the upstream schema to the broadly supported Structured Outputs
      // subset. Length and uniqueness limits are enforced again locally below.
      bodyHtml: { type: 'string' },
      summary: { type: 'string' },
      evidenceIds: {
        type: 'array',
        items: { type: 'string', enum: evidenceIds },
      },
      skillVersion: { type: 'string', enum: [input.skillVersion] },
    },
    required: ['bodyHtml', 'summary', 'evidenceIds', 'skillVersion'],
    additionalProperties: false,
  };
}

export function reflectionOutputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      content: { type: 'string' },
      rationale: { type: 'string' },
    },
    required: ['content', 'rationale'],
    additionalProperties: false,
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}
