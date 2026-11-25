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
  await pipeline([
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
  const head = { confirm: '🗓️ 식구 모임 날짜가 정해졌어요!', d7: '⏰ 식구 모임 1주일 전이에요', d1: '🍚 내일은 식구 모임 날이에요!' }[kind];
  const when = [day(m.confirmed), m.time].filter(Boolean).join(' ');
  return [head, '', m.title, when, m.place ? `📍 ${m.place}` : ''].filter((l, i) => l || i === 1).join('\n').slice(0, 200);
}

// Send one alert to everyone connected. Returns who it reached. Never sends the same alert twice.
export async function notify(kind, m) {
  if (!kakaoReady() || !m || !m.confirmed) return { skipped: 'not ready' };
  const key = `${m.id}:${kind}:${m.confirmed}`;
  if (!(await redis('SADD', 'kakao:sent', key))) return { skipped: 'already sent' };
  try {
    const token = await senderToken();
    const users = Object.fromEntries(Object.entries(pairs(await redis('HGETALL', 'kakao:users'))).map(([k, v]) => [k, JSON.parse(v).id]));
    const ids = new Set(Object.entries(users).filter(([k]) => k !== process.env.KAKAO_SENDER).map(([, id]) => id));
    const friends = ids.size ? (await kakao('https://kapi.kakao.com/v1/api/talk/friends?limit=100', { token })).elements || [] : [];
    const uuids = friends.filter(f => ids.has(f.id)).map(f => f.uuid).slice(0, 5);
    const template_object = JSON.stringify({
      object_type: 'text', text: messageText(kind, m), button_title: '식구 열기',
      link: { web_url: SITE, mobile_web_url: SITE },
    });
    const sent = [];
    if (uuids.length) {
      const r = await kakao('https://kapi.kakao.com/v1/api/talk/friends/message/default/send', { token, body: { receiver_uuids: JSON.stringify(uuids), template_object } });
      sent.push(...(r.successful_receiver_uuids || []));
    }
    await kakao('https://kapi.kakao.com/v2/api/talk/memo/default/send', { token, body: { template_object } });
    return { sent: sent.length, self: true };
  } catch (e) {
    await redis('SREM', 'kakao:sent', key); // let the next try (cron or another confirm) send it
    console.error('kakao notify failed', kind, m.id, e.message);
    return { error: e.message };
  }
}
