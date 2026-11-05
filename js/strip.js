// The strip under the web demo's stage: what the model hears, and how the robot answers.
// Left, the last 12 s: rhythm (where notes and hits start), spectrogram (60 Hz - 8 kHz, log scale), volume, and the
// robot's joint speed drawn when the robot moves (1.24 s after the music). Right, the sound now: a pulse on each hit,
// spectrum bars and a volume meter.
// The replays analyse their audio file once when the dance loads, so the strip follows the playback clock on every
// sound route. Live analyses the samples it streams to the model, as they play.

export const BANDS = 24;
const LO = 60, HI = 8000, WIN = 12;
const DB_MIN = -100, DB_MAX = -20;            // byte scale (the live AnalyserNode is set to the same)
const SMOOTH = 0.5;                           // the live analyser's smoothingTimeConstant
const FFT = 2048, SPEC_FPS = 40;              // replays: 2048-point frames, 40 a second
const LEVEL_STEP = 0.1;                       // s per volume bar (Live measures each 0.1 s it streams)

function bandBins(nyq, bins) {
  const k0 = new Int32Array(BANDS), k1 = new Int32Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    const f0 = LO * Math.pow(HI / LO, b / BANDS), f1 = LO * Math.pow(HI / LO, (b + 1) / BANDS);
    k0[b] = Math.floor((f0 / nyq) * bins);
    k1[b] = Math.min(bins, Math.max(k0[b] + 1, Math.ceil((f1 / nyq) * bins)));
  }
  return { k0, k1 };
}

// Hits: spectral flux (the sum of rises across the bands) at a local peak, above its mean + 1.5 sd over the last
// second, and at least 0.12 s after the previous hit. Causal, one frame late, so Live and the replays agree.
export class Hits {
  constructor() { this.prev = null; this.hist = []; this.f1 = 0; this.f2 = 0; this.t1 = 0; this.times = []; }
  push(bands, t) {                            // bands: 0..1 per band at time t
    let flux = 0;
    if (this.prev) for (let b = 0; b < BANDS; b++) flux += Math.max(0, bands[b] - this.prev[b]);
    else this.prev = new Float32Array(BANDS);
    this.prev.set(bands);
    const h = this.hist;
    while (h.length && h[0][0] < this.t1 - 1) h.shift();
    if (this.f1 > this.f2 && this.f1 >= flux && h.length > 4) {
      let m = 0, s = 0;
      for (const [, f] of h) m += f;
      m /= h.length;
      for (const [, f] of h) s += (f - m) * (f - m);
      const last = this.times.length ? this.times[this.times.length - 1] : -1;
      if (this.f1 > m + 1.5 * Math.sqrt(s / h.length) && this.f1 > 0.35 && this.t1 - last >= 0.12) this.times.push(this.t1);
    }
    h.push([t, flux]);
    this.f2 = this.f1; this.f1 = flux; this.t1 = t;
  }
}

// ---------------------------------------------------------------- analysis
function fftTables(n) {
  const bits = Math.log2(n), rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((-2 * Math.PI * i) / n); sin[i] = Math.sin((-2 * Math.PI * i) / n); }
  return { rev, cos, sin };
}
function fft(re, im, { rev, cos, sin }) {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step], si = sin[k * step], a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * si, ti = re[b] * si + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

// One spectrum frame every 1/40 s from the 2048 samples before it: Blackman window, magnitudes smoothed over frames
// (as an AnalyserNode does), the loudest bin of each band on a -100..-20 dB scale; and the hits found in those frames.
class Spectra {
  constructor(sr, seconds) {
    this.sr = sr;
    this.n = 0;
    this.data = new Uint8Array(Math.ceil(seconds * SPEC_FPS + 2) * BANDS);
    this.hits = new Hits();
    this.tables = fftTables(FFT);
    this.re = new Float64Array(FFT);
    this.im = new Float64Array(FFT);
    this.win = new Float64Array(FFT);
    for (let i = 0; i < FFT; i++) this.win[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / FFT) + 0.08 * Math.cos((4 * Math.PI * i) / FFT);
    Object.assign(this, bandBins(sr / 2, FFT / 2));
    this.sm = new Float64Array(this.k1[BANDS - 1]);
    this.bands = new Float32Array(BANDS);
  }
  end(j) { return Math.round((j / SPEC_FPS) * this.sr); }          // the sample where frame j ends
  full() { return (this.n + 1) * BANDS > this.data.length; }
  frame(get) {                                                      // get(k): sample k, 0 where unknown
    const j = this.n, start = this.end(j) - FFT, { re, im, win, sm, bands, k0, k1 } = this;
    for (let i = 0; i < FFT; i++) { re[i] = get(start + i) * win[i]; im[i] = 0; }
    fft(re, im, this.tables);
    for (let k = 0; k < sm.length; k++) sm[k] = SMOOTH * sm[k] + (1 - SMOOTH) * (Math.hypot(re[k], im[k]) / FFT);
    for (let b = 0; b < BANDS; b++) {
      let m = 0;
      for (let k = k0[b]; k < k1[b]; k++) m = Math.max(m, sm[k]);
      const v = Math.round(Math.max(0, Math.min(1, (20 * Math.log10(m + 1e-12) - DB_MIN) / (DB_MAX - DB_MIN))) * 255);
      bands[b] = v / 255;
      this.data[j * BANDS + b] = v;
    }
    this.hits.push(bands, j / SPEC_FPS);
    this.n = j + 1;
  }
  get spec() { return { data: this.data, fps: SPEC_FPS, n: this.n }; }
}

