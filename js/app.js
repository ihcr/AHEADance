import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { forwardKinematics } from './fk.js?v=20261105e';
import { drawStrip, analyseMusic } from './strip.js?v=20261105e';

// Offline version: replays of dances the deployed model generated. Each programme = one audio file (exactly what the
// model heard) + its generated motion. The robot is shown 1.24 s behind the music, as on the real robot.

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STAND = 0.12, DANCE = 0.25;   // rad/s, mean joint speed of the generated motion

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (HTTP ${r.status})`);
  return r.json();
}
async function getBuffer(url, base64 = url.endsWith('.b64.txt')) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not load ${url} (HTTP ${r.status})`);
  if (!base64) return r.arrayBuffer();
  const s = atob((await r.text()).trim());           // binary data is shipped as base64 text
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}
const mmss = (t) => { t = Math.max(0, Math.floor(t)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="5" height="16" rx="1.2"/><rect x="14" y="4" width="5" height="16" rx="1.2"/></svg>',
  again: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 0 7.75 10h-2.1A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35A7.96 7.96 0 0 0 12 4z"/></svg>',
  wait: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="12" r="2"/></svg>',
};

// ---------------------------------------------------------------- scene
const stageEl = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.05, 80);
camera.position.set(2.1, 1.2, 2.55);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.75, 0);
controls.enableDamping = !reduceMotion;
controls.minDistance = 1.2;
controls.maxDistance = 9;
controls.maxPolarAngle = Math.PI * 0.49;
let needsRender = true;
controls.addEventListener('change', () => { needsRender = true; });

// Wheel zoom. OrbitControls r160 divides the wheel delta by (devicePixelRatio | 0), which is 0 when the browser is
// zoomed out below 100%: one wheel step then jumps straight to the nearest or farthest view. Zoom here instead, in
// proportion to how far the wheel turned (about 8% per mouse notch); pinch zoom on touch screens stays with OrbitControls.
stageEl.addEventListener('wheel', (e) => {
  if (e.target !== renderer.domElement) return;
  e.preventDefault();
  e.stopPropagation();                               // capture phase: OrbitControls' own wheel handler never runs
  let px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stageEl.clientHeight : 1);
  if (e.ctrlKey) px *= 5;                            // touchpad pinch arrives as small ctrl+wheel steps
  px = Math.max(-300, Math.min(300, px));
  const offset = camera.position.clone().sub(controls.target);
  const d = THREE.MathUtils.clamp(offset.length() * Math.pow(0.92, -px / 100), controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(offset.setLength(d));
  needsRender = true;
}, { capture: true, passive: false });

scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bcc4, 1.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.9);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -1.6, right: 1.6, top: 1.6, bottom: -1.6, near: 0.5, far: 14 });
sun.shadow.bias = -0.0004;
sun.shadow.radius = 6;
scene.add(sun, sun.target);
const floorMat = new THREE.ShadowMaterial({ opacity: 0.16 });   // invisible floor, only the robot's shadow
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

function applyTheme() {
  scene.background = new THREE.Color(css('--media'));
  floorMat.opacity = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light'
    || document.documentElement.dataset.theme === 'dark' ? 0.45 : 0.16;
  needsRender = true;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
applyTheme();

new ResizeObserver(() => {
  const w = stageEl.clientWidth, h = stageEl.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  needsRender = true;
}).observe(stageEl);
if (matchMedia('(pointer: coarse)').matches) $('stage-hint').textContent = 'Drag to turn · pinch to zoom';

// ---------------------------------------------------------------- robot
const robotRoot = new THREE.Group();
robotRoot.rotation.x = -Math.PI / 2;                 // MuJoCo is z-up, three.js is y-up
scene.add(robotRoot);
let tree = null;
const bodyObjs = [];
const rootWorld = new THREE.Vector3(0, 0.78, 0);

async function loadRobot() {
  tree = await getJSON('assets/g1.json');
  const buf = await getBuffer('assets/g1_meshes.bin');
  const geos = tree.meshes.map((m) => {
    const q = new Int16Array(buf, m.vert_offset, m.vert_count * 3);
    const pos = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) {
      const k = i % 3;
      pos[i] = m.lo[k] + ((q[i] + 32768) / 65535) * m.span[k];
    }
    const Index = m.index_type === 'uint16' ? Uint16Array : Uint32Array;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(new Index(buf, m.face_offset, m.face_count * 3), 1));
    g.computeVertexNormals();
    return g;
  });
  for (let i = 0; i < tree.bodies.length; i++) {
    const o = new THREE.Group();
    robotRoot.add(o);
    bodyObjs.push(o);
  }
  const mats = new Map();
  for (const gm of tree.geoms) {
    const key = gm.rgba.join(',');
    if (!mats.has(key)) {
      // product-style render: light shell, dark joints and sensors
      const light = gm.rgba[0] + gm.rgba[1] + gm.rgba[2] > 1.5;
      mats.set(key, new THREE.MeshStandardMaterial({ color: light ? 0xeeeff2 : 0x2a2b2f, roughness: light ? 0.55 : 0.4, metalness: light ? 0.05 : 0.3 }));
    }
    const mesh = new THREE.Mesh(geos[gm.mesh], mats.get(key));
    mesh.position.set(gm.pos[0], gm.pos[1], gm.pos[2]);
    mesh.quaternion.set(gm.quat[1], gm.quat[2], gm.quat[3], gm.quat[0]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    bodyObjs[gm.body].add(mesh);
  }
}

