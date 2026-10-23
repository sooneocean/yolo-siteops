export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProtocolError';
  }
}

export class AgentSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSecurityError';
  }
}

export type AgentOutputErrorCode =
  | 'output_schema'
  | 'skill_version_mismatch'
  | 'duplicate_evidence'
  | 'ungrounded_evidence'
  | 'html_policy'
  | 'summary_policy';

export class AgentOutputError extends AgentSecurityError {
  constructor(readonly code: AgentOutputErrorCode, message: string) {
    super(message);
    this.name = 'AgentOutputError';
  }
}

export type AgentBlockErrorCode = 'block_structure' | 'block_preservation';

export class AgentBlockError extends AgentSecurityError {
  constructor(readonly code: AgentBlockErrorCode, message: string) {
    super(message);
    this.name = 'AgentBlockError';
  }
}

export class AgentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentTimeoutError';
  }
}

export interface AgentTurnDiagnostic {
  status: string;
  codexErrorInfo: string;
  messageCategory: string;
}

export class AgentTurnError extends AgentProtocolError {
  constructor(readonly diagnostic: AgentTurnDiagnostic) {
    super(`Codex turn ended with status ${diagnostic.status} (${diagnostic.codexErrorInfo}; ${diagnostic.messageCategory})`);
    this.name = 'AgentTurnError';
  }
}

export function abortError(message = 'Agent run was cancelled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
