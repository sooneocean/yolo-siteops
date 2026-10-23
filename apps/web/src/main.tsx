import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import type {
  AppState,
  ChangeProposal,
  Connection,
  ConnectionId,
  Experiment,
  Opportunity,
  ReconciliationReview,
  SkillVersion,
  Task,
  TaskEvent,
} from '../../../packages/contracts';
import './styles.css';

type TabId = 'today' | 'radar' | 'review' | 'impact';
type Session = { csrf: string };
type ApiErrorShape = { error?: { message?: string }; message?: string };

const tabItems: Array<{ id: TabId; label: string; short: string; icon: string }> = [
  { id: 'today', label: '今日營運', short: '營運', icon: '◒' },
  { id: 'radar', label: '需求雷達', short: '雷達', icon: '⌁' },
  { id: 'review', label: '文章審閱', short: '審閱', icon: '▣' },
  { id: 'impact', label: '成效與 Skill', short: '成效', icon: '✦' },
];

const connectionLabels: Record<ConnectionId, string> = {
  wordpress: 'WordPress',
  gsc: 'Search Console',
  ga4: 'GA4',
  codex: 'Codex',
};

const connectionDescriptions: Record<ConnectionId, string> = {
  wordpress: '內容與修訂寫入',
  gsc: '搜尋查詢證據',
  ga4: '使用情境證據',
  codex: '代理技能執行',
};

const statusLabels: Record<string, string> = {
  ready: '可用',
  unconfigured: '未設定',
  error: '異常',
  checking: '檢查中',
  queued: '排隊中',
  running: '執行中',
  waiting_approval: '等待核准',
  completed: '已完成',
  failed: '失敗',
  cancelled: '已取消',
  review_required: '需要複核',
  verified_transformed: '已驗證格式轉換',
  pending: '待審閱',
  approved: '已核准',
  applied: '已套用',
  rejected: '已拒絕',
  rolled_back: '已回滾',
  observing: '觀測中',
  insufficient: '資料不足',
  confounded: '受干擾',
  measured: '已量測',
  candidate: '候選',
  evaluated: '已評估',
  active: '使用中',
  retired: '已退役',
};

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as ApiErrorShape;
    if (value.error?.message) return value.error.message;
    if (value.message) return value.message;
  }
  return error instanceof Error ? error.message : '操作失敗，請稍後再試。';
}

function extractApprovalId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { approvalId?: unknown; receipt?: { approvalId?: unknown } };
  if (typeof record.approvalId === 'string' && record.approvalId) return record.approvalId;
  if (typeof record.receipt?.approvalId === 'string' && record.receipt.approvalId) return record.receipt.approvalId;
  return undefined;
}

class RequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}, csrf?: string): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (csrf && options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrf);

  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    headers,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload: unknown = contentType.includes('application/json')
    ? await response.json().catch(() => undefined)
    : await response.text().catch(() => undefined);

  if (!response.ok) {
    throw new RequestError(errorMessage(payload), response.status);
  }
  return payload as T;
}

function statusTone(status: string): string {
  if (['ready', 'completed', 'approved', 'applied', 'verified_transformed', 'active', 'measured'].includes(status)) return 'success';
  if (['error', 'failed', 'rejected', 'review_required', 'confounded'].includes(status)) return 'danger';
  if (['checking', 'running', 'waiting_approval', 'observing', 'evaluated'].includes(status)) return 'info';
  return 'neutral';
}

