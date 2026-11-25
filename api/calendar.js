import { configured, readMeetings } from './_db.js';

// GET /api/calendar -> iCalendar feed of confirmed meetings.
// Each phone subscribes once (webcal://…/api/calendar) and picks up new or changed dates on its own.

const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 bytes continue on the next line after a space (RFC 5545).
function fold(line) {
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 73) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
const ymd = d => d.replace(/-/g, '');
const nextDay = d => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

function event(m, site) {
  const lines = ['BEGIN:VEVENT', `UID:${m.id}@siggu`, `DTSTAMP:${stamp()}`];
  if (m.time) {
    const [h, mi] = m.time.split(':').map(Number), end = Math.min(h + 3, 23);
    lines.push(`DTSTART;TZID=Asia/Seoul:${ymd(m.confirmed)}T${String(h).padStart(2, '0')}${String(mi).padStart(2, '0')}00`,
      `DTEND;TZID=Asia/Seoul:${ymd(m.confirmed)}T${String(end).padStart(2, '0')}${end === 23 ? '59' : String(mi).padStart(2, '0')}00`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${ymd(m.confirmed)}`, `DTEND;VALUE=DATE:${ymd(nextDay(m.confirmed))}`);
  }
  lines.push(`SUMMARY:${esc(m.title)}`);
  if (m.place) lines.push(`LOCATION:${esc(m.place)}`);
  lines.push(`URL:${site}`, `DESCRIPTION:${esc(`식구 모임 · ${site}`)}`, 'END:VEVENT');
  return lines;
}

export default async function handler(req, res) {
  const site = `https://${req.headers.host}`;
  let meetings = [];
  if (configured()) {
    try { meetings = Object.values(await readMeetings()).filter(m => m.confirmed); }
    catch (e) { res.statusCode = 503; return res.end('try again'); }
  }
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Siggu//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:식구', 'X-WR-TIMEZONE:Asia/Seoul', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Seoul', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:KST', 'END:STANDARD', 'END:VTIMEZONE',
    ...meetings.flatMap(m => event(m, site)),
    'END:VCALENDAR',
  ];
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="siggu.ics"');
  res.setHeader('Cache-Control', 'no-store');
  res.end(lines.map(fold).join('\r\n') + '\r\n');
}