function setPose(qpos) {
  const fk = forwardKinematics(tree, qpos);
  for (let i = 0; i < fk.length; i++) {
    const { pos, quat } = fk[i];
    bodyObjs[i].position.set(pos[0], pos[1], pos[2]);
    bodyObjs[i].quaternion.set(quat[1], quat[2], quat[3], quat[0]);
  }
  rootWorld.set(qpos[0], qpos[2], -qpos[1]);
  needsRender = true;
}

function follow(alpha) {
  const goal = new THREE.Vector3(rootWorld.x, 0.75, rootWorld.z);
  const delta = goal.sub(controls.target).multiplyScalar(alpha);
  controls.target.add(delta);
  camera.position.add(delta);
  sun.position.set(controls.target.x + 2.2, 5, controls.target.z + 2.8);
  sun.target.position.set(controls.target.x, 0, controls.target.z);
}

// ---------------------------------------------------------------- data
let manifest = null;
const motionCache = new Map();

// the strip under the stage (js/strip.js): each replay's audio file is analysed once, when the dance loads
const musicCache = new Map();
function loadMusic(p) {
  if (!musicCache.has(p.id)) {
    const entry = { ready: null };
    musicCache.set(p.id, entry);
    getBuffer(p.audio).then((b) => analyseMusic(b)).then((r) => { entry.ready = r; })
      .catch((e) => console.warn(`music analysis of ${p.id}: ${e.message || e}`));
  }
  return musicCache.get(p.id);
}

function computeActivity(fr, n, ch, fps) {
  const a = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    let s = 0;
    for (let j = 7; j < ch; j++) s += Math.abs(fr[i * ch + j] - fr[(i - 1) * ch + j]);
    a[i] = (s / (ch - 7)) * fps;
  }
  a[0] = n > 1 ? a[1] : 0;
  const h = Math.round(fps * 0.25), c = new Float64Array(n + 1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i + 1] = c[i] + a[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - h), hi = Math.min(n, i + h + 1);
    out[i] = (c[hi] - c[lo]) / (hi - lo);
  }
  return out;
}
// What the robot shows: 'sim' = SONIC, the whole-body controller of our robot, executing the generated motion in the
// MuJoCo simulator (replays that have it, p.motion_sim; live sessions whose server runs SONIC); 'gen' = the generated
// motion itself. Same frames, same clock (live: SONIC's pose is shown later, js/live.js).
let view = 'sim';
const motionOf = (p) => (view === 'sim' && p.motion_sim ? p.motion_sim : p.motion);
function loadMotion(p) {
  const d = motionOf(p), key = `${p.id}|${d.file}`;
  if (!motionCache.has(key)) {
    motionCache.set(key, getBuffer(d.file, d.base64 ?? d.file.endsWith('.b64.txt')).then((buf) => {
      const raw = new Int16Array(buf), ch = d.channels;
      const frames = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) frames[i] = raw[i] * d.scale[i % ch];
      return { frames, activity: computeActivity(frames, d.frames, ch, d.fps) };
    }));
  }
  return motionCache.get(key);
}
function viewSwitch() {
  const sw = $('view-switch'), has = L ? !!(L.hasSim && L.hasSim()) : !!(P.prog && P.prog.motion_sim);
  sw.hidden = !has;
  const cur = L ? L.view : view;
  sw.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === (has ? cur : 'gen'))));
}
function setView(v) {
  if (L) {                               // live: the session's own view (it may have switched itself after a fall)
    view = v;
    if (L.setView) L.setView(v);
    viewSwitch();
    lastUI = '';
    return;
  }
  if (v === view) return;
  view = v;
  viewSwitch();
  const p = P.prog;
  if (!p) return;
  loadMotion(p).then((motion) => {
    if (P.prog !== p || L) return;
    P.motion = motion;
    drawDetails();
    poseAt(now());
    follow(1);
    lastUI = '';
  });
}
const song = (id) => manifest.songs[id];
const songsOf = (p) => [...new Set(p.segments.filter((s) => s.kind === 'music').map((s) => s.song))];
const endOf = (p) => p.duration + p.display_delay_s;
const segAt = (p, t) => p.segments.find((s) => s.t0 <= t && t < s.t1) || { kind: 'silence', t0: t, t1: Infinity };
const lastMusicEnd = (p) => Math.max(...p.segments.filter((s) => s.kind === 'music').map((s) => s.t1));

// ---------------------------------------------------------------- player (replay control)
// Sound goes through the first route that works in this viewer, in this order: an <audio> element on the file URL
// (it also plays with the iPhone silent switch on, and starts inside the tap), the same file fetched into a blob URL,
// then Web Audio on the fetched bytes. If none works, the robot plays without sound and the page says why.
const ROUTES = ['element', 'blob', 'webaudio', 'silent'];
const ROUTE_NAMES = { element: 'the audio file', blob: 'a downloaded copy of the audio file', webaudio: 'Web Audio', silent: 'none' };
const audio = new Audio();
audio.preload = 'auto';
audio.setAttribute('playsinline', '');
let loadedSrc = '', ctx = null;
const blobURLs = new Map(), buffers = new Map();
const P = { prog: null, motion: null, running: false, t: 0, ended: false, route: 'element', errors: [],
  clock: 'media', wallBase: 0, wallStart: 0, startAt: 0, node: null };   // clock: media | context | wall