function StatusPill({ status, label }: { status: string; label?: string }) {
  return <span className={`status-pill status-pill--${statusTone(status)}`}><i />{label ?? statusLabels[status] ?? status}</span>;
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatNumber(value?: number): string {
  return typeof value === 'number' ? new Intl.NumberFormat('zh-TW').format(value) : '—';
}

function formatPercent(value?: number): string {
  return typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—';
}

function getBootstrapValue(): string {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return '';
  const params = new URLSearchParams(hash);
  return params.get('token') ?? params.get('bootstrap') ?? hash;
}

function clearBootstrapHash() {
  if (window.location.hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

function App() {
  const [tab, setTab] = useState<TabId>('today');
  const [csrf, setCsrf] = useState<string>();
  const csrfRef = useRef<string | undefined>(undefined);
  const [state, setState] = useState<AppState>();
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const busyRef = useRef(new Set<string>());
  const hashAttempted = useRef(false);
  const [approvalIds, setApprovalIds] = useState<Record<string, string>>({});
  const approvalIdsRef = useRef<Record<string, string>>({});
  const [rollbackApprovalIds, setRollbackApprovalIds] = useState<Record<string, string>>({});
  const rollbackApprovalIdsRef = useRef<Record<string, string>>({});
  const [reconciliationReviews, setReconciliationReviews] = useState<Record<string, ReconciliationReview>>({});
  const [reconciliationAcceptanceIds, setReconciliationAcceptanceIds] = useState<Record<string, string>>({});
  const [taskEvents, setTaskEvents] = useState<Record<string, TaskEvent[]>>({});

  const reloadState = useCallback(async (sessionCsrf?: string) => {
    const token = sessionCsrf ?? csrfRef.current;
    if (!token) return;
    const next = await request<AppState>('/api/state', undefined, token);
    setState(next);
  }, []);

  const signIn = useCallback(async (bootstrap: string) => {
    if (!bootstrap.trim()) {
      setError('請輸入一次性碼。');
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      const session = await request<Session>('/api/session', {
        method: 'POST',
        body: JSON.stringify({ bootstrap: bootstrap.trim() }),
      });
      csrfRef.current = session.csrf;
      setCsrf(session.csrf);
      setAuthRequired(false);
      setAuthCode('');
      clearBootstrapHash();
      await reloadState(session.csrf);
    } catch (nextError) {
      setError(errorMessage(nextError));
      setAuthRequired(true);
    } finally {
      setLoading(false);
    }
  }, [reloadState]);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      setLoading(true);
      try {
        const session = await request<Session>('/api/session');
        if (cancelled) return;
        csrfRef.current = session.csrf;
        setCsrf(session.csrf);
        await reloadState(session.csrf);
      } catch (nextError) {
        if (cancelled) return;
        if (nextError instanceof RequestError && nextError.status === 401) {
          setAuthRequired(true);
          const bootstrap = getBootstrapValue();
          if (bootstrap && !hashAttempted.current) {
            hashAttempted.current = true;
            await signIn(bootstrap);
            return;
          }
        } else {
          setError(errorMessage(nextError));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void start();
    return () => { cancelled = true; };
  }, [reloadState, signIn]);

  useEffect(() => {
    if (!state) return;
    const activeTasks = state.tasks.filter((task) => ['queued', 'running', 'waiting_approval'].includes(task.status));
    const sources: EventSource[] = [];
    for (const task of activeTasks) {
      const source = new EventSource(`/api/tasks/${task.id}/events`, { withCredentials: true });
      source.onmessage = (event) => {
        try {
          const incoming = JSON.parse(event.data) as TaskEvent;
          setTaskEvents((current) => {
            const events = [...(current[task.id] ?? [])];
            if (!events.some((item) => item.sequence === incoming.sequence)) events.push(incoming);
            events.sort((left, right) => left.sequence - right.sequence);
            return { ...current, [task.id]: events.slice(-20) };
          });
        } catch {
          // Ignore malformed SSE data; the API state remains the source of truth.
        }
      };
      sources.push(source);
    }
    return () => sources.forEach((source) => source.close());
  }, [state]);

  const perform = useCallback(async (key: string, action: () => Promise<void>, successMessage?: string) => {
    if (busyRef.current.has(key)) return;
    busyRef.current.add(key);
    setBusy((current) => ({ ...current, [key]: true }));
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      if (successMessage) setNotice(successMessage);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      busyRef.current.delete(key);
      setBusy((current) => ({ ...current, [key]: false }));
    }
  }, []);

  const checkConnections = () => perform('connections-check', async () => {
    await request('/api/connections/check', { method: 'POST', body: JSON.stringify({}) }, csrf);
    await reloadState();
  }, '連線檢查已完成，狀態已更新。');

  const sync = () => perform('sync', async () => {
    await request('/api/sync', { method: 'POST', body: JSON.stringify({}) }, csrf);
    await reloadState();
  }, '同步請求已送出，請查看工作時間線。');

  const createTask = (opportunity: Opportunity) => perform(`task-${opportunity.id}`, async () => {
    await request<Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ postId: opportunity.postId }),
    }, csrf);
    await reloadState();
    setTab('today');
  }, '審閱任務已建立。');

  const cancelTask = (task: Task) => perform(`cancel-${task.id}`, async () => {
    await request(`/api/tasks/${task.id}/cancel`, { method: 'POST', body: JSON.stringify({}) }, csrf);
    await reloadState();
  }, '任務取消請求已送出。');

  const proposalAction = (proposal: ChangeProposal, action: 'approve' | 'apply' | 'reject' | 'rollback-approve' | 'rollback' | 'reconcile-prepare' | 'reconcile-accept' | 'reconcile') => perform(`${action}-${proposal.id}`, async () => {
    const path = `/api/proposals/${proposal.id}/${action}`;
    const approvalId = approvalIdsRef.current[proposal.id];
    const rollbackApprovalId = rollbackApprovalIdsRef.current[proposal.id];
    if (action === 'apply' && !approvalId) throw new Error('此提案尚未取得新的核准憑證，請先重新核准。');
    if (action === 'rollback' && !rollbackApprovalId) throw new Error('此回滾尚未取得新的核准憑證，請先核准回滾。');
    const review = reconciliationReviews[proposal.id];
    const reconciliationAcceptanceId = reconciliationAcceptanceIds[proposal.id];
    if (action === 'reconcile-accept' && !review) throw new Error('請先檢查實際 WordPress 格式差異。');
    if (action === 'reconcile' && !reconciliationAcceptanceId) throw new Error('請先明確接受已檢查的格式轉換。');
    const body = action === 'approve' || action === 'rollback-approve'
      ? { patchHash: proposal.patchHash }
      : action === 'apply'
        ? { approvalId }
        : action === 'rollback'
          ? { approvalId: rollbackApprovalId }
        : action === 'reconcile-accept'
          ? { reviewId: review?.id, reviewedActualHash: review?.reviewedActualHash }
          : action === 'reconcile'
            ? { acceptanceId: reconciliationAcceptanceId }
            : {};
    const receipt = await request<unknown>(path, { method: 'POST', body: JSON.stringify(body) }, csrf);
    if (action === 'reconcile-prepare') {
      setReconciliationReviews((current) => ({ ...current, [proposal.id]: receipt as ReconciliationReview }));
    }
    if (action === 'reconcile-accept') {
      const acceptanceId = receipt && typeof receipt === 'object' && typeof (receipt as { acceptanceId?: unknown }).acceptanceId === 'string'
        ? (receipt as { acceptanceId: string }).acceptanceId : undefined;
      if (!acceptanceId) throw new Error('伺服器未提供格式轉換接受憑證。');
      setReconciliationAcceptanceIds((current) => ({ ...current, [proposal.id]: acceptanceId }));
    }
    if (action === 'approve' || action === 'rollback-approve') {
      const nextApprovalId = extractApprovalId(receipt);
      if (!nextApprovalId) throw new Error('伺服器未提供核准憑證，無法安全繼續。');
      if (action === 'approve') {
        approvalIdsRef.current = { ...approvalIdsRef.current, [proposal.id]: nextApprovalId };
        setApprovalIds(approvalIdsRef.current);
      } else {
        rollbackApprovalIdsRef.current = { ...rollbackApprovalIdsRef.current, [proposal.id]: nextApprovalId };
        setRollbackApprovalIds(rollbackApprovalIdsRef.current);
      }
    }
    await reloadState();
  }, action === 'apply' ? '變更已套用，狀態已更新。' : action === 'rollback' ? '回滾已完成，狀態已更新。' : action === 'reconcile' ? '格式轉換已接受，未再次寫入 WordPress。' : '審閱狀態已更新。');

  const proposeSkill = () => perform('skill-propose', async () => {
    await request('/api/skills/propose', { method: 'POST', body: JSON.stringify({}) }, csrf);
    await reloadState();
  }, 'Skill 候選已建立。');

  const evaluateSkill = (skill: SkillVersion) => perform(`skill-evaluate-${skill.id}`, async () => {
    await request(`/api/skills/${skill.id}/evaluate`, { method: 'POST', body: JSON.stringify({}) }, csrf);
    await reloadState();
  }, 'Skill 評估已完成，狀態已更新。');

  const activateSkill = (skill: SkillVersion) => perform(`skill-activate-${skill.id}`, async () => {
    await request(`/api/skills/${skill.id}/activate`, { method: 'POST', body: JSON.stringify({}) }, csrf);
    await reloadState();
  }, 'Skill 啟用請求已送出。');

  const toggleSchedule = () => {
    if (!state) return;
    const scheduleEnabled = !state.settings.scheduleEnabled;
    return perform('schedule-toggle', async () => {
      await request('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify({ scheduleEnabled }),
      }, csrf);
      await reloadState();
    }, scheduleEnabled ? '排程已開啟。' : '排程已關閉。');
  };

  if (loading && !state && !authRequired) return <LoadingScreen />;
  if (authRequired && !state) return <AuthScreen value={authCode} onChange={setAuthCode} onSubmit={() => void signIn(authCode)} loading={loading} error={error} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">Y</div>
          <div>
            <div className="brand-name">YOLO LAB</div>
            <div className="brand-product">SITEOPS <span>LOCAL</span></div>
          </div>
        </div>
        <div className="sidebar-site">
          <span className="eyebrow">目前網站</span>
          <strong>{state?.siteUrl ?? '等待網站狀態'}</strong>
          <span className="connection-dot"><i /> 單一網站工作台</span>
        </div>
        <nav className="main-nav" aria-label="主要導覽">
          {tabItems.map((item) => (
            <button key={item.id} className={`nav-item ${tab === item.id ? 'is-active' : ''}`} onClick={() => setTab(item.id)}>
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === 'review' && (state?.proposals.length ?? 0) > 0 && <em>{state?.proposals.filter((proposal) => ['pending', 'approved', 'review_required'].includes(proposal.status)).length}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-note"><span className="lock-icon">⌑</span><span>憑證由伺服器端設定<br /><small>工作台不會儲存秘密</small></span></div>
          <div className="sidebar-footer">{state?.mode === 'demo' ? '演示資料' : '本機連線'}</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand"><div className="brand-mark">Y</div><span>SITEOPS</span></div>
          <div className="topbar-meta"><span className="mode-badge"><i />{state?.mode === 'demo' ? 'DEMO · 僅供演示' : 'LIVE · 本機工作階段'}</span><span className="topbar-time">資料狀態由伺服器回報</span></div>
        </header>
        {state?.mode === 'demo' && <div className="demo-banner"><span className="demo-spark">✦</span><span><strong>演示模式</strong> 目前內容來自本機合成資料；不代表網站流量、排名或收益成長。</span></div>}
        {error && <div className="alert alert--error" role="alert"><span>!</span><div><strong>操作未完成</strong><p>{error}</p></div><button onClick={() => setError(undefined)} aria-label="關閉錯誤">×</button></div>}
        {notice && <div className="alert alert--success" role="status"><span>✓</span><p>{notice}</p><button onClick={() => setNotice(undefined)} aria-label="關閉通知">×</button></div>}

        <div className="content-wrap">
          {tab === 'today' && state && <TodayView state={state} events={taskEvents} busy={busy} onCheck={checkConnections} onSync={sync} onCancel={cancelTask} />}
          {tab === 'radar' && state && <RadarView state={state} busy={busy} onCreateTask={createTask} />}
          {tab === 'review' && state && <ReviewView state={state} busy={busy} approvalIds={approvalIds} rollbackApprovalIds={rollbackApprovalIds} reconciliationReviews={reconciliationReviews} reconciliationAcceptanceIds={reconciliationAcceptanceIds} onAction={proposalAction} />}
          {tab === 'impact' && state && <ImpactView state={state} busy={busy} onProposeSkill={proposeSkill} onEvaluateSkill={evaluateSkill} onActivateSkill={activateSkill} onToggleSchedule={toggleSchedule} />}
        </div>
      </main>
    </div>
  );
}

function LoadingScreen() {
  return <div className="loading-screen"><div className="loading-orbit"><span /></div><p>正在連接本機 SiteOps…</p><small>讀取 session 與網站狀態</small></div>;
}

function AuthScreen({ value, onChange, onSubmit, loading, error }: { value: string; onChange: (value: string) => void; onSubmit: () => void; loading: boolean; error?: string }) {
  return <div className="auth-screen">
    <div className="auth-card">
      <div className="brand-lockup"><div className="brand-mark">Y</div><div><div className="brand-name">YOLO LAB</div><div className="brand-product">SITEOPS <span>LOCAL</span></div></div></div>
      <div className="auth-kicker">LOCAL WORDPRESS WORKBENCH</div>
      <h1>連接你的網站工作台</h1>
      <p className="auth-copy">輸入伺服器提供的一次性碼，建立這次本機工作階段。一次性碼只會送到 SiteOps 伺服器，不會寫入瀏覽器儲存。</p>
      <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <label htmlFor="bootstrap-code">一次性碼</label>
        <input id="bootstrap-code" value={value} onChange={(event) => onChange(event.target.value)} placeholder="貼上一次性碼" autoComplete="off" autoFocus />
        <button className="button button--primary button--wide" type="submit" disabled={loading || !value.trim()}>{loading ? '連接中…' : '建立工作階段'}</button>
      </form>
      {error && <div className="auth-error">{error}</div>}
      <div className="auth-footnote"><span>⌑</span> 正式站憑證與健康狀態請由伺服器端設定。</div>
    </div>
  </div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="page-header-action">{action}</div>}</div>;
}

