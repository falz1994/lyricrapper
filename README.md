# Lyric Rapper — piloto

Sitio web estático para leer una letra de rap y **hacer clic en cualquier línea
para que la música empiece exactamente ahí**. Sin frameworks, sin build, sin
dependencias: HTML, CSS y JavaScript a secas.

```
./serve.sh          →  http://localhost:8088
```

El piloto viene con una pista de demostración (*Demo Beat*, instrumental de
90 BPM sintetizada por `tools/make_demo_beat.py`) para que puedas probar la
mecánica antes de meter tu canción.

`./serve.sh` levanta un servidor local que además permite guardar desde el
navegador. El sitio en sí es estático: se puede publicar en GitHub Pages,
Netlify o cualquier hosting de archivos, y el estudio sigue funcionando en modo
«descargar JSON».

---

## Cómo se identifican los tiempos de cada línea

Esta es la parte que no es magia. **Cada línea guarda dos números: `start` y
`end`, en segundos.** El reproductor no "escucha" nada: cuando haces clic en la
línea 5, ejecuta

```js
audio.currentTime = line.start - 0.12;   // 0,12 s de margen para no cortar la sílaba
audio.play();
```

Ese `- 0,12` (constante `PREROLL` en `assets/js/app.js`) es la diferencia entre
"empieza en la línea" y "empieza cortando la primera letra".

Los tiempos se pueden obtener de tres maneras:

### 1. A mano, con el estudio — `sync.html` (la más fiable para rap)

`http://localhost:8088/sync.html`

1. Cargas el audio (no sale de tu equipo).
2. Pegas la letra, un verso por renglón.
3. Le das play y **pulsas `espacio` justo cuando empieza cada verso**. Cada
   pulsación sella la línea seleccionada y salta a la siguiente.
4. Ajustas con ±0,1 s / ±0,5 s lo que haya quedado corrido.
5. Guardas: escribe `data/tracks/<id>.json` y lo agrega a `data/tracks.json`.

Precisión real: la de tu dedo, ±30–60 ms. Para rap es lo que yo usaría: el
oído humano detecta un desfase de 100 ms y Whisper no siempre lo acierta.

### 2. Automático, con Whisper — `tools/align.py`

```bash
pip install --target tools/pylib -r tools/requirements.txt   # una sola vez

PYTHONPATH=tools/pylib python3 tools/align.py \
    assets/audio/mi-tema.mp3 letra.txt \
    --id mi-tema --title "Mi tema" --artist "Quien sea" \
    --language es --model base
```

En este equipo ya está instalado en `tools/pylib` (445 MB) con el modelo
`base` descargado en `tools/models` (142 MB), así que funciona sin más. Si
quieres recuperar el espacio: `rm -rf tools/pylib tools/models`.

Qué hace, paso a paso:

1. **Transcribe** el audio con `faster-whisper` pidiendo el tiempo de **cada
   palabra** (`word_timestamps=True`).
2. **Alinea** esa transcripción con *tu* letra palabra por palabra
   (`difflib.SequenceMatcher`): si Whisper oyó "nueva york" y tú escribiste
   "New York", igual las empareja.
3. Las palabras que Whisper se comió se **interpolan** entre sus vecinas.
4. `start` de la línea = tiempo de su primera palabra. `end` = `start` de la
   siguiente.

Al final imprime una tabla con la **cobertura** de cada línea (qué porcentaje de
sus palabras se reconocieron). Las líneas por debajo del 34 % se marcan con ⚠:
normalmente son estribillos repetidos, ad-libs o partes donde la instrumental
tapa la voz.

**Lo que medí** (fixture de voz sintética, 6 líneas, `--model base`): error
medio de 0,25 s por línea, con un sesgo sistemático de unos −0,25 s que se
corrige con `--offset 0.25`. Al añadirle música al 30 % de volumen el error fue
prácticamente el mismo (0,22 s). O sea: sirve para dejar la letra bien
sincronizada de un tirón, no para clavar el *punchline* al milisegundo.

