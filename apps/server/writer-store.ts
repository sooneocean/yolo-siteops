import type { ChangeProposal, ReconciliationReview } from '../../packages/contracts.js';
import { Store } from './store.js';
import type { ApprovalRecord, FinalizeReconciliationInput, ReconciliationAcceptance, WriterBackup, WriterReceipt, WriterStorage } from './writer/types.js';
import { applyReconciliationTransform, isReconciliationTransform } from './writer/transform-helper.js';

const KINDS = {
  proposal: 'proposal', approval: 'writer_approval', backup: 'writer_backup', receipt: 'writer_receipt',
  reconciliationReview: 'writer_reconciliation_review', reconciliationAcceptance: 'writer_reconciliation_acceptance',
} as const;

export class SQLiteWriterStorage implements WriterStorage {
  constructor(private readonly store: Store) {}

  async getProposal(id: string) { return this.store.get<ChangeProposal>(KINDS.proposal, id); }
  async saveProposal(proposal: ChangeProposal) { this.store.put(KINDS.proposal, proposal.id, proposal); }
  async insertApproval(approval: ApprovalRecord) { this.store.put(KINDS.approval, approval.id, approval); }
  async getApproval(id: string) { return this.store.get<ApprovalRecord>(KINDS.approval, id); }

  async consumeApproval(id: string, consumedAt: string): Promise<boolean> {
    return this.store.transaction(() => {
      const approval = this.store.get<ApprovalRecord>(KINDS.approval, id);
      if (!approval || approval.consumedAt) return false;
      this.store.put(KINDS.approval, id, { ...approval, consumedAt });
      return true;
    });
  }

