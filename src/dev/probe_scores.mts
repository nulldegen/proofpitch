// Dev utility: probe every scores endpoint for a fixture and report the
// latest record + whether a finalised one exists anywhere.
import { getSession } from '../auth.js';
import { FeedClient, parseScoreHistory, scoreSummary } from '../feed.js';

const fid = Number(process.argv[2] ?? 18257865);
const s = await getSession();
const f = new FeedClient(s);

for (const [name, call] of [
  ['snapshot', () => f.scoresSnapshot(fid)],
  ['updates', () => f.scoresUpdates(fid)],
  ['historical', () => f.scoresHistorical(fid)],
] as [string, () => Promise<unknown>][]) {
  try {
    const recs = parseScoreHistory(await call());
    const sums = recs.map((r) => scoreSummary(r));
    const final = sums.filter((x) => x.etFinal);
    const last = sums[sums.length - 1];
    console.log(`${name}: ${recs.length} records`
      + (last ? ` | last seq=${last.seq} status=${last.statusId} action=${last.action} goals=${JSON.stringify(last.goals)}` : '')
      + ` | finalised: ${final.length ? `YES seq=${final[final.length - 1].seq}` : 'no'}`);
  } catch (e: any) {
    console.log(`${name}: ERROR ${e.message?.slice(0, 120)}`);
  }
}
