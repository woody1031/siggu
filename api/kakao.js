import { MEMBERS, configured, readMeetings, send } from './_db.js';
import { finishLogin, kakaoReady, loginUrl, notify, todayKST } from './_kakao.js';

// GET /api/kakao?member=koala       -> Kakao login for that member
// GET /api/kakao?code=..&state=koala -> Kakao sends them back here; save and return to the site
// GET /api/kakao?step=test&key=CRON_SECRET -> send a test alert for the next confirmed meeting
export default async function handler(req, res) {
  if (!configured() || !kakaoReady()) return send(res, 503, { error: '카톡 알림이 아직 설정되지 않았어요.' });
  const redirect = `https://${req.headers.host}/api/kakao`;
  const q = req.query || {};
  const back = s => { res.statusCode = 302; res.setHeader('Location', `/?kakao=${s}`); res.end(); };

  if (q.step === 'test') {
    if (!process.env.CRON_SECRET || q.key !== process.env.CRON_SECRET) return send(res, 401, { error: 'no' });
    const next = Object.values(await readMeetings()).filter(m => m.confirmed && m.confirmed >= todayKST()).sort((a, b) => a.confirmed.localeCompare(b.confirmed))[0];
    if (!next) return send(res, 404, { error: '확정된 다음 모임이 없어요.' });
    return send(res, 200, await notify(q.kind || 'confirm', { ...next, id: `test-${Date.now()}` }));
  }

  if (q.code || q.error) {
    if (q.error || !MEMBERS.includes(q.state)) return back('cancel');
    try { await finishLogin(redirect, q.state, String(q.code)); return back('ok'); }
    catch (e) { console.error('kakao login failed', e.message); return back('fail'); }
  }

  if (!MEMBERS.includes(q.member)) return send(res, 400, { error: '누구인지 먼저 골라주세요.' });
  res.statusCode = 302;
  res.setHeader('Location', loginUrl(redirect, q.member));
  res.end();
}
