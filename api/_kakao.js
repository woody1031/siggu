// KakaoTalk alerts for Siggu, through Kakao's "send to friends" API.
//
// One member (env KAKAO_SENDER, e.g. 'koala') is the sender: messages go from their KakaoTalk
// to each other member's 1:1 chat, and to the sender's own "나와의 채팅".
// Every member connects once on the site (Kakao login); that is what lets the sender reach them.
//
// Env
//   KAKAO_REST_KEY       REST API key of the Kakao Developers app
//   KAKAO_CLIENT_SECRET  optional, only if client secret is turned on in the app
//   KAKAO_SENDER         member id whose KakaoTalk sends the alerts
//   CRON_SECRET          Vercel sends it to /api/cron; also unlocks /api/kakao?step=test
//
// Keys
//   kakao:users   hash memberId -> { id (Kakao user id), at }
//   kakao:tokens  hash memberId -> { access, refresh, accessExp, refreshExp } (ms timestamps)
//   kakao:sent    set  '<meetingId>:<kind>:<date>' alerts already sent, so none goes out twice

import { MEMBERS, pairs, pipeline, redis } from './_db.js';

export const kakaoReady = () => Boolean(process.env.KAKAO_REST_KEY && MEMBERS.includes(process.env.KAKAO_SENDER));
export const SITE = 'https://siggu-silk.vercel.app';
const NAMES = { pigeon: '수진', babsae: '다연', koala: '근주', fox: '동은', dog: '영지' };

export const todayKST = (plus = 0) => new Date(Date.now() + 9 * 3600e3 + plus * 864e5).toISOString().slice(0, 10);

const form = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== ''));

