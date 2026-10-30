/* ==========================================================================
   Estudio de sincronización
   --------------------------------------------------------------------------
   Flujo: cargar audio → pegar letra → pulsar espacio al inicio de cada verso
   → exportar JSON. Sin dependencias, sin subir nada a ningún servidor.
   ========================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const DRAFT_KEY = 'lyric-rapper:studio';
const SPEEDS = [1, 0.75, 0.5, 1.25, 1.5];

const el = {
  audio: $('#audio'),
  banner: $('#banner'),
  bannerTitle: $('#banner-title'),
  bannerText: $('#banner-text'),
  status: $('#studio-status'),
  drop: $('#drop'),
  fileInput: $('#file-audio'),
  pick: $('#pick-audio'),
  audioName: $('#audio-name'),
  fTitle: $('#f-title'),
  fArtist: $('#f-artist'),
  fId: $('#f-id'),
  uploadRow: $('#upload-row'),
  fUpload: $('#f-upload'),
  lyricsInput: $('#lyrics-input'),
  btnBuild: $('#btn-build'),
  btnClear: $('#btn-clear'),
  buildInfo: $('#build-info'),
  rows: $('#rows'),
  stDone: $('#st-done'),
  stTotal: $('#st-total'),
  stDur: $('#st-dur'),
  stNote: $('#st-note'),
  stamp: $('#btn-stamp'),
  stampTarget: $('#stamp-target'),
  btnUndo: $('#btn-undo'),
  btnSetNow: $('#btn-set-now'),
  btnPlay: $('#btn-play'),
  btnBack: $('#btn-back'),
  btnFwd: $('#btn-fwd'),
  btnSpeed: $('#btn-speed'),
  progress: $('#progress'),
  progressFill: $('#progress-fill'),
  progressTicks: $('#progress-ticks'),
  progressKnob: $('#progress-knob'),
  timeCurrent: $('#time-current'),
  timeTotal: $('#time-total'),
  json: $('#json-preview'),
  btnSave: $('#btn-save'),
  btnDownload: $('#btn-download'),
  btnCopy: $('#btn-copy'),
  fileJson: $('#file-json'),
  saveNote: $('#save-note'),
  toast: $('#toast'),
};

const S = {
  rows: [],            // [{ text, start: number|null }]
  sel: 0,
  history: [],         // [{ i, prev }]
  file: null,
  audioPath: '',
  dur: 0,
  studio: false,
  saving: false,
  scrubbing: false,
};

/* ---------------------------------------------------------------- utilidades */

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtStamp(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}

function slug(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2400);
}

function showBanner(title, html) {
  el.bannerTitle.textContent = title;
  el.bannerText.innerHTML = html;
  el.banner.hidden = false;
}
el.banner.querySelector('.banner-close')?.addEventListener('click', () => { el.banner.hidden = true; });

/* ---------------------------------------------------------------- audio */

function loadAudioFile(file) {
  if (!file) return;
  if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|ogg|opus|wav|flac|aac)$/i.test(file.name)) {
    toast('Ese archivo no parece audio');
    return;
  }
  S.file = file;
  S.audioPath = '';
  el.audio.src = URL.createObjectURL(file);
  el.audio.load();

  el.audioName.hidden = false;
  el.audioName.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  el.status.textContent = 'audio cargado';
  el.status.classList.add('is-ready');

  if (!el.fTitle.value.trim()) {
    const guess = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    el.fTitle.value = guess;
    el.fId.value = slug(guess);
  }
  el.uploadRow.hidden = !S.studio;
  saveDraft();
}

el.audio.addEventListener('loadedmetadata', () => {
  S.dur = el.audio.duration || 0;
  el.timeTotal.textContent = fmt(S.dur);
  el.stDur.textContent = fmt(S.dur);
  renderTicks();
  renderProgress();
  render();
});