Límites honestos:

- ±100–300 ms en el mejor de los casos, y bastante peor si le pasas la mezcla
  completa con la instrumental encima.
- Si puedes, pásale **solo el stem de voz**:
  `demucs --two-stems=vocals cancion.mp3` y alinea `vocals.wav`.
- No uses `--vad` salvo que el audio tenga silencios larguísimos: con VAD,
  Whisper estira la primera palabra de cada tramo hacia el silencio anterior y
  el inicio de línea se va más de un segundo.
- Si la letra no coincide con lo que suena (versión censurada, directo, remix),
  la alineación se degrada y el informe te lo dice.

El modelo se descarga la primera vez en `tools/models/` (`base` ≈ 145 MB;
`small` ≈ 480 MB y alinea mejor).

### 3. Desde la rejilla del beat

Si la canción va a tempo fijo y sabes el BPM, los tiempos salen de una cuenta:
un compás a 90 BPM dura `4 × 60 / 90 = 2,667 s`. Así se generó la demo: cada
línea cae cada dos compases y los tiempos son exactos al milisegundo
(`tools/make_demo_beat.py`). Sirve para demos y para pistas instrumentales; para
un rapeo real el intérprete se adelanta y se atrasa.

**El mejor flujo para una canción real:** `tools/sync_tool.py` para tener el
borrador alineado (un comando) → `sync.html` → *Importar JSON o LRC* → corregir
a oído las líneas que suenen corridas. Lo automático te ahorra el 80 %, el oído
pone el 20 % que se nota.

---

## Agregar una canción

Todo el trabajo pesado está en una herramienta:

```
tools/sync_tool.py    fuente → audio → letra → timestamps → canción en el proyecto
```

### La automática (un comando)

```bash
# con tu letra
python3 tools/sync_tool.py ~/música/mi-tema.mp3 --lyrics letra.txt \
    --title "Mi tema" --artist "Yo" --language es --model base

# sin letra: la saca transcribiendo el audio
python3 tools/sync_tool.py ~/música/mi-tema.mp3 --auto-lyrics \
    --title "Mi tema" --artist "Yo"

# desde una URL a un archivo de audio (tu hosting, licencia abierta)
python3 tools/sync_tool.py https://mi-sitio.com/tema.mp3 --auto-lyrics
```

Qué hace, en orden:

1. **Resuelve la fuente**: copia el archivo a `assets/audio/` o lo descarga si es
   una URL directa a un `.mp3`/`.m4a`/`.wav`/`.ogg`.
2. **Consigue la letra**: la lee de un `.txt`, la saca transcribiendo el audio
   (`--auto-lyrics`), o reparte las líneas como borrador.
3. **Sincroniza**: alinea palabra por palabra con Whisper (o usa los tiempos de
   la transcripción) y calcula `start`/`end` por línea.
4. **Registra** `data/tracks/<id>.json` y lo agrega a `data/tracks.json`.
5. Te imprime la URL del reproductor y la del estudio para retocar.

**Qué no hace, a propósito:**

- **No descarga audio de YouTube.** Si le pasas un enlace de YouTube, se detiene,
  lee el título y el canal con el endpoint público de oEmbed, y te explica las
  alternativas. Bajar el audio de ahí infringe derechos de autor y los términos
  del servicio, y ningún permiso en la nube cambia eso.
- **No busca letras en sitios de letras.** O las tienes tú (`--lyrics`), o las
  saca del propio audio (`--auto-lyrics`).

Ojo con `--auto-lyrics`: la transcripción tiene errores propios del reconocimiento
de voz (se come palabras, confunde nombres). Sirve para arrancar, pero si tienes
la letra escrita, pásala con `--lyrics` y queda exacta.

### A mano, en el estudio

`http://localhost:8088/sync.html`