function ConnectionCard({ connection }: { connection: Connection }) {
  return <div className="connection-card">
    <div className="connection-heading"><span className={`service-icon service-icon--${connection.id}`}>{connection.id === 'wordpress' ? 'W' : connection.id === 'gsc' ? 'G' : connection.id === 'ga4' ? 'A' : 'C'}</span><div><strong>{connectionLabels[connection.id]}</strong><small>{connectionDescriptions[connection.id]}</small></div><StatusPill status={connection.status} /></div>
    <p className={connection.status === 'error' ? 'text-danger' : ''}>{connection.message}</p>
    <div className="connection-meta"><span>最後檢查</span><strong>{formatDate(connection.checkedAt)}</strong></div>
  </div>;
}

function TodayView({ state, events, busy, onCheck, onSync, onCancel }: { state: AppState; events: Record<string, TaskEvent[]>; busy: Record<string, boolean>; onCheck: () => void; onSync: () => void; onCancel: (task: Task) => void }) {
  const readyCount = state.connections.filter((connection) => connection.status === 'ready').length;
  const activeTasks = state.tasks.filter((task) => ['queued', 'running', 'waiting_approval'].includes(task.status));
  return <>
    <PageHeader eyebrow="WORKSPACE / TODAY" title="今日營運" description="從連線健康、證據同步到人工審閱，掌握這個工作階段真正發生的事。" action={<div className="header-actions"><button className="button button--quiet" onClick={onCheck} disabled={busy['connections-check']}><span className="button-icon">◌</span>{busy['connections-check'] ? '檢查中…' : '檢查連線'}</button><button className="button button--primary" onClick={onSync} disabled={busy.sync}><span className="button-icon">↻</span>{busy.sync ? '同步中…' : '同步資料'}</button></div>} />
    <div className="metric-row">
      <MetricCard label="連線健康" value={`${readyCount}/${state.connections.length}`} note={readyCount === state.connections.length && state.connections.length > 0 ? '所有連線可用' : '需要查看設定'} tone={readyCount === state.connections.length && state.connections.length > 0 ? 'success' : 'neutral'} icon="◉" />
      <MetricCard label="待處理任務" value={formatNumber(activeTasks.length)} note="以伺服器回報為準" tone={activeTasks.length ? 'info' : 'neutral'} icon="◷" />
      <MetricCard label="待處理文章" value={formatNumber(state.proposals.filter((proposal) => ['pending', 'approved', 'review_required'].includes(proposal.status)).length)} note="需要人工作業" tone={state.proposals.some((proposal) => ['pending', 'approved', 'review_required'].includes(proposal.status)) ? 'warning' : 'neutral'} icon="▣" />
      <MetricCard label="目前模式" value={state.mode === 'demo' ? 'DEMO' : 'LIVE'} note={state.mode === 'demo' ? '僅供演示' : '本機工作階段'} tone={state.mode === 'demo' ? 'warning' : 'success'} icon="✦" />
    </div>
    <section className="section-block"><div className="section-heading"><div><span className="section-number">01</span><h2>連線與證據</h2></div><span className="section-caption">只顯示伺服器回報狀態</span></div><div className="connections-grid">{state.connections.length ? state.connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} />) : <EmptyState title="尚無連線狀態" body="等待伺服器回報網站連線資訊。" />}</div></section>
    <section className="section-block"><div className="section-heading"><div><span className="section-number">02</span><h2>工作時間線</h2></div><span className="section-caption">即時進度 · {activeTasks.length} 個活動任務</span></div><TaskTimeline tasks={state.tasks} events={events} onCancel={onCancel} busy={busy} /></section>
    <section className="evidence-strip"><div className="evidence-icon">◎</div><div><strong>證據邊界</strong><p>SiteOps 只會根據伺服器回傳的資料快照、查詢與分析資料建立建議；沒有證據的欄位會標示為未知，不會補寫成績效結論。</p></div><span className="evidence-tag">{state.snapshot ? `${state.snapshot.evidence.length} 個證據` : '尚未同步'}</span></section>
  </>;
}