function unlockContext() {               // inside a tap, so the Web Audio route can start later without another tap
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch { /* no Web Audio in this viewer */ }
}
function wallFrom(t) { Object.assign(P, { clock: 'wall', wallBase: t, wallStart: performance.now() }); }
function now() {
  if (!P.prog) return 0;
  if (!P.running) return P.t;
  const t = P.clock === 'wall' ? P.wallBase + (performance.now() - P.wallStart) / 1000
    : P.clock === 'context' ? ctx.currentTime - P.startAt : audio.currentTime;
  return Math.min(t, endOf(P.prog));
}
audio.addEventListener('ended', () => { if (P.running && P.clock === 'media') wallFrom(P.prog.duration); });
audio.addEventListener('error', () => {
  if (!P.prog || !loadedSrc || !['element', 'blob'].includes(P.route)) return;
  const e = audio.error;
  soundFailed(e ? `media error ${e.code}${e.message ? ` (${e.message})` : ''}` : 'media error');
});
function stopNode() {
  if (P.node) { try { P.node.stop(); } catch { /* already stopped */ } P.node.disconnect(); P.node = null; }
}
function stopSound() { audio.pause(); stopNode(); }
function setSrc(url) { if (loadedSrc !== url) { loadedSrc = url; audio.src = url; } }

function showSoundStatus() {
  const failed = P.errors.length ? ` Earlier routes failed: ${P.errors.join('; ')}.` : '';
  $('sound-status').textContent = P.route === 'silent'
    ? `Sound: blocked in this viewer.${failed}` : `Sound: playing through ${ROUTE_NAMES[P.route]}.${failed}`;
}
function soundFailed(why) {
  if (P.route === 'silent') return;
  const t = now();
  P.errors.push(`${P.route}: ${why}`);
  console.warn(`sound route ${P.route} failed (${why})`);
  P.route = ROUTES[ROUTES.indexOf(P.route) + 1];
  if (!['element', 'blob'].includes(P.route)) { audio.removeAttribute('src'); loadedSrc = ''; audio.load(); }
  showSoundStatus();
  lastUI = '';
  if (P.running) { stopSound(); startSound(t); }
}

// start sound at programme time t; the robot follows whichever clock is playing
function startSound(t) {
  const p = P.prog;
  if (P.route === 'silent' || t >= p.duration - 0.02) { wallFrom(t); return; }
  if (P.route === 'webaudio') {
    if (!ctx) { soundFailed('Web Audio is not available'); return; }
    wallFrom(t);                                       // keep time while the file is decoded
    if (!buffers.has(p.id)) buffers.set(p.id, getBuffer(p.audio).then((b) => ctx.decodeAudioData(b.slice(0))));
    buffers.get(p.id).then((buf) => {
      if (!P.running || P.prog !== p || P.route !== 'webaudio') return;
      const t2 = now();
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      P.startAt = ctx.currentTime + 0.05 - t2;
      node.start(P.startAt + t2, t2);
      Object.assign(P, { node, clock: 'context' });
    }).catch((e) => soundFailed(`decoding: ${e.message || e.name}`));
    return;
  }
  const go = (url, at) => {
    const route = P.route;                             // a late rejection must not be blamed on a later route
    setSrc(url);
    P.clock = 'media';
    if (Math.abs(audio.currentTime - at) > 0.05) audio.currentTime = at;
    const pr = audio.play();
    if (pr) pr.catch((err) => {
      if (err.name === 'AbortError' || !P.running || P.prog !== p || P.route !== route) return;
      if (err.name === 'NotAllowedError') {
        Object.assign(P, { running: false, t: at });
        lastUI = '';
        setHint('The browser wants a tap before it plays sound. Tap play.');
      } else soundFailed(`${err.name}: ${err.message}`);
    });
  };
  if (P.route === 'element') { go(p.audio, t); return; }     // synchronous, inside the tap
  wallFrom(t);
  if (!blobURLs.has(p.id)) {
    blobURLs.set(p.id, getBuffer(p.audio).then((b) => URL.createObjectURL(new Blob([b], { type: p.audio_type || 'audio/mpeg' }))));
  }
  blobURLs.get(p.id).then((url) => {
    if (P.running && P.prog === p && P.route === 'blob') go(url, now());
  }).catch((e) => soundFailed(`download: ${e.message}`));
}

