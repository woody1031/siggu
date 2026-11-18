import { configured, photoKey, redis } from './_db.js';

// GET /api/photo?mid=<meetingId>&pid=<photoId> -> one meeting photo as JPEG (no pid = the older single photo).
// Each photo id is new when uploaded and never reused, so responses can be cached for good.
export default async function handler(req, res) {
  const mid = String(req.query.mid || ''), pid = String(req.query.pid || 'legacy');
  if (!configured() || !/^m[\w-]{1,40}$/.test(mid) || !/^[\w-]{1,40}$/.test(pid)) return res.status(404).end();
  try {
    const dataUrl = await redis('GET', photoKey(mid, pid));
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(Buffer.from(m[2], 'base64'));
  } catch (e) {
    res.status(500).end();
  }
}
