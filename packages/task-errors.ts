import type { TaskFailureCode } from './contracts.js';

export const taskFailureMessages: Record<TaskFailureCode, string> = {
  output_schema: '代理輸出格式不正確，未建立提案。',
  skill_version_mismatch: '代理輸出使用了不符的 Skill 版本，未建立提案。',
  duplicate_evidence: '代理輸出含重複證據，未建立提案。',
  ungrounded_evidence: '代理輸出引用未核准證據，未建立提案。',
  html_policy: '提案內容未通過 HTML 安全檢查。',
  summary_policy: '提案摘要未通過安全檢查。',
  block_structure: '文章區塊結構不符合安全要求，未建立提案。',
  block_preservation: '提案未完整保留既有文章區塊，未建立提案。',
  agent_timeout: '代理執行逾時，未建立提案。',
  agent_protocol: '代理通訊格式錯誤，未建立提案。',
  agent_security: '代理執行未通過安全檢查。',
  agent_turn: '代理執行失敗，未建立提案。',
  task_input_stale: '任務輸入已失效，請重新同步後再建立任務。',
  wordpress_state_drift: 'WordPress 內容已變更，請重新同步後再建立任務。',
  task_reservation_expired: '任務執行額度已過期，請重新建立任務。',
  internal_error: '系統處理任務時發生錯誤，未建立提案。',
};

const genericTaskFailureMessage = '任務失敗，請重新同步後再試。';

export function taskFailureMessage(code: TaskFailureCode | undefined): string {
  if (!code || !Object.hasOwn(taskFailureMessages, code)) return genericTaskFailureMessage;
  return taskFailureMessages[code];
}
