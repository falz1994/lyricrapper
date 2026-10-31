/* Puerta de acceso por URL-capacidad.
 *
 * El sitio no se indexa y no se puede ver sin la clave: hay que entrar una vez
 * con  https://<sitio>/?k=<ACCESS_KEY>  y se guarda una cookie de un año.
 *
 * La clave NO está en el repo (es público): se configura como variable de
 * entorno ACCESS_KEY en Vercel. Si no está definida, el middleware devuelve 404
 * a todo — falla cerrado, nunca abierto.
 */
const COOKIE = 'lr_access';
const MAX_AGE = 60 * 60 * 24 * 365;

export const config = {
  // todo excepto los endpoints internos de Vercel y robots.txt
  matcher: ['/((?!_vercel|favicon\\.ico|robots\\.txt).*)'],
};

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
  const key = process.env.ACCESS_KEY;
  if (!key) return notFound();

  const url = new URL(request.url);
  const provided = url.searchParams.get('k');
  const cookie = request.headers.get('cookie') || '';
  const authorized = cookie.split(/;\s*/).some((part) => part === `${COOKIE}=${key}`);

  // ?k=correcta → cookie y redirección limpia (la clave no queda en la barra)
  if (provided === key) {
    url.searchParams.delete('k');
    const target = `${url.pathname}${url.search}`;
    return new Response(null, {
      status: 307,
      headers: {
        location: target,
        'set-cookie': `${COOKIE}=${key}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store',
      },
    });
  }

  if (provided !== null) return notFound();   // clave incorrecta
  if (authorized) return;                      // pasa al contenido

  return notFound();
}