1. Título, artista e id.
2. Cargas el audio (marca «Copiar el audio a `assets/audio/`»).
3. Pegas la letra y pulsas **Preparar líneas**.
4. Play, y `espacio` al inicio de cada verso. Si te trabas, `Retroceder 5 s`
   (`←`) y vuelves a marcar; `Deshacer` (`Backspace`) borra la última marca.
5. **Guardar en el proyecto**.

### Si ya tienes un `.lrc`

En el estudio, **Importar JSON o LRC** acepta el formato de los reproductores:

```
[ti:N.Y. State of Mind]
[ar:Nas]
[00:12.34]primera línea
[00:12.34][00:45.10]estribillo que se repite
```

Entra con los tiempos puestos, listo para corregir y guardar.

### El caso concreto de "N.Y. State of Mind"

No incluí la canción ni la letra en el repo, y no las descargo de ningún sitio:
el audio es una grabación comercial de NasVEVO y la letra está protegida. Con
**tu** copia (CD, vinilo, compra):

```bash
python3 tools/sync_tool.py ~/música/ny-state-of-mind.mp3 --lyrics ~/letra.txt \
    --title "N.Y. State of Mind" --artist "Nas" --language en --model small
```

Y queda en el selector del reproductor.

---

## Publicarlo: URL privada y analítica

El despliegue es estático (Vercel). Dos piezas lo convierten en algo privado y
medible, sin cuentas de terceros ni cookies de seguimiento.

### Sólo entra quien tiene la URL

`middleware.js` corre en el edge de Vercel y **devuelve 404 a todo** salvo que la
petición traiga la clave. La clave no está en el repo (es público): se configura
como variable de entorno.

1. En Vercel → *Settings* → *Environment Variables*: `ACCESS_KEY` = una cadena
   larga y aleatoria (`openssl rand -hex 24`).
2. Redeploy.
3. Entra una vez con `https://<sitio>/?k=<ACCESS_KEY>`: el middleware deja una
   cookie `lr_access` de un año y redirige a la URL limpia (la clave no queda en
   la barra de direcciones). A partir de ahí, todo normal.

Detalles a propósito:

- **Falla cerrado**: si `ACCESS_KEY` no está definida, el sitio devuelve 404. No
  hay forma de dejarlo abierto por olvido.
- Los intentos con `?k=` incorrecta también dan 404, no 401: no confirman que el
  sitio exista.
- `robots.txt` y la cabecera `X-Robots-Tag: noindex, nofollow` (en `vercel.json`)
  lo mantienen fuera de los buscadores.

En local no hay puerta: `tools/server.py` sirve sin clave, que es lo cómodo para
trabajar.

### Analítica

`assets/js/analytics.js` emite cuatro eventos —`pageview`, `track_open`,
`line_click`, `play`— a `/api/event`. Respeta *Do Not Track*, no usa cookies de
terceros y sólo guarda un id aleatorio de sesión en `localStorage`.

- **En Vercel**: cada evento queda como una línea en los logs del deployment
  (Vercel → proyecto → *Logs*, busca `lr_event`). El plan gratuito guarda un día
  de logs; para histórico hace falta conectar Vercel Blob o KV y cambiar el
  `console.log` de `api/event.js` por la escritura.
- **En local**: los eventos van a `data/analytics.jsonl` (ignorado por git) y hay
  un resumen en `http://localhost:8088/api/stats`:

```json
{ "total": 4, "sessions": 2,
  "events": { "line_click": 2, "pageview": 1, "track_open": 1 },
  "tracks": { "cream": 3 }, "lines": { "cream:12": 2 } }
```

Para medir algo propio desde la consola del navegador:
`lrAnalytics.track('evento', { track: 'cream' })`.

## Estructura

