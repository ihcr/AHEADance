// Live: play a music file here; the model on our cloud GPU listens as it plays and the robot dances 1.24 s behind
// the music, as on the real robot. Pause the music and the browser streams silence, so the model hears the music
// stop and the robot settles; play again and it dances again.
//
// The page plays the music through Web Audio at 48 kHz. A small audio worklet passes it to the speakers and sends
// exactly those samples (16-bit stereo, 0.1 s per message) to the live server; paused music is digital silence.
// The server sends back one 16-frame chunk of motion (0.533 s at 30 fps) at a time. Frame f is shown when the
// stream clock (what the speakers are playing) reaches f / 30 + 1.24 s.
import { CLIENT, store } from './requests.js';

export const LIVE = 'wss://pengtianhu--aheadance-live-web.us-east.modal.run/ws';
const SR = 48000, FPS = 30, CH = 36, LEAD = 1.0, MAX_MB = 60;
const STAND = 0.12, DANCE = 0.25;     // rad/s, as in the web demo
const $ = (id) => document.getElementById(id);
const mmss = (t) => { t = Math.max(0, Math.floor(t)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false; this.first = -1; this.n = 0; this.buf = new Int16Array(9600);
    this.port.onmessage = (e) => { this.on = e.data === 'start' ? true : e.data === 'stop' ? false : this.on; };
  }
  process(inputs, outputs) {
    const inp = inputs[0] || [], out = outputs[0], n = out[0].length;
    const l = inp[0], r = inp[1] || inp[0];
    out[0].set(l || new Float32Array(n));
    if (out[1]) out[1].set(r || new Float32Array(n));
    if (!this.on) return true;
    if (this.first < 0) { this.first = currentFrame; this.port.postMessage({ first: currentFrame }); }
    for (let i = 0; i < n; i++) {
      const a = l ? l[i] : 0, b = r ? r[i] : 0;
      this.buf[2 * this.n] = Math.max(-32768, Math.min(32767, Math.round(a * 32768)));
      this.buf[2 * this.n + 1] = Math.max(-32768, Math.min(32767, Math.round(b * 32768)));
      if (++this.n === 4800) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Int16Array(9600); this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('aheadance-tap', Tap);`;

export function initLive(api) {
  const el = Object.fromEntries(['live', 'live-code-form', 'live-code', 'live-who', 'live-who-text', 'live-forget',
    'live-file', 'live-file-name', 'live-go', 'live-music', 'live-end', 'live-status', 'live-stats']
    .map((k) => [k.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(k)]));
  const S = { code: store.get(), buffer: null, name: '', ctx: null, tap: null, src: null, ws: null, state: 'idle',
    first: -1, max: 180, delay: 1.24, frames: null, have: 0, music: [], playing: false, pos: 0, startedAt: 0,
    late: 0, rx: [], done: null };

  // ---- access code (the same code as Your song)
  function showCode() {
    const has = !!S.code;
    el.liveCodeForm.hidden = has;
    el.liveWho.hidden = !has;
    if (has) el.liveWhoText.textContent = 'Access code saved';
    buttons();
  }
  el.liveCodeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = el.liveCode.value.trim();
    if (!v) return;
    S.code = v;
    store.set(v);
    showCode();
  });
  el.liveForget.addEventListener('click', () => { S.code = ''; store.set(''); el.liveCode.value = ''; showCode(); });
  window.addEventListener('aheadance-code', (e) => { S.code = e.detail; showCode(); });

  // ---- the music file
  el.liveFile.addEventListener('change', async () => {
    const f = el.liveFile.files[0];
    if (!f) return;
    if (f.size > MAX_MB * 1e6) { status(`That file is larger than ${MAX_MB} MB.`); return; }
    status('Reading the file…');
    try {
      const ctx = context();
      S.buffer = await ctx.decodeAudioData(await f.arrayBuffer());
      S.name = f.name.replace(/\.[^.]+$/, '');
      el.liveFileName.textContent = `${f.name} · ${mmss(S.buffer.duration)}`;
      status('');
    } catch {
      S.buffer = null;
      status('This file could not be decoded as audio.');
    }
    buttons();
  });

  function context() {
    if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    if (S.ctx.state === 'suspended') S.ctx.resume().catch(() => {});
    return S.ctx;
  }
  function status(text) { el.liveStatus.textContent = text; }
  function buttons() {
    const live = ['connecting', 'warming', 'live'].includes(S.state);
    el.liveGo.hidden = live;
    el.liveGo.disabled = !S.code || !S.buffer;
    el.liveMusic.hidden = S.state !== 'live';
    el.liveMusic.textContent = S.playing ? 'Pause the music' : 'Play the music';
    el.liveEnd.hidden = !live;
    el.liveFile.disabled = live;
  }

  // ---- the stream clock: the context time the speakers are playing, minus the time of the first streamed sample
  function streamTime() {
    if (!S.ctx || S.first < 0) return 0;
    let heard = S.ctx.currentTime - (S.ctx.outputLatency || 0) - (S.ctx.baseLatency || 0);
    if (S.ctx.getOutputTimestamp) {     // more exact where the browser reports it; ignored when implausible
      const ts = S.ctx.getOutputTimestamp();
      const at = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      if (ts.contextTime > 0 && Math.abs(at - heard) < 0.5) heard = at;
    }
    return Math.max(0, heard - S.first / SR);
  }

  // ---- music on and off
  function musicOn() {
    if (S.playing || !S.buffer || S.state !== 'live') return;
    if (S.pos >= S.buffer.duration - 0.05) S.pos = 0;
    const src = S.ctx.createBufferSource();
    src.buffer = S.buffer;
    src.connect(S.tap);
    src.start(0, S.pos);
    src.onended = () => { if (S.src === src) { S.pos = S.buffer.duration; musicOff(true); } };
    Object.assign(S, { src, playing: true, startedAt: S.ctx.currentTime });
    mark(true);
  }
  function musicOff(ended) {
    if (!S.playing) return;
    const src = S.src;
    S.src = null;
    if (!ended) S.pos = Math.min(S.buffer.duration, S.pos + S.ctx.currentTime - S.startedAt);
    try { src.stop(); } catch { /* already stopped */ }
    src.disconnect();
    S.playing = false;
    mark(false);
  }
  function mark(playing) {             // on the stream clock: where in the stream the change lands
    const at = S.first < 0 ? 0 : Math.max(0, S.ctx.currentTime - S.first / SR);
    S.music.push({ playing, at });
    send(JSON.stringify({ type: 'music', playing, at: +at.toFixed(3) }));
    buttons();
  }
  function send(x) {
    if (!S.ws || S.ws.readyState !== 1) return;
    S.ws.send(x);
    const queued = S.ws.bufferedAmount;          // bytes the connection has not sent yet
    S.maxQueued = Math.max(S.maxQueued, queued);
    if (queued > SR * 4 && S.state === 'live' && !S.warned) {
      S.warned = true;
      el.liveStats.textContent = 'Your connection is not sending the music fast enough, so the robot may stall.';
    }
  }

  // ---- a session
  async function go() {
    if (!S.code || !S.buffer) return;
    api.begin(controller);
    const ctx = context();
    Object.assign(S, { state: 'connecting', first: -1, have: 0, music: [], playing: false, pos: 0, late: 0, rx: [],
      done: null, frames: null, maxQueued: 0, warned: false });
    el.liveStats.textContent = '';
    buttons();
    status('Connecting to the live server…');
    try {
      if (!S.tap) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        S.tap = new AudioWorkletNode(ctx, 'aheadance-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        S.tap.connect(ctx.destination);
      }
    } catch (e) {
      return finish(`This browser cannot run the live mode (${e.message}).`);
    }
    if (ctx.sampleRate !== SR) return finish('This browser cannot play audio at 48 kHz, which the live mode needs.');
    S.tap.port.onmessage = (e) => {
      if (e.data && e.data.first !== undefined) { S.first = e.data.first; return; }
      send(e.data);
    };
    const ws = new WebSocket(LIVE);
    ws.binaryType = 'arraybuffer';
    S.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', code: S.code, client: CLIENT }));
    ws.onmessage = (e) => {
      if (S.ws !== ws) return;
      if (typeof e.data !== 'string') return chunk(e.data);
      const m = JSON.parse(e.data);
      if (m.type === 'warming') {
        S.state = 'warming';
        status(`Starting the cloud GPU… ${m.seconds} s (the first visitor in a while waits about a minute)`);
      } else if (m.type === 'ready') {
        Object.assign(S, { state: 'live', max: m.seconds, delay: m.delay, frames: new Float32Array(m.seconds * FPS * CH + 16 * CH) });
        status('Live. The robot starts standing; the music starts in a moment.');
        S.tap.port.postMessage('start');
        setTimeout(() => { if (S.state === 'live' && S.ws === ws) musicOn(); }, LEAD * 1000);
      } else if (m.type === 'done') {
        if (m.error) el.liveStats.textContent = m.error;
        finish(m.reason === 'the music stopped arriving'
          ? 'The music stopped reaching our server, so the live session ended. A slow or busy connection can cause this.'
          : m.error ? 'The live model stopped unexpectedly. Please go live again.' : null, m.reason);
      } else if (['busy', 'limit', 'error'].includes(m.type)) {
        finish(m.message || 'The live server refused the session.');
      }
      buttons();
    };
    ws.onerror = () => { if (S.ws === ws && S.state !== 'idle') finish('The live server cannot be reached.'); };
    ws.onclose = () => { if (S.ws === ws && S.state !== 'idle') finish(S.state === 'live' ? null : 'The live server closed the connection.'); };
  }
  function chunk(buf) {
    const v = new DataView(buf), frame = v.getInt32(0, true), lag = v.getFloat32(4, true);
    const rows = new Float32Array(buf, 12);
    if (!S.frames || frame * CH + rows.length > S.frames.length) return;
    S.frames.set(rows, frame * CH);
    S.have = Math.max(S.have, frame + 16);
    S.rx.push(streamTime() - frame / FPS);
    if (S.rx.length > 40) S.rx.shift();
    if (S.rx.length % 4 === 0) {
      const sorted = [...S.rx].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
      el.liveStats.textContent = med > S.delay
        ? `The motion is arriving ${med.toFixed(1)} s after the music, later than the ${S.delay.toFixed(2)} s it is shown at, so the robot may stall. A slow connection or a busy device can cause this.`
        : `Motion arrives ${med.toFixed(2)} s after the music it answers (shown at ${S.delay.toFixed(2)} s) · feature lag ${lag.toFixed(2)} s`;
    }
  }
  function finish(message, reason) {
    const was = S.state;
    if (S.playing) musicOff();
    if (S.tap) S.tap.port.postMessage('stop');
    S.state = 'idle';
    const ws = S.ws;
    S.ws = null;
    if (ws && ws.readyState <= 1) {
      const sorted = [...S.rx].sort((a, b) => a - b);
      const page = { max_queued_bytes: S.maxQueued, late_frames: S.late, arrival_median_s: sorted.length ? +sorted[sorted.length >> 1].toFixed(3) : null,
        sample_rate: S.ctx ? S.ctx.sampleRate : null, output_latency_s: S.ctx ? S.ctx.outputLatency ?? null : null, agent: navigator.userAgent.slice(0, 160) };
      try { ws.send(JSON.stringify({ type: 'end', page })); } catch { /* closing */ }
      ws.close();
    }
    S.first = -1;
    status(message || (was === 'live' ? `Live session ended${reason === 'longest session reached' ? ` (the longest is ${mmss(S.max)})` : ''}. Go live again any time.` : ''));
    buttons();
    api.end();
  }

  // ---- what the stage shows
  const q = new Float64Array(CH);
  function frameAt(f) {
    if (!S.frames || S.have === 0) return null;
    const last = S.have - 1;
    if (f > last) { S.late++; f = last; }
    const i0 = Math.max(0, Math.floor(f)), i1 = Math.min(i0 + 1, last), a = Math.max(0, Math.min(1, f - i0));
    let dot = 0;
    for (let j = 3; j < 7; j++) dot += S.frames[i0 * CH + j] * S.frames[i1 * CH + j];
    const sign = dot < 0 ? -1 : 1;
    for (let j = 0; j < CH; j++) q[j] = S.frames[i0 * CH + j] * (1 - a) + S.frames[i1 * CH + j] * (j >= 3 && j < 7 ? sign : 1) * a;
    return q;
  }
  function activity(i) {              // mean joint speed around frame i (rad/s), as computeActivity in app.js
    const h = Math.round(FPS * 0.25), lo = Math.max(1, i - h), hi = Math.min(S.have - 1, i + h);
    if (hi < lo) return 0;
    let s = 0;
    for (let k = lo; k <= hi; k++) for (let j = 7; j < CH; j++) s += Math.abs(S.frames[k * CH + j] - S.frames[(k - 1) * CH + j]);
    return (s / (CH - 7) / (hi - lo + 1)) * FPS;
  }
  function robot(t) {
    const f = Math.round((t - S.delay) * FPS);
    if (!S.frames || f < 1 || S.have < 2) return 'standing';
    const a = activity(Math.min(f, S.have - 1)), b = activity(Math.max(1, Math.min(f, S.have - 1) - FPS / 2));
    return a < STAND ? 'standing' : a > DANCE ? 'dancing' : a < b ? 'settling down' : 'starting to dance';
  }
  const controller = {
    get title() { return `Live · ${S.name}`; },
    get max() { return S.max; },
    now: streamTime,
    pose: (t) => frameAt((t - S.delay) * FPS),
    music: () => (S.playing ? `Music: ${S.name}` : 'Music: off'),
    playing: () => S.playing,
    robot,
    segments(t) {                     // music on/off so far, on the stream clock
      const out = [];
      for (let i = 0; i < S.music.length; i++) {
        if (!S.music[i].playing) continue;
        const end = S.music[i + 1] ? S.music[i + 1].at : t;
        out.push({ kind: 'music', t0: S.music[i].at, t1: end });
      }
      return out;
    },
    hint(t) {
      if (S.state === 'connecting') return 'Connecting to the live server…';
      if (S.state === 'warming') return 'Starting the cloud GPU. The robot will stand, then dance to your music.';
      if (S.state !== 'live') return '';
      const r = robot(t), left = S.max - t;
      if (left < 15) return `The live session ends in ${Math.ceil(left)} s.`;
      if (!S.music.length) return 'The robot is standing. The music starts in a moment.';
      if (S.playing) return t - S.music[S.music.length - 1].at < S.delay + 0.3 ? 'The model is listening. The robot answers 1.24 s behind the music.'
        : 'Live. Pause the music any time and watch the robot react.';
      if (S.pos >= S.buffer.duration - 0.05) return r === 'standing' ? 'The music has ended and the robot is standing.' : 'The music has ended. The robot heard the silence and is settling.';
      return r === 'standing' ? 'Music paused. The robot is standing. Play the music again.' : 'Music paused. The robot heard the silence and is settling.';
    },
    toggle() { if (S.state === 'live') (S.playing ? musicOff() : musicOn()); },
    stop() { if (S.state !== 'idle') finish(); },
    debug: () => ({ state: S.state, t: +streamTime().toFixed(2), have: S.have, late: S.late, playing: S.playing,
      queued: S.ws ? S.ws.bufferedAmount : 0, maxQueued: S.maxQueued,
      music: S.music.map((m) => [m.playing, +m.at.toFixed(2)]), rx: S.rx.slice(-8).map((x) => +x.toFixed(2)) }),
  };

  el.liveGo.addEventListener('click', () => { context(); go(); });
  el.liveMusic.addEventListener('click', () => controller.toggle());
  el.liveEnd.addEventListener('click', () => controller.stop());
  showCode();
  return controller;
}
