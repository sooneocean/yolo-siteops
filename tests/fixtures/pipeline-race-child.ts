import path from 'node:path';
import { DemoAgentAdapter } from '../../apps/server/agent/index.js';
import { DemoDataProvider, DemoWordPressAdapter } from '../../apps/server/demo-wordpress.js';
import { SiteOpsService } from '../../apps/server/service.js';
import { SkillService } from '../../apps/server/skills.js';
import { Store } from '../../apps/server/store.js';
import { WriterService } from '../../apps/server/writer/service.js';
import { SQLiteWriterStorage } from '../../apps/server/writer-store.js';
import { executeLifecycleWithAdapter, runWeeklySkill } from '../../scripts/weekly-skill.js';

// Synthetic child-process fixture only. No production configuration, network, or model.
const databasePath = process.env.SITEOPS_FIXTURE_DB;
const role = process.env.SITEOPS_FIXTURE_ROLE;
if (!databasePath || !['weekly', 'task'].includes(role ?? '')) throw new Error('fixture_configuration_required');
const fixtureDatabase = databasePath;
const now = () => new Date('2026-10-26T02:30:00Z');
const store = new Store(fixtureDatabase);
const agent = new DemoAgentAdapter();
const wordpress = new DemoWordPressAdapter(store, now);
const provider = new DemoDataProvider(wordpress, now);
const writerStorage = new SQLiteWriterStorage(store);
const skills = new SkillService(store, { agent, mode: 'demo', now });
const writer = new WriterService({ storage: writerStorage, adapter: wordpress,
  siteOrigin: 'https://example.test', lockPath: path.join(path.dirname(fixtureDatabase), 'unused.lock'), now });
const service = new SiteOpsService({ mode: 'demo', siteUrl: 'https://example.test', store,
  provider, wordpress, writerStorage, writer, agent, agentMode: 'demo', skills, now });

let started = false;
process.on('message', () => {
  if (started) return;
  started = true;
  void (async () => {
    try {
      if (role === 'weekly') {
        const result = await runWeeklySkill('run', { databasePath: fixtureDatabase, now,
          appHealthy: async () => true, codexCommandReady: async () => true,
          lifecycle: (db, at, capability, signal) => executeLifecycleWithAdapter(db, at, {
            run: agent.run.bind(agent),
            reflect: async () => ({
              content: 'Preserve facts and evidence boundaries. Make one bounded editorial clarification while preserving all useful original content for human review.',
              rationale: 'Synthetic reflection used only to verify process-safe quota reservation.',
            }),
          }, capability, signal),
        });
        process.send?.({ type: 'result', won: result.status === 'completed', claimed: result.claimed === true });
      } else {
        await service.createTask(1);
        for (let index = 0; index < 100 && service.state().tasks.some(task => ['queued', 'running'].includes(task.status)); index++) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        process.send?.({ type: 'result', won: true, claimed: false });
      }
    } catch {
      process.send?.({ type: 'result', won: false, claimed: false });
    } finally {
      store.close();
      process.disconnect();
    }
  })();
});
process.send?.({ type: 'ready' });
