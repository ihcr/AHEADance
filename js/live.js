// Live: play a music file here; the model on our cloud GPU listens as it plays and the robot dances 1.24 s behind
// the music, as on the real robot. Pause the music and the browser streams silence, so the model hears the music
// stop and the robot settles; play again and it dances again.
//
// The page plays the music through Web Audio at 48 kHz. A small audio worklet passes it to the speakers and sends
// exactly those samples (16-bit stereo, 0.1 s per message) to the live server; paused music is digital silence.
// The server sends back one 16-frame chunk of motion (0.533 s at 30 fps) at a time. Frame f is shown when the
// stream clock (what the speakers are playing) reaches f / 30 + 1.24 s.
//
// Microphone (beta, user 11-04 for the advisor): the music plays on another device, such as a phone, and the
// computer's microphone streams what it hears (browser echo cancelling, noise suppression and gain control off; the
// microphone is never played back here). The server runs the real robot's microphone chain on it, which spends the
// first 4.7 s learning the room. Nothing is kept unless the visitor ticks the box.
//
// SONIC (user 11-05): the server also runs SONIC, the whole-body motion tracker of our robot, in the MuJoCo simulator,
// on the generated motion as it arrives (the real robot's 1.24 s delivery), and streams back the pose SONIC achieves
// (frame numbers from ready.sonic.base up). That pose comes later than the generated chunks, so the SONIC view is
// shown ready.sonic.delay s behind the music. If the simulated robot falls or SONIC stops, the page says so and
// switches to the generated motion; the visitor can switch back.
import { CLIENT, store } from './requests.js?v=20261105m';   // same URL as app.js: one module
import { drawStrip, streamAnalysis } from './strip.js?v=20261105m';

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
    this.mono = false; this.el = 0; this.er = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.on = true;
      else if (e.data === 'stop') this.on = false;
      else if (e.data === 'mono' || e.data === 'stereo') { this.mono = e.data === 'mono'; this.el = 0; this.er = 0; }
    };
  }
  process(inputs, outputs) {
    const inp = inputs[0] || [], out = outputs[0], n = out[0].length;
    const l = inp[0], r = inp[1] || inp[0];
    out[0].set(l || new Float32Array(n));
    if (out[1]) out[1].set(r || new Float32Array(n));
    if (!this.on) return true;
    if (this.first < 0) { this.first = currentFrame; this.port.postMessage({ first: currentFrame }); }
    // microphone: the server reads one channel, as the robot's mic (dual mono). Safari on a Mac gives the built-in
    // mic on the left channel only, the right one silent (11-05), so send the channel that has the sound on both.
    let L = l, R = r;
    if (this.mono && l && r && l !== r) {
      for (let i = 0; i < n; i++) { this.el += l[i] * l[i]; this.er += r[i] * r[i]; }
      L = R = this.er > this.el ? r : l;
    }
    for (let i = 0; i < n; i++) {
      const a = L ? L[i] : 0, b = R ? R[i] : 0;
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
  const el = Object.fromEntries(['live', 'live-signin', 'live-who', 'live-who-text', 'live-forget',
    'live-file', 'live-file-name', 'live-go', 'live-music', 'live-end', 'live-status', 'live-stats',
    'live-src-file', 'live-src-mic', 'live-mic', 'live-keep', 'live-drop', 'live-mic-device', 'live-mic-test', 'live-mic-level',
    'live-viz-wrap', 'live-viz']
    .map((k) => [k.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(k)]));
  const S = { code: store.get(), buffer: null, name: '', ctx: null, tap: null, src: null, ws: null, state: 'idle',
    first: -1, max: 180, delay: 1.24, frames: null, have: 0, music: [], playing: false, pos: 0, startedAt: 0,
    late: 0, rx: [], done: null, source: 'file', mic: null, micNode: null, out: null, level: -120, room: 0, zeros: 0,
    levels: [], speed: null,         // for the timeline: dBFS per streamed 0.1 s, joint speed per received frame
    sonic: null, sim: null, simHave: 0, simSpeed: null, simRx: [], simLate: 0, simState: '', view: 'sim' };
  const sim = () => S.view === 'sim' && !!S.sonic;     // the SONIC view is on
  // the frames the stage shows: the generated motion, or SONIC's
  const src = () => (sim() ? { frames: S.sim, have: S.simHave, speed: S.simSpeed, delay: S.sonic.delay }
    : { frames: S.frames, have: S.have, speed: S.speed, delay: S.delay });
  const isMic = () => S.source === 'microphone';

  // ---- signed in? (the same sign-in as Your song: an email token or an access code)
  function showCode() {
    const has = !!S.code;
    el.liveSignin.hidden = has;
    el.liveWho.hidden = !has;
    if (has) el.liveWhoText.textContent = 'Signed in';
    buttons();
  }
  el.liveForget.addEventListener('click', () => { S.code = ''; store.set(''); showCode(); });
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

  // ---- music file or microphone
  function setSource(src) {
    if (['connecting', 'queued', 'warming', 'live'].includes(S.state)) return;
    S.source = src;
    el.liveSrcFile.setAttribute('aria-pressed', String(src === 'file'));
    el.liveSrcMic.setAttribute('aria-pressed', String(src === 'microphone'));
    el.liveDrop.hidden = src !== 'file';
    el.liveMic.hidden = src !== 'microphone';
    buttons();
  }
  // ---- microphone check (no server, no GPU): level meter and device choice
  const MIC = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  const micConstraints = () => ({ audio: el.liveMicDevice.value ? { ...MIC, deviceId: { exact: el.liveMicDevice.value } } : MIC });
  async function listMics() {
    try {
      const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      const keep = el.liveMicDevice.value;
      el.liveMicDevice.replaceChildren(...all.map((d, i) => Object.assign(document.createElement('option'),
        { value: d.deviceId, textContent: d.label || `Microphone ${i + 1}` })));
      if (keep && all.some((d) => d.deviceId === keep)) el.liveMicDevice.value = keep;
      el.liveMicDevice.hidden = all.length < 1;
    } catch { /* no device list */ }
  }
  let testing = null;
  async function testMic() {
    try { await runMicTest(); } catch (e) {
      el.liveMicLevel.textContent = `The microphone test failed: ${e && e.message ? e.message : e}`;
    }
  }
  async function runMicTest() {
    if (testing) { testing(); return; }
    el.liveMicLevel.textContent = 'Asking to use the microphone… (allow it in the browser prompt)';
    const ctx = context();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints());
    } catch (e) {
      el.liveMicLevel.textContent = e && e.name === 'NotAllowedError' ? 'The microphone was not allowed.' : `No microphone (${e && e.message ? e.message : e}).`;
      return;
    }
    await listMics();
    const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
    an.fftSize = 4096;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const track = stream.getAudioTracks()[0], used = track && track.label ? `Using "${track.label}". ` : '';
    let zeros = 0, n = 0, timer = 0;
    const stopTest = () => { clearInterval(timer); src.disconnect(); stream.getTracks().forEach((tr) => tr.stop()); testing = null; el.liveMicTest.textContent = 'Test the microphone'; };
    testing = stopTest;
    el.liveMicTest.textContent = 'Stop the test';
    timer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let p = 0;
      for (const v of buf) p += v * v;
      const db = 10 * Math.log10(p / buf.length + 1e-12);
      zeros = p === 0 ? zeros + 1 : 0;
      el.liveMicLevel.textContent = used + (zeros >= 10
        ? 'Pure silence: this input is muted, has nothing plugged in, or is blocked. Pick another microphone above, or check the computer\'s sound input settings (unmuted, level up) and its microphone permission for the browser.'
        : `Level ${db.toFixed(0)} dB · ${db > -50 ? 'hearing sound' : 'quiet room'}. Music from the phone should read above -40 dB.`);
      if (++n > 150) stopTest();                 // 15 s
    }, 100);
  }
  el.liveMicTest.addEventListener('click', testMic);
  el.liveMicDevice.addEventListener('change', () => { if (testing) { testing(); testMic(); } });

  el.liveSrcFile.addEventListener('click', () => setSource('file'));
  el.liveSrcMic.addEventListener('click', () => setSource('microphone'));

  function context() {
    if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
    if (S.ctx.state === 'suspended') S.ctx.resume().catch(() => {});
    return S.ctx;
  }
  function status(text) { el.liveStatus.textContent = text; }
  function buttons() {
    const live = ['connecting', 'queued', 'warming', 'live'].includes(S.state);
    el.liveGo.hidden = live;
    el.liveGo.disabled = !S.code || (!isMic() && !S.buffer);
    el.liveMusic.hidden = S.state !== 'live' || isMic();
    el.liveSrcFile.disabled = el.liveSrcMic.disabled = live;
    el.liveMusic.textContent = S.playing ? 'Pause the music' : 'Play the music';
    el.liveEnd.hidden = !live;
    el.liveEnd.textContent = S.state === 'queued' ? 'Leave the line' : 'End';
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
    if (!S.code || (!isMic() && !S.buffer)) return;
    api.begin(controller);
    const ctx = context();
    Object.assign(S, { state: 'connecting', first: -1, have: 0, music: [], playing: false, pos: 0, late: 0, rx: [],
      done: null, frames: null, maxQueued: 0, warned: false, zeros: 0, levels: [], speed: null, vz: null,
      sonic: null, sim: null, simHave: 0, simSpeed: null, simRx: [], simLate: 0, simState: '', simNote: '', simSwitchAt: 0 });
    el.liveStats.textContent = '';
    buttons();
    status('Connecting to the live server…');
    try {
      if (!S.tap) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await ctx.audioWorklet.addModule(url);
        S.tap = new AudioWorkletNode(ctx, 'aheadance-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        S.out = ctx.createGain();
        S.tap.connect(S.out);
        S.out.connect(ctx.destination);
      }
    } catch (e) {
      return finish(`This browser cannot run the live mode (${e.message}).`);
    }
    if (ctx.sampleRate !== SR) return finish('This browser cannot play audio at 48 kHz, which the live mode needs.');
    S.out.gain.value = isMic() ? 0 : 1;           // the microphone is never played back (no feedback)
    if (isMic()) {
      status('Asking to use the microphone…');
      try {
        if (testing) testing();
        S.mic = await navigator.mediaDevices.getUserMedia(micConstraints());
        listMics();
        S.micNode = ctx.createMediaStreamSource(S.mic);
        S.micNode.connect(S.tap);
      } catch (e) {
        return finish(e && e.name === 'NotAllowedError' ? 'The microphone was not allowed. Allow it in the browser and go live again.'
          : `This browser cannot use the microphone here (${e && e.message ? e.message : e}). Chrome works best.`);
      }
      status('Connecting to the live server…');
    }
    S.tap.port.onmessage = (e) => {
      if (e.data && e.data.first !== undefined) { S.first = e.data.first; return; }
      const a = new Int16Array(e.data);
      let p = 0;
      for (let i = 0; i < a.length; i += 2) p += a[i] * a[i];
      S.level = 10 * Math.log10(p / Math.max(1, a.length / 2) / 1073741824 + 1e-12);   // dBFS of this 0.1 s
      // a microphone that delivers exact zeros is blocked or the wrong device (seen 11-04: the OS had not allowed it)
      S.zeros = p === 0 ? S.zeros + 1 : 0;
      if (S.state === 'live' && S.first >= 0) { S.levels.push(S.level); if (S.vz) S.vz.push(a); }   // the strip under the stage
      if (isMic() && S.state === 'live' && S.zeros === 15) {
        status('Your microphone is sending pure silence. Check that your computer lets the browser use the microphone '
          + '(macOS: System Settings › Privacy & Security › Microphone; Windows: Settings › Privacy › Microphone) and that '
          + 'the browser uses the right microphone (the icon left of the address bar), then go live again.');
      }
      send(e.data);
    };
    const ws = new WebSocket(LIVE);
    ws.binaryType = 'arraybuffer';
    S.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', code: S.code, client: CLIENT, source: S.source,
      keep: isMic() && el.liveKeep.checked }));
    ws.onmessage = (e) => {
      if (S.ws !== ws) return;
      if (typeof e.data !== 'string') return chunk(e.data);
      const m = JSON.parse(e.data);
      if (m.type === 'queue') {             // someone else is live: wait in line (one session at a time)
        S.state = 'queued';
        status(`Someone else is live right now. You are number ${m.position} in line, about ${m.wait} s to go. Keep this page open.`);
      } else if (m.type === 'warming') {
        S.state = 'warming';
        status(`Starting the cloud GPU… ${m.seconds} s (the first visitor in a while waits about a minute)`);
      } else if (m.type === 'ready') {
        Object.assign(S, { state: 'live', max: m.seconds, delay: m.delay, frames: new Float32Array(m.seconds * FPS * CH + 16 * CH),
          speed: new Float32Array(m.seconds * FPS + 16), vz: streamAnalysis(m.seconds, S.ctx ? S.ctx.sampleRate : SR) });
        if (m.sonic) Object.assign(S, { sonic: m.sonic, sim: new Float32Array(m.seconds * FPS * CH + 64 * CH),
          simSpeed: new Float32Array(m.seconds * FPS + 64), simState: 'on' });
        api.views();
        S.tap.port.postMessage(isMic() ? 'mono' : 'stereo');
        S.tap.port.postMessage('start');
        el.liveVizWrap.hidden = false;
        if (isMic()) {
          S.room = m.room_seconds || 0;
          status('Live. Keep the room quiet for 5 seconds, then play music on your phone near this computer.');
        } else {
          status('Live. The robot starts standing; the music starts in a moment.');
          setTimeout(() => { if (S.state === 'live' && S.ws === ws) musicOn(); }, LEAD * 1000);
        }
      } else if (m.type === 'sonic') {    // the simulated robot fell, or SONIC stopped
        if (S.simState !== 'on') return;
        S.simState = m.event;
        S.simNote = (m.event === 'fell'
          ? `The tracker fell at ${mmss(m.at)}: it could not keep its balance in this motion.`
          : m.why === 'low' ? `The tracker stopped at ${mmss(m.at)}: the motion squatted below the simulator's 0.45 m safety height.`
            : m.why === 'late' ? `The tracker stopped at ${mmss(m.at)}: the motion reached it too late (a slow connection can cause this).`
              : `The tracker stopped at ${mmss(m.at)}.`) + ' Now showing the generated motion; switch back to Tracker to see where it stopped.';
        S.simSwitchAt = m.at + S.sonic.delay + 1.0;   // once the SONIC view has shown the moment (1 s after it)
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
  function simChunk(k0, rows) {      // SONIC's pose, 30 fps on the generated motion's clock
    const n = rows.length / CH;
    if (!S.sim || (k0 + n) * CH > S.sim.length) return;
    S.sim.set(rows, k0 * CH);
    for (let k = Math.max(1, k0); k < k0 + n; k++) {
      let sp = 0;
      for (let j = 7; j < CH; j++) sp += Math.abs(S.sim[k * CH + j] - S.sim[(k - 1) * CH + j]);
      S.simSpeed[k] = (sp / (CH - 7)) * FPS;
    }
    S.simHave = Math.max(S.simHave, k0 + n);
    S.simRx.push(streamTime() - (k0 + n - 1) / FPS);
    if (S.simRx.length > 40) S.simRx.shift();
  }
  function chunk(buf) {
    const v = new DataView(buf), frame = v.getInt32(0, true), lag = v.getFloat32(4, true);
    const rows = new Float32Array(buf, 12);
    if (S.sonic && frame >= S.sonic.base) return simChunk(frame - S.sonic.base, rows);
    if (!S.frames || frame * CH + rows.length > S.frames.length) return;
    S.frames.set(rows, frame * CH);
    for (let k = Math.max(1, frame); k < frame + 16; k++) {      // mean joint speed per frame (rad/s), as in app.js
      let sp = 0;
      for (let j = 7; j < CH; j++) sp += Math.abs(S.frames[k * CH + j] - S.frames[(k - 1) * CH + j]);
      S.speed[k] = (sp / (CH - 7)) * FPS;
    }
    S.have = Math.max(S.have, frame + 16);
    S.rx.push(streamTime() - frame / FPS);
    if (S.rx.length > 40) S.rx.shift();
    if (S.rx.length % 4 === 0 && !(S.simNote && !S.simSwitchAt)) {
      if (sim()) {
        const ss = [...S.simRx].sort((a, b) => a - b), sm = ss[ss.length >> 1];
        if (ss.length) {
          el.liveStats.textContent = sm > S.sonic.delay
            ? `The tracker's pose is arriving ${sm.toFixed(1)} s after the music, later than the ${S.sonic.delay.toFixed(2)} s it is shown at, so the robot may stall. A slow connection can cause this.`
            : `Tracker: pose arrives ${sm.toFixed(2)} s after the music (shown at ${S.sonic.delay.toFixed(2)} s) · generated motion ${med2(S.rx)} s`
              + (isMic() ? ` · microphone ${S.level.toFixed(0)} dB` : '');
        }
        return;
      }
      const sorted = [...S.rx].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
      el.liveStats.textContent = med > S.delay
        ? `The motion is arriving ${med.toFixed(1)} s after the music, later than the ${S.delay.toFixed(2)} s it is shown at, so the robot may stall. A slow connection or a busy device can cause this.`
        : `Motion arrives ${med.toFixed(2)} s after the music it answers (shown at ${S.delay.toFixed(2)} s) · feature lag ${lag.toFixed(2)} s`
          + (isMic() ? ` · microphone ${S.level.toFixed(0)} dB` : '');
    }
  }
  function med2(x) { const s = [...x].sort((a, b) => a - b); return s.length ? s[s.length >> 1].toFixed(2) : '–'; }
  function finish(message, reason) {
    const was = S.state;
    if (S.playing) musicOff();
    if (S.tap) S.tap.port.postMessage('stop');
    if (S.micNode) { S.micNode.disconnect(); S.micNode = null; }
    el.liveVizWrap.hidden = true;
    if (S.mic) { S.mic.getTracks().forEach((tr) => tr.stop()); S.mic = null; }
    S.state = 'idle';
    const ws = S.ws;
    S.ws = null;
    if (ws && ws.readyState <= 1) {
      const sorted = [...S.rx].sort((a, b) => a - b);
      const ss = [...S.simRx].sort((a, b) => a - b);
      const page = { max_queued_bytes: S.maxQueued, late_frames: S.late, arrival_median_s: sorted.length ? +sorted[sorted.length >> 1].toFixed(3) : null,
        sonic_late_frames: S.simLate, sonic_arrival_median_s: ss.length ? +ss[ss.length >> 1].toFixed(3) : null,
        sonic_arrival_max_s: ss.length ? +ss[ss.length - 1].toFixed(3) : null, view: S.view,
        sample_rate: S.ctx ? S.ctx.sampleRate : null, output_latency_s: S.ctx ? S.ctx.outputLatency ?? null : null, agent: navigator.userAgent.slice(0, 160) };
      try { ws.send(JSON.stringify({ type: 'end', page })); } catch { /* closing */ }
      ws.close();
    }
    S.first = -1;
    status(message || (was === 'live' ? `Live session ended${reason === 'longest session reached' ? ` (the longest is ${mmss(S.max)})` : ''}. Go live again any time.`
      : was === 'queued' ? 'You left the line.' : ''));
    buttons();
    api.end();
  }

  // ---- the strip under the stage (js/strip.js): rhythm, spectrogram and volume of what the model gets, and the robot
  function viz(t) {
    if (el.liveVizWrap.hidden) return;
    const s = src();
    drawStrip(el.liveViz, { t, levels: S.levels, nLevels: S.levels.length, spec: S.vz ? S.vz.spec : null, hits: S.vz ? S.vz.hits : [],
      speed: s.speed, n: Math.min(s.have, Math.floor((t - s.delay) * FPS) + 1), delay: s.delay, fps: FPS, smooth: 7,
      playing: S.state === 'live' });
  }

  // ---- what the stage shows
  const q = new Float64Array(CH);
  function frameAt(f) {
    const { frames, have } = src();
    if (!frames || have === 0) return null;
    const last = have - 1;
    if (f > last) { if (sim()) S.simLate++; else S.late++; f = last; }
    const i0 = Math.max(0, Math.floor(f)), i1 = Math.min(i0 + 1, last), a = Math.max(0, Math.min(1, f - i0));
    let dot = 0;
    for (let j = 3; j < 7; j++) dot += frames[i0 * CH + j] * frames[i1 * CH + j];
    const sign = dot < 0 ? -1 : 1;
    for (let j = 0; j < CH; j++) q[j] = frames[i0 * CH + j] * (1 - a) + frames[i1 * CH + j] * (j >= 3 && j < 7 ? sign : 1) * a;
    return q;
  }
  function activity(i) {              // mean joint speed around frame i (rad/s), as computeActivity in app.js
    const { frames, have } = src();
    const h = Math.round(FPS * 0.25), lo = Math.max(1, i - h), hi = Math.min(have - 1, i + h);
    if (hi < lo) return 0;
    let s = 0;
    for (let k = lo; k <= hi; k++) for (let j = 7; j < CH; j++) s += Math.abs(frames[k * CH + j] - frames[(k - 1) * CH + j]);
    return (s / (CH - 7) / (hi - lo + 1)) * FPS;
  }
  function robot(t) {
    const { frames, have, delay } = src();
    const f = Math.round((t - delay) * FPS);
    if (!frames || f < 1 || have < 2) return 'standing';
    const a = activity(Math.min(f, have - 1)), b = activity(Math.max(1, Math.min(f, have - 1) - FPS / 2));
    return a < STAND ? 'standing' : a > DANCE ? 'dancing' : a < b ? 'settling down' : 'starting to dance';
  }
  const controller = {
    get title() { return isMic() ? 'Live · microphone' : `Live · ${S.name}`; },
    get max() { return S.max; },
    now: streamTime,
    pose: (t) => {
      if (S.simSwitchAt && t >= S.simSwitchAt) {     // SONIC stopped or fell: say so, show the generated motion
        S.simSwitchAt = 0;
        el.liveStats.textContent = S.simNote;
        if (S.view === 'sim') { S.view = 'gen'; api.views(); }
      }
      return frameAt((t - src().delay) * FPS);
    },
    hasSim: () => !!S.sonic,
    get view() { return S.view; },
    setView(v) { S.view = v; },
    music: () => (isMic() ? `Microphone: ${S.level > -50 ? 'hearing sound' : 'quiet'}` : S.playing ? `Music: ${S.name}` : 'Music: off'),
    playing: () => (isMic() ? S.state === 'live' && S.level > -50 : S.playing),
    mainLabel: () => (isMic() ? 'End live' : S.playing ? 'Pause the music' : 'Play the music'),
    robot,
    segments(t) {                     // music on/off so far, on the stream clock
      if (isMic()) return [];
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
      if (S.state === 'queued') return 'Waiting for your turn. Each live session is at most 1 minute.';
      if (S.state !== 'live') return '';
      const r = robot(t), left = S.max - t;
      if (left < 15) return `The live session ends in ${Math.ceil(left)} s.`;
      if (isMic()) {
        if (S.zeros >= 15) return 'The microphone is silent: check the browser\'s microphone permission (see the Live panel).';
        if (t < S.room + 0.3) return `Listening to the room. Keep it quiet for ${Math.ceil(S.room + 0.3 - t)} s more.`;
        if (r === 'standing') return S.level < -50 ? 'Now play music on your phone, near this computer.'
          : 'The model is listening. The robot answers a moment after it hears.';
        return 'Stop the music or switch songs on your phone, and watch the robot follow.';
      }
      if (!S.music.length) return 'The robot is standing. The music starts in a moment.';
      if (S.playing) return t - S.music[S.music.length - 1].at < S.delay + 0.3 ? 'The model is listening. The robot answers a moment after the music.'
        : 'Live. Pause the music any time and watch the robot react.';
      if (S.pos >= S.buffer.duration - 0.05) return r === 'standing' ? 'The music has ended and the robot is standing.' : 'The music has ended. The robot heard the silence and is settling.';
      return r === 'standing' ? 'Music paused. The robot is standing. Play the music again.' : 'Music paused. The robot heard the silence and is settling.';
    },
    viz,
    // the timeline under "Music in. Motion out."
    levels: () => S.levels,
    speeds: () => { const s = src(); return s.speed ? s.speed.subarray(0, s.have) : new Float32Array(0); },
    get delay() { return src().delay; },
    events: () => (isMic() ? [] : S.music.map((m) => [m.at, m.playing ? 'start' : 'stop'])),
    toggle() { if (S.state !== 'live') return; if (isMic()) finish(); else (S.playing ? musicOff() : musicOn()); },
    stop() { if (S.state !== 'idle') finish(); },
    debug: () => ({ state: S.state, source: S.source, level: +S.level.toFixed(1), t: +streamTime().toFixed(2), have: S.have, late: S.late, playing: S.playing,
      queued: S.ws ? S.ws.bufferedAmount : 0, maxQueued: S.maxQueued,
      music: S.music.map((m) => [m.playing, +m.at.toFixed(2)]), rx: S.rx.slice(-8).map((x) => +x.toFixed(2)),
      sonic: S.sonic, view: S.view, simHave: S.simHave, simLate: S.simLate, simState: S.simState,
      simRx: S.simRx.slice(-8).map((x) => +x.toFixed(2)) }),
  };

  el.liveGo.addEventListener('click', () => { context(); go(); });
  el.liveMusic.addEventListener('click', () => controller.toggle());
  el.liveEnd.addEventListener('click', () => controller.stop());
  showCode();
  return controller;
}
