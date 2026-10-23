import { loadConfig } from '../apps/server/config.js';
import { LiveDataProvider } from '../apps/server/data/provider.js';
import { HttpWordPressAdapter } from '../apps/server/writer/wordpress-adapter.js';
import { rankOpportunities } from '../apps/server/opportunities.js';
const config = loadConfig();
if (!config.live) throw new Error('Use SITEOPS_MODE=live and SITEOPS_CONFIG_PATH. This script only reads connections.');
const adapter = new HttpWordPressAdapter({ siteOrigin: config.live.siteUrl, username: config.live.username, applicationPassword: config.live.appPassword });
const provider = new LiveDataProvider(config.live, adapter, () => {});
console.log(JSON.stringify({ at: new Date().toISOString(), connections: await provider.check() }, null, 2));
if (process.argv.includes('--sync')) {
  const snapshot = await provider.sync();
  console.log(JSON.stringify({ at: snapshot.createdAt, pagesRead: snapshot.pages.length, opportunityCount: rankOpportunities(snapshot).length,
    sources: snapshot.evidence.map(({ source, startDate, endDate, complete }) => ({ source, startDate, endDate, complete })),
    warningCount: snapshot.warnings.length, productionWrites: 0 }, null, 2));
}
