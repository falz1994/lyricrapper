/* Recibe los eventos de assets/js/analytics.js.
 *
 * Dos destinos, en este orden:
 *   1. Supabase (tabla public.lr_events) si SUPABASE_URL y
 *      SUPABASE_SERVICE_KEY están definidas. Es lo que da histórico.
 *   2. Siempre, además, una línea en los logs del deployment (plan B y
 *      depuración: Vercel → Logs → filtra "lr_event").
 *
 * La service key NUNCA sale al navegador: sólo se usa aquí, en el servidor.
 */
const LIMITS = { event: 40, sid: 64, path: 200, track: 60, ref: 300 };

const clip = (value, max) =>
  typeof value === 'string' ? value.slice(0, max) : null;

async function store(entry) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { stored: false, reason: 'sin Supabase configurado' };

  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/lr_events`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify(entry),
  });

  if (!res.ok) {
    return { stored: false, reason: `${res.status} ${(await res.text()).slice(0, 160)}` };
  }
  return { stored: true };
}

module.exports = async (req, res) => {
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
    event,
    sid: clip(body.sid, LIMITS.sid),
    path: clip(body.path, LIMITS.path),
    track: clip(body.track, LIMITS.track),
    line: Number.isFinite(body.line) ? body.line : null,
    ref: clip(body.ref, LIMITS.ref),
    country: req.headers['x-vercel-ip-country'] || null,
    ua: clip(req.headers['user-agent'], 120),
  };

  // Plan B y traza: siempre queda en los logs, haya o no Supabase.
  console.log(`lr_event ${JSON.stringify(entry)}`);

  try {
    const result = await store(entry);
    if (!result.stored) console.log(`lr_event_skip ${result.reason}`);
  } catch (err) {
    console.log(`lr_event_error ${String(err).slice(0, 160)}`);
  }

  // La analítica nunca debe romper la página: siempre 204.
  res.statusCode = 204;
  return res.end();
};
