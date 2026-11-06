// Shared data layer for the Siggu API: Upstash Redis over its REST API (no npm dependencies).
//
// Keys
//   meetings          hash  meetingId -> meeting JSON (without availability)
//   avail:<meetingId> hash  memberId  -> JSON array of 'YYYY-MM-DD'
//   photo:<meetingId> string            JPEG data URL (one photo per meeting)

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
const pairs = flat => {
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
  if (!meetings.length) return { meetings: [] };
  const avails = await pipeline(meetings.map(m => ['HGETALL', `avail:${m.id}`]));
  meetings.forEach((m, i) => {
    const a = pairs(avails[i]);
    m.avail = Object.fromEntries(Object.entries(a).map(([member, json]) => [member, JSON.parse(json)]));
  });
  meetings.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || b.year - a.year || b.round - a.round);
  return { meetings };
}

export const saveMeeting = m => {
  const { avail, ...rest } = m;
  return ['HSET', 'meetings', m.id, JSON.stringify(rest)];
};

export function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.json(body);
}
