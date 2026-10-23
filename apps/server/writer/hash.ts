import crypto from 'node:crypto';
import type { WordPressPostSnapshot } from './types.js';

type GuardedPostState = Pick<WordPressPostSnapshot, 'bodyHtml' | 'status' | 'protectedFields'>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/** Hashes exactly the mutable body plus every field that a body-only write must preserve. */
export function hashPostState(post: GuardedPostState): string {
  const state = {
    bodyHtml: post.bodyHtml,
    status: post.status,
    protectedFields: {
      ...post.protectedFields,
      categories: [...post.protectedFields.categories].sort((a, b) => a - b),
      tags: [...post.protectedFields.tags].sort((a, b) => a - b),
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(state)), 'utf8').digest('hex');
}
