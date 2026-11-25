import { configured, readMeetings, send } from './_db.js';
import { kakaoReady, notify, senderToken, todayKST } from './_kakao.js';

// Vercel runs this every day at 09:00 KST (vercel.json).
// Sends the 1-week and day-before alerts, and keeps the sender's Kakao login alive.
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return send(res, 401, { error: 'no' });
  if (!configured() || !kakaoReady()) return send(res, 200, { skipped: 'not ready' });
  const out = {};
  try { await senderToken(true); out.token = 'renewed'; } catch (e) { out.token = e.message; }
  const meetings = Object.values(await readMeetings()).filter(m => m.confirmed);
  for (const [kind, days] of [['d7', 7], ['d1', 1]]) {
    for (const m of meetings.filter(x => x.confirmed === todayKST(days))) out[`${m.id}:${kind}`] = await notify(kind, m);
  }
  send(res, 200, out);
}
