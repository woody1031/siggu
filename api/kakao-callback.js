import { configured, redis } from './_db.js';
import { exchangeCode, kakaoEnabled, saveTokens, sendToMe } from './_kakao.js';

// Kakao sends the member back here after they agree; keep their tokens and say hello in their own chat.
export default async function handler(req, res) {
  const back = r => { res.statusCode = 302; res.setHeader('Cache-Control', 'no-store'); res.setHeader('Location', `/?kakao=${r}`); res.end(); };
  const { code, state, error } = req.query || {};
  if (!configured() || !kakaoEnabled() || error || !code || !state) return back(error === 'access_denied' ? 'cancel' : 'fail');
  const key = `kstate:${String(state).replace(/[^a-f0-9]/g, '')}`;
  const member = await redis('GET', key);
  if (!member) return back('fail');
  await redis('DEL', key);
  try {
    await saveTokens(member, await exchangeCode(String(code), req));
    await sendToMe(member, '식구 알림이 연결됐어요 🐾\n모이는 날 한 달 전, 일주일 전, 3일 전, 하루 전에 여기로 알려드릴게요.').catch(() => {});
    back('ok');
  } catch (e) { back('fail'); }
}
