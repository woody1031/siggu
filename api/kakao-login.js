import { MEMBERS, configured, redis } from './_db.js';
import { kakaoEnabled, redirectUri } from './_kakao.js';

// GET /api/kakao-login?member=dog -> Kakao Login (asks for permission to send messages to me)
export default async function handler(req, res) {
  const member = String(req.query.member || '');
  if (!configured() || !kakaoEnabled() || !MEMBERS.includes(member)) { res.statusCode = 302; res.setHeader('Location', '/?kakao=fail'); return res.end(); }
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  await redis('SET', `kstate:${nonce}`, member, 'EX', 600);
  const q = new URLSearchParams({
    client_id: process.env.KAKAO_REST_KEY, redirect_uri: redirectUri(req), response_type: 'code', scope: 'talk_message', state: nonce,
  });
  res.statusCode = 302;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', `https://kauth.kakao.com/oauth/authorize?${q}`);
  res.end();
}
