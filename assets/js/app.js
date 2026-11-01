/* ==========================================================================
   Lyric Rapper — reproductor de letras sincronizadas
   --------------------------------------------------------------------------
   Idea central: cada línea de la letra tiene un `start` y un `end` en
   segundos. Al hacer clic en una línea se hace audio.currentTime = start.
   No hay magia: sólo un JSON con tiempos y un <audio>.
   ========================================================================== */

const PREROLL = 0.12;        // segundos de margen antes del inicio real de la línea
const STORE_KEY = 'lyric-rapper:';
const AUTOSCROLL_PAUSE = 4000; // ms sin autoscroll después de que el usuario toca la página
const SPEEDS = [1, 0.75, 1.25, 1.5];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const el = {
  audio: $('#audio'),
  lyrics: $('#lyrics'),
  select: $('#track-select'),
  trackList: $('#track-list'),
  queueCount: $('#queue-count'),
  trackMenu: $('#track-menu'),
  picker: $('#btn-picker'),
  pickerName: $('#picker-name'),
  pickerArtist: $('#picker-artist'),
  banner: $('#banner'),
  bannerTitle: $('#banner-title'),
  bannerText: $('#banner-text'),
  trackTitle: $('#track-title'),
  trackArtist: $('#track-artist'),
  coverArt: $('#cover-art'),
  coverKicker: $('#cover-kicker'),
  statLine: $('#stat-line'),
  statTime: $('#stat-time'),
  statBpm: $('#stat-bpm'),
  search: $('#search'),
  searchClear: $('#search-clear'),
  btnPlay: $('#btn-play'),
  btnPrev: $('#btn-prev'),
  btnNext: $('#btn-next'),
  btnMute: $('#btn-mute'),
  btnLoop: $('#btn-loop'),
  btnTimes: $('#btn-times'),
  btnShare: $('#btn-share'),
  btnSpeed: $('#btn-speed'),
  btnHelp: $('#btn-help'),
  volume: $('#volume'),
  progress: $('#progress'),
  progressFill: $('#progress-fill'),
  progressBuffer: $('#progress-buffer'),
  progressTicks: $('#progress-ticks'),
  progressKnob: $('#progress-knob'),
  timeCurrent: $('#time-current'),
  timeTotal: $('#time-total'),
  lyricsFoot: $('#lyrics-foot'),
  toast: $('#toast'),
  help: $('#help'),
};

const state = {
  tracks: [],
  track: null,
  lines: [],
  active: -1,
  scrubbing: false,
  loopLine: false,
  showTimes: false,
  manualScrollUntil: 0,
  lastSavedAt: 0,
  rafId: 0,
  loaded: false,
};

/* ---------------------------------------------------------------- utilidades */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtStamp(sec) {
  if (!Number.isFinite(sec)) return '--';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ');
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(STORE_KEY + key));
    localStorage.setItem(STORE_KEY + key, JSON.stringify(value));
  } catch { /* modo privado / cuota llena: no es crítico */ }
  return null;
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2200);
}

function showBanner(title, html) {
  el.bannerTitle.textContent = title;
  el.bannerText.innerHTML = html;
  el.banner.hidden = false;
}
el.banner.querySelector('.banner-close')?.addEventListener('click', () => { el.banner.hidden = true; });

/* ---------------------------------------------------------------- carga de datos */

