/* Sitio público.
 *
 * El 31-oct se decidió abrir el sitio: cualquiera con la URL puede ver el
 * reproductor y las letras. Lo que NO se abre, y sigue devolviendo 404:
 *
 *   · sync.html   estudio de sincronización (escribe en el proyecto)
 *
 * stats.html y /api/stats son públicos por decisión del usuario (31-oct):
 * quiere ver la analítica desde el sitio en producción.
 *
 * /api/event también es público: lo llama assets/js/analytics.js en cada visita.
 *
 * Historia: hasta hoy este archivo era una puerta por URL-capacidad
 * (`?k=ACCESS_KEY` + cookie `lr_access`). Se retiró al abrirlo al público; el
 * código de la puerta queda en el historial de git (commit 2470399~1).
 *
 * Los buscadores siguen fuera por `X-Robots-Tag: noindex, nofollow`
 * (vercel.json) y por robots.txt.
 */

const BLOCKED = [
  /^\/sync\.html$/,
];

function notFound() {
  return new Response('404: NOT_FOUND', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export default function middleware(request) {
  const { pathname } = new URL(request.url);
  if (BLOCKED.some((re) => re.test(pathname))) return notFound();
  return; // el resto del sitio es público
}

export const config = {
  matcher: ['/((?!_vercel|favicon\\.ico|robots\\.txt).*)'],
};
