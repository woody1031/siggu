import { configured, redis } from './_db.js';

// GET /api/photo?mid=<meetingId>&v=<version> -> the meeting photo as JPEG.
// The page always adds a new ?v= when a photo changes, so responses can be cached for good.
export default async function handler(req, res) {
  const mid = String(req.query.mid || '');
  if (!configured() || !/^m[\w-]{1,40}$/.test(mid)) return res.status(404).end();
  try {
    const dataUrl = await redis('GET', `photo:${mid}`);
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
    if (!m) return res.status(404).end();
    res.setHeader('Content-Type', m[1]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(Buffer.from(m[2], 'base64'));
  } catch (e) {
    res.status(500).end();
  }
}