  async saveBackup(backup: WriterBackup) { this.store.put(KINDS.backup, backup.proposalId, backup); }
  async getBackupForProposal(proposalId: string) { return this.store.get<WriterBackup>(KINDS.backup, proposalId); }
  async pruneBackups(expiredBefore: string) {
    for (const backup of this.store.list<WriterBackup>(KINDS.backup)) {
      if (backup.expiresAt <= expiredBefore) this.store.remove(KINDS.backup, backup.proposalId);
    }
  }
  async getReceipt(operation: WriterReceipt['operation'], proposalId: string) {
    return this.store.get<WriterReceipt>(KINDS.receipt, `${operation}:${proposalId}`);
  }
  async putReceipt(receipt: WriterReceipt) {
    this.store.put(KINDS.receipt, `${receipt.operation}:${receipt.proposalId}`, receipt);
  }
  async saveReconciliationReview(review: ReconciliationReview) { this.store.put(KINDS.reconciliationReview, review.id, review); }
  async getReconciliationReview(id: string) { return this.store.get<ReconciliationReview>(KINDS.reconciliationReview, id); }
  async insertReconciliationAcceptance(acceptance: ReconciliationAcceptance) {
    this.store.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?)').run(
      KINDS.reconciliationAcceptance, acceptance.id, JSON.stringify(acceptance),
    );
  }
  async getReconciliationAcceptance(id: string) {
    return this.store.get<ReconciliationAcceptance>(KINDS.reconciliationAcceptance, id);
  }
  async finalizeReconciliation(input: FinalizeReconciliationInput): Promise<ChangeProposal> {
    return this.store.transaction(() => {
      const acceptance = this.store.get<ReconciliationAcceptance>(KINDS.reconciliationAcceptance, input.acceptance.id);
      const proposal = this.store.get<ChangeProposal>(KINDS.proposal, input.acceptance.proposalId);
      const original = this.store.get<WriterReceipt>(KINDS.receipt, `apply:${input.acceptance.proposalId}`);
      const review = acceptance?.reviewId
        ? this.store.get<ReconciliationReview>(KINDS.reconciliationReview, acceptance.reviewId) : undefined;
      if (!acceptance || acceptance.consumedAt || acceptance.expiresAt <= input.reconciledAt
        || JSON.stringify(acceptance) !== JSON.stringify(input.acceptance)
        || !isReconciliationTransform(acceptance.transform) || !review
        || review.id !== acceptance.reviewId || review.proposalId !== acceptance.proposalId
        || review.postId !== acceptance.postId || review.sessionId !== acceptance.sessionId
        || review.baseHash !== acceptance.baseHash || review.originalPatchHash !== acceptance.originalPatchHash
        || review.originalApplyReceiptId !== acceptance.originalApplyReceiptId
        || review.originalReviewReason !== acceptance.originalReviewReason
        || review.reviewedActualHash !== acceptance.reviewedActualHash || review.transform !== acceptance.transform
        || review.actualBodyHtml !== applyReconciliationTransform(acceptance.transform, proposal?.afterHtml ?? '')
        || !proposal || proposal.status !== 'review_required'
        || proposal.postId !== acceptance.postId || proposal.baseHash !== acceptance.baseHash
        || proposal.patchHash !== acceptance.originalPatchHash || proposal.error !== acceptance.originalReviewReason
        || proposal.reconciliationTransform !== undefined
        || !original || original.id !== acceptance.originalApplyReceiptId || original.status !== 'review_required'
        || original.operation !== 'apply' || original.proposalId !== proposal.id || original.postId !== proposal.postId
        || !original.sessionId || original.beforeHash !== proposal.baseHash
        || original.afterHash !== undefined || original.message !== acceptance.originalReviewReason
        || input.receipt.operation !== 'reconcile' || input.receipt.status !== 'verified_transformed'
        || input.receipt.proposalId !== proposal.id || input.receipt.postId !== proposal.postId
        || input.receipt.sessionId !== acceptance.sessionId || input.receipt.beforeHash !== acceptance.originalPatchHash
        || input.receipt.afterHash !== acceptance.reviewedActualHash || input.receipt.createdAt !== input.reconciledAt
        || input.receipt.reconciliationTransform !== acceptance.transform) {
        throw new Error('Reconciliation acceptance bindings are no longer valid');
      }
      if (this.store.get<WriterReceipt>(KINDS.receipt, `reconcile:${proposal.id}`)) {
        throw new Error('Reconciliation receipt already exists');
      }
      this.store.put(KINDS.reconciliationAcceptance, acceptance.id, { ...acceptance, consumedAt: input.reconciledAt });
      this.store.db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?)').run(
        KINDS.receipt, `reconcile:${proposal.id}`, JSON.stringify(input.receipt),
      );
      const reconciled: ChangeProposal = {
        ...proposal, status: 'verified_transformed', afterHash: acceptance.reviewedActualHash,
        originalReviewReason: acceptance.originalReviewReason, originalApplyReceiptId: acceptance.originalApplyReceiptId,
        originalPatchHash: acceptance.originalPatchHash, reconciliationTransform: acceptance.transform,
        reconciliationReviewId: acceptance.reviewId, reconciliationAcceptanceId: acceptance.id,
        reconciledAt: input.reconciledAt, reviewedActualHash: acceptance.reviewedActualHash,
      };
      this.store.put(KINDS.proposal, proposal.id, reconciled);
      return reconciled;
    });
  }

  listProposals(): ChangeProposal[] { return this.store.list<ChangeProposal>(KINDS.proposal); }

  /** Fail closed after a crash between consuming approval and persisting its receipt. */
  reconcileConsumedApprovals(): number {
    let reconciled = 0;
    for (const approval of this.store.list<ApprovalRecord>(KINDS.approval)) {
      if (!approval.consumedAt) continue;
      const operation: WriterReceipt['operation'] = approval.kind === 'apply' ? 'apply' : 'rollback';
      if (this.store.get<WriterReceipt>(KINDS.receipt, `${operation}:${approval.proposalId}`)) continue;
      const proposal = this.store.get<ChangeProposal>(KINDS.proposal, approval.proposalId);
      if (!proposal || proposal.status === 'review_required') continue;
      this.store.put<ChangeProposal>(KINDS.proposal, proposal.id, {
        ...proposal,
        status: 'review_required',
        error: `Interrupted ${operation} after one-time approval consumption; verify WordPress before any further write.`,
      });
      reconciled += 1;
    }
    return reconciled;
  }
}
