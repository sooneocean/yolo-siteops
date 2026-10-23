import crypto from 'node:crypto';
import type { ChangeProposal, ReconciliationReview, ReconciliationTransform } from '../../../packages/contracts.js';
import { assertSafeProposalHtml, normalizeHtmlText } from '../security/html.js';
import { hashPostState } from './hash.js';
import { acquireWriterLock, type WriterLockOptions } from './lock.js';
import { applyReconciliationTransform, isReconciliationTransform, matchingReconciliationTransforms } from './transform-helper.js';
import {
  UnknownWordPressWriteError,
  type ApprovalKind,
  type ApprovalRecord,
  type ReconciliationAcceptance,
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
    if (!['applied', 'verified_transformed'].includes(proposal.status) || !proposal.afterHash) {
      throw new WriterServiceError('proposal_not_applied', 'Only a verified applied proposal may be approved for rollback');
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
      if (!['applied', 'verified_transformed'].includes(proposal.status) || !proposal.afterHash) {
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

  async prepareReconciliation(args: { proposalId: string; sessionId: string }): Promise<ReconciliationReview> {
    if (!args.sessionId) throw new WriterServiceError('session_required', 'Reconciliation review requires a session', 401);
    const proposal = await this.requireProposal(args.proposalId);
    if (proposal.status !== 'review_required' || !proposal.error) {
      throw new WriterServiceError('proposal_not_review_required', 'Only an unresolved review-required apply may be reconciled');
    }
    const original = await this.storage.getReceipt('apply', proposal.id);
    if (!original || !this.originalReceiptMatches(original, proposal)) {
      throw new WriterServiceError('original_receipt_required', 'The original review-required apply receipt is missing');
    }
    const backup = await this.requireBackup(proposal.id);
    const release = await acquireWriterLock(`yolo-siteops:reconcile-prepare:${proposal.id}`, this.lockOptions);
    try {
      const actual = await this.adapter.getPostForEdit(proposal.postId);
      this.validateReconciliationPost(proposal, backup, actual);
      const transforms = matchingReconciliationTransforms(proposal.afterHtml, actual.bodyHtml);
      if (transforms.length !== 1) {
        throw new WriterServiceError('unsupported_wordpress_transform', 'Actual WordPress body is not the exact approved bare-p transformation');
      }
      const readback = await this.adapter.checkPublicReadback(actual);
      ensureUrlOrigin(readback.url, this.siteOrigin);
      expectPublicReadback(actual, readback);
      const review: ReconciliationReview = {
        id: crypto.randomUUID(), proposalId: proposal.id, postId: proposal.postId, sessionId: args.sessionId,
        baseHash: proposal.baseHash, originalPatchHash: proposal.patchHash, originalApplyReceiptId: original.id,
        originalReviewReason: proposal.error, reviewedActualHash: hashPostState(actual), actualBodyHtml: actual.bodyHtml,
        transform: transforms[0], createdAt: this.now().toISOString(),
      };
      if (!this.storage.saveReconciliationReview) throw new WriterServiceError('reconciliation_storage_unavailable', 'Reconciliation storage is unavailable', 503);
      await this.storage.saveReconciliationReview(review);
      return review;
    } finally {
      await release();
    }
  }

  async acceptReconciliation(args: { reviewId: string; proposalId: string; sessionId: string; reviewedActualHash: string; expectedTransform: ReconciliationTransform; expiresInMs?: number }): Promise<ReconciliationAcceptance> {
    if (!this.storage.getReconciliationReview || !this.storage.insertReconciliationAcceptance) {
      throw new WriterServiceError('reconciliation_storage_unavailable', 'Reconciliation storage is unavailable', 503);
    }
    const review = await this.storage.getReconciliationReview(args.reviewId);
    const proposal = await this.requireProposal(args.proposalId);
    const original = await this.storage.getReceipt('apply', proposal.id);
    if (!review || review.proposalId !== proposal.id || review.sessionId !== args.sessionId
      || review.reviewedActualHash !== args.reviewedActualHash || proposal.status !== 'review_required'
      || proposal.baseHash !== review.baseHash || proposal.patchHash !== review.originalPatchHash
      || proposal.error !== review.originalReviewReason || proposal.postId !== review.postId
      || review.transform !== args.expectedTransform || !isReconciliationTransform(args.expectedTransform)
      || review.actualBodyHtml !== applyReconciliationTransform(args.expectedTransform, proposal.afterHtml)
      || proposal.reconciliationTransform !== undefined
      || !original || original.id !== review.originalApplyReceiptId
      || !this.originalReceiptMatches(original, proposal)) {
      throw new WriterServiceError('invalid_reconciliation_review', 'Reconciliation acceptance does not match the reviewed state', 403);
    }
    const expiresInMs = args.expiresInMs ?? 10 * 60 * 1000;
    if (!Number.isFinite(expiresInMs) || expiresInMs <= 0 || expiresInMs > 60 * 60 * 1000) {
      throw new WriterServiceError('invalid_approval_expiry', 'Acceptance expiry must be between zero and one hour', 400);
    }
    const now = this.now();
    const acceptance: ReconciliationAcceptance = {
      id: crypto.randomUUID(), reviewId: review.id, proposalId: proposal.id, postId: proposal.postId, sessionId: args.sessionId,
      baseHash: review.baseHash, originalPatchHash: review.originalPatchHash,
      originalApplyReceiptId: review.originalApplyReceiptId, originalReviewReason: review.originalReviewReason,
      reviewedActualHash: review.reviewedActualHash, transform: review.transform, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    };
    await this.storage.insertReconciliationAcceptance(acceptance);
    return acceptance;
  }

  async reconcile(args: { proposalId: string; acceptanceId: string; sessionId: string }): Promise<WriterReceipt> {
    const existing = await this.storage.getReceipt('reconcile', args.proposalId);
    if (existing) return this.requireReconciliationReplay(existing, args.proposalId, args.sessionId);
    if (!this.storage.getReconciliationAcceptance || !this.storage.finalizeReconciliation) {
      throw new WriterServiceError('reconciliation_storage_unavailable', 'Reconciliation storage is unavailable', 503);
    }
    const release = await acquireWriterLock(`yolo-siteops:reconcile:${args.proposalId}`, this.lockOptions);
    try {
      const replay = await this.storage.getReceipt('reconcile', args.proposalId);
      if (replay) return this.requireReconciliationReplay(replay, args.proposalId, args.sessionId);
      const proposal = await this.requireProposal(args.proposalId);
      const acceptance = await this.storage.getReconciliationAcceptance(args.acceptanceId);
      const review = acceptance?.reviewId ? await this.storage.getReconciliationReview?.(acceptance.reviewId) : undefined;
      const original = await this.storage.getReceipt('apply', proposal.id);
      if (!acceptance || acceptance.proposalId !== proposal.id || acceptance.sessionId !== args.sessionId
        || acceptance.consumedAt || Date.parse(acceptance.expiresAt) <= this.now().getTime()
        || acceptance.postId !== proposal.postId || !isReconciliationTransform(acceptance.transform)
        || proposal.status !== 'review_required' || proposal.error !== acceptance.originalReviewReason
        || proposal.patchHash !== acceptance.originalPatchHash || proposal.baseHash !== acceptance.baseHash
        || proposal.reconciliationTransform !== undefined || !review
        || !this.reviewMatchesAcceptance(review, acceptance)
        || !original || original.id !== acceptance.originalApplyReceiptId
        || !this.originalReceiptMatches(original, proposal)) {
        throw new WriterServiceError('invalid_reconciliation_acceptance', 'Reconciliation acceptance is invalid, expired, or already consumed', 403);
      }
      const backup = await this.requireBackup(proposal.id);
      const actual = await this.adapter.getPostForEdit(proposal.postId);
      this.validateReconciliationPost(proposal, backup, actual);
      if (actual.bodyHtml !== applyReconciliationTransform(acceptance.transform, proposal.afterHtml)
        || actual.bodyHtml !== review.actualBodyHtml || hashPostState(actual) !== acceptance.reviewedActualHash) {
        throw new WriterServiceError('reconciliation_drift', 'WordPress content changed after reconciliation review');
      }
      const readback = await this.adapter.checkPublicReadback(actual);
      ensureUrlOrigin(readback.url, this.siteOrigin);
      expectPublicReadback(actual, readback);
      const at = this.now().toISOString();
      const receipt: WriterReceipt = {
        id: crypto.randomUUID(), sessionId: args.sessionId, operation: 'reconcile', proposalId: proposal.id,
        postId: proposal.postId, status: 'verified_transformed', beforeHash: proposal.patchHash,
        afterHash: acceptance.reviewedActualHash, createdAt: at,
        reconciliationTransform: acceptance.transform,
        message: `Verified exact WordPress ${acceptance.transform} formatting transformation without another write.`,
      };
      await this.storage.finalizeReconciliation({ acceptance, receipt, reconciledAt: at });
      return receipt;
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

  private validateReconciliationPost(proposal: ChangeProposal, backup: WriterBackup, actual: WordPressPostSnapshot): void {
    const proposalUrl = ensureUrlOrigin(proposal.url, this.siteOrigin);
    const actualUrl = ensureUrlOrigin(actual.url, this.siteOrigin);
    if (actual.postId !== proposal.postId || actual.postId !== backup.post.postId || proposalUrl.href !== actualUrl.href
      || actual.url !== backup.post.url || actual.status !== backup.post.status
      || hashPostState({ ...backup.post, bodyHtml: actual.bodyHtml }) !== hashPostState(actual)) {
      throw new WriterServiceError('reconciliation_identity_drift', 'WordPress identity, URL, status, or protected fields changed');
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

  private originalReceiptMatches(receipt: WriterReceipt, proposal: ChangeProposal): boolean {
    return receipt.operation === 'apply' && receipt.status === 'review_required'
      && receipt.proposalId === proposal.id && receipt.postId === proposal.postId
      && Boolean(receipt.sessionId) && receipt.beforeHash === proposal.baseHash
      && receipt.afterHash === undefined && receipt.message === proposal.error;
  }

  private reviewMatchesAcceptance(review: ReconciliationReview, acceptance: ReconciliationAcceptance): boolean {
    return review.id === acceptance.reviewId && review.proposalId === acceptance.proposalId
      && review.postId === acceptance.postId && review.sessionId === acceptance.sessionId
      && review.baseHash === acceptance.baseHash && review.originalPatchHash === acceptance.originalPatchHash
      && review.originalApplyReceiptId === acceptance.originalApplyReceiptId
      && review.originalReviewReason === acceptance.originalReviewReason
      && review.reviewedActualHash === acceptance.reviewedActualHash && review.transform === acceptance.transform;
  }

  private async requireReconciliationReplay(receipt: WriterReceipt, proposalId: string, sessionId: string): Promise<WriterReceipt> {
    this.requireReceiptSession(receipt, sessionId);
    const proposal = await this.requireProposal(proposalId);
    const original = await this.storage.getReceipt('apply', proposal.id);
    const baseValid = proposal.status === 'verified_transformed' && receipt.operation === 'reconcile'
      && receipt.status === 'verified_transformed' && receipt.proposalId === proposal.id
      && receipt.postId === proposal.postId && receipt.beforeHash === proposal.patchHash
      && receipt.beforeHash === proposal.originalPatchHash && receipt.afterHash === proposal.afterHash
      && receipt.createdAt === proposal.reconciledAt && original?.id === proposal.originalApplyReceiptId
      && Boolean(original) && this.originalReceiptMatches(original!, { ...proposal, error: proposal.originalReviewReason });
    if (!baseValid) throw new WriterServiceError('reconciliation_replay_conflict', 'Stored reconciliation receipt bindings are invalid', 500);
    if (receipt.reconciliationTransform === undefined) {
      if (proposal.reconciliationTransform !== 'strip_bare_p_v1'
        || receipt.message !== 'Verified exact WordPress strip_bare_p_v1 formatting transformation without another write.') {
        throw new WriterServiceError('reconciliation_replay_conflict', 'Legacy reconciliation receipt is not eligible for replay', 500);
      }
      return receipt;
    }
    const acceptance = proposal.reconciliationAcceptanceId
      ? await this.storage.getReconciliationAcceptance?.(proposal.reconciliationAcceptanceId) : undefined;
    const review = acceptance?.reviewId ? await this.storage.getReconciliationReview?.(acceptance.reviewId) : undefined;
    if (!acceptance || !review || receipt.reconciliationTransform !== proposal.reconciliationTransform
      || receipt.reconciliationTransform !== acceptance.transform || !this.reviewMatchesAcceptance(review, acceptance)) {
      throw new WriterServiceError('reconciliation_replay_conflict', 'Stored reconciliation receipt bindings are invalid', 500);
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
