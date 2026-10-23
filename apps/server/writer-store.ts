import type { ChangeProposal } from '../../packages/contracts.js';
import { Store } from './store.js';
import type { ApprovalRecord, WriterBackup, WriterReceipt, WriterStorage } from './writer/types.js';

const KINDS = {
  proposal: 'proposal', approval: 'writer_approval', backup: 'writer_backup', receipt: 'writer_receipt',
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