function play(fromT) {                   // call straight from a tap
  if (!P.prog) return;
  unlockContext();
  const t = Math.min(Math.max(fromT ?? (P.ended ? 0 : P.t), 0), endOf(P.prog));
  Object.assign(P, { running: true, ended: false, t });
  startSound(t);
  lastUI = '';
}
function pause() {
  if (!P.running) return;
  P.t = now();
  P.running = false;
  stopSound();
  lastUI = '';
}
function seek(t) {
  if (!P.prog) return;
  t = Math.min(Math.max(t, 0), endOf(P.prog));
  P.ended = false;
  if (P.running) { stopSound(); startSound(t); } else P.t = t;
  if (P.motion) { poseAt(t); follow(1); }
}
function select(p, autoplay) {           // everything before the first await runs inside the tap
  if (L) L.stop();
  pause();
  Object.assign(P, { prog: p, motion: null, t: 0, ended: false, clock: 'media' });
  if (P.route === 'element') setSrc(p.audio);
  programmeChanged();
  loadMusic(p);
  $('live-viz-wrap').hidden = false;
  if (autoplay) play(0);
  return loadMotion(p).then((motion) => {
    if (P.prog !== p) return;
    P.motion = motion;
    drawDetails();
    poseAt(now());
    follow(1);
  });
}

// ---------------------------------------------------------------- per frame
const qbuf = new Float64Array(36);
function poseAt(t) {
  if (!P.prog || !tree) return;
  const { fps, frames: n, channels: ch } = P.prog.motion;
  const fr = P.motion.frames;
  const f = Math.min(Math.max((t - P.prog.display_delay_s) * fps, 0), n - 1);
  const i0 = Math.floor(f), i1 = Math.min(i0 + 1, n - 1), a = f - i0;
  let dot = 0;
  for (let j = 3; j < 7; j++) dot += fr[i0 * ch + j] * fr[i1 * ch + j];
  const sign = dot < 0 ? -1 : 1;
  for (let j = 0; j < ch; j++) qbuf[j] = fr[i0 * ch + j] * (1 - a) + fr[i1 * ch + j] * (j >= 3 && j < 7 ? sign : 1) * a;
  setPose(qbuf);
}

function robotState(t) {
  if (!P.motion) return 'standing';
  const p = P.prog, { fps, frames: n } = p.motion;
  const f = Math.round((t - p.display_delay_s) * fps);
  if (f < 0) return 'standing';
  const act = P.motion.activity, i = Math.min(f, n - 1), a = act[i], prev = act[Math.max(0, i - Math.round(fps * 0.5))];
  return a < STAND ? 'standing' : a > DANCE ? 'dancing' : a < prev ? 'settling down' : 'starting to dance';
}
function setHint(text) { if ($('hint').textContent !== text) $('hint').textContent = text; }

let lastUI = '';
function updateUI(t, force = false) {
  const p = P.prog;
  if (!p) return;
  const s = segAt(p, t);
  const musicText = s.kind === 'music' ? `Music: ${song(s.song).name} · ${song(s.song).style}` : 'Music: off';
  const robot = P.motion ? robotState(t) : 'standing';
  let mode, label, hint;
  if (P.ended) { mode = 'again'; label = 'Play again'; hint = 'Play it again, or pick another one below.'; }
  else if (!P.running) {
    mode = 'play'; label = 'Play';
    hint = t > 0 ? 'Paused.' : 'Press play. The robot starts from standing.';
  } else {
    mode = 'pause'; label = 'Pause';
    const next = p.segments.find((x) => x.t0 > t + 1e-6);
    if (s.kind === 'music') {
      hint = !next || next.t0 >= p.duration ? 'Music playing.'
        : next.kind === 'silence' ? (s.t1 >= lastMusicEnd(p) ? `The music ends at ${mmss(s.t1)}. Watch the robot settle.`
          : `The music stops at ${mmss(s.t1)}. Watch the robot react.`)
          : `The song changes at ${mmss(s.t1)}.`;
    } else if (t < Math.min(...p.segments.filter((x) => x.kind === 'music').map((x) => x.t0))) {
      hint = 'The robot is standing. The music starts in a moment.';
    } else if (t >= lastMusicEnd(p)) {
      hint = robot === 'standing' ? 'The music is over and the robot is standing again.' : 'The music is over. The robot heard the silence and is settling.';
    } else {
      const nm = p.segments.find((x) => x.kind === 'music' && x.t0 > t);
      const prev = [...p.segments].reverse().find((x) => x.kind === 'music' && x.t1 <= t + 1e-6);
      const what = nm && prev && nm.song !== prev.song ? 'A new song starts' : 'The music comes back';
      hint = `Silence. ${robot === 'standing' ? 'The robot is standing.' : 'The robot heard it and is settling.'} ${what} at ${mmss(nm ? nm.t0 : t)}.`;
    }
    if (P.clock === 'media' && audio.readyState < 3) hint = 'Loading the music…';
    if (P.route === 'silent') hint = `Sound is blocked in this viewer, so the robot dances without it. ${hint}`;
  }
  const key = [musicText, robot, mode, label, hint].join('|');
  if (force || key !== lastUI) {
    lastUI = key;
    $('cap-music-text').textContent = musicText;
    $('cap-music').classList.toggle('on', s.kind === 'music');
    $('cap-robot-text').textContent = `Robot: ${robot}`;
    const main = $('main');
    main.innerHTML = ICON[mode];
    main.setAttribute('aria-label', label);
    main.title = label;
    main.disabled = mode === 'wait';
    setHint(hint);
  }
  const end = endOf(p);
  $('time').textContent = `${mmss(t)} / ${mmss(end)}`;
  $('fill').style.width = `${(t / end) * 100}%`;
  $('playhead').style.left = `calc(4.5rem + 10px + (100% - 4.5rem - 10px) * ${t / end})`;
}

