// Shared data layer for the Siggu API: Upstash Redis over its REST API (no npm dependencies).
//
// Keys
//   meetings          hash  meetingId -> meeting JSON (without availability)
//   avail:<meetingId> hash  memberId  -> JSON array of 'YYYY-MM-DD'
//   photo:<meetingId>:<photoId> string  JPEG data URL (up to 3 photos per meeting)
//   photo:<meetingId>     string        older single photo, shown as photo id 'legacy'
//   profiles          hash  memberId  -> { birthday 'MM-DD', phone, bio, updatedAt }
// Photos uploaded through Vercel Blob keep only their URLs here: url (display), thumb, orig (original file).

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const MEMBERS = ['pigeon', 'babsae', 'koala', 'fox', 'dog'];
export const configured = () => Boolean(REDIS_URL && REDIS_TOKEN);

export async function pipeline(commands) {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis request failed (${res.status})`);
  const out = await res.json();
  return out.map(r => {
    if (r.error) throw new Error(r.error);
    return r.result;
  });
}

export const redis = async (...command) => (await pipeline([command]))[0];

// HGETALL returns a flat [field, value, field, value, ...] array.
export const pairs = flat => {
  const o = {};
  for (let i = 0; flat && i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
};

export async function readMeetings() {
  const raw = pairs(await redis('HGETALL', 'meetings'));
  return Object.fromEntries(Object.entries(raw).map(([id, json]) => [id, JSON.parse(json)]));
}

// Full state the page needs: newest meeting first, each with its availability.
export async function readState() {
  const meetings = Object.values(await readMeetings());
  const profiles = Object.fromEntries(Object.entries(pairs(await redis('HGETALL', 'profiles'))).map(([k, v]) => [k, JSON.parse(v)]));
  const features = { blob: blobEnabled(), maxPhotos: MAX_PHOTOS };
  if (!meetings.length) return { meetings: [], profiles, features };
  const avails = await pipeline(meetings.map(m => ['HGETALL', `avail:${m.id}`]));
  meetings.forEach((m, i) => {
    m.photos = photosOf(m);
    // Pages opened before multi-photo read a single photo/photoBy; keep sending the first one for them.
    m.photo = m.photos[0] ? m.photos[0].url : null; m.photoBy = m.photos[0] ? m.photos[0].by : null;
    const a = pairs(avails[i]);
    m.avail = Object.fromEntries(Object.entries(a).map(([member, json]) => [member, JSON.parse(json)]));
  });
  meetings.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || b.year - a.year || b.round - a.round);
  return { meetings, profiles, features };
}

export const MAX_PHOTOS = 5;
export const blobEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
export const BLOB_URL = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/[^\s"'<>]+$/i;
export const photoKey = (mid, pid) => (pid === 'legacy' ? `photo:${mid}` : `photo:${mid}:${pid}`);
// Photos as a list; meetings saved before multi-photo had a single photo/photoBy.
export const photosOf = m => m.photos || (m.photo ? [{ id: 'legacy', url: m.photo, by: m.photoBy || null }] : []);

export const saveMeeting = m => {
  const { avail, ...rest } = m;
  return ['HSET', 'meetings', m.id, JSON.stringify(rest)];
};

export function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.json(body);
}
