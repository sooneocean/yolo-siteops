import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChangeProposal } from '../packages/contracts.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeHtmlText } from '../apps/server/security/html.js';
import { hashPostState } from '../apps/server/writer/hash.js';
import { acquireWriterLock, WriterLockHeldError } from '../apps/server/writer/lock.js';
import { WriterService, WriterServiceError } from '../apps/server/writer/service.js';
import { HttpWordPressAdapter } from '../apps/server/writer/wordpress-adapter.js';
import {
  UnknownWordPressWriteError,
  type ApprovalRecord,
  type PublicReadback,
  type WordPressAdapter,
  type WordPressPostSnapshot,
  type WriterBackup,
  type WriterReceipt,
  type WriterStorage,
} from '../apps/server/writer/types.js';

class MemoryStorage implements WriterStorage {
  proposals = new Map<string, ChangeProposal>();
  approvals = new Map<string, ApprovalRecord>();
  backups = new Map<string, WriterBackup>();
  receipts = new Map<string, WriterReceipt>();

  async getProposal(id: string) { return this.proposals.get(id); }
  async saveProposal(proposal: ChangeProposal) { this.proposals.set(proposal.id, proposal); }
  async insertApproval(approval: ApprovalRecord) { this.approvals.set(approval.id, approval); }
  async getApproval(id: string) { return this.approvals.get(id); }
  async consumeApproval(id: string, consumedAt: string) {
    const approval = this.approvals.get(id);
    if (!approval || approval.consumedAt) return false;
    this.approvals.set(id, { ...approval, consumedAt });
    return true;
  }
  async saveBackup(backup: WriterBackup) { this.backups.set(backup.proposalId, backup); }
  async getBackupForProposal(proposalId: string) { return this.backups.get(proposalId); }
  async pruneBackups(expiredBefore: string) {
    for (const [key, backup] of this.backups) if (backup.expiresAt <= expiredBefore) this.backups.delete(key);
  }
  async getReceipt(operation: WriterReceipt['operation'], proposalId: string) { return this.receipts.get(`${operation}:${proposalId}`); }
  async putReceipt(receipt: WriterReceipt) { this.receipts.set(`${receipt.operation}:${receipt.proposalId}`, receipt); }
}

class FakeAdapter implements WordPressAdapter {
  updates = 0;
  unknownWrite = false;

  constructor(public post: WordPressPostSnapshot) {}

  async getPostForEdit() { return structuredClone(this.post); }
  async updateBody(_postId: number, bodyHtml: string) {
    this.updates += 1;
    if (this.unknownWrite) throw new UnknownWordPressWriteError();
    this.post = { ...this.post, bodyHtml, modified: '2026-10-23T01:01:00Z' };
  }
  async checkPublicReadback(post: WordPressPostSnapshot): Promise<PublicReadback> {
    if (post.status === 'publish') {
      return { visibility: 'public', statusCode: 200, url: post.url, normalizedText: normalizeHtmlText(post.bodyHtml) };
    }
    return { visibility: 'isolated', statusCode: 404, url: post.url };
  }
}

const initialPost = (): WordPressPostSnapshot => ({
  postId: 42,
  url: 'https://example.test/article/',
  bodyHtml: '<!-- wp:paragraph --><p>before</p><!-- /wp:paragraph -->',
  status: 'publish',
  modified: '2026-10-23T00:00:00Z',
  protectedFields: {
    slug: 'article', title: 'Article', excerpt: 'Excerpt', categories: [2, 1], tags: [8, 3],
    featured_media: 99, meta: { yoast_wpseo_title: 'SEO title', nested: { stable: true } },
  },
});

function proposalFor(post: WordPressPostSnapshot): ChangeProposal {
  const afterHtml = '<!-- wp:paragraph --><p>after</p><!-- /wp:paragraph -->';
  return {
    id: 'proposal-1', taskId: 'task-1', postId: post.postId, title: 'Article', url: post.url,
    beforeHtml: post.bodyHtml, afterHtml, summary: 'Update body', evidenceIds: ['evidence-1'],
    baseHash: hashPostState(post), patchHash: hashPostState({ ...post, bodyHtml: afterHtml }),
    status: 'pending', createdAt: '2026-10-23T00:00:00Z',
  };
}

let tempRoot = '';

beforeEach(async () => { tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'siteops-writer-test-')); });
afterEach(async () => { await fs.rm(tempRoot, { recursive: true, force: true }); });

function fixture() {
  const post = initialPost();
  const storage = new MemoryStorage();
  const proposal = proposalFor(post);
  storage.proposals.set(proposal.id, proposal);
  const adapter = new FakeAdapter(post);
  const service = new WriterService({
    storage, adapter, siteOrigin: 'https://example.test', lockPath: path.join(tempRoot, 'writer.lock'),
    now: () => new Date('2026-10-23T01:00:00Z'),
  });
  return { adapter, proposal, service, storage };
}

