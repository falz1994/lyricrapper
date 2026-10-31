/* Resumen de analítica en producción.
 *
 * En Vercel no hay base de datos: `api/event.js` escribe cada evento en los
 * logs del deployment (retención de un día en Hobby). Para que este endpoint
 * devuelva números hace falta un almacén:
 *
 *   Vercel → Storage → Create Database → Blob
 *
 * Al crearlo, Vercel añade la variable BLOB_READ_WRITE_TOKEN al proyecto. Con
 * eso, api/event.js puede ir acumulando los eventos en un blob y este endpoint
 * devolver el mismo JSON que tools/server.py en /api/stats.
 *
 * Mientras no exista el almacén, responde 503 con el motivo: el panel
 * (stats.html) lo muestra tal cual en vez de un error opaco.
 */
module.exports = (req, res) => {
  res.setHeader('cache-control', 'no-store');

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.statusCode = 503;
    return res.json({
      ok: false,
      error: 'sin almacenamiento: los eventos se escriben en los logs del deployment (1 día)',
      hint: 'Vercel → Storage → Create → Blob, y vuelve a desplegar. Después este panel tendrá histórico.',
      where: 'Vercel → proyecto → Logs → busca "lr_event"',
    });
  }

  res.statusCode = 501;
  return res.json({
    ok: false,
    error: 'almacén detectado, pero el lector todavía no está implementado',
    hint: 'Avísame y lo conecto: api/event.js acumula en un blob y este endpoint lo agrega.',
  });
};
