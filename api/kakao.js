import { MEMBERS, configured, readMeetings, send } from './_db.js';
import { bdayText, finishLogin, reachable, kakaoReady, lastText, loginUrl, messageText, notify, nudgeText, sendText, todayKST } from './_kakao.js';

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
    if (q.check) { try { return send(res, 200, await reachable()); } catch (e) { return send(res, 200, { error: e.message }); } }
    const next = Object.values(await readMeetings()).filter(m => m.confirmed && m.confirmed >= todayKST()).sort((a, b) => a.confirmed.localeCompare(b.confirmed))[0];
    // &me=1 sends only to the sender ("나와의 채팅"), &kind= confirm|d7|d1|nudge1|nudge2|last|bday, &who= member for last/bday
    const kind = q.kind || 'confirm', who = MEMBERS.includes(q.who) ? q.who : process.env.KAKAO_SENDER;
    const m = next || { title: '🐑신년모임', start: '2026-12-01', end: '2027-01-31', confirmed: '2027-02-13' };
    const text = kind.startsWith('nudge') ? nudgeText(Number(kind.slice(5)) || 1, m) : kind === 'last' ? lastText(who, m) : kind === 'bday' ? bdayText(who) : messageText(kind, m);
    if (q.me) return send(res, 200, await sendText(`test-${Date.now()}`, text, [process.env.KAKAO_SENDER]));
    // &to=dog,pigeon sends a test note only to those members
    const to = String(q.to || '').split(',').filter(x => MEMBERS.includes(x));
    if (to.length) return send(res, 200, await sendText(`test-${Date.now()}`, `🧪 [식구] 테스트 쪽지예요\n\n이 메시지가 보이면 카톡 알림이 잘 연결된 거예요!`, to));
    if (!next) return send(res, 404, { error: '확정된 다음 모임이 없어요.' });
    return send(res, 200, await notify(kind, { ...next, id: `test-${Date.now()}` }));
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
