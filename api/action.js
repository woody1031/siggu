import { BLOB_URL, MAX_PHOTOS, MEMBERS, configured, pairs, photoKey, photosOf, pipeline, readMeetings, readState, redis, saveMeeting, send } from './_db.js';

// Remove uploaded files from Vercel Blob (best effort; the record is removed either way).
async function dropBlobs(photos) {
  const urls = photos.flatMap(p => [p.url, p.thumb, p.orig]).filter(u => u && BLOB_URL.test(u));
  if (!urls.length || !process.env.BLOB_READ_WRITE_TOKEN) return;
  try { const { del } = await import('@vercel/blob'); await del(urls); } catch (e) { /* ignore */ }
}

// POST /api/action { type, ... } -> applies one change, returns the full new state.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PHOTO = 1_500_000; // characters of the data URL (~1.1MB image)

class Bad extends Error {}
const need = (ok, msg) => { if (!ok) throw new Bad(msg); };
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
// Korea time, e.g. 2026-11-06T17:26 (the page shows it as 11/6 17:26)
const nowKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16);

async function apply(op) {
  const meetings = await readMeetings();
  const list = Object.values(meetings);
  const m = op.mid ? meetings[op.mid] : null;
  if (!['create', 'record', 'profile'].includes(op.type)) need(m, '모임을 찾을 수 없어요. 새로고침해 주세요.');
  if ('member' in op || 'by' in op) need(MEMBERS.includes(op.member ?? op.by), '누구인지 먼저 골라주세요.');

  switch (op.type) {
    case 'create': {
      need(DATE.test(op.start) && DATE.test(op.end) && op.start <= op.end, '후보 기간을 다시 골라주세요.');
      const year = Number(op.start.slice(0, 4));
      const round = list.filter(x => x.year === year).length + 1;
      const fresh = {
        id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        year, round, title: clean(op.title, 20) || `${round}회차 모임`,
        start: op.start, end: op.end, confirmed: null, status: 'voting',
        time: '', place: '', log: [], photo: null, photoBy: null, createdAt: Date.now(),
      };
      const archived = list.filter(x => x.status === 'voting').map(x => saveMeeting({ ...x, status: 'archived' }));
      await pipeline([...archived, saveMeeting(fresh)]);
      return { created: fresh };
    }
    case 'update': {
      // Rename and/or change the candidate period. Dates outside the new period are dropped,
      // and a confirmed date that falls outside it is un-confirmed.
      need(DATE.test(op.start) && DATE.test(op.end) && op.start <= op.end, '후보 기간을 다시 골라주세요.');
      const year = Number(op.start.slice(0, 4));
      const round = year === m.year ? m.round : list.filter(x => x.id !== m.id && x.year === year).length + 1;
      const outside = m.confirmed && (m.confirmed < op.start || m.confirmed > op.end);
      const next = {
        ...m, year, round, title: clean(op.title, 20) || m.title, start: op.start, end: op.end,
        ...(outside ? { confirmed: null, status: 'voting' } : {}),
      };
      const avail = pairs(await redis('HGETALL', `avail:${m.id}`));
      const trimmed = Object.entries(avail).flatMap(([member, json]) => {
        const kept = JSON.parse(json).filter(d => d >= op.start && d <= op.end);
        return [member, JSON.stringify(kept)];
      });
      const others = outside ? list.filter(x => x.id !== m.id && x.status === 'voting').map(x => saveMeeting({ ...x, status: 'archived' })) : [];
      await pipeline([...others, saveMeeting(next), ...(trimmed.length ? [['HSET', `avail:${m.id}`, ...trimmed]] : [])]);
      return {};
    }
    case 'profile': {
      const birthday = String(op.birthday || ''), phone = clean(op.phone, 20), bio = clean(op.bio, 40);
      need(!birthday || /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(birthday), '생일을 다시 골라주세요.');
      need(!phone || /^[0-9+\-() ]{3,20}$/.test(phone), '전화번호는 숫자와 - 만 써주세요.');
      await redis('HSET', 'profiles', op.member, JSON.stringify({ birthday, phone, bio, updatedAt: nowKST() }));
      return {};
    }
    case 'delete': {
      await dropBlobs(photosOf(m));
      const keys = new Set([`photo:${m.id}`, ...photosOf(m).map(p => photoKey(m.id, p.id))]);
      await pipeline([['HDEL', 'meetings', m.id], ['DEL', `avail:${m.id}`], ...[...keys].map(k => ['DEL', k])]);
      return {};
    }
    case 'record': {
      // Add a meeting that already happened (date confirmed), without touching the current one.
      need(DATE.test(op.date), '날짜를 다시 골라주세요.');
      const time = clean(op.time, 5), place = clean(op.place, 40);
      need(!time || TIME.test(time), '시간을 다시 골라주세요.');
      const [y, mo] = op.date.split('-').map(Number);
      const start = `${op.date.slice(0, 8)}01`, end = `${op.date.slice(0, 8)}${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
      const fresh = {
        id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        year: y, round: 0, title: clean(op.title, 20) || '모임', start, end, confirmed: op.date, status: 'confirmed',
        time, place, log: [], photos: [], createdAt: Date.parse(`${op.date}T12:00:00+09:00`),
      };
      // Rounds in that year follow the meeting dates.
      const sameYear = [...list.filter(x => x.year === y), fresh]
        .sort((a, b) => (a.confirmed || a.start).localeCompare(b.confirmed || b.start) || (a.createdAt || 0) - (b.createdAt || 0));
      const writes = sameYear.map((x, i) => saveMeeting({ ...x, round: i + 1 }));
      await pipeline(writes);
      return { created: { ...fresh, round: sameYear.indexOf(fresh) + 1 } };
    }
    case 'avail': {
      need(Array.isArray(op.dates) && op.dates.length <= 400, '날짜를 다시 골라주세요.');
      const dates = [...new Set(op.dates)].filter(d => DATE.test(d) && d >= m.start && d <= m.end).sort();
      await redis('HSET', `avail:${m.id}`, op.member, JSON.stringify(dates));
      return {};
    }
    case 'confirm': {
      need(DATE.test(op.date) && op.date >= m.start && op.date <= m.end, '후보 기간 안의 날짜를 골라주세요.');
      await pipeline([saveMeeting({ ...m, confirmed: op.date, status: 'confirmed' })]);
      return {};
    }
    case 'unconfirm': {
      const others = list.filter(x => x.id !== m.id && x.status === 'voting').map(x => saveMeeting({ ...x, status: 'archived' }));
      await pipeline([...others, saveMeeting({ ...m, confirmed: null, status: 'voting' })]);
      return {};
    }
    case 'plan': {
      const time = clean(op.time, 5), place = clean(op.place, 40);
      need(!time || TIME.test(time), '시간을 다시 골라주세요.');
      const log = [...(m.log || []), { by: op.by, at: nowKST(), text: clean(op.text, 80) }].slice(-30);
      await pipeline([saveMeeting({ ...m, time, place, log })]);
      return {};
    }
    case 'photo': {
      const photos = photosOf(m);
      need(photos.length < MAX_PHOTOS, `사진은 모임마다 ${MAX_PHOTOS}장까지 올릴 수 있어요.`);
      const pid = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const { photo, photoBy, ...rest } = m;
      let entry, writes = [];
      if (op.url) {
        // Uploaded straight to Vercel Blob: display version, thumbnail and the original file.
        need([op.url, op.thumb || op.url, op.orig || op.url].every(u => BLOB_URL.test(String(u))), '사진 주소가 올바르지 않아요.');
        entry = { id: pid, url: op.url, thumb: op.thumb || op.url, orig: op.orig || op.url, by: op.by };
      } else {
        const data = String(op.data || '');
        need(/^data:image\/(jpeg|png|webp);base64,/.test(data), '사진 파일만 올릴 수 있어요.');
        need(data.length <= MAX_PHOTO, '사진이 너무 커요. 다른 사진으로 해볼래요?');
        entry = { id: pid, url: `/api/photo?mid=${m.id}&pid=${pid}`, by: op.by };
        writes = [['SET', photoKey(m.id, pid), data]];
      }
      await pipeline([...writes, saveMeeting({ ...rest, photos: [...photos, entry] })]);
      return { photoId: pid };
    }
    case 'photodel': {
      const photos = photosOf(m), pid = String(op.pid || (photos[0] && photos[0].id) || '');
      need(photos.some(p => p.id === pid), '사진을 찾을 수 없어요. 새로고침해 주세요.');
      const { photo, photoBy, ...rest } = m;
      await dropBlobs(photos.filter(p => p.id === pid));
      await pipeline([['DEL', photoKey(m.id, pid)], saveMeeting({ ...rest, photos: photos.filter(p => p.id !== pid) })]);
      return {};
    }
    default:
      throw new Bad('알 수 없는 요청이에요.');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST만 쓸 수 있어요.' });
  if (!configured()) return send(res, 503, { error: '데이터베이스가 아직 연결되지 않았어요.', code: 'not_configured' });
  const op = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  try {
    const extra = await apply(op);
    send(res, 200, { ...extra, ...(await readState()) });
  } catch (e) {
    if (e instanceof Bad) return send(res, 400, { error: e.message });
    send(res, 500, { error: '저장하지 못했어요. 잠시 뒤 다시 해주세요.' });
  }
}
