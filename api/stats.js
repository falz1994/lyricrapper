/* Resumen de analítica en producción.
 *
 * Llama a la función public.lr_stats() de Supabase (ver supabase/lr_events.sql),
 * que agrega los eventos de public.lr_events. Devuelve el mismo JSON que
 * tools/server.py en /api/stats, así que stats.html sirve en los dos sitios.
 *
 * Si falta configuración o la tabla aún no existe, responde 503 con el motivo
 * en vez de un error opaco.
 */
module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    res.statusCode = 503;
    return res.json({
      ok: false,
      error: 'sin almacenamiento configurado',
      hint: 'Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en las variables del proyecto.',
      where: 'Vercel → proyecto → Logs → busca "lr_event"',
    });
  }

  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/lr_stats`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 200);
      res.statusCode = 503;
      return res.json({
        ok: false,
        error: 'la base de datos no responde a lr_stats()',
        hint: 'Ejecuta supabase/lr_events.sql en el SQL Editor de Supabase.',
        detail,
      });
    }

    const data = await r.json();
    res.statusCode = 200;
    return res.json(data);
  } catch (err) {
    res.statusCode = 502;
    return res.json({ ok: false, error: String(err).slice(0, 200) });
  }
};