describe('WriterService', () => {
  it('binds approval to session and exact displayed patch hash, preserves protected fields, and replays one receipt', async () => {
    const { adapter, proposal, service } = fixture();
    await expect(service.approve({ proposalId: proposal.id, sessionId: 'session-a', expectedPatchHash: 'stale' }))
      .rejects.toMatchObject({ code: 'stale_proposal_view' });
    const approval = await service.approve({ proposalId: proposal.id, sessionId: 'session-a', expectedPatchHash: proposal.patchHash });
    await expect(service.apply({ proposalId: proposal.id, approvalId: approval.id, sessionId: 'session-b' }))
      .rejects.toMatchObject({ code: 'invalid_approval' });

    const receipt = await service.apply({ proposalId: proposal.id, approvalId: approval.id, sessionId: 'session-a' });
    expect(receipt.status).toBe('applied');
    expect(hashPostState(adapter.post)).toBe(proposal.patchHash);
    expect(adapter.post.protectedFields).toEqual(initialPost().protectedFields);
    expect(await service.apply({ proposalId: proposal.id, approvalId: approval.id, sessionId: 'session-a' })).toEqual(receipt);
    expect(adapter.updates).toBe(1);
  });

  it('stops before write when any protected metadata drifts', async () => {
    const { adapter, proposal, service } = fixture();
    const approval = await service.approve({ proposalId: proposal.id, sessionId: 'session-a', expectedPatchHash: proposal.patchHash });
    adapter.post.protectedFields.title = 'Changed elsewhere';
    await expect(service.apply({ proposalId: proposal.id, approvalId: approval.id, sessionId: 'session-a' }))
      .rejects.toMatchObject({ code: 'content_drift' });
    expect(adapter.updates).toBe(0);
  });

  it('records an unknown write as review_required and never resends it', async () => {
    const { adapter, proposal, service, storage } = fixture();
    const approval = await service.approve({ proposalId: proposal.id, sessionId: 'session-a', expectedPatchHash: proposal.patchHash });
    adapter.unknownWrite = true;
    const receipt = await service.apply({ proposalId: proposal.id, approvalId: approval.id, sessionId: 'session-a' });
    expect(receipt.status).toBe('review_required');
    expect(storage.proposals.get(proposal.id)?.status).toBe('review_required');
    expect((await service.apply({ proposalId: proposal.id, approvalId: approval.id, sessionId: 'session-a' })).id).toBe(receipt.id);
    expect(adapter.updates).toBe(1);
  });

  it('requires a separate rollback approval and restores only an unchanged after-state', async () => {
    const { adapter, proposal, service } = fixture();
    const approval = await service.approve({ proposalId: proposal.id, sessionId: 'session-a', expectedPatchHash: proposal.patchHash });
    await service.apply({ proposalId: proposal.id, approvalId: approval.id, sessionId: 'session-a' });
    const rollbackApproval = await service.approveRollback({ proposalId: proposal.id, sessionId: 'session-a' });
    const receipt = await service.rollback({ proposalId: proposal.id, approvalId: rollbackApproval.id, sessionId: 'session-a' });
    expect(receipt.status).toBe('rolled_back');
    expect(adapter.post.bodyHtml).toBe(initialPost().bodyHtml);
    expect(adapter.updates).toBe(2);
  });

  it('returns conflict and does not rollback when the post drifts after apply', async () => {
    const { adapter, proposal, service } = fixture();
    const approval = await service.approve({ proposalId: proposal.id, sessionId: 'session-a', expectedPatchHash: proposal.patchHash });
    await service.apply({ proposalId: proposal.id, approvalId: approval.id, sessionId: 'session-a' });
    const rollbackApproval = await service.approveRollback({ proposalId: proposal.id, sessionId: 'session-a' });
    adapter.post.bodyHtml = '<p>newer external edit</p>';
    await expect(service.rollback({ proposalId: proposal.id, approvalId: rollbackApproval.id, sessionId: 'session-a' }))
      .rejects.toBeInstanceOf(WriterServiceError);
    expect(adapter.updates).toBe(1);
  });
});