```
index.html                 reproductor
sync.html                  estudio para marcar los tiempos
middleware.js              puerta de acceso (URL con clave) en el edge de Vercel
api/event.js               endpoint de analítica (logs en Vercel)
assets/css/styles.css      estilos del reproductor (y base del estudio)
assets/css/sync.css        estilos propios del estudio
assets/js/app.js           lógica del reproductor
assets/js/sync.js          lógica del estudio
assets/js/analytics.js     eventos de uso (pageview, track_open, line_click, play)
assets/audio/              aquí van los audios (mp3/m4a/ogg/webm)
data/tracks.json           índice de canciones
data/tracks/<id>.json      una canción con sus líneas y tiempos
tools/server.py            servidor local (estático + guardado + analítica)
tools/align.py             alineación automática con Whisper
tools/gcp_align.py         alineación con Google Cloud Speech-to-Text
tools/optimize_audio.py    audio a Opus 64k + respaldo mp3
tools/set_audio_host.py    apunta los audios a un host externo (R2, CDN…)
tools/sync_tool.py         fuente → audio + letra → canción (la automática)
tools/add_song.py          audio + letra → canción (atajo de lo anterior)
tools/songkit.py           utilidades compartidas por las dos herramientas
tools/make_demo_beat.py    genera la pista de demostración
tools/smoke.mjs            prueba automática del reproductor (Chrome headless)
vercel.json                cabeceras de caché, MIME del webm y noindex
serve.sh                   atajo: arranca el servidor
```

## Formato del JSON

```json
{
  "id": "ny-state-of-mind",
  "title": "N.Y. State of Mind",
  "artist": "Nas",
  "album": "Illmatic",
  "kicker": "Piloto",
  "audio": "assets/audio/ny-state-of-mind.mp3",
  "duration": 286.0,
  "bpm": 84,
  "language": "en",
  "lines": [
    { "start": 0.0,   "end": 3.4,  "text": "…" },
    { "start": 3.4,   "end": 7.1,  "text": "…" }
  ]
}
```

- `start` es obligatorio; `end` es opcional (si falta, se usa el `start` de la
  línea siguiente).
- Las líneas se ordenan por `start` al cargar: no importa el orden del archivo.
- `duration` es sólo para mostrar la duración antes de que cargue el audio.

Plantilla lista para copiar: `data/tracks/_plantilla.json`.

## Atajos

| Tecla | Reproductor | Estudio |
|---|---|---|
| `espacio` | play / pausa | **marcar la línea** |
| `↑` `↓` | línea anterior / siguiente | línea anterior / siguiente |
| `←` `→` | ±5 s | ±5 s |
| `L` | repetir la línea actual | — |
| `M` | silenciar | — |
| `/` | buscar en la letra | — |
| `K` | — | play / pausa |
| `Backspace` | — | deshacer la última marca |
| `Enter` | — | fijar la marca en el tiempo actual |

## Problemas comunes

**«No se pudo cargar `data/tracks.json`»**
Estás abriendo el `index.html` con doble clic (`file://`). Los navegadores
bloquean `fetch` ahí. Usa `./serve.sh`.

**«Falta el archivo de audio»**
El `audio` del JSON no coincide con ningún archivo. Revisa la ruta y el nombre
exacto (mayúsculas incluidas).

**El salto cae al principio de la canción**
El servidor no soporta peticiones parciales (`Range`). El sitio reintenta el
salto hasta que hay datos, pero con archivos grandes se nota. `tools/server.py`
sí las soporta; `python -m http.server` **no**.

**En el móvil el audio no arranca solo**
Es la política de reproducción de iOS/Android: el primer play necesita un toque.
El clic en una línea cuenta como toque, así que funciona.

## Verificación

```bash
node tools/smoke.mjs     # Chrome headless: clic en una línea, salto, resaltado, URL
```

Comprueba que el clic en la línea 5 deja `currentTime` en `start − 0,12`,
que el audio suena, que la línea queda resaltada y que la URL guarda el punto
(`?at=21.58#l5`).

---

Audio de demostración: sintetizado por este repo, sin samples de terceros.
El código es tuyo para lo que quieras; las canciones que cargues, no.
