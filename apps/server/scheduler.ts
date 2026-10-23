import type { AppState, Snapshot, Task } from '../../packages/contracts.js';
import { Store } from './store.js';

interface ScheduledService { state(): AppState; sync(): Promise<Snapshot>; createTask(postId: number): Promise<Task> }
interface Run { status: 'running' | 'completed' | 'failed'; at: string }
const activeStores = new WeakSet<Store>();

function taipeiParts(now: Date): { date: string; minutes: number; weekday: number } {
  const shifted = new Date(now.getTime() + 8 * 3600000);
  return { date: shifted.toISOString().slice(0, 10), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(), weekday: shifted.getUTCDay() };
}
function clock(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('Invalid schedule time');
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Durable claims before side effects: crashes require review, never catch-up replay. */
export async function runScheduledTick({ store, service, now = new Date() }: { store: Store; service: ScheduledService; now?: Date }): Promise<void> {
  if (activeStores.has(store) || !service.state().settings.scheduleEnabled) return;
  activeStores.add(store);
  try {
    const settings = service.state().settings;
    const current = taipeiParts(now);
    const dailyDue = current.minutes >= clock(settings.dailyTime);
    const weeklyMatch = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{2}:\d{2})$/.exec(settings.weeklyTime);
    if (!weeklyMatch) throw new Error('Invalid weekly schedule');
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weeklyMatch[1]);
    let daysBack = (current.weekday - day + 7) % 7;
    if (!daysBack && current.minutes < clock(weeklyMatch[2])) daysBack = 7;
    const weekDate = new Date(Date.parse(`${current.date}T00:00:00Z`) - daysBack * 86400000).toISOString().slice(0, 10);
    const dailyDate = dailyDue ? current.date : new Date(Date.parse(`${current.date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const claim = async (key: string, action: () => Promise<void>): Promise<boolean> => {
      const acquired = store.transaction(() => {
        if (store.get<Run>('schedule', key)) return false;
        store.put<Run>('schedule', key, { status: 'running', at: now.toISOString() });
        return true;
      });
      if (!acquired) return store.get<Run>('schedule', key)?.status === 'completed';
      try { await action(); store.put<Run>('schedule', key, { status: 'completed', at: now.toISOString() }); return true; }
      catch { store.put<Run>('schedule', key, { status: 'failed', at: now.toISOString() }); return false; }
    };
    const synced = await claim(`daily:${dailyDate}`, async () => { await service.sync(); });
    if (!synced) return;
    await claim(`weekly:${weekDate}`, async () => {
      const state = service.state();
      const activePosts = new Set(state.tasks.filter(task => ['queued', 'running', 'waiting_approval', 'review_required'].includes(task.status)).map(task => task.postId));
      for (const opportunity of state.opportunities.filter(item => !activePosts.has(item.postId)).slice(0, Math.min(3, settings.maxWeeklyProposals))) await service.createTask(opportunity.postId);
    });
  } finally { activeStores.delete(store); }
}
