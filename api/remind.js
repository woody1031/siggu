import { MEMBERS, configured, pairs, readMeetings, redis } from './_db.js';
import { accessFor, kakaoEnabled, sendToMe } from './_kakao.js';

// Daily (vercel.json cron, 09:00 KST): KakaoTalk reminders 30, 7, 3 and 1 day(s) before each confirmed meeting.
// Each reminder is recorded in 'reminded', so running it twice in a day sends nothing new.
const DAYS = { 30: '한 달 남았어요', 7: '일주일 남았어요', 3: '3일 남았어요', 1: '내일 만나요!' };
const WD = '일월화수목금토';
const timeText = t => { if (!t) return ''; const [h, mi] = t.split(':').map(Number); return `${h < 12 ? '오전' : h === 12 ? '낮' : '오후'} ${h % 12 || 12}시${mi ? ` ${mi}분` : ''}`; };

export function message(m, n) {
  const d = new Date(`${m.confirmed}T00:00:00Z`);
  const lines = [`🐾 [${m.title}] ${DAYS[n]}`, `📅 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${WD[d.getUTCDay()]})${m.time ? ` ${timeText(m.time)}` : ''}`];
  if (m.place) lines.push(`📍 ${m.place}`);
  if (m.course) lines.push(`🚶 ${m.course.split('\n').join(' → ')}`);
  return lines.join('\n');
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) { res.statusCode = 401; return res.end(); }
  if (!configured() || !kakaoEnabled()) return res.status(200).json({ skipped: 'not configured' });
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const linked = Object.keys(pairs(await redis('HGETALL', 'kakao'))).filter(x => MEMBERS.includes(x));
  const done = pairs(await redis('HGETALL', 'reminded'));
  const sent = [];
  for (const m of Object.values(await readMeetings())) {
    if (!m.confirmed) continue;
    const n = Math.round((Date.parse(m.confirmed) - Date.parse(today)) / 86400e3);
    const key = `${m.id}:${m.confirmed}:${n}`;
    if (!DAYS[n] || done[key]) continue;
    await redis('HSET', 'reminded', key, today);
    for (const member of linked) {
      try { if (await sendToMe(member, message(m, n))) sent.push(`${member}:${m.id}:D-${n}`); } catch (e) { /* try the others */ }
    }
  }
  // Keep every link alive: Kakao renews a refresh token only when it is used in its last month.
  for (const member of linked) await accessFor(member).catch(() => {});
  res.status(200).json({ today, sent });
}