describe('writer lock', () => {
  it('never steals or deletes an existing lock', async () => {
    const lockPath = path.join(tempRoot, 'writer.lock');
    const release = await acquireWriterLock('first', { production: false, lockPath });
    await expect(acquireWriterLock('second', { production: false, lockPath })).rejects.toBeInstanceOf(WriterLockHeldError);
    expect(JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({ label: 'first' });
    await release();
  });
});

describe('HttpWordPressAdapter', () => {
  it('uses fixed-origin manual redirects, sends only content, and normalizes rendered public text', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify({
        id: 42, link: 'https://example.test/article/', status: 'publish', modified_gmt: '2026-10-23T00:00:00Z',
        content: { raw: '<!-- wp:paragraph --><p>Hello <strong>world</strong></p><!-- /wp:paragraph -->' },
        slug: 'article', title: { raw: 'Article' }, excerpt: { raw: 'Excerpt' }, categories: [1], tags: [2],
        featured_media: 3, meta: { yoast_wpseo_title: 'SEO title' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      new Response(JSON.stringify({ id: 42, content: { rendered: '<p>Hello <strong>world</strong></p>' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
      new Response('<html><head><link href="https://example.test/article/" rel="canonical"></head><body><article><p>Hello <strong>world</strong></p></article></body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    ];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error('unexpected fetch');
      return response;
    };
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret', fetch: fakeFetch,
    });
    const post = await adapter.getPostForEdit(42);
    await adapter.updateBody(42, post.bodyHtml);
    const publicReadback = await adapter.checkPublicReadback(post);

    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.init?.redirect === 'manual')).toBe(true);
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ content: post.bodyHtml });
    expect(publicReadback).toMatchObject({ visibility: 'public', statusCode: 200, normalizedText: 'Hello world' });
    const editUrl = new URL(calls[0].url);
    const writeUrl = new URL(calls[1].url);
    const publicRestUrl = new URL(calls[2].url);
    const publicPageUrl = new URL(calls[3].url);
    expect(editUrl.searchParams.has('_siteops_verify')).toBe(false);
    expect(writeUrl.searchParams.has('_siteops_verify')).toBe(false);
    expect(publicRestUrl.searchParams.get('context')).toBe('view');
    expect(publicPageUrl.href).toBe('https://example.test/article/');
    const restNonce = publicRestUrl.searchParams.get('_siteops_verify');
    expect(restNonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(publicPageUrl.searchParams.has('_siteops_verify')).toBe(false);
    expect(new Headers(calls[0].init?.headers).has('Cache-Control')).toBe(false);
    expect(new Headers(calls[1].init?.headers).has('Cache-Control')).toBe(false);
    expect(new Headers(calls[2].init?.headers).get('Cache-Control')).toBe('no-cache');
    expect(new Headers(calls[3].init?.headers).get('Cache-Control')).toBe('no-cache');
    expect(publicReadback.url).toBe('https://example.test/article/');
  });

  it('rejects redirect and ambiguous update results without following or retrying', async () => {
    let calls = 0;
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } });
      },
    });
    await expect(adapter.updateBody(42, '<p>x</p>')).rejects.toBeInstanceOf(UnknownWordPressWriteError);
    expect(calls).toBe(1);
  });

  it('accepts approved body text inside ordinary theme wrappers', async () => {
    const responses = [
      new Response(JSON.stringify({ id: 42, content: { rendered: '<h2>測試標題</h2><p>正文 <strong>內容</strong></p>' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
      new Response('<html><head><title>Theme title</title><link rel="canonical" href="https://example.test/article/"></head><body><header>Site</header><main><article><h2>測試標題</h2><p>正文 <strong>內容</strong></p></article></main><footer>Footer</footer></body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    ];
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
    });
    const post = { ...initialPost(), bodyHtml: '<h2>測試標題</h2><p>正文 <strong>內容</strong></p>' };

    await expect(adapter.checkPublicReadback(post)).resolves.toMatchObject({ visibility: 'public', statusCode: 200 });
  });

  it('rejects a public page when approved text appears only in head content', async () => {
    const bodyHtml = '<p>Approved body sentence</p>';
    const responses = [
      new Response(JSON.stringify({ id: 42, content: { rendered: bodyHtml } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
      new Response('<html><head><title>Approved body sentence</title><link rel="canonical" href="https://example.test/article/"></head><body><article><p>Different body</p></article></body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    ];
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
    });

    await expect(adapter.checkPublicReadback({ ...initialPost(), bodyHtml }))
      .rejects.toThrow('WordPress public page did not contain the approved visible body text');
  });

  it('accepts one heading-validated generated TOC on the public page only', async () => {
    const bodyHtml = '<p>導言</p><h2>第一節</h2><h3>第二節</h3><p>結尾</p>';
    const toc = '<div id="toc_container" role="navigation" data-nosnippet><p class="toc_title">文章目錄</p><ul class="toc_list"><li><a href="#first"><span class="toc_number">1.</span>第一節</a><ul><li><a href="#second"><span class="toc_number">1.1.</span>第二節</a></li></ul></li></ul></div>';
    const responses = [
      new Response(JSON.stringify({ id: 42, content: { rendered: bodyHtml } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
      new Response(`<html><head><link rel="canonical" href="https://example.test/article/"></head><body><h1>Theme</h1><article class="wp-block-post-content"><p>導言</p>${toc}<h2><span id="first">第一節</span></h2><h3><span id="second">第二節</span></h3><p>結尾</p></article></body></html>`, {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    ];
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
    });

    await expect(adapter.checkPublicReadback({ ...initialPost(), bodyHtml }))
      .resolves.toMatchObject({ visibility: 'public', statusCode: 200 });
  });

  it('still rejects a generated TOC injected into the public REST body', async () => {
    const bodyHtml = '<p>導言</p><h2 id="first">第一節</h2><p>結尾</p>';
    const toc = '<div id="toc_container" role="navigation" data-nosnippet><p class="toc_title">文章目錄</p><ul class="toc_list"><li><a href="#first"><span class="toc_number">1.</span>第一節</a></li></ul></div>';
    let calls = 0;
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: 42, content: { rendered: `${toc}${bodyHtml}` } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(adapter.checkPublicReadback({ ...initialPost(), bodyHtml }))
      .rejects.toThrow('WordPress public REST text did not match the authenticated body');
    expect(calls).toBe(1);
  });

  it('uses a nonce only for public REST and verifies the exact base page URL', async () => {
    const bodyHtml = '<p>fresh body</p>';
    const seen: URL[] = [];
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async (input) => {
        const url = new URL(String(input));
        seen.push(url);
        if (url.pathname.startsWith('/wp-json/')) {
          if (!url.searchParams.has('_siteops_verify')) {
            return new Response(JSON.stringify({ id: 42, content: { rendered: '<p>stale body</p>' } }), {
              status: 200, headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ id: 42, content: { rendered: bodyHtml } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (url.searchParams.has('_siteops_verify')) return new Response(null, { status: 301 });
        return new Response('<html><head><link rel="canonical" href="https://example.test/article/"></head><body><p>fresh body</p></body></html>', {
          status: 200, headers: { 'content-type': 'text/html' },
        });
      },
    });

    await expect(adapter.checkPublicReadback({ ...initialPost(), bodyHtml }))
      .resolves.toMatchObject({ visibility: 'public', url: 'https://example.test/article/' });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.searchParams.has('_siteops_verify')).toBe(true);
    expect(seen[1]?.href).toBe('https://example.test/article/');
  });

  it('still rejects stale content returned for a nonce-bearing public REST request', async () => {
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async () => new Response(JSON.stringify({ id: 42, content: { rendered: '<p>stale body</p>' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    });

    await expect(adapter.checkPublicReadback({ ...initialPost(), bodyHtml: '<p>fresh body</p>' }))
      .rejects.toThrow('WordPress public REST text did not match the authenticated body');
  });

  it('rejects a canonical URL polluted with the verification nonce', async () => {
    const bodyHtml = '<p>fresh body</p>';
    let requestCount = 0;
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ id: 42, content: { rendered: bodyHtml } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(`<html><head><link rel="canonical" href="https://example.test/article/?_siteops_verify=00000000-0000-4000-8000-000000000000"></head><body>${bodyHtml}</body></html>`, {
          status: 200, headers: { 'content-type': 'text/html' },
        });
      },
    });

    await expect(adapter.checkPublicReadback({ ...initialPost(), bodyHtml }))
      .rejects.toThrow('WordPress public page canonical did not match the authenticated post URL');
  });

  it('rejects an exact-page redirect without following, retrying, or falling back', async () => {
    const bodyHtml = '<p>fresh body</p>';
    let calls = 0;
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ id: 42, content: { rendered: bodyHtml } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 301, headers: { location: 'https://example.test/article/' } });
      },
    });

    await expect(adapter.checkPublicReadback({ ...initialPost(), bodyHtml }))
      .rejects.toThrow('WordPress redirects are not allowed');
    expect(calls).toBe(2);
  });

  it('rejects stale content returned by a 200 exact-page response', async () => {
    const bodyHtml = '<p>fresh body</p>';
    const responses = [
      new Response(JSON.stringify({ id: 42, content: { rendered: bodyHtml } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
      new Response('<html><head><link rel="canonical" href="https://example.test/article/"></head><body><p>stale body</p></body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    ];
    const adapter = new HttpWordPressAdapter({
      siteOrigin: 'https://example.test', username: 'user', applicationPassword: 'secret',
      fetch: async () => responses.shift() ?? new Response(null, { status: 500 }),
    });

    await expect(adapter.checkPublicReadback({ ...initialPost(), bodyHtml }))
      .rejects.toThrow('WordPress public page did not contain the approved visible body text');
  });
});
