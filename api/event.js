/* Recibe los eventos de assets/js/analytics.js.
 *
 * En Vercel no hay base de datos: cada evento se escribe como una línea JSON en
 * los logs del deployment (Vercel → tu proyecto → Logs). Con el servidor local
 * (tools/server.py) los mismos eventos se guardan en data/analytics.jsonl y se
 * pueden consultar en /api/stats.
 *
 * Para persistir en Vercel: conecta Vercel Blob o KV y sustituye el console.log
 * por la escritura correspondiente.
 */
const LIMITS = { event: 40, sid: 64, path: 200, track: 60, ref: 300 };

const clip = (value, max) =>
  typeof value === 'string' ? value.slice(0, max) : null;

module.exports = (req, res) => {
  res.setHeader('cache-control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ ok: false, error: 'método no permitido' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  if (!body || typeof body !== 'object') {
    res.statusCode = 400;
    return res.json({ ok: false, error: 'cuerpo inválido' });
  }

  const event = clip(body.event, LIMITS.event);
  if (!event) {
    res.statusCode = 400;
    return res.json({ ok: false, error: 'falta event' });
  }

  const entry = {
    t: new Date().toISOString(),
    event,
    sid: clip(body.sid, LIMITS.sid),
    path: clip(body.path, LIMITS.path),
    track: clip(body.track, LIMITS.track),
    line: Number.isFinite(body.line) ? body.line : null,
    ref: clip(body.ref, LIMITS.ref),
    country: req.headers['x-vercel-ip-country'] || null,
    ua: clip(req.headers['user-agent'], 120),
  };

  // Una línea JSON por evento: se filtra en los logs por "lr_event".
  console.log(`lr_event ${JSON.stringify(entry)}`);

  res.statusCode = 204;
  return res.end();
};
