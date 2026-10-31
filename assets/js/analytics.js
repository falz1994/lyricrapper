/* Analítica propia y mínima.
 *
 * - Sin cookies de terceros, sin fingerprinting: sólo un id aleatorio de sesión
 *   guardado en localStorage.
 * - Respeta Do Not Track.
 * - Manda los eventos a /api/event con sendBeacon (no bloquea la página).
 *
 * Eventos que emite: pageview, track_open, line_click, play.
 * Para emitir los tuyos: window.lrAnalytics.track('evento', { ...props });
 */
(() => {
  const ENDPOINT = '/api/event';
  const SID_KEY = 'lr_sid';
  const MAX = { event: 40, path: 200, track: 60, ref: 300 };

  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') {
    window.lrAnalytics = { track: () => {} };
    return;
  }

  const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);

  let sid = null;
  try {
    sid = localStorage.getItem(SID_KEY);
    if (!sid) {
      sid = (crypto.randomUUID && crypto.randomUUID()) ||
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(SID_KEY, sid);
    }
  } catch {
    sid = null;                     // modo privado sin almacenamiento: sesión anónima
  }

  function track(event, props = {}) {
    if (!event) return;
    const payload = {
      event: clip(event, MAX.event),
      sid,
      path: clip(location.pathname, MAX.path),
      track: clip(props.track, MAX.track),
      line: Number.isFinite(props.line) ? props.line : null,
      ref: clip(document.referrer || props.ref, MAX.ref),
    };

    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        const sent = navigator.sendBeacon(
          ENDPOINT, new Blob([body], { type: 'application/json' }),
        );
        if (sent) return;
      }
    } catch { /* cae al fetch */ }

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* la analítica nunca debe romper la página */ });
  }

  window.lrAnalytics = { track };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => track('pageview'), { once: true });
  } else {
    track('pageview');
  }
})();
