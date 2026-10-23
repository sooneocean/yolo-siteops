import crypto from 'node:crypto';
import type { ChangeProposal } from '../../../packages/contracts.js';
import { assertSafeProposalHtml, normalizeHtmlText } from '../security/html.js';
import { hashPostState } from './hash.js';
import { acquireWriterLock, type WriterLockOptions } from './lock.js';
import {
  UnknownWordPressWriteError,
  type ApprovalKind,
  type ApprovalRecord,
  type WordPressAdapter,
  type WordPressPostSnapshot,
  type WriterBackup,
  type WriterReceipt,
  type WriterStorage,
} from './types.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export class WriterServiceError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 409) {
    super(message);
    this.name = 'WriterServiceError';
  }
}

export interface WriterServiceOptions {
  storage: WriterStorage;
  adapter: WordPressAdapter;
  siteOrigin: string;
  production?: boolean;
  lockPath?: string;
  now?: () => Date;
}

function fixedHttpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('siteOrigin must be an exact HTTPS origin without credentials or a path');
  }
  return url;
}

function ensureUrlOrigin(rawUrl: string, siteOrigin: URL): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.origin !== siteOrigin.origin || url.username || url.password) {
    throw new WriterServiceError('invalid_proposal_url', 'Proposal URL must use the configured HTTPS site origin');
  }
  return url;
}

function expectPublicReadback(post: WordPressPostSnapshot, readback: { visibility: 'public' | 'isolated'; statusCode: number; normalizedText?: string }): void {
  if (post.status === 'publish') {
    if (readback.visibility !== 'public' || readback.statusCode !== 200 || readback.normalizedText !== normalizeHtmlText(post.bodyHtml)) {
      throw new WriterServiceError('public_readback_mismatch', 'Published WordPress content did not match normalized public text');
    }
    return;
  }
  if (readback.visibility !== 'isolated' || ![401, 404].includes(readback.statusCode)) {
    throw new WriterServiceError('public_readback_mismatch', `Expected 401/404 isolation for ${post.status} post`);
  }
}

export class WriterService {
  private readonly storage: WriterStorage;
  private readonly adapter: WordPressAdapter;
  private readonly siteOrigin: URL;
  private readonly lockOptions: WriterLockOptions;
  private readonly now: () => Date;

  constructor(options: WriterServiceOptions) {
    this.storage = options.storage;
    this.adapter = options.adapter;
    this.siteOrigin = fixedHttpsOrigin(options.siteOrigin);
    this.lockOptions = { production: options.production ?? false, lockPath: options.lockPath };
    this.now = options.now ?? (() => new Date());
  }

  async approve(args: { proposalId: string; sessionId: string; expectedPatchHash: string; expiresInMs?: number }): Promise<ApprovalRecord> {
    const proposal = await this.requireProposal(args.proposalId);
    if (proposal.status !== 'pending' && proposal.status !== 'approved') {
      throw new WriterServiceError('proposal_not_pending', 'Only an unapplied proposal may be approved');
    }
    this.validateProposal(proposal);
    if (args.expectedPatchHash !== proposal.patchHash) {
      throw new WriterServiceError('stale_proposal_view', 'The displayed proposal hash is no longer current', 409);
    }
    return this.createApproval('apply', proposal, args.sessionId, proposal.baseHash, proposal.patchHash, args.expiresInMs);
  }

  async reject(args: { proposalId: string; reason: string }): Promise<ChangeProposal> {
    const proposal = await this.requireProposal(args.proposalId);
    if (proposal.status !== 'pending' && proposal.status !== 'approved') {
      throw new WriterServiceError('proposal_not_rejectable', 'Proposal is no longer rejectable');
    }
    const rejected: ChangeProposal = { ...proposal, status: 'rejected', error: args.reason };
    await this.storage.saveProposal(rejected);
    return rejected;
  }

