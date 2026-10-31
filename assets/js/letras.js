/* Sección de letras: una página por canción, texto limpio y seleccionable.
   El audio es opcional: si el .webm/.mp3 no existe, se muestra un aviso y la
   letra sigue siendo legible. No se inventa nada: los tiempos vienen del JSON. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  tracks: [],      // [{id, title, artist, file}]
  current: null,   // track cargado
  query: '',
};

/* ------------------------------------------------------------------ datos */

async function loadIndex() {
  const res = await fetch('data/tracks.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('no se pudo leer data/tracks.json');
  const data = await res.json();
  return (data.tracks || []).filter((t) => t && t.id && t.file);
}

async function loadTrack(entry) {
  const res = await fetch(entry.file, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`no se pudo leer ${entry.file}`);
  return res.json();
}

/* Sólo metadatos: pregunta por el fichero sin descargarlo entero. */
async function audioExists(src) {
  if (!src) return false;
  try {
    const res = await fetch(src, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- vista */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderNav() {
  const nav = $('#letras-nav');
  const q = state.query.trim().toLowerCase();
  const items = state.tracks.filter((t) =>
    !q ||
    String(t.title || '').toLowerCase().includes(q) ||
    String(t.artist || '').toLowerCase().includes(q));

  if (!items.length) {
    nav.innerHTML = '<p class="letras-nav-empty">Sin resultados.</p>';
    return;
  }

  nav.innerHTML = items.map((t) => `
    <a href="#${esc(t.id)}" class="letras-chip${state.current?.id === t.id ? ' is-active' : ''}"
       data-id="${esc(t.id)}">
      <span class="chip-title">${esc(t.title || t.id)}</span>
      <span class="chip-artist">${esc(t.artist || '—')}</span>
    </a>`).join('');

  $$('.letras-chip', nav).forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      history.replaceState(null, '', `#${a.dataset.id}`);
      open(a.dataset.id);
    });
  });
}

function renderTrack(track, entry) {
  const meta = [
    track.artist || entry.artist,
    track.album,
    track.duration ? fmtTime(track.duration) : null,
    `${(track.lines || []).length} líneas`,
  ].filter(Boolean).map(esc).join(' · ');

  const hasAudio = track.__hasAudio;

  const notices = hasAudio
    ? `<div class="letras-audio-note ok">
         <span>▶ Audio disponible en el reproductor</span>
         <a href="./?track=${encodeURIComponent(track.id)}">Abrir con la letra sincronizada →</a>
       </div>`
    : `<div class="letras-audio-note">
         <span>Esta letra está lista; el audio todavía no está publicado.</span>
         <span class="muted">Los tiempos por línea están en el JSON, así que en cuanto
         exista el fichero la sincronización funciona sin tocar nada más.</span>
       </div>`;

  const lines = (track.lines || [])
    .filter((l) => typeof l.start === 'number' && String(l.text || '').trim())
    .sort((a, b) => a.start - b.start)
    .map((l) => `
      <li class="letras-line" data-start="${Number(l.start)}">
        <span class="letras-time">${fmtTime(l.start)}</span>
        <span class="letras-text">${esc(l.text)}</span>
      </li>`).join('');

  $('#letras-main').innerHTML = `
    <article class="letras-article" id="track-${esc(track.id)}">
      <header class="letras-article-head">
        <h2>${esc(track.title || entry.title || track.id)}</h2>
        <p class="letras-meta">${meta}</p>
        ${notices}
      </header>
      <ol class="letras-lines">${lines}</ol>
      <p class="letras-copy-hint">Puedes seleccionar y copiar el texto libremente.</p>
    </article>`;

  $('#letras-sub').textContent =
    `${esc(track.title || '')} — ${esc(track.artist || '')}`.replace(/\s+—\s+$/, '');
  document.title = `${track.title || track.id} — Letras`;
}

function renderError(msg) {
  $('#letras-main').innerHTML =
    `<p class="letras-empty">${esc(msg)}</p>`;
  $('#letras-sub').textContent = 'Letras';
}

/* ------------------------------------------------------------------- flujo */

async function open(id) {
  const entry = state.tracks.find((t) => t.id === id) || state.tracks[0];
  if (!entry) return renderError('No hay canciones con letra todavía.');

  try {
    const track = await loadTrack(entry);
    track.__hasAudio = await audioExists(track.audio);
    state.current = track;
    renderNav();
    renderTrack(track, entry);
    window.lrAnalytics?.track('lyrics_open', { track: track.id });
  } catch (err) {
    renderError(`No se pudo cargar la letra: ${err.message}`);
  }
}

function wireSearch() {
  const input = $('#letras-q');
  if (!input) return;
  input.addEventListener('input', () => {
    state.query = input.value;
    renderNav();
  });
}

(async function init() {
  wireSearch();
  try {
    state.tracks = await loadIndex();
  } catch (err) {
    return renderError(err.message);
  }
  if (!state.tracks.length) return renderError('No hay canciones en el índice.');

  const initial = decodeURIComponent(location.hash.slice(1)) || state.tracks[0].id;
  open(initial);

  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && id !== state.current?.id) open(id);
  });
})();