function MetricCard({ label, value, note, tone, icon }: { label: string; value: string; note: string; tone: string; icon: string }) {
  return <div className={`metric-card metric-card--${tone}`}><div className="metric-icon">{icon}</div><div className="metric-label">{label}</div><strong>{value}</strong><span>{note}</span></div>;
}

function TaskTimeline({ tasks, events, onCancel, busy }: { tasks: Task[]; events: Record<string, TaskEvent[]>; onCancel: (task: Task) => void; busy: Record<string, boolean> }) {
  const ordered = [...tasks].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  if (!ordered.length) return <EmptyState title="還沒有任務事件" body="在需求雷達建立審閱任務後，即時進度會顯示在這裡。" />;
  return <div className="timeline">{ordered.map((task) => <div className="timeline-item" key={task.id}><div className={`timeline-node timeline-node--${statusTone(task.status)}`}><span /></div><div className="timeline-content"><div className="timeline-top"><div><strong>{task.title}</strong><span className="timeline-id">#{task.id.slice(0, 8)}</span></div><StatusPill status={task.status} /></div><p className="timeline-stage">{task.stage}</p><div className="timeline-meta"><span>更新於 {formatDate(task.updatedAt)}</span><span>Skill {task.skillVersion}</span><span>資料快照 {task.snapshotId.slice(0, 10)}</span>{['queued', 'running', 'waiting_approval'].includes(task.status) && <button className="text-button text-button--danger" onClick={() => onCancel(task)} disabled={busy[`cancel-${task.id}`]}>{busy[`cancel-${task.id}`] ? '取消中…' : '取消任務'}</button>}</div>{events[task.id]?.length ? <div className="event-list">{events[task.id].map((event) => <div className="event-row" key={`${task.id}-${event.sequence}`}><span>{formatDate(event.at)}</span><strong>{event.message}</strong></div>)}</div> : <div className="event-pending">等待即時進度…</div>}</div></div>)}</div>;
}

function RadarView({ state, busy, onCreateTask }: { state: AppState; busy: Record<string, boolean>; onCreateTask: (opportunity: Opportunity) => void }) {
  return <>
    <PageHeader eyebrow="WORKSPACE / OPPORTUNITIES" title="需求雷達" description="把搜尋與使用情境訊號整理成可審閱的機會；每個假設都保留它的證據邊界。" action={<div className="radar-legend"><span className="legend-dot legend-dot--real" />真實證據<span className="legend-dot legend-dot--hypothesis" />待驗證假設</div>} />
    <div className="radar-summary"><div><strong>{state.opportunities.length}</strong><span>伺服器回報機會</span></div><div><strong>{state.opportunities.filter((item) => item.quality === 'available').length}</strong><span>具備證據</span></div><div><strong>{state.opportunities.filter((item) => item.quality === 'unknown').length}</strong><span>資料不足</span></div><div className="radar-summary-note">機會排序與數字來自最近一次資料快照。點擊任務後，文章變更仍需人工審閱。</div></div>
    <div className="opportunity-list">{state.opportunities.length ? state.opportunities.map((opportunity, index) => <OpportunityCard key={opportunity.id} opportunity={opportunity} index={index} busy={busy[`task-${opportunity.id}`]} onCreate={() => onCreateTask(opportunity)} />) : <EmptyState title="尚無需求機會" body="等待同步取得可用的搜尋或分析證據。" />}</div>
  </>;
}

function OpportunityCard({ opportunity, index, busy, onCreate }: { opportunity: Opportunity; index: number; busy?: boolean; onCreate: () => void }) {
  const hasEvidence = opportunity.quality === 'available' && opportunity.evidenceIds.length > 0;
  return <article className="opportunity-card"><div className="opportunity-index">0{index + 1}</div><div className="opportunity-main"><div className="opportunity-heading"><div><div className="opportunity-type"><span className={`signal-dot signal-dot--${hasEvidence ? 'real' : 'hypothesis'}`} />{opportunity.kind === 'decay' ? '內容衰退訊號' : '位置機會'}<span className="post-id">POST {opportunity.postId}</span></div><h2>{opportunity.title}</h2><a href={opportunity.url} target="_blank" rel="noreferrer">{opportunity.url} ↗</a></div><StatusPill status={hasEvidence ? 'ready' : 'unconfigured'} label={hasEvidence ? '有證據' : '待補證據'} /></div><div className="opportunity-stats"><div><span>目前點擊</span><strong>{formatNumber(opportunity.clicks)}</strong></div><div><span>前期點擊</span><strong>{formatNumber(opportunity.previousClicks)}</strong></div><div><span>曝光</span><strong>{formatNumber(opportunity.impressions)}</strong></div><div><span>位置</span><strong>{typeof opportunity.position === 'number' ? opportunity.position.toFixed(1) : '—'}</strong></div>{opportunity.engagementRate !== undefined && <div><span>互動率</span><strong>{formatPercent(opportunity.engagementRate)}</strong></div>}</div><p className="opportunity-reason">{opportunity.reason}</p><div className="hypothesis-grid"><div><span className="hypothesis-label"><i />讀者假設</span><p>{opportunity.audienceHypothesis}</p></div><div><span className="hypothesis-label"><i />關鍵字假設</span><p>{opportunity.keywordHypotheses.length ? opportunity.keywordHypotheses.join(' · ') : '尚未提供'}</p></div></div><div className="opportunity-footer"><div className="evidence-chips">{opportunity.evidenceIds.length ? opportunity.evidenceIds.map((id) => <span key={id}>證據：{id}</span>) : <span className="evidence-empty">沒有證據編號</span>}</div><button className="button button--outline" onClick={onCreate} disabled={busy}>{busy ? '建立中…' : '建立審閱任務'} <span>→</span></button></div></div></article>;
}

type ProposalAction = 'approve' | 'apply' | 'reject' | 'rollback-approve' | 'rollback' | 'reconcile-prepare' | 'reconcile-accept' | 'reconcile';

function ReviewView({ state, busy, approvalIds, rollbackApprovalIds, reconciliationReviews, reconciliationAcceptanceIds, onAction }: { state: AppState; busy: Record<string, boolean>; approvalIds: Record<string, string>; rollbackApprovalIds: Record<string, string>; reconciliationReviews: Record<string, ReconciliationReview>; reconciliationAcceptanceIds: Record<string, string>; onAction: (proposal: ChangeProposal, action: ProposalAction) => void }) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = state.proposals.find((proposal) => proposal.id === selectedId) ?? state.proposals[0];
  useEffect(() => { if (selectedId && !state.proposals.some((proposal) => proposal.id === selectedId)) setSelectedId(undefined); }, [selectedId, state.proposals]);
  return <>
    <PageHeader eyebrow="WORKSPACE / HUMAN REVIEW" title="文章審閱" description="先看差異、證據與隔離預覽，再決定是否核准或套用。所有變更都保留可回滾邊界。" action={<div className="review-count"><span>待處理</span><strong>{state.proposals.filter((proposal) => ['pending', 'approved', 'review_required'].includes(proposal.status)).length}</strong></div>} />
    <div className="review-layout"><aside className="proposal-list"><div className="list-heading"><span>變更提案</span><span>{state.proposals.length}</span></div>{state.proposals.length ? state.proposals.map((proposal) => <button className={`proposal-row ${selected?.id === proposal.id ? 'is-selected' : ''}`} key={proposal.id} onClick={() => setSelectedId(proposal.id)}><span className="proposal-row-dot" /><span><strong>{proposal.title}</strong><small>#{proposal.postId} · {formatDate(proposal.createdAt)}</small></span><StatusPill status={proposal.status} /></button>) : <div className="proposal-empty">尚無文章提案。<br />在需求雷達建立任務後，伺服器建立的提案會出現在這裡。</div>}</aside><div className="review-detail">{selected ? <ProposalDetail proposal={selected} busy={busy} approvalId={approvalIds[selected.id]} rollbackApprovalId={rollbackApprovalIds[selected.id]} reconciliationReview={reconciliationReviews[selected.id]} reconciliationAcceptanceId={reconciliationAcceptanceIds[selected.id]} onAction={onAction} /> : <EmptyState title="選取一個提案" body="左側會顯示伺服器回報的文章變更。" />}</div></div>
  </>;
}

function ProposalDetail({ proposal, busy, approvalId, rollbackApprovalId, reconciliationReview, reconciliationAcceptanceId, onAction }: { proposal: ChangeProposal; busy: Record<string, boolean>; approvalId?: string; rollbackApprovalId?: string; reconciliationReview?: ReconciliationReview; reconciliationAcceptanceId?: string; onAction: (proposal: ChangeProposal, action: ProposalAction) => void }) {
  const [view, setView] = useState<'diff' | 'preview'>('diff');
  const canApprove = proposal.status === 'pending';
  const canApply = proposal.status === 'approved' && Boolean(approvalId);
  const needsReapproval = proposal.status === 'approved' && !approvalId;
  const canReject = proposal.status === 'pending' || proposal.status === 'approved';
  const canRollback = (proposal.status === 'applied' || proposal.status === 'verified_transformed') && Boolean(rollbackApprovalId);
  const canApproveRollback = proposal.status === 'applied' || proposal.status === 'verified_transformed';
  return <div className="proposal-detail"><div className="proposal-detail-head"><div><div className="opportunity-type"><span className="signal-dot signal-dot--real" />文章變更提案 <span className="post-id">POST {proposal.postId}</span></div><h2>{proposal.title}</h2><a href={proposal.url} target="_blank" rel="noreferrer">開啟原文 ↗</a></div><StatusPill status={proposal.status} /></div><div className="proposal-summary"><strong>變更摘要</strong><p>{proposal.summary}</p><div className="proposal-evidence">{proposal.evidenceIds.map((id) => <span key={id}>證據：{id}</span>)}</div></div><div className="review-tabs"><button className={view === 'diff' ? 'is-active' : ''} onClick={() => setView('diff')}>文字差異</button><button className={view === 'preview' ? 'is-active' : ''} onClick={() => setView('preview')}>隔離預覽</button><span className="hash-label">變更指紋 {proposal.patchHash.slice(0, 12)}…</span></div>{view === 'diff' ? <DiffView before={proposal.beforeHtml} after={proposal.afterHtml} /> : <PreviewView before={proposal.beforeHtml} after={proposal.afterHtml} />}{proposal.error && <div className="proposal-error">原始複核原因：{proposal.error}</div>}{reconciliationReview && <><div className="proposal-summary"><strong>WordPress 實際格式差異</strong><p>已確認實際內容僅移除段落標記；接受後不會再次寫入 WordPress。請核對下方精確差異與實際內容指紋 {reconciliationReview.reviewedActualHash.slice(0, 12)}…</p></div><ExactHtmlDiff approved={proposal.afterHtml} actual={reconciliationReview.actualBodyHtml} /></>}<div className="proposal-actions">{(canApprove || needsReapproval) && <button className="button button--primary" onClick={() => onAction(proposal, 'approve')} disabled={busy[`approve-${proposal.id}`]}>{busy[`approve-${proposal.id}`] ? '核准中…' : needsReapproval ? '重新核准' : '核准變更'}</button>}{canApply && <button className="button button--primary" onClick={() => onAction(proposal, 'apply')} disabled={busy[`apply-${proposal.id}`]}>{busy[`apply-${proposal.id}`] ? '套用中…' : '套用至 WordPress'}</button>}{canReject && <button className="button button--quiet-danger" onClick={() => onAction(proposal, 'reject')} disabled={busy[`reject-${proposal.id}`]}>{busy[`reject-${proposal.id}`] ? '拒絕中…' : '拒絕'}</button>}{proposal.status === 'review_required' && !reconciliationReview && <button className="button button--outline" onClick={() => onAction(proposal, 'reconcile-prepare')}>檢查格式轉換</button>}{proposal.status === 'review_required' && reconciliationReview && !reconciliationAcceptanceId && <button className="button button--primary" onClick={() => onAction(proposal, 'reconcile-accept')}>明確接受格式轉換</button>}{proposal.status === 'review_required' && reconciliationAcceptanceId && <button className="button button--primary" onClick={() => onAction(proposal, 'reconcile')}>完成無寫入核對</button>}{canApproveRollback && <button className="button button--outline-danger" onClick={() => onAction(proposal, 'rollback-approve')} disabled={busy[`rollback-approve-${proposal.id}`]}>{busy[`rollback-approve-${proposal.id}`] ? '核准中…' : '核准回滾'}</button>}{canRollback && <button className="button button--outline-danger" onClick={() => onAction(proposal, 'rollback')} disabled={busy[`rollback-${proposal.id}`]}>{busy[`rollback-${proposal.id}`] ? '回滾中…' : '執行回滾'}</button>}<span className="action-boundary">需要人工作業 · {reconciliationAcceptanceId ? '格式接受已記錄' : approvalId ? `核准憑證 ${approvalId.slice(0, 10)}…` : rollbackApprovalId ? `回滾憑證 ${rollbackApprovalId.slice(0, 10)}…` : '尚無核准憑證'}</span></div></div>;
}

function ExactHtmlDiff({ approved, actual }: { approved: string; actual: string }) {
  return <div className="diff-view"><div className="diff-column diff-column--before"><div className="diff-column-head"><span>APPROVED HTML</span><small>原核准內容</small></div><pre>{approved}</pre></div><div className="diff-column diff-column--after"><div className="diff-column-head"><span>ACTUAL HTML</span><small>WordPress 實際內容</small></div><pre>{actual}</pre></div></div>;
}

function DiffView({ before, after }: { before: string; after: string }) {
  const beforeLines = toPlainText(before).split('\n').filter((line) => line.trim());
  const afterLines = toPlainText(after).split('\n').filter((line) => line.trim());
  const rows = Math.max(beforeLines.length, afterLines.length);
  return <div className="diff-view"><div className="diff-column diff-column--before"><div className="diff-column-head"><span>BEFORE</span><small>目前內容</small></div>{Array.from({ length: rows }, (_, index) => <div className={`diff-line ${beforeLines[index] && beforeLines[index] !== afterLines[index] ? 'is-removed' : ''}`} key={`before-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><p>{beforeLines[index] ?? ''}</p></div>)}</div><div className="diff-column diff-column--after"><div className="diff-column-head"><span>AFTER</span><small>提案內容</small></div>{Array.from({ length: rows }, (_, index) => <div className={`diff-line ${afterLines[index] && beforeLines[index] !== afterLines[index] ? 'is-added' : ''}`} key={`after-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><p>{afterLines[index] ?? ''}</p></div>)}</div></div>;
}

function toPlainText(html: string): string {
  if (!html) return '';
  const documentFragment = new DOMParser().parseFromString(html, 'text/html');
  return (documentFragment.body.textContent ?? '').replace(/\r\n/g, '\n').replace(/[\t ]+/g, ' ').trim();
}

function safePreviewDocument(html: string): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<link[\s\S]*?>/gi, '')
    .replace(/<base[\s\S]*?>/gi, '')
    .replace(/<(iframe|frame|frameset|object|embed|form|input|button|textarea|select|video|audio|source|track)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|frame|frameset|object|embed|form|input|button|textarea|select|video|audio|source|track)[^>]*\/?>/gi, '')
    .replace(/\s(on[a-z]+|style)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(src)\s*=\s*(?!"?data:)("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; navigate-to 'none'"><style>*,*::before,*::after{box-sizing:border-box}body{margin:0;padding:28px;color:#263632;background:#fffdf8;font:16px/1.8 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif}img{max-width:100%;height:auto}a{color:#176d69;text-decoration:underline}h1,h2,h3{line-height:1.3;color:#193f3b}</style></head><body>${cleaned}</body></html>`;
}

function PreviewView({ before, after }: { before: string; after: string }) {
  return <div className="preview-grid"><div className="preview-pane"><div className="preview-pane-head"><span>目前內容</span><small>BEFORE</small></div><iframe title="目前內容預覽" sandbox="" srcDoc={safePreviewDocument(before)} /></div><div className="preview-pane preview-pane--after"><div className="preview-pane-head"><span>提案內容</span><small>AFTER</small></div><iframe title="提案內容預覽" sandbox="" srcDoc={safePreviewDocument(after)} /></div></div>;
}

function ImpactView({ state, busy, onProposeSkill, onEvaluateSkill, onActivateSkill, onToggleSchedule }: { state: AppState; busy: Record<string, boolean>; onProposeSkill: () => void; onEvaluateSkill: (skill: SkillVersion) => void; onActivateSkill: (skill: SkillVersion) => void; onToggleSchedule: () => void }) {
  return <>
    <PageHeader eyebrow="WORKSPACE / MEASUREMENT" title="成效與 Skill" description="保留實驗的觀測邊界，讓技能候選先評估再啟用；排程設定只反映伺服器回傳的狀態。" action={<button className="button button--primary" onClick={onProposeSkill} disabled={busy['skill-propose']}><span className="button-icon">✦</span>{busy['skill-propose'] ? '建立中…' : '提出 Skill 候選'}</button>} />
    <section className="section-block"><div className="section-heading"><div><span className="section-number">01</span><h2>實驗觀測</h2></div><span className="section-caption">只報告已存在的量測資料</span></div><div className="experiment-grid">{state.experiments.length ? state.experiments.map((experiment) => <ExperimentCard key={experiment.id} experiment={experiment} />) : <EmptyState title="尚無實驗紀錄" body="套用文章變更後，伺服器回報的觀測結果會顯示在這裡。" />}</div></section>
    <section className="section-block"><div className="section-heading"><div><span className="section-number">02</span><h2>Skill 版本</h2></div><span className="section-caption">候選 → 評估 → 啟用</span></div><div className="skill-list">{state.skills.length ? state.skills.map((skill) => <SkillCard key={skill.id} skill={skill} busy={busy} onEvaluate={() => onEvaluateSkill(skill)} onActivate={() => onActivateSkill(skill)} />) : <EmptyState title="尚無 Skill 版本" body="由伺服器提出候選後，才能在這裡進行評估。" />}</div></section>
    <section className="section-block"><div className="section-heading"><div><span className="section-number">03</span><h2>排程與正式站設定</h2></div><span className="section-caption">伺服器設定</span></div><div className="settings-grid"><div className="schedule-card"><div className="setting-card-head"><div><strong>自動排程</strong><p>只控制伺服器是否接受每日與每週工作。</p></div><button className={`toggle ${state.settings.scheduleEnabled ? 'is-on' : ''}`} onClick={onToggleSchedule} disabled={busy['schedule-toggle']} aria-label="切換自動排程"><span /></button></div><div className="schedule-times"><div><span>每日</span><strong>{state.settings.dailyTime}</strong></div><div><span>每週</span><strong>{state.settings.weeklyTime}</strong></div><div><span>時區</span><strong>{state.settings.timezone}</strong></div></div><div className="schedule-limits"><span>每日 agent 上限 {state.settings.maxAgentRunsPerDay}</span><span>每週提案上限 {state.settings.maxWeeklyProposals}</span><span>待處理上限 {state.settings.maxPendingTasks}</span></div></div><div className="server-guidance"><div className="server-guidance-icon">⌑</div><div><strong>正式站憑證</strong><p>WordPress、Search Console、GA4 與 Codex 憑證由伺服器端環境設定管理。此頁只顯示健康狀態，不提供秘密輸入，也不會儲存在瀏覽器。</p><div className="guidance-status"><span className="legend-dot legend-dot--real" />健康狀態請回到「今日營運」檢視</div></div></div></div></section>
  </>;
}

function ExperimentCard({ experiment }: { experiment: Experiment }) {
  const currentClicks = experiment.currentClicks;
  const currentSessions = experiment.currentSessions;
  return <article className="experiment-card"><div className="experiment-head"><div><span className="mini-label">EXPERIMENT</span><strong>文章 #{experiment.postId}</strong></div><StatusPill status={experiment.status} /></div><div className="experiment-dates"><span>{experiment.startDate} 開始</span><span>·</span><span>{experiment.dueDate} 到期</span></div><div className="experiment-values"><div><span>基準點擊</span><strong>{formatNumber(experiment.baselineClicks)}</strong></div><div><span>目前點擊</span><strong>{formatNumber(currentClicks)}</strong></div><div><span>基準 sessions</span><strong>{formatNumber(experiment.baselineSessions)}</strong></div><div><span>目前 sessions</span><strong>{formatNumber(currentSessions)}</strong></div></div><p>{experiment.note}</p></article>;
}

function SkillCard({ skill, busy, onEvaluate, onActivate }: { skill: SkillVersion; busy: Record<string, boolean>; onEvaluate: () => void; onActivate: () => void }) {
  const evaluation = skill.evaluation;
  const canRestoreBaseline = skill.status === 'retired' && skill.version === 1;
  return <article className="skill-card"><div className="skill-card-head"><div className="skill-version"><span>SKILL</span><strong>v{skill.version}</strong></div><StatusPill status={skill.status} /></div><p className="skill-rationale">{skill.rationale}</p><div className="skill-content">{skill.content}</div>{evaluation && <div className={`evaluation-result ${evaluation.passed ? 'is-passed' : 'is-failed'}`}><strong>{evaluation.passed ? '評估通過' : '評估未通過'}</strong><span>{evaluation.cases} cases · {evaluation.failures.length ? `${evaluation.failures.length} failures` : '無 failures'}</span></div>}<div className="skill-actions">{skill.status === 'candidate' && <button className="button button--outline" onClick={onEvaluate} disabled={busy[`skill-evaluate-${skill.id}`]}>{busy[`skill-evaluate-${skill.id}`] ? '評估中…' : '執行評估'}</button>}{skill.status === 'evaluated' && evaluation?.passed && <button className="button button--primary" onClick={onActivate} disabled={busy[`skill-activate-${skill.id}`]}>{busy[`skill-activate-${skill.id}`] ? '啟用中…' : '啟用 Skill'}</button>}{canRestoreBaseline && <button className="button button--outline" onClick={onActivate} disabled={busy[`skill-activate-${skill.id}`]}>{busy[`skill-activate-${skill.id}`] ? '恢復中…' : '恢復基線'}</button>}<span>建立於 {formatDate(skill.createdAt)}</span></div></article>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><div className="empty-state-mark">∅</div><strong>{title}</strong><p>{body}</p></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
