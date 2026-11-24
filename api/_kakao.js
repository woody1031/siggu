// KakaoTalk "send to me" reminders.
// Each member links their own Kakao account once (Kakao Login, scope talk_message);
// the daily cron then sends the reminder into that member's own "나와의 채팅".
//
// Keys
//   kakao            hash  memberId -> { access, accessExp, refresh, refreshExp, at }  (never sent to the page)
//   kstate:<nonce>   string memberId, for 10 minutes while the Kakao login is in progress
//   reminded         hash  '<meetingId>:<date>:<daysBefore>' -> sent time (so each reminder goes out once)
//
// Env: KAKAO_REST_KEY (REST API key), KAKAO_CLIENT_SECRET (only if enabled in the Kakao app),
//      CRON_SECRET (optional; Vercel sends it to /api/remind).
import { redis } from './_db.js';

export const kakaoEnabled = () => Boolean(process.env.KAKAO_REST_KEY);
export const SITE = 'https://siggu-silk.vercel.app';

export function origin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}
export const redirectUri = req => `${origin(req)}/api/kakao-callback`;

async function tokenCall(params) {
  const body = new URLSearchParams({ client_id: process.env.KAKAO_REST_KEY, ...params });
  if (process.env.KAKAO_CLIENT_SECRET) body.set('client_secret', process.env.KAKAO_CLIENT_SECRET);
  const r = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new Error(j.error_description || j.error || `token ${r.status}`); e.code = j.error; throw e; }
  return j;
}

// Merge a token response into what we keep (a refresh response may leave out the refresh token).
function merge(old, j) {
  const now = Date.now();
  return {
    access: j.access_token, accessExp: now + (j.expires_in || 21599) * 1000 - 60e3,
    refresh: j.refresh_token || old.refresh,
    refreshExp: j.refresh_token ? now + (j.refresh_token_expires_in || 5184000) * 1000 : old.refreshExp,
    at: old.at || now,
  };
}

export async function exchangeCode(code, req) {
  return merge({}, await tokenCall({ grant_type: 'authorization_code', redirect_uri: redirectUri(req), code }));
}

export const loadTokens = async member => { const v = await redis('HGET', 'kakao', member); return v ? JSON.parse(v) : null; };
export const saveTokens = (member, t) => redis('HSET', 'kakao', member, JSON.stringify(t));
export const dropTokens = member => redis('HDEL', 'kakao', member);

// Fresh access token for a member, refreshing (and saving) when needed. null when the link is gone.
export async function accessFor(member, { force = false } = {}) {
  let t = await loadTokens(member);
  if (!t) return null;
  const refreshSoon = t.refreshExp && t.refreshExp - Date.now() < 30 * 86400e3; // Kakao renews it only in its last month
  if (force || Date.now() >= t.accessExp || refreshSoon) {
    try { t = merge(t, await tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh })); await saveTokens(member, t); }
    catch (e) { if (e.code === 'invalid_grant') { await dropTokens(member); return null; } throw e; }
  }
  return t.access;
}

// Send a text message to the member's own chat. Returns true when Kakao accepted it.
export async function sendToMe(member, text, url = SITE) {
  const template = JSON.stringify({
    object_type: 'text', text: text.slice(0, 200),
    link: { web_url: url, mobile_web_url: url }, button_title: '식구 열기',
  });
  for (const force of [false, true]) {
    const token = await accessFor(member, { force });
    if (!token) return false;
    const r = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams({ template_object: template }),
    });
    if (r.ok) return true;
    if (r.status !== 401) {
      const j = await r.json().catch(() => ({}));
      if (j.code === -402) { await dropTokens(member); return false; } // message permission withdrawn
      throw new Error(`kakao send ${r.status} ${j.msg || ''}`);
    }
  }
  return false;
}
