import { MEMBERS, configured, pairs, pipeline, readMeetings, redis, send } from './_db.js';
import { bdayText, kakaoReady, notify, nudgeText, sendText, senderToken, todayKST } from './_kakao.js';

// Vercel runs this every day at 09:00 KST (vercel.json).
// Sends the 1-week and day-before alerts, reminders to pick dates (day 3 and day 6 of a vote),
// birthday wishes, and keeps the sender's Kakao login alive.
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return send(res, 401, { error: 'no' });
  if (!configured() || !kakaoReady()) return send(res, 200, { skipped: 'not ready' });
  const out = {};
  try { await senderToken(true); out.token = 'renewed'; } catch (e) { out.token = e.message; }
  const meetings = Object.values(await readMeetings()).filter(m => m.confirmed);
  for (const [kind, days] of [['d7', 7], ['d1', 1]]) {
    for (const m of meetings.filter(x => x.confirmed === todayKST(days))) out[`${m.id}:${kind}`] = await notify(kind, m);
  }
  // Day 3 and day 6 of a vote: remind those who haven't picked dates yet.
  // A narrow window per round, so a missed day still sends but an old vote never sends both at once.
  // Days count by Korean calendar date: a vote made any time on the 1st gets round 1 on the 4th.
  const voting = Object.values(await readMeetings()).filter(m => m.status === 'voting' && !m.confirmed && m.end >= todayKST() && m.createdAt);
  const avails = voting.length ? await pipeline(voting.map(m => ['HKEYS', `avail:${m.id}`])) : [];
  const kstDay = ms => Math.floor((ms + 9 * 3600e3) / 864e5);
  for (const [i, m] of voting.entries()) {
    const done = avails[i] || [];
    const days = kstDay(Date.now()) - kstDay(m.createdAt);
    const round = days >= 3 && days <= 5 ? 1 : days >= 6 && days <= 8 ? 2 : 0;
    const left = MEMBERS.filter(x => !done.includes(x));
    if (round && left.length) out[`${m.id}:nudge${round}`] = await sendText(`${m.id}:nudge${round}`, nudgeText(round, m), left);
  }
  // Birthday (only members who saved the exact day): wish goes to the other four.
  const today = todayKST().slice(5);
  const profiles = pairs(await redis('HGETALL', 'profiles'));
  for (const [id, json] of Object.entries(profiles)) {
    if (JSON.parse(json).birthday === today) out[`bday:${id}`] = await sendText(`bday:${id}:${todayKST().slice(0, 4)}`, bdayText(id), MEMBERS.filter(x => x !== id));
  }
  send(res, 200, out);
}