async function boot() {
  if (location.protocol === 'file:') {
    showBanner(
      'Abre la página con un servidor local',
      'El navegador bloquea la carga de archivos <code>.json</code> desde <code>file://</code>. ' +
      'En la carpeta del proyecto ejecuta <code>./serve.sh</code> y entra a ' +
      '<code>http://localhost:8000</code>.'
    );
  }

  try {
    const res = await fetch('data/tracks.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const index = await res.json();
    state.tracks = index.tracks || [];
  } catch (err) {
    el.lyrics.innerHTML = '<div class="lyrics-empty">No se pudo cargar <code>data/tracks.json</code>. ' +
      '¿Estás sirviendo la carpeta con un servidor HTTP?</div>';
    console.error(err);
    return;
  }

  if (!state.tracks.length) {
    el.lyrics.innerHTML = '<div class="lyrics-empty">Todavía no hay canciones en <code>data/tracks.json</code>.</div>';
    return;
  }

  renderTrackSelect();

  const wanted = new URLSearchParams(location.search).get('track') || location.hash.match(/^#([\w-]+)/)?.[1];
  const last = store('lastTrack');
  const initial = state.tracks.find(t => t.id === wanted)?.id
    || state.tracks.find(t => t.id === last)?.id
    || state.tracks[0].id;

  await loadTrack(initial);
}

function renderTrackSelect() {
  el.select.innerHTML = state.tracks
    .map(t => `<option value="${t.id}">${escapeHtml(t.title)} — ${escapeHtml(t.artist || '')}</option>`)
    .join('');
  el.select.addEventListener('change', () => selectTrack(el.select.value));
  renderQueue();
}

/* Lista de canciones: la UI real. El <select> quedó oculto, así que esta lista
 * es la que se maneja con ratón y teclado (son botones nativos). */
function renderQueue() {
  if (!el.trackList) return;
  el.queueCount.textContent = state.tracks.length === 1
    ? '1 canción'
    : `${state.tracks.length} canciones`;

  el.trackList.innerHTML = state.tracks.map((t, i) => {
    const artist = t.artist || '';
    return `
      <li class="queue-item" data-id="${escapeHtml(t.id)}">
        <button class="queue-btn" type="button" data-id="${escapeHtml(t.id)}"
                aria-current="false" title="${escapeHtml(t.title)} — ${escapeHtml(artist)}">
          <span class="queue-index" aria-hidden="true">
            <span class="num">${String(i + 1).padStart(2, '0')}</span>
            <span class="eq"><i></i><i></i><i></i></span>
          </span>
          <span class="queue-body">
            <span class="queue-name">${escapeHtml(t.title)}</span>
            <span class="queue-artist">${escapeHtml(artist)}</span>
          </span>
          <span class="queue-time">${fmtTime(t.duration || 0)}</span>
        </button>
      </li>`;
  }).join('');

  el.trackList.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.queue-btn');
    if (!btn) return;
    selectTrack(btn.dataset.id);
    closePicker(true);
  });

  bindPicker();
  loadQueueDurations();
}

/* La duración vive en el JSON de cada pista, no en el índice: se cargan en
 * paralelo y sin bloquear el reproductor. Si una falla, se queda en 0:00. */
async function loadQueueDurations() {
  await Promise.all(state.tracks.map(async (t) => {
    if (t.duration) { setQueueDuration(t.id, t.duration); return; }
    try {
      const res = await fetch(t.file, { cache: 'force-cache' });
      if (!res.ok) return;
      const track = await res.json();
      if (track.duration) setQueueDuration(t.id, track.duration);
    } catch { /* la lista nunca debe romper la página */ }
  }));
}

function selectTrack(id) {
  loadTrack(id);
  const url = new URL(location.href);
  url.searchParams.set('track', id);
  url.hash = '';
  history.replaceState(null, '', url);
}

/* ---------------------------------------------------------- selector de canción */

function bindPicker() {
  if (!el.picker || !el.trackMenu) return;
  el.picker.addEventListener('click', (ev) => {
    ev.stopPropagation();
    togglePicker();
  });

  // cerrar al hacer clic fuera o con Escape
  document.addEventListener('click', (ev) => {
    if (el.trackMenu.hidden) return;
    if (!el.trackMenu.contains(ev.target) && !el.picker.contains(ev.target)) closePicker();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !el.trackMenu.hidden) { closePicker(true); }
  });
}

function togglePicker() {
  if (el.trackMenu.hidden) openPicker(); else closePicker();
}

function openPicker() {
  el.trackMenu.hidden = false;
  el.picker.setAttribute('aria-expanded', 'true');
}

function closePicker(focusBack = false) {
  if (!el.trackMenu) return;
  el.trackMenu.hidden = true;
  el.picker?.setAttribute('aria-expanded', 'false');
  if (focusBack) el.picker?.focus();
}

/* Marca en la lista la canción que está sonando. */
function markQueueActive(id) {
  if (!el.trackList) return;
  for (const item of el.trackList.querySelectorAll('.queue-item')) {
    const on = item.dataset.id === id;
    item.classList.toggle('is-active', on);
    item.querySelector('.queue-btn')?.setAttribute('aria-current', on ? 'true' : 'false');
  }
}