  async apply(args: { proposalId: string; approvalId: string; sessionId: string }): Promise<WriterReceipt> {
    const existing = await this.storage.getReceipt('apply', args.proposalId);
    if (existing) return this.requireReceiptSession(existing, args.sessionId);
    const release = await acquireWriterLock(`yolo-siteops:apply:${args.proposalId}`, this.lockOptions);
    try {
      const replay = await this.storage.getReceipt('apply', args.proposalId);
      if (replay) return this.requireReceiptSession(replay, args.sessionId);
      const proposal = await this.requireProposal(args.proposalId);
      if (proposal.status !== 'approved') throw new WriterServiceError('proposal_not_approved', 'Proposal is not approved for apply');
      this.validateProposal(proposal);
      const approval = await this.requireApproval(args.approvalId, 'apply', proposal, args.sessionId, proposal.baseHash, proposal.patchHash);
      const before = await this.adapter.getPostForEdit(proposal.postId);
      this.validateFreshPost(proposal, before, proposal.baseHash);
      if (hashPostState({ ...before, bodyHtml: proposal.afterHtml }) !== proposal.patchHash) {
        throw new WriterServiceError('proposal_hash_mismatch', 'Proposed body does not produce the approved protected-state hash');
      }

      const now = this.now();
      const backup: WriterBackup = {
        id: crypto.randomUUID(),
        proposalId: proposal.id,
        post: before,
        stateHash: hashPostState(before),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + NINETY_DAYS_MS).toISOString(),
      };
      await this.storage.pruneBackups(now.toISOString());
      await this.storage.saveBackup(backup);
      await this.consumeApproval(approval, now);

      try {
        await this.adapter.updateBody(proposal.postId, proposal.afterHtml);
      } catch (error) {
        if (error instanceof UnknownWordPressWriteError) {
          return this.recordReviewRequired(proposal, args.sessionId, 'apply', proposal.baseHash, undefined, error.message);
        }
        throw error;
      }

      try {
        const after = await this.adapter.getPostForEdit(proposal.postId);
        this.validatePostWrite(before, after, proposal.patchHash);
        const publicReadback = await this.adapter.checkPublicReadback(after);
        ensureUrlOrigin(publicReadback.url, this.siteOrigin);
        expectPublicReadback(after, publicReadback);
        const receipt: WriterReceipt = {
          id: crypto.randomUUID(), sessionId: args.sessionId, operation: 'apply', proposalId: proposal.id, postId: proposal.postId,
          status: 'applied', beforeHash: proposal.baseHash, afterHash: proposal.patchHash, createdAt: this.now().toISOString(),
        };
        await this.storage.saveProposal({ ...proposal, status: 'applied', appliedAt: receipt.createdAt, afterHash: proposal.patchHash, error: undefined });
        await this.storage.putReceipt(receipt);
        return receipt;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'WordPress read-back failed';
        return this.recordReviewRequired(proposal, args.sessionId, 'apply', proposal.baseHash, undefined, message);
      }
    } finally {
      await release();
    }
  }

  async approveRollback(args: { proposalId: string; sessionId: string; expiresInMs?: number }): Promise<ApprovalRecord> {
    const proposal = await this.requireProposal(args.proposalId);
    if (proposal.status !== 'applied' || !proposal.afterHash) {
      throw new WriterServiceError('proposal_not_applied', 'Only an applied proposal may be approved for rollback');
    }
    const backup = await this.requireBackup(proposal.id);
    return this.createApproval('rollback', proposal, args.sessionId, proposal.afterHash, backup.stateHash, args.expiresInMs);
  }

  async rollback(args: { proposalId: string; approvalId: string; sessionId: string }): Promise<WriterReceipt> {
    const existing = await this.storage.getReceipt('rollback', args.proposalId);
    if (existing) return this.requireReceiptSession(existing, args.sessionId);
    const release = await acquireWriterLock(`yolo-siteops:rollback:${args.proposalId}`, this.lockOptions);
    try {
      const replay = await this.storage.getReceipt('rollback', args.proposalId);
      if (replay) return this.requireReceiptSession(replay, args.sessionId);
      const proposal = await this.requireProposal(args.proposalId);
      if (proposal.status !== 'applied' || !proposal.afterHash) {
        throw new WriterServiceError('proposal_not_applied', 'Proposal is not eligible for rollback');
      }
      const backup = await this.requireBackup(proposal.id);
      const approval = await this.requireApproval(args.approvalId, 'rollback', proposal, args.sessionId, proposal.afterHash, backup.stateHash);
      const current = await this.adapter.getPostForEdit(proposal.postId);
      this.validateFreshPost(proposal, current, proposal.afterHash);
      await this.consumeApproval(approval, this.now());

      try {
        await this.adapter.updateBody(proposal.postId, backup.post.bodyHtml);
      } catch (error) {
        if (error instanceof UnknownWordPressWriteError) {
          return this.recordReviewRequired(proposal, args.sessionId, 'rollback', proposal.afterHash, undefined, error.message);
        }
        throw error;
      }

      try {
        const restored = await this.adapter.getPostForEdit(proposal.postId);
        this.validatePostWrite(current, restored, backup.stateHash);
        const publicReadback = await this.adapter.checkPublicReadback(restored);
        ensureUrlOrigin(publicReadback.url, this.siteOrigin);
        expectPublicReadback(restored, publicReadback);
        const receipt: WriterReceipt = {
          id: crypto.randomUUID(), sessionId: args.sessionId, operation: 'rollback', proposalId: proposal.id, postId: proposal.postId,
          status: 'rolled_back', beforeHash: proposal.afterHash, afterHash: backup.stateHash, createdAt: this.now().toISOString(),
        };
        await this.storage.saveProposal({ ...proposal, status: 'rolled_back', error: undefined });
        await this.storage.putReceipt(receipt);
        return receipt;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'WordPress rollback read-back failed';
        return this.recordReviewRequired(proposal, args.sessionId, 'rollback', proposal.afterHash, undefined, message);
      }
    } finally {
      await release();
    }
  }

  private async requireProposal(id: string): Promise<ChangeProposal> {
    const proposal = await this.storage.getProposal(id);
    if (!proposal) throw new WriterServiceError('proposal_not_found', 'Proposal was not found', 404);
    return proposal;
  }

  private validateProposal(proposal: ChangeProposal): void {
    ensureUrlOrigin(proposal.url, this.siteOrigin);
    assertSafeProposalHtml(proposal.afterHtml);
  }

  private validateFreshPost(proposal: ChangeProposal, post: WordPressPostSnapshot, expectedHash: string): void {
    if (post.postId !== proposal.postId || hashPostState(post) !== expectedHash) {
      throw new WriterServiceError('content_drift', 'Fresh WordPress content does not match the approved hash');
    }
    const proposalUrl = ensureUrlOrigin(proposal.url, this.siteOrigin);
    const postUrl = ensureUrlOrigin(post.url, this.siteOrigin);
    if (proposalUrl.href !== postUrl.href) throw new WriterServiceError('url_drift', 'Fresh WordPress URL does not match the proposal');
  }

  private validatePostWrite(before: WordPressPostSnapshot, after: WordPressPostSnapshot, expectedHash: string): void {
    if (after.postId !== before.postId || after.url !== before.url || hashPostState(after) !== expectedHash) {
      throw new WriterServiceError('authenticated_readback_mismatch', 'Authenticated WordPress read-back did not match the requested body-only update');
    }
  }

  private async createApproval(kind: ApprovalKind, proposal: ChangeProposal, sessionId: string, baseHash: string, patchHash: string, expiresInMs = 10 * 60 * 1000): Promise<ApprovalRecord> {
    if (!sessionId) throw new WriterServiceError('session_required', 'Approval requires an authenticated session', 401);
    if (!Number.isFinite(expiresInMs) || expiresInMs <= 0 || expiresInMs > 60 * 60 * 1000) {
      throw new WriterServiceError('invalid_approval_expiry', 'Approval expiry must be between zero and one hour', 400);
    }
    const now = this.now();
    const approval: ApprovalRecord = {
      id: crypto.randomUUID(), sessionId, kind, proposalId: proposal.id, baseHash, patchHash,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    };
    await this.storage.insertApproval(approval);
    if (kind === 'apply' && proposal.status === 'pending') await this.storage.saveProposal({ ...proposal, status: 'approved' });
    return approval;
  }

  private async requireApproval(id: string, kind: ApprovalKind, proposal: ChangeProposal, sessionId: string, baseHash: string, patchHash: string): Promise<ApprovalRecord> {
    const approval = await this.storage.getApproval(id);
    if (!approval || approval.sessionId !== sessionId || approval.kind !== kind || approval.proposalId !== proposal.id || approval.baseHash !== baseHash || approval.patchHash !== patchHash) {
      throw new WriterServiceError('invalid_approval', 'Approval is not bound to this exact proposal operation', 403);
    }
    if (approval.consumedAt) throw new WriterServiceError('approval_replayed', 'Approval was already consumed', 403);
    if (Date.parse(approval.expiresAt) <= this.now().getTime()) throw new WriterServiceError('approval_expired', 'Approval has expired', 403);
    return approval;
  }

  private async consumeApproval(approval: ApprovalRecord, now: Date): Promise<void> {
    if (!await this.storage.consumeApproval(approval.id, now.toISOString())) {
      throw new WriterServiceError('approval_replayed', 'Approval was already consumed', 403);
    }
  }

  private async requireBackup(proposalId: string): Promise<WriterBackup> {
    const backup = await this.storage.getBackupForProposal(proposalId);
    if (!backup) throw new WriterServiceError('backup_not_found', 'Rollback backup was not found', 404);
    if (Date.parse(backup.expiresAt) <= this.now().getTime()) throw new WriterServiceError('backup_expired', 'Rollback backup has expired', 410);
    if (backup.proposalId !== proposalId || hashPostState(backup.post) !== backup.stateHash) {
      throw new WriterServiceError('backup_integrity_mismatch', 'Rollback backup failed its integrity check');
    }
    return backup;
  }

  private requireReceiptSession(receipt: WriterReceipt, sessionId: string): WriterReceipt {
    if (!sessionId || receipt.sessionId !== sessionId) {
      throw new WriterServiceError('receipt_session_mismatch', 'Receipt belongs to a different authenticated session', 403);
    }
    return receipt;
  }

  private async recordReviewRequired(proposal: ChangeProposal, sessionId: string, operation: WriterReceipt['operation'], beforeHash: string, afterHash: string | undefined, message: string): Promise<WriterReceipt> {
    const receipt: WriterReceipt = {
      id: crypto.randomUUID(), sessionId, operation, proposalId: proposal.id, postId: proposal.postId,
      status: 'review_required', beforeHash, afterHash, createdAt: this.now().toISOString(), message,
    };
    await this.storage.saveProposal({ ...proposal, status: 'review_required', error: message });
    await this.storage.putReceipt(receipt);
    return receipt;
  }
}