// ---------------------------------------------------------------- live mode (js/live.js runs the session)
let L = null;                            // the live session's controller while one is on
let liveDrawn = '';
function liveBegin(ctrl) {
  pauseVideos();
  pause();
  L = ctrl;
  lastUI = '';
  liveDrawn = '';
  liveLookAt = 0;
  $('axis').dataset.span = '';
  $('over').hidden = true;
  $('stage-hint').hidden = true;
  if (ctrl.setView) ctrl.setView(view);
  viewSwitch();
  if (narrow.matches) stageEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
}
function liveEnd() {
  L = null;
  $('over').hidden = false;
  if (P.prog) { programmeChanged(); updateUI(now(), true); }
  if (P.motion) { drawDetails(); poseAt(now()); follow(1); }
  $('axis').dataset.span = '';
  $('stage-hint').hidden = false;
  $('live-viz-wrap').hidden = !P.prog;
  viewSwitch();
}
function replayStrip(t) {
  if ($('live-viz-wrap').hidden) return;
  const p = P.prog, a = loadMusic(p).ready, m = P.motion, fps = p.motion.fps, delay = p.display_delay_s;
  drawStrip($('live-viz'), { t, levels: a && a.levels, nLevels: a ? Math.floor(Math.min(t, p.duration) / 0.1) : 0,
    spec: a && a.spec, hits: a ? a.hits : [], speed: m && m.activity,
    n: m ? Math.min(m.activity.length, Math.floor((t - delay) * fps) + 1) : 0, delay, fps, smooth: 0,
    playing: P.running && t < p.duration, key: `${p.id}|${t.toFixed(3)}|${!!a}|${!!m}|${P.running}` });
}
function liveUI(t) {
  const playing = L.playing(), robot = L.robot(t), hint = L.hint(t);
  const mode = playing ? 'pause' : 'play', label = L.mainLabel ? L.mainLabel() : playing ? 'Pause the music' : 'Play the music';
  const key = ['live', L.title, L.music(), robot, mode, hint].join('|');
  if (key !== lastUI) {
    lastUI = key;
    $('title').textContent = L.title;
    $('cap-music-text').textContent = L.music();
    $('cap-music').classList.toggle('on', playing);
    $('cap-robot-text').textContent = `Robot: ${robot}`;
    const main = $('main');
    main.innerHTML = ICON[mode];
    main.setAttribute('aria-label', label);
    main.title = label;
    main.disabled = false;
    setHint(hint);
  }
  const span = L.max, segs = L.segments(t), drawn = `${segs.length}|${Math.round(t * 4)}`;
  if (drawn !== liveDrawn) {             // music on/off so far; redrawn four times a second at most
    liveDrawn = drawn;
    const el = $('progress');
    el.replaceChildren(...segs.map((s) => {
      const d = document.createElement('div');
      d.className = 'seg music';
      d.style.left = pct(s.t0, span);
      d.style.width = pct(Math.max(0, s.t1 - s.t0), span);
      d.style.background = 'var(--song-1)';
      return d;
    }));
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.id = 'fill';
    el.append(fill);
  }
  $('time').textContent = `${mmss(t)} / ${mmss(span)}`;
  $('fill').style.width = `${Math.min(1, t / span) * 100}%`;
}

// ---------------------------------------------------------------- drawing
const pct = (t, span) => `${(t / span) * 100}%`;
const songColor = (p, id) => `var(--song-${(songsOf(p).indexOf(id) % 3) + 1})`;

function drawProgress() {
  const p = P.prog, span = endOf(p), el = $('progress');
  el.replaceChildren();
  for (const s of p.segments) {
    const d = document.createElement('div');
    d.className = `seg ${s.kind}`;
    d.style.left = pct(s.t0, span);
    d.style.width = pct(s.t1 - s.t0, span);
    if (s.kind === 'music') d.style.background = songColor(p, s.song);
    el.append(d);
  }
  const fill = document.createElement('div');
  fill.className = 'fill';
  fill.id = 'fill';
  el.append(fill);
}
function fillTrack(el, p, span, shift, labels) {
  el.replaceChildren();
  for (const s of p.segments) {
    const d = document.createElement('div');
    d.className = `seg ${s.kind}`;
    d.style.left = pct(s.t0 + shift, span);
    d.style.width = pct(s.t1 - s.t0, span);
    if (s.kind === 'music') {
      d.style.background = songColor(p, s.song);
      if (labels) d.textContent = song(s.song).name;
    } else if (labels && s.t1 - s.t0 >= 1.5) d.textContent = 'silence';
    el.append(d);
  }
}
function eventsOf(segments) {
  const out = [];
  let lastSong = null;
  segments.forEach((s, i) => {
    const prev = segments[i - 1];
    if (!prev) return;
    if (prev.kind === 'music' && s.kind === 'silence') out.push([s.t0, 'music stops']);
    if (s.kind === 'music') {
      if (prev.kind === 'music' && prev.song !== s.song) out.push([s.t0, 'switch']);
      else if (prev.kind === 'silence') out.push([s.t0, lastSong === null ? 'music starts' : lastSong === s.song ? 'music resumes' : 'new song']);
    }
    if (prev.kind === 'music') lastSong = prev.song;
  });
  return out;
}
function drawDetails() {
  const p = P.prog, span = endOf(p), act = P.motion.activity, fps = p.motion.fps;
  fillTrack($('track-music'), p, span, 0, true);
  fillTrack($('track-robot'), p, span, p.display_delay_s, false);
  let max = 0;
  for (const v of act) max = Math.max(max, v);
  max = max || 1;
  let d = '';
  for (let i = 0; i < act.length; i += 2) {
    const x = ((i / fps + p.display_delay_s) / span) * 1000;
    d += `${i ? 'L' : 'M'}${x.toFixed(1)},${(32 - (act[i] / max) * 28).toFixed(1)}`;
  }
  const x0 = (p.display_delay_s / span) * 1000, x1 = (((act.length - 1) / fps + p.display_delay_s) / span) * 1000;
  d += `L${x1.toFixed(1)},32L${x0.toFixed(1)},32Z`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 1000 32');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'activity');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  $('track-robot').append(svg);
  const marks = $('marks');
  marks.replaceChildren();
  for (const [t, label] of eventsOf(p.segments)) {
    const m = document.createElement('div');
    m.className = label === 'music stops' ? 'mark before' : 'mark';
    m.style.left = pct(t, span);
    m.title = `${label} at ${t.toFixed(1)} s`;
    const s = document.createElement('span');
    s.textContent = label;
    m.append(s);
    marks.append(m);
  }
  const axis = $('axis');
  axis.replaceChildren();
  const step = span > 70 ? 20 : span > 35 ? 10 : 5;
  for (let t = 0; t <= span + 1e-6; t += step) {
    const s = document.createElement('span');
    s.style.left = pct(t, span);
    s.textContent = `${t}s`;
    axis.append(s);
  }
}