async function kakao(url, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' } : {}) },
    body: body ? form(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Kakao ${res.status}: ${j.msg || j.error_description || j.error || ''}`);
  return j;
}

const tokenSet = (j, old = {}) => ({
  access: j.access_token,
  refresh: j.refresh_token || old.refresh,
  accessExp: Date.now() + (j.expires_in || 0) * 1000,
  refreshExp: j.refresh_token_expires_in ? Date.now() + j.refresh_token_expires_in * 1000 : old.refreshExp,
});

/* ---------- login ---------- */
export const loginUrl = (redirect, member) => `https://kauth.kakao.com/oauth/authorize?${form({
  client_id: process.env.KAKAO_REST_KEY, redirect_uri: redirect, response_type: 'code', scope: 'talk_message,friends', state: member,
})}`;

// Finish a member's Kakao login: keep who they are on Kakao, and their tokens.
export async function finishLogin(redirect, member, code) {
  const j = await kakao('https://kauth.kakao.com/oauth/token', { body: {
    grant_type: 'authorization_code', client_id: process.env.KAKAO_REST_KEY, client_secret: process.env.KAKAO_CLIENT_SECRET, redirect_uri: redirect, code,
  } });
  const me = await kakao('https://kapi.kakao.com/v2/user/me', { token: j.access_token });
  // One Kakao account belongs to one member: if it was linked to someone else's slot (wrong phone), drop that link.
  const stale = Object.entries(pairs(await redis('HGETALL', 'kakao:users'))).filter(([k, v]) => k !== member && JSON.parse(v).id === me.id).map(([k]) => k);
  await pipeline([
    ...stale.flatMap(k => [['HDEL', 'kakao:users', k], ['HDEL', 'kakao:tokens', k]]),
    ['HSET', 'kakao:users', member, JSON.stringify({ id: me.id, at: Date.now() })],
    ['HSET', 'kakao:tokens', member, JSON.stringify(tokenSet(j))],
  ]);
}

export const connectedMembers = async () => Object.keys(pairs(await redis('HGETALL', 'kakao:users')));

// The sender's access token, renewed when it is close to running out.
// Kakao hands out a fresh refresh token when the old one has under a month left, so a daily call keeps it alive.
export async function senderToken(force = false) {
  const who = process.env.KAKAO_SENDER;
  const raw = await redis('HGET', 'kakao:tokens', who);
  if (!raw) throw new Error(`${NAMES[who] || who} has not connected Kakao yet`);
  const t = JSON.parse(raw);
  if (!force && t.accessExp - Date.now() > 30 * 60e3) return t.access;
  const j = await kakao('https://kauth.kakao.com/oauth/token', { body: {
    grant_type: 'refresh_token', client_id: process.env.KAKAO_REST_KEY, client_secret: process.env.KAKAO_CLIENT_SECRET, refresh_token: t.refresh,
  } });
  const next = tokenSet(j, t);
  await redis('HSET', 'kakao:tokens', who, JSON.stringify(next));
  return next.access;
}

/* ---------- messages ---------- */
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const day = d => { const [y, m, dd] = d.split('-').map(Number); return `${m}월 ${dd}일 (${DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]})`; };

export function messageText(kind, m) {
  const head = { confirm: '🗓️ [식구] 식구 모임 날짜가 정해졌어요!', d7: '⏰ [식구] 식구 모임 1주일 전이에요', d1: '🍚 [식구] 내일은 식구 모임 날이에요!' }[kind];
  const when = [day(m.confirmed), m.time].filter(Boolean).join(' ');
  return [head, '', m.title, when, m.place ? `📍 ${m.place}` : ''].filter((l, i) => l || i === 1).join('\n').slice(0, 200);
}

const fmtMD = d => { const [, m, dd] = d.split('-').map(Number); return `${m}월 ${dd}일`; };
export const memberName = id => NAMES[id] || id;

// Reminder for members who haven't picked dates yet (round 1 on day 3, round 2 on day 6).
export const nudgeText = (round, m) => [round === 1 ? '⏰ [식구] 아직 날짜를 안 골랐어요' : '⏰ [식구] 날짜 고르기, 잊지 않으셨죠?', '',
  m.title, `후보 ${fmtMD(m.start)} ~ ${fmtMD(m.end)}`, '가능한 날을 찍어주세요!'].join('\n');
// Four have picked; only one is left.
export const lastText = (id, m) => [`🙋 [식구] 이제 ${memberName(id)}님만 남았어요!`, '',
  m.title, `${memberName(id)}님이 가능한 날을 고르면 모임 날짜가 정해져요.`].join('\n');
const BDAY = {
  dog: '내일은 충주의 힙쟁이 영지 생일이에요',
  babsae: '내일은 알잘딱깔센 다연공주의 생일이에요',
  koala: '내일은 우리 영원한 막둥이 근주 생일이에요',
  fox: '내일은 마음만은 온면인 냉미녀 동은의 생일이에요',
  pigeon: '내일은 다정한 수진의 생일이에요',
};
export const bdayText = (id, today = false) => {
  const line = BDAY[id] || `내일은 ${memberName(id)} 생일이에요`;
  return [`🎂 [식구] ${today ? line.replace(/^내일은/, '오늘은') : line}`, '', '다 같이 축하해 주세요 🎉'].join('\n');
};

// Send a text to some members (default: everyone connected), once per key.
// Members other than the sender get it in their 1:1 chat with the sender; the sender gets it in "나와의 채팅".
export async function sendText(key, text, to = null) {
  if (!kakaoReady()) return { skipped: 'not ready' };
  if (!(await redis('SADD', 'kakao:sent', key))) return { skipped: 'already sent' };
  try {
    const sender = process.env.KAKAO_SENDER;
    const users = Object.fromEntries(Object.entries(pairs(await redis('HGETALL', 'kakao:users'))).map(([k, v]) => [k, JSON.parse(v).id]));
    const want = Object.keys(users).filter(k => !to || to.includes(k));
    if (!want.length) { await redis('SREM', 'kakao:sent', key); return { skipped: 'nobody connected' }; }
    const token = await senderToken();
    const others = want.filter(k => k !== sender);
    const friends = others.length ? (await kakao('https://kapi.kakao.com/v1/api/talk/friends?limit=100', { token })).elements || [] : [];
    const uuidOf = Object.fromEntries(others.map(k => [k, (friends.find(f => f.id === users[k]) || {}).uuid]).filter(([, u]) => u));
    const template_object = JSON.stringify({
      object_type: 'text', text: text.slice(0, 200), button_title: '식구 열기',
      link: { web_url: SITE, mobile_web_url: SITE },
    });
    const deliver = async list => {
      if (!list.length) return [];
      try {
        const r = await kakao('https://kapi.kakao.com/v1/api/talk/friends/message/default/send', { token, body: { receiver_uuids: JSON.stringify([...new Set(list.map(k => uuidOf[k]))]), template_object } });
        const ok = new Set(r.successful_receiver_uuids || []);
        if (r.failure_info) console.error('kakao partial failure', key, JSON.stringify(r.failure_info));
        return list.filter(k => ok.has(uuidOf[k]));
      } catch (e) { console.error('kakao send failed', key, e.message); return []; }
    };
    const targets = Object.keys(uuidOf);
    const got = await deliver(targets);
    got.push(...await deliver(targets.filter(k => !got.includes(k)))); // one retry for anyone missed
    const missed = others.filter(k => !got.includes(k));
    // Two members on one Kakao account means one of them really gets nothing (someone connected on the wrong phone).
    const sameAs = others.filter(k => others.some(o => o !== k && users[o] === users[k]));
    if (sameAs.length) missed.push(...sameAs.filter(k => !missed.includes(k)));
    const self = want.includes(sender);
    if (self) await kakao('https://kapi.kakao.com/v2/api/talk/memo/default/send', { token, body: { template_object } });
    if (missed.length) {
      // Tell the sender who didn't get it, so nobody is silently left out.
      const note = sameAs.length ? `\n(${sameAs.map(memberName).join(', ')}이 같은 카카오 계정으로 연결돼 있어요. 본인 폰에서 다시 연결해 주세요)` : '';
      const warn = JSON.stringify({ object_type: 'text', text: `⚠️ [식구] ${missed.map(memberName).join(', ')}에게 알림이 안 갔을 수 있어요${note}\n\n${text.split('\n')[0]}`.slice(0, 200), link: { web_url: SITE, mobile_web_url: SITE } });
      await kakao('https://kapi.kakao.com/v2/api/talk/memo/default/send', { token, body: { template_object: warn } }).catch(() => {});
    }
    return { sent: new Set(got.map(k => uuidOf[k])).size, got, missed, self };
  } catch (e) {
    await redis('SREM', 'kakao:sent', key); // let the next try send it
    console.error('kakao send failed', key, e.message);
    return { error: e.message };
  }
}

// Date alerts (confirmed / 1 week before / day before) go to everyone. Never sent twice for the same date.
export async function notify(kind, m) {
  if (!m || !m.confirmed) return { skipped: 'no date' };
  return sendText(`${m.id}:${kind}:${m.confirmed}`, messageText(kind, m));
}

// Setup check: which connected members the sender's KakaoTalk can reach right now.
export async function reachable() {
  const token = await senderToken();
  const users = Object.fromEntries(Object.entries(pairs(await redis('HGETALL', 'kakao:users'))).map(([k, v]) => [k, JSON.parse(v).id]));
  const friends = (await kakao('https://kapi.kakao.com/v1/api/talk/friends?limit=100', { token })).elements || [];
  const ids = new Set(friends.map(f => f.id));
  // Each member's own consent for messages and friend list (from the token saved when they connected).
  const toks = pairs(await redis('HGETALL', 'kakao:tokens')), consent = {};
  for (const [k, v] of Object.entries(toks)) {
    try {
      const t = JSON.parse(v);
      let access = t.access;
      if (t.accessExp - Date.now() < 60e3) access = (await kakao('https://kauth.kakao.com/oauth/token', { body: { grant_type: 'refresh_token', client_id: process.env.KAKAO_REST_KEY, client_secret: process.env.KAKAO_CLIENT_SECRET, refresh_token: t.refresh } })).access_token;
      const sc = (await kakao('https://kapi.kakao.com/v2/user/scopes', { token: access })).scopes || [];
      consent[k] = Object.fromEntries(sc.filter(x => ['talk_message', 'friends'].includes(x.id)).map(x => [x.id, x.agreed]));
    } catch (e) { consent[k] = e.message; }
  }
  const byId = {};
  for (const [k, id] of Object.entries(users)) (byId[id] = byId[id] || []).push(k);
  const shared = Object.values(byId).filter(list => list.length > 1);
  return { friendsVisible: friends.length, connected: Object.keys(users), reachable: Object.keys(users).filter(k => ids.has(users[k])), shared, consent };
}