function setQueueDuration(id, seconds) {
  const slot = el.trackList?.querySelector(`.queue-item[data-id="${id}"] .queue-time`);
  if (slot && seconds) slot.textContent = fmtTime(seconds);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function loadTrack(id) {
  const meta = state.tracks.find(t => t.id === id) || state.tracks[0];
  if (!meta) return;

  let track;
  try {
    const res = await fetch(meta.file, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    track = await res.json();
  } catch (err) {
    el.lyrics.innerHTML = `<div class="lyrics-empty">No se pudo cargar <code>${escapeHtml(meta.file)}</code>.</div>`;
    console.error(err);
    return;
  }

  state.track = track;
  state.lines = (track.lines || [])
    .filter(l => typeof l.start === 'number' && String(l.text || '').trim())
    .map(l => ({
      start: l.start,
      end: typeof l.end === 'number' ? l.end : null,
      text: String(l.text).trim(),
    }))
    .sort((a, b) => a.start - b.start);

  state.active = -1;
  state.loaded = true;
  store('lastTrack', track.id);

  // metadatos visuales
  const title = track.title || meta.title;
  const artist = track.artist || meta.artist || '';
  el.trackTitle.textContent = title;
  el.trackArtist.textContent = artist;
  el.coverKicker.textContent = track.kicker || 'Piloto';
  el.coverArt.dataset.initials = title
    .split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  el.statBpm.textContent = track.bpm ? `${track.bpm} BPM` : '—';
  el.select.value = track.id;
  if (el.pickerName) el.pickerName.textContent = title;
  if (el.pickerArtist) el.pickerArtist.textContent = artist;
  el.picker?.setAttribute('title', `${title} — ${artist}`);
  markQueueActive(track.id);
  // la duración real vive en el JSON de la pista, no en el índice
  if (track.duration) setQueueDuration(track.id, track.duration);
  document.title = `${title} — Lyric Rapper`;

  // audio: Opus (webm) primero; si el navegador no lo traga, cae al mp3
  el.audio.pause();
  el.audio.removeAttribute('src');
  el.audio.replaceChildren();
  const sources = [[track.audio, 'audio/webm; codecs=opus']];
  if (track.audioFallback) sources.push([track.audioFallback, 'audio/mpeg']);
  for (const [src, type] of sources) {
    const source = document.createElement('source');
    source.src = src;
    source.type = type;
    el.audio.appendChild(source);
  }
  el.audio.playbackRate = Number(store('rate')) || 1;
  el.btnSpeed.textContent = `${el.audio.playbackRate}×`;

  // analítica (silenciosa si no existe el módulo)
  window.lrAnalytics?.track('track_open', { track: track.id });

  el.timeTotal.textContent = fmtTime(track.duration || 0);
  el.audio.addEventListener('error', onAudioError, { once: true });
  el.audio.addEventListener('loadedmetadata', onMetadata, { once: true });
  el.audio.load();

  renderLines();
  renderTicks();
  applySearch();
  updateMediaSession(track);

  // posición previa o enlace profundo
  const at = new URLSearchParams(location.search).get('at');
  const saved = Number(store('pos:' + track.id));
  const startAt = Number.isFinite(Number(at)) && at !== null ? Number(at)
    : Number.isFinite(saved) && saved > 1 ? saved : 0;

  if (startAt > 0) {
    const seek = () => {
      seekAudio(clamp(startAt, 0, el.audio.duration || track.duration || startAt));
      renderProgress();
      syncActive(true);
    };
    if (el.audio.readyState >= 1) seek();
    else el.audio.addEventListener('loadedmetadata', seek, { once: true });
  }
}

function onAudioError() {
  const src = state.track?.audio || '';
  showBanner(
    'Falta el archivo de audio',
    `No se pudo abrir <code>${escapeHtml(src)}</code>. Coloca tu archivo en ` +
    `<code>assets/audio/</code> con ese nombre (o cambia el campo <code>audio</code> del JSON). ` +
    `Formatos recomendados: <code>.mp3</code> o <code>.m4a</code>.`
  );
}

function onMetadata() {
  const dur = el.audio.duration;
  el.timeTotal.textContent = fmtTime(dur);
  renderTicks();
  renderProgress();
}

/* ---------------------------------------------------------------- letra */

function renderLines() {
  const frag = document.createDocumentFragment();
  state.lines.forEach((line, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'line';
    btn.dataset.index = String(i);
    btn.innerHTML =
      `<span class="line-idx" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="line-text">${escapeHtml(line.text)}</span>` +
      `<span class="line-times" aria-hidden="true">${fmtStamp(line.start)} → ${fmtStamp(line.end ?? line.start)}</span>`;
    btn.setAttribute('aria-label', `Línea ${i + 1}: ${line.text}`);
    frag.appendChild(btn);
  });

  el.lyrics.replaceChildren(frag);
  if (!state.lines.length) {
    el.lyrics.innerHTML = '<div class="lyrics-empty">Esta canción no tiene líneas todavía. ' +
      'Genéralas en el <a href="sync.html">estudio de sincronización</a>.</div>';
  }
  const dur = state.track?.duration;
  el.lyricsFoot.textContent = state.lines.length
    ? `${state.lines.length} líneas${dur ? ` · ${fmtTime(dur)} de audio` : ''} · clic = empezar ahí`
    : '';
}

function renderTicks() {
  const dur = el.audio.duration || state.track?.duration || 0;
  if (!dur) { el.progressTicks.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  for (const line of state.lines) {
    if (line.start <= 0 || line.start >= dur) continue;
    const i = document.createElement('i');
    i.style.left = `${(line.start / dur) * 100}%`;
    frag.appendChild(i);
  }
  el.progressTicks.replaceChildren(frag);
}

/* ---------------------------------------------------------------- reproducción */

/* Saltar de forma confiable -------------------------------------------------
   Si el servidor no anuncia `Range`, el navegador recorta el salto a la parte
   que ya descargó (currentTime vuelve a 0). Reintentamos hasta que el salto
   "pegue", que suele pasar en cuanto llegan los primeros bytes del tramo. */
let pendingSeek = null;
let seekTries = 0;

function seekAudio(t) {
  const dur = el.audio.duration || state.track?.duration || 0;
  pendingSeek = clamp(Number(t) || 0, 0, dur || Number(t) || 0);
  seekTries = 0;
  el.audio.currentTime = pendingSeek;
  verifySeek();
}

function verifySeek() {
  if (pendingSeek == null) return;
  if (Math.abs(el.audio.currentTime - pendingSeek) < 0.4) { pendingSeek = null; return; }
  if (seekTries++ > 40) { pendingSeek = null; return; }
  setTimeout(() => {
    if (pendingSeek == null) return;
    el.audio.currentTime = pendingSeek;
    verifySeek();
  }, 120);
}

function lineEnd(i) {
  const line = state.lines[i];
  if (!line) return 0;
  return line.end ?? state.lines[i + 1]?.start ?? el.audio.duration ?? line.start;
}

/**
 * Índice de la última línea que ya empezó (-1 antes de la primera).
 * Se adelanta PREROLL para que, al hacer clic, la línea elegida quede
 * resaltada de inmediato y no la anterior.
 */
function indexAt(t) {
  const lines = state.lines;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start <= t + PREROLL + 0.001) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function seekToLine(i, { play = true, fromClick = false } = {}) {
  const line = state.lines[i];
  if (!line) return;
  seekAudio(Math.max(0, line.start - PREROLL));
  renderProgress();
  if (play) {
    el.audio.play().catch(() => { /* autoplay bloqueado hasta interacción */ });
  }
  syncActive(true);
  if (fromClick) {
    window.lrAnalytics?.track('line_click', { track: state.track?.id, line: i + 1 });
    const elLine = el.lyrics.children[i];
    if (elLine && !isLineVisible(elLine)) {
      state.manualScrollUntil = 0;
      elLine.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  updateHash();
}

function isLineVisible(node) {
  const r = node.getBoundingClientRect();
  return r.top >= 70 && r.bottom <= window.innerHeight - 110;
}

function stepLine(delta) {
  const current = state.active >= 0 ? state.active : indexAt(el.audio.currentTime);
  const next = clamp(current + delta, 0, state.lines.length - 1);
  seekToLine(next);
}

function syncActive(force = false) {
  const i = indexAt(el.audio.currentTime);
  if (i === state.active && !force) return;

  const prev = state.active;
  state.active = i;

  if (prev >= 0) {
    const old = el.lyrics.children[prev];
    old?.classList.remove('is-active');
    old?.removeAttribute('aria-current');
  }

  const node = el.lyrics.children[i];
  if (node) {
    node.classList.add('is-active');
    node.setAttribute('aria-current', 'true');
    if (Date.now() > state.manualScrollUntil) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  $$('.line', el.lyrics).forEach((n, idx) => {
    n.classList.toggle('is-past', idx < i);
    n.classList.toggle('is-next', idx === i + 1);
  });

  el.statLine.textContent = i >= 0 ? `${i + 1}/${state.lines.length}` : `–/${state.lines.length}`;
  updateHash();
}

function renderProgress() {
  const dur = el.audio.duration || state.track?.duration || 0;
  const t = el.audio.currentTime || 0;
  const pct = dur ? clamp((t / dur) * 100, 0, 100) : 0;

  el.progressFill.style.width = `${pct}%`;
  el.progressKnob.style.left = `${pct}%`;
  el.progress.setAttribute('aria-valuenow', pct.toFixed(1));
  el.progress.setAttribute('aria-valuetext', `${fmtTime(t)} de ${fmtTime(dur)}`);
  el.timeCurrent.textContent = fmtTime(t);
  el.statTime.textContent = fmtTime(t);

  try {
    const b = el.audio.buffered;
    if (b.length && dur) el.progressBuffer.style.width = `${(b.end(b.length - 1) / dur) * 100}%`;
  } catch { /* noop */ }

  // guardar posición cada ~2 s
  if (Date.now() - state.lastSavedAt > 2000 && state.track) {
    state.lastSavedAt = Date.now();
    store('pos:' + state.track.id, t);
  }
}

function tick() {
  if (el.audio.paused) { state.rafId = 0; return; }

  if (state.loopLine && state.active >= 0) {
    const end = lineEnd(state.active);
    if (el.audio.currentTime >= end - 0.02) {
      seekAudio(Math.max(0, state.lines[state.active].start - PREROLL));
      renderProgress();
      state.rafId = requestAnimationFrame(tick);
      return;
    }
  }

  renderProgress();
  syncActive();
  state.rafId = requestAnimationFrame(tick);
}

function startLoop() {
  if (!state.rafId) state.rafId = requestAnimationFrame(tick);
}

/* ---------------------------------------------------------------- enlaces */

let hashTimer = 0;
function updateHash() {
  if (!state.track) return;
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const url = new URL(location.href);
    url.searchParams.set('track', state.track.id);
    if (state.active >= 0) {
      url.searchParams.set('at', state.lines[state.active].start.toFixed(2));
      url.hash = `l${state.active + 1}`;
    } else {
      url.searchParams.delete('at');
      url.hash = '';
    }
    history.replaceState(null, '', url);
  }, 400);
}

async function share() {
  const url = new URL(location.href);
  if (state.active >= 0) url.searchParams.set('at', state.lines[state.active].start.toFixed(2));
  const label = state.active >= 0 ? `línea ${state.active + 1}` : 'esta canción';
  try {
    await navigator.clipboard.writeText(url.toString());
    toast(`Enlace copiado (${label})`);
  } catch {
    toast('No se pudo copiar el enlace');
  }
}

/* ---------------------------------------------------------------- búsqueda */

function applySearch() {
  const q = normalize(el.search.value.trim());
  el.searchClear.hidden = !el.search.value;

  let matches = 0;
  $$('.line', el.lyrics).forEach((node, i) => {
    const textNode = node.querySelector('.line-text');
    const raw = state.lines[i]?.text || '';
    if (!q) {
      node.classList.remove('is-filtered');
      textNode.textContent = raw;
      return;
    }
    const hit = normalize(raw).includes(q);
    node.classList.toggle('is-filtered', !hit);
    if (hit) {
      matches++;
      textNode.innerHTML = highlight(raw, q);
    } else {
      textNode.textContent = raw;
    }
  });

  if (q) {
    el.lyricsFoot.textContent = `${matches} línea${matches === 1 ? '' : 's'} con “${el.search.value.trim()}”`;
  } else {
    const dur = state.track?.duration;
    el.lyricsFoot.textContent = state.lines.length
      ? `${state.lines.length} líneas${dur ? ` · ${fmtTime(dur)} de audio` : ''} · clic = empezar ahí`
      : '';
  }
}

/**
 * Normaliza conservando el mapa carácter → índice original, para poder
 * resaltar sobre el texto real aunque tenga acentos o puntuación.
 */
function normalizeWithMap(text) {
  let out = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const base = text[i].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    out += /[a-z0-9ñ\s]/.test(base) ? base : ' ';
    map.push(i);
  }
  return { out, map };
}

/** Resalta coincidencias sin romper acentos, mayúsculas ni puntuación. */
function highlight(text, needle) {
  const { out: norm, map } = normalizeWithMap(text);
  const parts = [];
  let from = 0;
  let at = norm.indexOf(needle, from);
  while (at !== -1) {
    const start = map[at];
    const end = map[at + needle.length - 1] + 1;
    parts.push(escapeHtml(text.slice(from, start)));
    parts.push(`<span class="hl">${escapeHtml(text.slice(start, end))}</span>`);
    from = end;
    at = norm.indexOf(needle, from);
  }
  parts.push(escapeHtml(text.slice(from)));
  return parts.join('');
}

/* ---------------------------------------------------------------- media session */

function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || '',
      album: track.album || 'Lyric Rapper',
    });
    navigator.mediaSession.setActionHandler('play', () => el.audio.play());
    navigator.mediaSession.setActionHandler('pause', () => el.audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => stepLine(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => stepLine(1));
    navigator.mediaSession.setActionHandler('seekbackward', () => seekAudio(el.audio.currentTime - 5));
    navigator.mediaSession.setActionHandler('seekforward', () => seekAudio(el.audio.currentTime + 5));
  } catch { /* Safari antiguo */ }
}