// the same timeline for a live session, redrawn as it goes: the music lane shows the level of what the model hears
// (and, with a music file, when the music is on); the robot lane shows its joint speed 1.24 s later, up to now
let liveLookAt = 0;
function svgPath(cls, d) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 1000 32');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
function drawLiveLook(t) {
  const span = L.max;
  $('playhead').style.left = `calc(4.5rem + 10px + (100% - 4.5rem - 10px) * ${Math.min(1, t / span)})`;
  const ms = performance.now();
  if (ms - liveLookAt < 250) return;
  liveLookAt = ms;
  $('look-title').textContent = L.title;
  const x = (sec) => ((sec / span) * 1000).toFixed(1);
  const music = $('track-music');
  music.replaceChildren(...L.segments(t).map((s) => {
    const d = document.createElement('div');
    d.className = 'seg music live-on';
    d.style.left = pct(s.t0, span);
    d.style.width = pct(Math.max(0, s.t1 - s.t0), span);
    return d;
  }));
  const lv = L.levels();
  let d = 'M0,32';
  for (let i = 0; i < lv.length; i++) d += `L${x((i + 0.5) * 0.1)},${(32 - Math.max(0, Math.min(1, (lv[i] + 60) / 54)) * 30).toFixed(1)}`;
  music.append(svgPath('envelope', `${d}L${x(lv.length * 0.1)},32Z`));
  const robot = $('track-robot');
  robot.replaceChildren();
  const sp = L.speeds(), n = Math.min(sp.length, Math.floor((t - L.delay) * 30) + 1), h = 7;
  if (n > 1) {
    const c = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + sp[i];
    let r = `M${x(L.delay)},32`;
    for (let i = 0; i < n; i += 2) {
      const lo = Math.max(0, i - h), hi = Math.min(n, i + h + 1), a = (c[hi] - c[lo]) / (hi - lo);
      r += `L${x(i / 30 + L.delay)},${(32 - Math.min(1, a / 1.6) * 28).toFixed(1)}`;
    }
    robot.append(svgPath('activity', `${r}L${x((n - 1) / 30 + L.delay)},32Z`));
  }
  const marks = $('marks');
  marks.replaceChildren(...L.events().map(([at, label]) => {
    const m = document.createElement('div');
    m.className = label === 'stop' ? 'mark before' : 'mark';
    m.style.left = pct(at, span);
    const s = document.createElement('span');
    s.textContent = label;
    m.append(s);
    return m;
  }));
  const axis = $('axis');
  if (axis.dataset.span !== String(span)) {
    axis.dataset.span = String(span);
    axis.replaceChildren();
    for (let s = 0; s <= span + 1e-6; s += span > 70 ? 20 : 10) {
      const e = document.createElement('span');
      e.style.left = pct(s, span);
      e.textContent = `${s}s`;
      axis.append(e);
    }
  }
}

function titleOf(p) {
  const ids = songsOf(p);
  if (p.section === 'switch') return ids.map((id) => song(id).style).join(' → ');
  const s = song(ids[0]);
  return p.section === 'pause' ? `${s.style}: the music stops, then carries on`
    : p.section === 'takes' ? `${s.name} · ${s.style} · take ${p.take} of 3` : `${s.name} · ${s.style}`;
}
function programmeChanged() {
  $('title').textContent = titleOf(P.prog);
  $('look-title').textContent = titleOf(P.prog);
  drawProgress();
  document.querySelectorAll('.row').forEach((el) => el.classList.toggle('current', el.dataset.id === P.prog.id));
  viewSwitch();
  lastUI = '';
}

