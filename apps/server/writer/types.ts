import type { ChangeProposal, ReconciliationReview } from '../../../packages/contracts.js';

export type ApprovalKind = 'apply' | 'rollback';

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  kind: ApprovalKind;
  proposalId: string;
  baseHash: string;
  patchHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface WordPressPostSnapshot {
  postId: number;
  url: string;
  bodyHtml: string;
  status: string;
  modified: string;
  protectedFields: {
    slug: string;
    title: string;
    excerpt: string;
    categories: number[];
    tags: number[];
    featured_media: number;
    meta: Record<string, unknown>;
  };
}

export interface WriterBackup {
  id: string;
  proposalId: string;
  post: WordPressPostSnapshot;
  stateHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface PublicReadback {
  visibility: 'public' | 'isolated';
  statusCode: number;
  url: string;
  normalizedText?: string;
}

export interface WriterReceipt {
  id: string;
  sessionId: string;
  operation: 'apply' | 'rollback' | 'reconcile';
  proposalId: string;
  postId: number;
  status: 'applied' | 'rolled_back' | 'review_required' | 'verified_transformed';
  beforeHash: string;
  afterHash?: string;
  createdAt: string;
  message?: string;
}

export interface ReconciliationAcceptance {
  id: string;
  proposalId: string;
  postId: number;
  sessionId: string;
  baseHash: string;
  originalPatchHash: string;
  originalApplyReceiptId: string;
  originalReviewReason: string;
  reviewedActualHash: string;
  transform: 'strip_bare_p_v1';
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface FinalizeReconciliationInput {
  acceptance: ReconciliationAcceptance;
  receipt: WriterReceipt;
  reconciledAt: string;
}

export interface WriterStorage {
  getProposal(id: string): Promise<ChangeProposal | undefined>;
  saveProposal(proposal: ChangeProposal): Promise<void>;
  insertApproval(approval: ApprovalRecord): Promise<void>;
  getApproval(id: string): Promise<ApprovalRecord | undefined>;
  /** Must atomically return false when the approval was already consumed. */
  consumeApproval(id: string, consumedAt: string): Promise<boolean>;
  saveBackup(backup: WriterBackup): Promise<void>;
  getBackupForProposal(proposalId: string): Promise<WriterBackup | undefined>;
  pruneBackups(expiredBefore: string): Promise<void>;
  getReceipt(operation: WriterReceipt['operation'], proposalId: string): Promise<WriterReceipt | undefined>;
  putReceipt(receipt: WriterReceipt): Promise<void>;
  saveReconciliationReview?(review: ReconciliationReview): Promise<void>;
  getReconciliationReview?(id: string): Promise<ReconciliationReview | undefined>;
  insertReconciliationAcceptance?(acceptance: ReconciliationAcceptance): Promise<void>;
  getReconciliationAcceptance?(id: string): Promise<ReconciliationAcceptance | undefined>;
  finalizeReconciliation?(input: FinalizeReconciliationInput): Promise<ChangeProposal>;
}

export interface WordPressAdapter {
  getPostForEdit(postId: number): Promise<WordPressPostSnapshot>;
  /** The adapter must send an update containing only the exact body HTML. */
  updateBody(postId: number, bodyHtml: string): Promise<void>;
  checkPublicReadback(post: WordPressPostSnapshot): Promise<PublicReadback>;
}

export class UnknownWordPressWriteError extends Error {
  readonly code = 'unknown_wordpress_write';

  constructor(message = 'The WordPress write result is unknown') {
    super(message);
    this.name = 'UnknownWordPressWriteError';
  }
}