/* ---------------------------------------------------------------- eventos */

function wireEvents() {
  // clic en una línea → empezar exactamente ahí
  el.lyrics.addEventListener('click', (e) => {
    const btn = e.target.closest('.line');
    if (!btn) return;
    seekToLine(Number(btn.dataset.index), { play: true, fromClick: true });
  });

  el.btnPlay.addEventListener('click', () => {
    if (el.audio.paused) el.audio.play().catch(() => {});
    else el.audio.pause();
  });

  el.btnPrev.addEventListener('click', () => stepLine(-1));
  el.btnNext.addEventListener('click', () => stepLine(1));

  el.audio.addEventListener('play', () => {
    document.body.classList.add('is-playing');
    el.btnPlay.setAttribute('aria-label', 'Pausar');
    window.lrAnalytics?.track('play', { track: state.track?.id });
    startLoop();
  });

  el.audio.addEventListener('pause', () => {
    document.body.classList.remove('is-playing');
    el.btnPlay.setAttribute('aria-label', 'Reproducir');
    renderProgress();
    syncActive(true);
    if (state.track) store('pos:' + state.track.id, el.audio.currentTime);
  });

  el.audio.addEventListener('timeupdate', () => {
    if (el.audio.paused) { renderProgress(); syncActive(); }
  });

  el.audio.addEventListener('ended', () => {
    document.body.classList.remove('is-playing');
    syncActive(true);          // deja resaltada la última línea
  });

  el.audio.addEventListener('seeked', () => { renderProgress(); syncActive(true); });
  el.audio.addEventListener('progress', verifySeek);
  el.audio.addEventListener('canplay', verifySeek);

  // volumen
  const savedVol = store('volume');
  const vol = typeof savedVol === 'number' ? savedVol : 1;
  el.audio.volume = vol;
  el.volume.value = String(vol);
  el.volume.addEventListener('input', () => {
    el.audio.volume = Number(el.volume.value);
    el.audio.muted = false;
    store('volume', el.audio.volume);
    document.body.classList.toggle('is-muted', el.audio.volume === 0);
  });

  el.btnMute.addEventListener('click', () => {
    el.audio.muted = !el.audio.muted;
    document.body.classList.toggle('is-muted', el.audio.muted || el.audio.volume === 0);
  });

  // velocidad
  el.btnSpeed.addEventListener('click', () => {
    const i = SPEEDS.indexOf(el.audio.playbackRate);
    const next = SPEEDS[(i + 1) % SPEEDS.length];
    el.audio.playbackRate = next;
    el.btnSpeed.textContent = `${next}×`;
    store('rate', next);
    toast(`Velocidad ${next}×`);
  });

  // repetir línea
  el.btnLoop.addEventListener('click', () => {
    state.loopLine = !state.loopLine;
    el.btnLoop.setAttribute('aria-pressed', String(state.loopLine));
    if (state.loopLine) {
      if (state.active < 0) state.active = indexAt(el.audio.currentTime);
      if (state.active >= 0) {
        seekAudio(Math.max(0, state.lines[state.active].start - PREROLL));
        renderProgress();
        syncActive(true);
        if (el.audio.paused) el.audio.play().catch(() => {});
      }
      toast('Repitiendo la línea actual');
    } else {
      toast('Repetición desactivada');
    }
  });

  // mostrar tiempos
  el.btnTimes.addEventListener('click', () => {
    state.showTimes = !state.showTimes;
    document.body.classList.toggle('show-times', state.showTimes);
    el.btnTimes.setAttribute('aria-pressed', String(state.showTimes));
  });

  el.btnShare.addEventListener('click', share);
  el.btnHelp.addEventListener('click', () => el.help.showModal());

  // búsqueda
  el.search.addEventListener('input', applySearch);
  el.searchClear.addEventListener('click', () => {
    el.search.value = '';
    applySearch();
    el.search.focus();
  });

  // barra de progreso (clic + arrastre)
  const seekFromEvent = (e) => {
    const dur = el.audio.duration || state.track?.duration || 0;
    if (!dur) return;
    const rect = el.progress.getBoundingClientRect();
    const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    seekAudio(pct * dur);
    renderProgress();
    syncActive(true);
  };

  el.progress.addEventListener('pointerdown', (e) => {
    state.scrubbing = true;
    el.progress.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  el.progress.addEventListener('pointermove', (e) => {
    if (state.scrubbing) seekFromEvent(e);
  });
  el.progress.addEventListener('pointerup', (e) => {
    state.scrubbing = false;
    try { el.progress.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  });
  el.progress.addEventListener('pointercancel', () => { state.scrubbing = false; });

  el.progress.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowRight') { seekAudio(el.audio.currentTime + step); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { seekAudio(el.audio.currentTime - step); e.preventDefault(); }
  });

  // pausar el autoscroll si el usuario está leyendo por su cuenta
  const holdAutoscroll = () => { state.manualScrollUntil = Date.now() + AUTOSCROLL_PAUSE; };
  window.addEventListener('wheel', holdAutoscroll, { passive: true });
  window.addEventListener('touchmove', holdAutoscroll, { passive: true });

  // atajos de teclado
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === '/' && !typing) {
      e.preventDefault();
      el.search.focus();
      el.search.select();
      return;
    }
    if (typing) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    if (el.help.open) return;

    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        if (el.audio.paused) el.audio.play().catch(() => {});
        else el.audio.pause();
        break;
      case 'ArrowDown':
        e.preventDefault();
        stepLine(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        stepLine(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekAudio(el.audio.currentTime + 5);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekAudio(el.audio.currentTime - 5);
        break;
      case 'l':
      case 'L':
        el.btnLoop.click();
        break;
      case 'm':
      case 'M':
        el.btnMute.click();
        break;
      case 'Home':
        seekAudio(0);
        break;
      default:
        break;
    }
  });

  // teclas del reproductor nativo (accesibilidad)
  el.btnPlay.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') e.stopPropagation();
  });

  // al cambiar de canción desde el historial
  window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.search).get('track');
    if (id && id !== state.track?.id) loadTrack(id);
  });

  // guardar posición al salir
  window.addEventListener('pagehide', () => {
    if (state.track) store('pos:' + state.track.id, el.audio.currentTime);
  });
}

/* ---------------------------------------------------------------- arranque */

wireEvents();
boot().then(() => {
  if (location.hash && state.lines.length) {
    const n = Number(location.hash.replace(/^#l?/, ''));
    if (Number.isFinite(n) && n > 0) {
      const i = clamp(n - 1, 0, state.lines.length - 1);
      state.manualScrollUntil = 0;
      requestAnimationFrame(() => el.lyrics.children[i]?.scrollIntoView({ block: 'center' }));
    }
  }
});

// expuesto para depurar desde la consola del navegador
window.LyricRapper = { state, seekToLine, el };