// ---------------------------------------------------------------- set list
const TABS = [
  { key: 'styles', label: 'Styles', note: 'One song per style. The model is never told the style; it only hears the music.' },
  { key: 'takes', label: 'Same song', note: 'One song the model never heard in training, danced three times. Only the random seed differs (1234, 1235, 1236, fixed in advance).' },
  { key: 'live', label: 'Live', note: '' },
  { key: 'new', label: 'New music', note: 'One melody, made with Suno in three arrangements for this test. No dataset has it.' },
  { key: 'switch', label: 'Song changes', note: 'Three songs in three styles, with 5 s of silence between them.' },
  { key: 'pause', label: 'Music stops', note: '20 s of music, 6 s of silence, then the same song carries on.' },
  { key: 'yours', label: 'Your song', note: '' },
];
const GENRES = [['Classic', 'Classical'], ['Folk', 'Folk'], ['Street', 'Street'], ['Mix', 'Mixed']];
const narrow = matchMedia('(max-width: 980px)');
let tab = 'styles';
try { tab = localStorage.getItem('aheadance-tab') || tab; } catch { /* storage unavailable */ }
if (!TABS.some((x) => x.key === tab)) tab = 'styles';

function freshness(ids) {
  const ss = ids.map(song);
  if (ss.every((s) => s.split === 'upload')) return ['your upload', true];
  if (ss.every((s) => s.split === 'new')) return ['new music', true];
  if (ss.every((s) => !s.seen_in_training)) return ['not in training', true];
  return ss.some((s) => !s.seen_in_training) ? ['partly in training', false] : ['heard in training', false];
}
function shape(p) {
  const el = document.createElement('span');
  el.className = 'shape';
  el.setAttribute('aria-hidden', 'true');
  for (const s of p.segments) {
    const d = document.createElement('span');
    d.className = `seg ${s.kind}`;
    d.style.left = pct(s.t0, p.duration);
    d.style.width = pct(s.t1 - s.t0, p.duration);
    if (s.kind === 'music') d.style.background = songColor(p, s.song);
    el.append(d);
  }
  return el;
}
function row(p) {
  const ids = songsOf(p), first = song(ids[0]);
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `row${P.prog === p ? ' current' : ''}`;
  b.dataset.id = p.id;
  b.addEventListener('click', () => {
    pauseVideos();
    select(p, true).catch(fail);
    if (narrow.matches) stageEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  });
  const text = document.createElement('span');
  text.className = 'text';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = p.section === 'switch' ? ids.map((id) => song(id).style).join(' → ')
    : p.section === 'takes' ? `Take ${p.take}` : first.style;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = `${p.section === 'switch' ? ids.map((id) => song(id).name).join(' → ')
    : p.section === 'new' ? 'm01 · made with Suno'
      : p.section === 'takes' ? `${first.name} · ${first.style} · seed ${p.seed}`
      : p.section === 'yours' && first.requested_by ? `${first.name} · from ${first.requested_by}` : first.name} · `;
  const [tag, fresh] = freshness(ids);
  const t = document.createElement('span');
  if (fresh) t.className = 'fresh';
  t.textContent = tag;
  sub.append(t);
  text.append(title, sub);
  const dur = document.createElement('span');
  dur.className = 'dur';
  dur.textContent = mmss(p.duration);
  b.append(shape(p), text, dur);
  li.append(b);
  return li;
}
function renderLibrary() {
  const tabs = $('tabs');
  tabs.replaceChildren(...TABS.map((x) => {
    const n = manifest.programmes.filter((p) => p.section === x.key).length;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(x.key === tab));
    b.textContent = x.label;
    if (n) {
      const c = document.createElement('span');
      c.className = 'n';
      c.textContent = n;
      b.append(c);
    }
    b.addEventListener('click', () => {
      tab = x.key;
      try { localStorage.setItem('aheadance-tab', tab); } catch { /* storage unavailable */ }
      renderLibrary();
    });
    return b;
  }));
  const meta = TABS.find((x) => x.key === tab);
  $('tab-note').textContent = meta.note;
  $('tab-note').hidden = !meta.note;
  $('own').hidden = tab !== 'yours';
  $('live').hidden = tab !== 'live';
  $('list').hidden = tab === 'live';
  const items = manifest.programmes.filter((p) => p.section === tab);
  const list = $('list');
  list.replaceChildren();
  if (tab === 'styles') {
    for (const [key, name] of GENRES) {
      const group = items.filter((p) => song(songsOf(p)[0]).genre === key);
      if (!group.length) continue;
      const h = document.createElement('li');
      h.className = 'group';
      h.textContent = name;
      list.append(h, ...group.map(row));
    }
  } else list.append(...items.map(row));
  if (!items.length && tab !== 'live') {
    const e = document.createElement('li');
    e.className = 'empty';
    e.textContent = tab === 'yours' ? 'No dances from requests yet.' : 'Nothing here yet.';
    list.append(e);
  }
}