el.audio.addEventListener('play', () => {
  document.body.classList.add('is-playing');
  el.btnPlay.setAttribute('aria-label', 'Pausar');
  startLoop();
});
el.audio.addEventListener('pause', () => {
  document.body.classList.remove('is-playing');
  el.btnPlay.setAttribute('aria-label', 'Reproducir');
});
el.audio.addEventListener('timeupdate', () => { if (el.audio.paused) renderProgress(); });

function renderProgress() {
  const t = el.audio.currentTime || 0;
  const pct = S.dur ? clamp((t / S.dur) * 100, 0, 100) : 0;
  el.progressFill.style.width = `${pct}%`;
  el.progressKnob.style.left = `${pct}%`;
  el.timeCurrent.textContent = fmt(t);
  el.progress.setAttribute('aria-valuenow', pct.toFixed(1));
  el.progress.setAttribute('aria-valuetext', `${fmt(t)} de ${fmt(S.dur)}`);
}

let rafId = 0;
function startLoop() {
  if (rafId) return;
  const loop = () => {
    if (el.audio.paused) { rafId = 0; return; }
    renderProgress();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function seek(t) {
  el.audio.currentTime = clamp(t, 0, S.dur || t);
  renderProgress();
}

/* ---------------------------------------------------------------- líneas */

function buildRows() {
  const lines = el.lyricsInput.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) { toast('Pega primero la letra'); return; }

  if (S.rows.length && !confirm('Esto reemplaza las líneas y las marcas actuales. ¿Seguir?')) return;

  S.rows = lines.map(text => ({ text, start: null }));
  S.sel = 0;
  S.history = [];
  el.buildInfo.textContent = `${S.rows.length} líneas`;
  render();
  saveDraft();
  toast(`${S.rows.length} líneas listas`);
  el.rows.scrollTop = 0;
}

function render() {
  if (!S.rows.length) {
    el.rows.innerHTML = '<li class="rows-empty">Todavía no hay líneas. Pega la letra en el paso 2.</li>';
  } else {
    const frag = document.createDocumentFragment();
    S.rows.forEach((row, i) => {
      const li = document.createElement('li');
      li.className = 'row' + (i === S.sel ? ' is-sel' : '') + (row.start != null ? ' is-done' : '');
      li.dataset.i = String(i);
      li.innerHTML =
        `<span class="row-idx">${i + 1}</span>` +
        `<span class="row-time" title="Clic para usar el tiempo actual">${row.start != null ? fmtStamp(row.start) : '--:--'}</span>` +
        `<span class="row-text" title="${escapeHtml(row.text)}">${escapeHtml(row.text)}</span>` +
        `<button class="row-del" type="button" aria-label="Quitar línea ${i + 1}">✕</button>`;
      frag.appendChild(li);
    });
    el.rows.replaceChildren(frag);
  }

  const done = S.rows.filter(r => r.start != null).length;
  el.stDone.textContent = String(done);
  el.stTotal.textContent = String(S.rows.length);
  el.stampTarget.textContent = S.rows.length ? (S.sel < S.rows.length ? `${S.sel + 1}/${S.rows.length}` : 'fin') : '—';
  updateNote(done);
  renderTicks();
  updatePreview();
  scrollSelIntoView();
}

function updateNote(done) {
  if (!S.rows.length) {
    el.stNote.textContent = 'Carga el audio y prepara las líneas para empezar.';
    return;
  }
  if (!S.dur) {
    el.stNote.textContent = 'Falta cargar el audio.';
    return;
  }
  if (done === S.rows.length) {
    el.stNote.textContent = '¡Todas marcadas! Revisa el orden y exporta.';
    return;
  }
  const outOfOrder = findOutOfOrder();
  if (outOfOrder) {
    el.stNote.textContent = `Ojo: la línea ${outOfOrder[0] + 1} empieza antes que la anterior.`;
    return;
  }
  el.stNote.textContent = `Siguiente: línea ${S.sel + 1}. Pulsa espacio cuando empiece.`;
}

function findOutOfOrder() {
  for (let i = 1; i < S.rows.length; i++) {
    const a = S.rows[i - 1].start;
    const b = S.rows[i].start;
    if (a != null && b != null && b < a) return [i];
  }
  return null;
}

function scrollSelIntoView() {
  const node = el.rows.children[S.sel];
  if (!node || !el.rows.children.length) return;
  const box = el.rows.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  if (r.top < box.top + 4 || r.bottom > box.bottom - 4) {
    node.scrollIntoView({ block: 'nearest' });
  }
}

function select(i, { seekToStart = true } = {}) {
  S.sel = clamp(i, 0, Math.max(0, S.rows.length - 1));
  render();
  if (seekToStart && S.rows[S.sel]?.start != null) seek(S.rows[S.sel].start);
}

function stamp() {
  if (!S.rows.length) { toast('Primero pega la letra'); return; }
  if (!S.dur) { toast('Primero carga el audio'); return; }
  if (S.sel >= S.rows.length) {
    toast('Ya marcaste todas las líneas');
    return;
  }

  const t = Number(el.audio.currentTime.toFixed(3));
  S.history.push({ i: S.sel, prev: S.rows[S.sel].start });
  S.rows[S.sel].start = t;

  if (S.sel < S.rows.length - 1) S.sel += 1;
  render();
  saveDraft();

  if (el.audio.paused) el.audio.play().catch(() => {});
}

function undo() {
  const last = S.history.pop();
  if (!last) { toast('Nada que deshacer'); return; }
  S.rows[last.i].start = last.prev;
  S.sel = last.i;
  render();
  saveDraft();
}

function nudge(delta) {
  const row = S.rows[S.sel];
  if (!row) return;
  const base = row.start ?? el.audio.currentTime;
  row.start = Math.max(0, Number((base + delta).toFixed(3)));
  render();
  saveDraft();
}

/* ---------------------------------------------------------------- progreso */

function renderTicks() {
  const dur = S.dur || 0;
  if (!dur) { el.progressTicks.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  for (const row of S.rows) {
    if (row.start == null || row.start <= 0 || row.start >= dur) continue;
    const i = document.createElement('i');
    i.style.left = `${(row.start / dur) * 100}%`;
    frag.appendChild(i);
  }
  el.progressTicks.replaceChildren(frag);
}

/* ---------------------------------------------------------------- exportar */

function buildTrack({ quiet = false } = {}) {
  const rows = S.rows.filter(r => r.start != null);
  if (!rows.length) {
    if (!quiet) toast('No hay ninguna línea marcada');
    return null;
  }

  const bad = findOutOfOrder();
  if (bad && !quiet) {
    toast(`La línea ${bad[0] + 1} empieza antes que la anterior`);
    select(bad[0], { seekToStart: false });
    return null;
  }

  const lines = S.rows.map((row, i) => {
    const next = S.rows.slice(i + 1).find(r => r.start != null);
    const end = next?.start ?? (S.dur || (row.start ?? 0) + 6);
    return row.start == null
      ? null
      : { start: Number(row.start.toFixed(3)), end: Number(end.toFixed(3)), text: row.text };
  }).filter(Boolean);

  const title = el.fTitle.value.trim() || 'Sin título';
  const id = (el.fId.value.trim() || slug(title) || 'cancion').toLowerCase();

  return {
    id,
    title,
    artist: el.fArtist.value.trim() || '',
    album: '',
    kicker: 'Sincronizado a mano',
    audio: S.audioPath || `assets/audio/${(S.file?.name || `${id}.mp3`)}`,
    duration: Number((S.dur || 0).toFixed(3)),
    bpm: null,
    language: '',
    lines,
  };
}

function updatePreview() {
  const track = buildTrack({ quiet: true });
  const has = Boolean(track && track.lines.length);
  el.btnDownload.disabled = !has;
  el.btnCopy.disabled = !has;
  el.btnSave.disabled = !has || !S.studio || S.saving;

  if (!has) {
    el.json.textContent = S.rows.length
      ? '// Marca al menos una línea para ver el JSON'
      : '{ }';
    return;
  }

  const view = {
    ...track,
    lines: track.lines.slice(0, 40),
  };
  const text = JSON.stringify(view, null, 2);
  el.json.textContent = track.lines.length > 40
    ? `${text}\n\n// … ${track.lines.length - 40} líneas más`
    : text;
}

function download() {
  const track = buildTrack();
  if (!track) return;
  const blob = new Blob([JSON.stringify(track, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${track.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('JSON descargado');
}

async function copyJson() {
  const track = buildTrack();
  if (!track) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(track, null, 2) + '\n');
    toast('JSON copiado');
  } catch {
    toast('No se pudo copiar');
  }
}

async function saveToProject() {
  if (!S.studio) {
    toast('Sin servidor: usa «Descargar JSON»');
    return;
  }
  const track = buildTrack();
  if (!track) return;

  S.saving = true;
  updatePreview();
  try {
    if (S.file && el.fUpload.checked) {
      el.saveNote.textContent = 'Copiando el audio…';
      const name = S.file.name.replace(/[^A-Za-z0-9 ._-]/g, '_');
      const res = await fetch(`/api/upload?name=${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: S.file,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'no se pudo copiar el audio');
      track.audio = data.path;
      S.audioPath = data.path;
    }

    el.saveNote.textContent = 'Guardando el JSON…';
    const res = await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(track),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'no se pudo guardar');

    el.saveNote.innerHTML =
      `Guardado en <code>${escapeHtml(data.file)}</code> · ` +
      `<a href="/?track=${encodeURIComponent(track.id)}">abrir en el reproductor</a>`;
    toast('Guardado. Ya aparece en el reproductor');
  } catch (err) {
    el.saveNote.textContent = `Error: ${err.message}. Puedes descargar el JSON y colocarlo a mano.`;
    toast('No se pudo guardar');
  } finally {
    S.saving = false;
    updatePreview();
  }
}

/* ---------------------------------------------------------------- LRC */

/**
 * Lee un .lrc (letra con marcas de tiempo, el formato de los reproductores).
 *   [ti:Título] [ar:Artista] [offset:+250]
 *   [00:12.34]primera línea
 *   [00:12.34][00:45.10]estribillo que se repite
 */
function parseLrc(text) {
  const meta = {};
  const rows = [];
  let offset = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const tag = line.match(/^\[(ti|ar|al|by|offset):\s*(.*?)\]$/i);
    if (tag) {
      const key = tag[1].toLowerCase();
      if (key === 'offset') offset = (Number(tag[2]) || 0) / 1000;
      else meta[key] = tag[2].trim();
      continue;
    }

    const re = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const stamps = [...line.matchAll(re)];
    if (!stamps.length) continue;

    const content = line.replace(re, '').trim();
    if (!content) continue;

    for (const st of stamps) {
      const frac = st[3] ? Number(st[3].padEnd(3, '0').slice(0, 3)) / 1000 : 0;
      const start = Number(st[1]) * 60 + Number(st[2]) + frac + offset;
      rows.push({ start: Math.max(0, Number(start.toFixed(3))), text: content });
    }
  }

  rows.sort((a, b) => a.start - b.start);
  return { meta, rows };
}

function looksLikeLrc(text) {
  return /^\s*\[\d{1,3}:\d{2}/m.test(text) || /^\s*\[ti:/im.test(text);
}

async function importFile(file) {
  const text = await file.text();

  if (/\.lrc$/i.test(file.name) || looksLikeLrc(text)) {
    const { meta, rows } = parseLrc(text);
    if (!rows.length) { toast('Ese .lrc no tiene líneas con tiempo'); return; }

    if (meta.ti && !el.fTitle.value.trim()) el.fTitle.value = meta.ti;
    if (meta.ar && !el.fArtist.value.trim()) el.fArtist.value = meta.ar;
    if (el.fTitle.value.trim() && !el.fId.value.trim()) el.fId.value = slug(el.fTitle.value);

    el.lyricsInput.value = rows.map(r => r.text).join('\n');
    S.rows = rows.map(r => ({ text: r.text, start: r.start }));
    S.sel = 0;
    S.history = [];
    el.buildInfo.textContent = `${S.rows.length} líneas desde LRC`;
    render();
    saveDraft();
    toast(`LRC importado: ${rows.length} líneas con tiempo`);
    return;
  }

  return importJsonFromText(text);
}

async function importJsonFromText(text) {
  try {
    const track = JSON.parse(text);
    if (!Array.isArray(track.lines) || !track.lines.length) throw new Error('el JSON no tiene líneas');

    el.fTitle.value = track.title || '';
    el.fArtist.value = track.artist || '';
    el.fId.value = track.id || slug(track.title || '');
    el.lyricsInput.value = track.lines.map(l => l.text).join('\n');
    S.rows = track.lines.map(l => ({ text: l.text, start: typeof l.start === 'number' ? l.start : null }));
    S.sel = 0;
    S.history = [];
    el.buildInfo.textContent = `${S.rows.length} líneas importadas`;

    if (track.audio && !S.file) {
      el.audio.src = track.audio;
      el.audio.load();
      S.audioPath = track.audio;
      el.audioName.hidden = false;
      el.audioName.textContent = track.audio;
      el.status.textContent = 'audio del proyecto';
      el.status.classList.add('is-ready');
    }
    render();
    saveDraft();
    toast('JSON importado');
  } catch (err) {
    toast(`No se pudo importar: ${err.message}`);
  }
}

/* ---------------------------------------------------------------- borrador */

let draftTimer = 0;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        title: el.fTitle.value,
        artist: el.fArtist.value,
        id: el.fId.value,
        rows: S.rows,
        audioPath: S.audioPath,
      }));
    } catch { /* sin espacio: da igual */ }
  }, 400);
}

function loadDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return; }
  if (!draft) return;
  el.fTitle.value = draft.title || '';
  el.fArtist.value = draft.artist || '';
  el.fId.value = draft.id || '';
  if (Array.isArray(draft.rows) && draft.rows.length) {
    S.rows = draft.rows;
    el.lyricsInput.value = draft.rows.map(r => r.text).join('\n');
    el.buildInfo.textContent = `${S.rows.length} líneas restauradas`;
    if (draft.audioPath) {
      S.audioPath = draft.audioPath;
      el.audio.src = draft.audioPath;
      el.audio.load();
      el.audioName.hidden = false;
      el.audioName.textContent = draft.audioPath;
    }
    render();
  }
}

/* ---------------------------------------------------------------- eventos */

el.pick.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => loadAudioFile(el.fileInput.files?.[0]));

['dragenter', 'dragover'].forEach(ev => el.drop.addEventListener(ev, (e) => {
  e.preventDefault();
  el.drop.classList.add('is-over');
}));
['dragleave', 'drop'].forEach(ev => el.drop.addEventListener(ev, (e) => {
  e.preventDefault();
  el.drop.classList.remove('is-over');
}));
el.drop.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) loadAudioFile(file);
});

el.btnBuild.addEventListener('click', buildRows);
el.btnClear.addEventListener('click', () => {
  if (!confirm('¿Vaciar la letra y las marcas?')) return;
  el.lyricsInput.value = '';
  S.rows = [];
  S.history = [];
  S.sel = 0;
  el.buildInfo.textContent = '';
  render();
  saveDraft();
});

el.rows.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const i = Number(row.dataset.i);

  if (e.target.closest('.row-del')) {
    S.rows.splice(i, 1);
    S.sel = clamp(S.sel, 0, Math.max(0, S.rows.length - 1));
    render();
    saveDraft();
    return;
  }

  if (e.target.classList.contains('row-time')) {
    if (S.rows[i] && S.dur) {
      S.rows[i].start = Number(el.audio.currentTime.toFixed(3));
      S.sel = i;
      render();
      saveDraft();
      toast(`Línea ${i + 1} → ${fmtStamp(S.rows[i].start)}`);
    }
    return;
  }

  select(i);
});

el.stamp.addEventListener('click', stamp);
el.btnUndo.addEventListener('click', undo);
el.btnSetNow.addEventListener('click', () => nudge(0));

$$('[data-nudge]').forEach(btn => btn.addEventListener('click', () => {
  nudge(Number(btn.dataset.nudge));
}));

el.btnPlay.addEventListener('click', () => {
  if (el.audio.paused) el.audio.play().catch(() => {});
  else el.audio.pause();
});
el.btnBack.addEventListener('click', () => seek(el.audio.currentTime - 5));
el.btnFwd.addEventListener('click', () => seek(el.audio.currentTime + 5));

el.btnSpeed.addEventListener('click', () => {
  const i = SPEEDS.indexOf(el.audio.playbackRate);
  const next = SPEEDS[(i + 1) % SPEEDS.length];
  el.audio.playbackRate = next;
  el.btnSpeed.textContent = `${next}×`;
});

el.btnDownload.addEventListener('click', download);
el.btnCopy.addEventListener('click', copyJson);
el.btnSave.addEventListener('click', saveToProject);
el.fileJson.addEventListener('change', () => {
  const file = el.fileJson.files?.[0];
  if (file) importFile(file).catch(err => toast(`No se pudo importar: ${err.message}`));
  el.fileJson.value = '';
});

// barra de progreso
const seekFromEvent = (e) => {
  if (!S.dur) return;
  const rect = el.progress.getBoundingClientRect();
  seek(clamp((e.clientX - rect.left) / rect.width, 0, 1) * S.dur);
};
el.progress.addEventListener('pointerdown', (e) => {
  S.scrubbing = true;
  el.progress.setPointerCapture(e.pointerId);
  seekFromEvent(e);
});
el.progress.addEventListener('pointermove', (e) => { if (S.scrubbing) seekFromEvent(e); });
el.progress.addEventListener('pointerup', (e) => {
  S.scrubbing = false;
  try { el.progress.releasePointerCapture(e.pointerId); } catch { /* noop */ }
});
el.progress.addEventListener('pointercancel', () => { S.scrubbing = false; });

// teclado
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.code === 'Space') {
    if (typing) return;
    e.preventDefault();
    e.stopPropagation();
    stamp();
    return;
  }
  if (typing) return;

  switch (e.key) {
    case 'k':
    case 'K':
      e.preventDefault();
      el.btnPlay.click();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seek(el.audio.currentTime - 5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      seek(el.audio.currentTime + 5);
      break;
    case 'ArrowDown':
      e.preventDefault();
      select(S.sel + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      select(S.sel - 1);
      break;
    case 'Backspace':
      e.preventDefault();
      undo();
      break;
    case 'Enter':
      e.preventDefault();
      nudge(0);
      break;
    default:
      break;
  }
});

/* ---------------------------------------------------------------- arranque */

(async function boot() {
  // ¿está el servidor del proyecto con la API de guardado?
  try {
    const res = await fetch('/api/ping', { cache: 'no-store' });
    S.studio = res.ok && (await res.json()).studio === true;
  } catch {
    S.studio = false;
  }

  el.uploadRow.hidden = !S.studio;
  el.saveNote.textContent = S.studio
    ? 'Guardar escribe directamente en la carpeta del proyecto.'
    : 'Este servidor no permite guardar: descarga el JSON y colócalo en data/tracks/.';
  if (!S.studio) el.btnSave.hidden = true;

  if (location.protocol === 'file:') {
    showBanner('Abre la página con un servidor local',
      'Usa <code>./serve.sh</code> y entra a <code>http://localhost:8088/sync.html</code>.');
  }

  loadDraft();
  render();
  renderProgress();
})();

// expuesto para depurar desde la consola del navegador
window.LyricSync = { state: S, stamp, undo, nudge, buildTrack, render, el };
