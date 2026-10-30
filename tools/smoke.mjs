// Prueba de humo del reproductor con Chrome DevTools Protocol.
// Uso:  node tools/smoke.mjs [url]
// Requiere Google Chrome instalado y el sitio servido (./serve.sh).

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';

const URL_ = process.argv[2] || 'http://127.0.0.1:8088/';
const PORT = 9333;
const CHROME = process.env.CHROME || 'google-chrome';
const profile = new URL('../.tmp/chrome-smoke', import.meta.url).pathname;
await mkdir(profile, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,1000', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let ws;
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject }));
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* todavía arrancando */ }
    await sleep(250);
  }
  throw new Error('Chrome no abrió el puerto de depuración');
}

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + JSON.stringify(exceptionDetails.exception?.description));
  return result.value;
};

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FALLA'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

try {
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(2500);

  const lines = await evaluate(`document.querySelectorAll('.line').length`);
  check('la letra se renderizó', lines === 8, `${lines} líneas`);

  const total = await evaluate(`document.querySelector('#time-total').textContent`);
  check('la duración aparece en el transporte', total !== '0:00', total);

  // clic real (gesto de usuario) en la línea 5
  const box = await evaluate(`(() => {
    const r = document.querySelectorAll('.line')[4].getBoundingClientRect();
    return { x: r.left + 120, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await sleep(260);

  const after = await evaluate(`(() => {
    const a = document.querySelector('#audio');
    return {
      time: a.currentTime, paused: a.paused, rate: a.playbackRate,
      active: [...document.querySelectorAll('.line')].findIndex(n => n.classList.contains('is-active')),
      lineStart: window.LyricRapper.state.lines[4].start,
    };
  })()`);

  check('el clic salta al inicio de la línea 5',
    Math.abs(after.time - (after.lineStart - 0.12)) < 0.6,
    `t=${after.time.toFixed(2)}s, línea empieza en ${after.lineStart}s`);
  check('el audio se está reproduciendo', after.paused === false);
  check('la línea 5 queda resaltada', after.active === 4, `activa=${after.active}`);

  await sleep(600);
  const url = await evaluate(`({ hash: location.hash, at: new URLSearchParams(location.search).get('at') })`);
  check('la URL guarda el punto', url.hash === '#l5' && url.at !== null, `${url.hash} at=${url.at}`);

  // atajo: flecha abajo → línea siguiente
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await sleep(500);
  const stepped = await evaluate(`window.LyricRapper.state.active`);
  check('la flecha abajo pasa a la línea 6', stepped === 5, `activa=${stepped}`);

  // búsqueda
  await evaluate(`(() => { const s = document.querySelector('#search'); s.value = 'json'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const visible = await evaluate(`[...document.querySelectorAll('.line')].filter(n => !n.classList.contains('is-filtered')).length`);
  check('la búsqueda filtra líneas', visible === 1, `${visible} visibles`);

  // repetir línea
  await evaluate(`document.querySelector('#search').value = ''; document.querySelector('#search').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#btn-loop').click();`);
  await sleep(150);
  const loopOn = await evaluate(`document.querySelector('#btn-loop').getAttribute('aria-pressed')`);
  check('el modo repetir se activa', loopOn === 'true');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(new URL('../.tmp/smoke.png', import.meta.url).pathname, Buffer.from(shot.data, 'base64'));
  console.log('  captura: .tmp/smoke.png');

  // móvil
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL('../.tmp/smoke-mobile.png', import.meta.url).pathname, Buffer.from(shot2.data, 'base64'));
  console.log('  captura móvil: .tmp/smoke-mobile.png');
} catch (err) {
  console.error('error:', err.message);
  failures++;
} finally {
  try { ws?.close(); } catch { /* noop */ }
  chrome.kill('SIGKILL');
  console.log(failures ? `\n${failures} fallo(s)` : '\ntodo verde');
  process.exit(failures ? 1 : 0);
}