(function bindScrub() {
  const tl = $('timeline');
  let dragging = false;
  const at = (e) => {
    const r = $('track-music').getBoundingClientRect();
    return Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * endOf(P.prog);
  };
  tl.addEventListener('pointerdown', (e) => {
    if (!P.prog || L) return;
    dragging = true;
    tl.setPointerCapture(e.pointerId);
    seek(at(e));
  });
  tl.addEventListener('pointermove', (e) => { if (dragging) seek(at(e)); });
  tl.addEventListener('pointerup', () => { dragging = false; });
  tl.addEventListener('pointercancel', () => { dragging = false; });
})();

// ---------------------------------------------------------------- loop and start
function loop() {
  requestAnimationFrame(loop);
  if (L && tree) {
    const t = L.now(), q = L.pose(t);
    if (q) { setPose(q); follow(reduceMotion ? 1 : 0.06); }
    liveUI(t);
    drawLiveLook(t);
    if (L.viz) L.viz(t);
  } else if (P.prog && tree) {
    let t = now();
    if (P.running && t >= endOf(P.prog)) {
      t = endOf(P.prog);
      pause();
      Object.assign(P, { t, ended: true });
    }
    if (P.running && P.motion) {
      poseAt(t);
      follow(reduceMotion ? 1 : 0.06);
    }
    updateUI(t);
    replayStrip(t);
  }
  controls.update();
  if (needsRender) {
    renderer.render(scene, camera);
    needsRender = false;
  }
}

// one sound at a time: a film or clip that starts pauses the web demo, and the web demo pauses the videos
const videos = [...document.querySelectorAll('video')];
let stopOthers = () => {};               // the Your song preview
function pauseVideos() { stopOthers(); videos.forEach((v) => { if (v.id !== 'film') v.pause(); else if (!v.muted) { v.muted = true; filmLabel(); } }); }
function filmLabel() { $('film-sound').textContent = $('film').muted ? 'Sound on' : 'Sound off'; }
videos.forEach((v) => v.addEventListener('play', () => {
  if (v.id === 'film' && v.muted) return;
  pause();
  if (L && L.playing()) L.toggle();
  videos.forEach((o) => { if (o !== v) { if (o.id === 'film') { o.muted = true; filmLabel(); } else o.pause(); } });
}));
$('film-sound').addEventListener('click', () => {
  const f = $('film');
  f.muted = !f.muted;
  filmLabel();
  if (!f.muted) { pause(); videos.forEach((o) => { if (o !== f) o.pause(); }); f.play().catch(() => {}); }
});
if (reduceMotion) { $('film').removeAttribute('autoplay'); $('film').pause(); }

function fail(err) {
  console.error(err);
  setHint(err.message || String(err));
}

async function start() {
  loop();
  manifest = await getJSON('clips/manifest.json');
  renderLibrary();
  await loadRobot();
  // first dance shown: a lively style the model never heard in training (Hip-hop, chiefRocka, FineDance val)
  const first = manifest.programmes.find((p) => p.id === 'n13_094')
    || manifest.programmes.find((p) => p.section === tab && songsOf(p).every((id) => !song(id).seen_in_training))
    || manifest.programmes.find((p) => p.section === 'styles' && songsOf(p).every((id) => !song(id).seen_in_training))
    || manifest.programmes[0];
  await select(first, false);
  $('main').addEventListener('click', () => {
    if (L) { L.toggle(); return; }
    pauseVideos();
    P.running ? pause() : play();
  });
  showSoundStatus();
  import('./requests.js?v=20261105e').then((m) => {
    stopOthers = m.initRequests({
      add(prog, s) {
        manifest.songs[s.id] = s;
        manifest.programmes = manifest.programmes.filter((x) => x.id !== prog.id).concat(prog);
        renderLibrary();
      },
      play(prog) {
        pauseVideos();
        tab = 'yours';
        renderLibrary();
        select(prog, true).catch(fail);
        stageEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      },
      pauseAll() { pause(); videos.forEach((v) => { if (v.id !== 'film') v.pause(); else if (!v.muted) { v.muted = true; filmLabel(); } }); },
    }).stop;
  }).catch(fail);
  // the Live card's button: open the Live tab next to the robot
  const openLive = () => {
    tab = 'live';
    try { localStorage.setItem('aheadance-tab', tab); } catch { /* storage unavailable */ }
    renderLibrary();
    (narrow.matches ? $('live') : $('demo')).scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  };
  $('go-live-btn').addEventListener('click', (e) => { e.preventDefault(); openLive(); });
  document.querySelectorAll('#view-switch button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  if (location.hash === '#live') openLive();
  let liveCtl = null;
  import('./live.js?v=20261105e').then((m) => { liveCtl = m.initLive({ begin: liveBegin, end: liveEnd, views: () => { viewSwitch(); lastUI = ''; } }); }).catch(fail);
  $('over').addEventListener('click', () => { pause(); seek(0); });
  // hook for automated checks (tools/page_check.mjs)
  window.aheadance = { seek, play: () => play(), pause, now, rootWorld, ready: true, live: () => liveCtl,
    select: (id) => select(manifest.programmes.find((p) => p.id === id), true),
    state: () => (updateUI(now()), { route: P.route, errors: P.errors, clock: P.clock, prog: P.prog.id, running: P.running, t: +now().toFixed(2), music: $('cap-music-text').textContent,
      robot: $('cap-robot-text').textContent, hint: $('hint').textContent, label: $('main').title }) };
}
start().catch(fail);
