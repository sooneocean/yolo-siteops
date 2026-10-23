import type { DatabaseSync } from 'node:sqlite';

export const HARD_AGENT_RUN_CAP = 10;

export function readAgentRunLimit(settings: unknown): number | undefined {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return undefined;
  const value = (settings as { maxAgentRunsPerDay?: unknown }).maxAgentRunsPerDay;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= HARD_AGENT_RUN_CAP
    ? value as number : undefined;
}

/** Missing means zero. Any persisted non-integer or negative value is invalid. */
export function readSkillCallCount(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

/** A crashed/running or malformed weekly job blocks every later week until human review. */
export function hasBlockingWeeklyJob(db: DatabaseSync): boolean {
  const rows = db.prepare("SELECT value FROM records WHERE kind='operator_job' AND id LIKE 'weekly-skill:%'").all() as Array<{ value: string }>;
  return rows.some(row => {
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true;
      const status = (parsed as { status?: unknown }).status;
      return status === 'running' || (status !== 'failed' && status !== 'completed');
    } catch { return true; }
  });
}
