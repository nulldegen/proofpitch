// Dev utility: print the score-history status of the bronze final and the final.
import { getSession } from '../auth.js';
import { FeedClient, parseScoreHistory, scoreSummary } from '../feed.js';

const s = await getSession();
const f = new FeedClient(s);

for (const [name, fid] of [['France-England (bronze)', 18257865], ['Spain-Argentina (final)', 18257739]] as [string, number][]) {
  try {
    const h = parseScoreHistory(await f.scoresHistorical(fid));
    console.log(`\n${name} fixture ${fid}: ${h.length} score records`);
    if (h.length) {
      const last = h[h.length - 1];
      const sum = scoreSummary(last);
      console.log('  last:', JSON.stringify({ seq: sum.seq, statusId: sum.statusId, action: sum.action, etFinal: sum.etFinal, goals: sum.goals }));
    }
  } catch (e: any) {
    console.log(`\n${name} fixture ${fid}: ERROR ${e.message}`);
  }
}