// x: the left channel (as Live's volume), sr: its sample rate. Returns the volume per 0.1 s (dBFS), the spectrogram
// and the hit times.
export async function analysePCM(x, sr) {
  const hop = Math.round(sr * LEVEL_STEP), nl = Math.ceil(x.length / hop), levels = new Float32Array(nl);
  for (let i = 0; i < nl; i++) {
    let p = 0;
    const a = i * hop, b = Math.min(x.length, a + hop);
    for (let k = a; k < b; k++) p += x[k] * x[k];
    levels[i] = 10 * Math.log10(p / Math.max(1, b - a) + 1e-12);
  }
  const sp = new Spectra(sr, x.length / sr), total = Math.ceil((x.length / sr) * SPEC_FPS);
  const get = (k) => (k >= 0 && k < x.length ? x[k] : 0);
  for (let j = 0; j < total && !sp.full(); j++) {
    sp.frame(get);
    if (j % 400 === 399) await new Promise((r) => setTimeout(r));   // keep the page responsive
  }
  return { levels, spec: sp.spec, hits: Float32Array.from(sp.hits.times) };
}

export async function analyseMusic(bytes) {
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ac = new Off(1, 1, 44100);
  const buf = await new Promise((resolve, reject) => {
    const r = ac.decodeAudioData(bytes, resolve, reject);
    if (r && r.then) r.then(resolve, reject);
  });
  return analysePCM(buf.getChannelData(0), buf.sampleRate);
}

// ---------------------------------------------------------------- Live: the same analysis, on the samples it streams
export function streamAnalysis(seconds, sr) {
  const sp = new Spectra(sr, seconds + 1), RING = 8192, ring = new Float32Array(RING);
  let total = 0;
  const get = (k) => (k >= 0 && k < total && k >= total - RING ? ring[k & (RING - 1)] : 0);
  return {
    get spec() { return sp.spec; },
    hits: sp.hits.times,
    push(a, stride = 2) {                     // Int16 interleaved samples; the first channel, as Live's volume
      for (let i = 0; i < a.length; i += stride) ring[(total++) & (RING - 1)] = a[i] / 32768;
      while (sp.end(sp.n) <= total && !sp.full()) sp.frame(get);
    },
  };
}

