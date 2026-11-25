import { MEMBERS, configured, pairs, redis, send } from './_db.js';
import { bdayText, kakaoReady, sendText, todayKST } from './_kakao.js';

// Vercel runs this every evening in the 23:00 KST hour (vercel.json): tomorrow's birthday wish goes to the other four.
// A run delayed past midnight still sends (it's then today's birthday, and the wording says 오늘은).
// If the night run never went out, the 9am job (api/cron.js) sends it on the day with 오늘은.
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return send(res, 401, { error: 'no' });
  if (!configured() || !kakaoReady()) return send(res, 200, { skipped: 'not ready' });
  const kstHour = new Date(Date.now() + 9 * 3600e3).getUTCHours();
  const late = kstHour < 12;
  send(res, 200, await sendBirthdays(todayKST(late ? 0 : 1), late));
}

// Wish for everyone whose birthday is `day` ('YYYY-MM-DD'), to the other four. One key per birthday per year,
// so the night-before wish and the 9am fallback on the day itself never both go out.
export async function sendBirthdays(day, today) {
  const out = { day };
  const profiles = pairs(await redis('HGETALL', 'profiles'));
  for (const [id, json] of Object.entries(profiles)) {
    if (JSON.parse(json).birthday === day.slice(5)) out[`bday:${id}`] = await sendText(`bday:${id}:${day.slice(0, 4)}`, bdayText(id, today), MEMBERS.filter(x => x !== id));
  }
  return out;
}
