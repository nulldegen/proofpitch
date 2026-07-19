// Dev utility: dump all fixtures in the snapshot window, sorted by kickoff.
import { getSession } from '../auth.js';
import { FeedClient } from '../feed.js';

const s = await getSession();
const f = new FeedClient(s);
const snap: any[] = await f.fixtures();
for (const x of snap) console.log(JSON.stringify(x));
console.log(`\ntotal: ${snap.length} fixtures, now = ${new Date().toISOString()}`);