// ---------------------------------------------------------------- drawing
const states = new WeakMap();
function hexRGB(s, d) {
  const m = /^#([0-9a-f]{6})$/i.exec(s.trim());
  const v = parseInt(m ? m[1] : d.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function themeColors() {
  const cs = getComputedStyle(document.documentElement), c = (n, d) => cs.getPropertyValue(n).trim() || d;
  return { blue: c('--song-1', '#0071e3'), purple: c('--song-3', '#a748d0'), orange: c('--robot-fill', '#ff9f0a'),
    ink: c('--ink', '#1d1d1f'), ink2: c('--ink2', '#6e6e73'), hair: c('--hair', '#d2d2d7'),
    purpleRGB: hexRGB(c('--song-3', '#a748d0'), '#a748d0') };
}

// d: { t: seconds on the music clock, levels: dBFS per 0.1 s, nLevels: how many have been heard,
//      spec: { data, fps, n }, hits: times, speed: robot joint speed per frame, n: frames the robot has done,
//      delay: s from the music to the robot, fps, smooth: half window (frames) for the speed line,
//      playing: whether sound is coming out now, key: skip the redraw while it is unchanged }
export function drawStrip(cv, d) {
  if (!cv.clientWidth) return;
  let st = states.get(cv);
  if (!st) { st = { at: 0, key: '', colors: null, colorsAt: 0, peaks: new Float32Array(BANDS), peaksAt: 0, off: null }; states.set(cv, st); }
  const ms = performance.now();
  if (ms - st.at < 33) return;                // at most 30 redraws a second
  const key = d.key ? `${d.key}|${cv.clientWidth}x${cv.clientHeight}` : '';
  if (key && key === st.key && ms - st.colorsAt < 2000) return;   // unchanged (paused): redraw only for a theme change
  st.at = ms;
  st.key = key;
  if (!st.colors || ms - st.colorsAt > 2000) { st.colors = themeColors(); st.colorsAt = ms; }
  const C = st.colors, t = d.t;
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const small = w < 560, fs = small ? 9 : 10;
  g.font = `${fs + 1}px -apple-system, system-ui, sans-serif`;
  g.textBaseline = 'top';
  const pad = 10, split = Math.round(w * (small ? 0.64 : 0.7)), gut = small ? 40 : 52;
  const top = small ? 20 : 24, bot = h - 8, A = bot - top, gap = Math.max(2, A * 0.03);
  const rows = [['Rhythm', 0.1], ['Sound', 0.33], ['Volume', 0.22], ['Robot', 0.26]];
  let y = top;
  const R = {};
  for (const [name, f] of rows) { R[name] = [y, y + A * f]; y += A * f + gap; }
  const x0 = pad + gut, x1 = split - pad, x = (sec) => x0 + ((sec - (t - WIN)) / WIN) * (x1 - x0);

  g.fillStyle = C.ink2;
  g.fillText('What the model hears', pad, 6);
  g.textAlign = 'right';
  g.fillText(`last ${WIN} s`, x1, 6);
  g.textAlign = 'left';
  g.font = `${fs}px -apple-system, system-ui, sans-serif`;
  g.textBaseline = 'middle';
  for (const [name] of rows) {
    g.fillStyle = name === 'Robot' ? C.orange : C.ink2;
    g.fillText(name, pad, (R[name][0] + R[name][1]) / 2);
  }
  g.save();
  g.beginPath();
  g.rect(x0, top - 1, x1 - x0, bot - top + 2);
  g.clip();

  // rhythm: a tick at each hit heard so far
  const hits = d.hits || [];
  g.strokeStyle = C.ink;
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = hits.length - 1; i >= 0; i--) {
    const ht = hits[i];
    if (ht > t) continue;
    if (ht < t - WIN) break;
    g.moveTo(x(ht), R.Rhythm[0]);
    g.lineTo(x(ht), R.Rhythm[1]);
  }
  g.stroke();

  // spectrogram: low notes at the bottom
  const sp = d.spec;
  if (sp && sp.n) {
    const cols = Math.ceil(WIN * sp.fps), i0 = Math.floor((t - WIN) * sp.fps), iNow = Math.min(sp.n, Math.floor(t * sp.fps) + 1);
    if (!st.off || st.off.width !== cols) {
      st.off = document.createElement('canvas');
      st.off.width = cols;
      st.off.height = BANDS;
      st.img = st.off.getContext('2d').createImageData(cols, BANDS);
    }
    const px = st.img.data, [r, gg, b] = C.purpleRGB;
    for (let c = 0; c < cols; c++) {
      const i = i0 + c, ok = i >= 0 && i < iNow;
      for (let k = 0; k < BANDS; k++) {
        const o = ((BANDS - 1 - k) * cols + c) * 4, v = ok ? sp.data[i * BANDS + k] / 255 : 0;
        px[o] = r; px[o + 1] = gg; px[o + 2] = b; px[o + 3] = Math.round(Math.pow(v, 1.6) * 255);
      }
    }
    st.off.getContext('2d').putImageData(st.img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(st.off, x(i0 / sp.fps), R.Sound[0], x((i0 + cols) / sp.fps) - x(i0 / sp.fps), R.Sound[1] - R.Sound[0]);
  }

  // volume: one bar per 0.1 s, centred
  const lv = d.levels, nl = Math.min(d.nLevels || 0, lv ? lv.length : 0);
  if (nl) {
    const mid = (R.Volume[0] + R.Volume[1]) / 2, half = (R.Volume[1] - R.Volume[0]) / 2;
    g.fillStyle = C.blue;
    for (let i = Math.max(0, Math.floor((t - WIN) / LEVEL_STEP)); i < nl; i++) {
      const a = Math.max(0, Math.min(1, (lv[i] + 60) / 54)), hh = Math.max(0.5, a * half), xx = x(i * LEVEL_STEP);
      g.fillRect(xx, mid - hh, Math.max(1, x((i + 1) * LEVEL_STEP) - xx - 1), 2 * hh);
    }
  }

  // robot: joint speed, drawn when the robot moves
  const spd = d.speed, n = d.n || 0, fps = d.fps || 30, sm = d.smooth || 0;
  if (spd && n > 1) {
    const yb = R.Robot[1], yh = R.Robot[1] - R.Robot[0];
    g.strokeStyle = C.orange;
    g.lineWidth = 1.6;
    g.beginPath();
    let started = false;
    for (let k = Math.max(1, Math.floor((t - WIN - d.delay) * fps)); k < n; k += 2) {
      let s = 0, c = 0;
      for (let j = Math.max(1, k - sm); j <= Math.min(n - 1, k + sm); j++) { s += spd[j]; c++; }
      const yy = yb - Math.min(1, s / c / 1.6) * yh, xx = x(k / fps + d.delay);
      if (started) g.lineTo(xx, yy); else { g.moveTo(xx, yy); started = true; }
    }
    g.stroke();
  }
  g.restore();
  g.strokeStyle = C.hair;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(split + 0.5, 6);
  g.lineTo(split + 0.5, h - 6);
  g.stroke();

  // right: the sound now
  const rx0 = split + pad, rx1 = w - pad;
  g.font = `${fs + 1}px -apple-system, system-ui, sans-serif`;
  g.textBaseline = 'top';
  g.fillStyle = C.ink2;
  g.fillText('Now', rx0, 6);
  let lastHit = -Infinity;
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i] <= t) { lastHit = hits[i]; break; }
  const e = d.playing ? Math.exp(-(t - lastHit) / 0.18) : 0, dotX = rx0 + 40, dotY = 6 + (fs + 1) / 2;
  g.fillStyle = C.ink;
  g.globalAlpha = 0.18 + 0.82 * e;
  g.beginPath();
  g.arc(dotX, dotY, 3 + 3 * e, 0, 2 * Math.PI);
  g.fill();
  g.globalAlpha = 1;
  g.font = `${fs}px -apple-system, system-ui, sans-serif`;
  g.fillStyle = C.ink2;
  g.fillText('hit', dotX + 9, 6 + 1);
  g.textAlign = 'right';
  g.fillText('vol', rx1, 6 + 1);
  g.textAlign = 'left';
  const meterW = 6, bx0 = rx0, bx1 = rx1 - meterW - 8, bw = (bx1 - bx0) / BANDS, by0 = top + 2, by1 = bot - (small ? 2 : 12);
  const iT = sp ? Math.floor(t * sp.fps) : -1, i = sp ? Math.min(iT, sp.n - 1) : -1;
  const on = d.playing && sp && i >= 0 && iT - i <= 0.3 * sp.fps;   // Live: the newest frame, up to 0.3 s old
  const dt = Math.min(0.2, (ms - st.peaksAt) / 1000);
  st.peaksAt = ms;
  const grad = g.createLinearGradient(0, by1, 0, by0);
  grad.addColorStop(0, C.blue);
  grad.addColorStop(1, C.purple);
  for (let k = 0; k < BANDS; k++) {
    const v = on ? sp.data[i * BANDS + k] / 255 : 0, hh = v * (by1 - by0);
    st.peaks[k] = on ? Math.max(v, st.peaks[k] - 0.8 * dt) : 0;
    g.fillStyle = grad;
    g.fillRect(bx0 + k * bw + 1, by1 - hh, Math.max(1, bw - 2), hh);
    if (st.peaks[k] > 0.02) {
      g.fillStyle = C.ink2;
      g.fillRect(bx0 + k * bw + 1, by1 - st.peaks[k] * (by1 - by0) - 1.5, Math.max(1, bw - 2), 1.5);
    }
  }
  // volume meter
  const li = Math.floor(t / LEVEL_STEP) - 1, lvNow = d.playing && lv && li >= 0 && li < nl ? Math.max(0, Math.min(1, (lv[li] + 60) / 54)) : 0;
  g.fillStyle = C.hair;
  g.fillRect(rx1 - meterW, by0, meterW, by1 - by0);
  g.fillStyle = C.blue;
  g.fillRect(rx1 - meterW, by1 - lvNow * (by1 - by0), meterW, lvNow * (by1 - by0));
  if (!small) {
    g.fillStyle = C.ink2;
    g.textBaseline = 'bottom';
    g.fillText('60 Hz', bx0, h - 1);
    g.textAlign = 'right';
    g.fillText('8 kHz', bx1, h - 1);
    g.textAlign = 'left';
  }
}
