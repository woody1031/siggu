import { send } from './_db.js';

// POST /api/blob-upload — issues short-lived tokens so the page can upload photos
// (original, display and thumbnail) straight to Vercel Blob, past the 4.5MB function limit.
const PATH = /^siggu\/m[\w-]{1,40}\/(orig|disp|thumb)-[\w.-]{1,80}$/;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST만 쓸 수 있어요.' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return send(res, 503, { error: '사진 저장소가 아직 연결되지 않았어요.', code: 'blob_not_configured' });
  try {
    const { handleUpload } = await import('@vercel/blob/client');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        if (!PATH.test(pathname)) throw new Error('bad path');
        return { allowedContentTypes: TYPES, maximumSizeInBytes: 40 * 1024 * 1024, addRandomSuffix: true };
      },
    });
    send(res, 200, json);
  } catch (e) {
    send(res, 400, { error: '사진을 올릴 준비를 하지 못했어요. 다시 해주세요.' });
  }
}
