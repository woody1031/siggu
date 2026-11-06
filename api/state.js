import { configured, readState, send } from './_db.js';

// GET /api/state -> { meetings: [...] }
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'GET만 쓸 수 있어요.' });
  if (!configured()) return send(res, 503, { error: '데이터베이스가 아직 연결되지 않았어요.', code: 'not_configured' });
  try {
    send(res, 200, await readState());
  } catch (e) {
    send(res, 500, { error: '데이터를 불러오지 못했어요. 잠시 뒤 다시 열어주세요.' });
  }
}
