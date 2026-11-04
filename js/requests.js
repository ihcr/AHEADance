// "Your song": send up to 20 s of music; our server runs the same model on it and the dance comes back to this page.
//
// Access codes (we email them on request):
//   lab code     no limit, and sees everyone's songs
//   guest code   LIMIT songs, and sees only its own
//   shared code  (e.g. "guest") anyone may use; each browser counts as its own person, with its own LIMIT songs
// A song is visible only with the code that sent it, and to the lab. Every request also carries this browser's
// random id (X-Client), which is how a shared code tells people apart. The page sends the chosen part as a
// 48 kHz 16-bit stereo WAV; the server adds 2 s of silence before it and 4 s after it, and generates the dance.

export const API = 'https://pengtianhu--aheadance-api.us-east.modal.run';
export const CONTACT = 'chengxuzhou@ucl.ac.uk';   // address shown for code requests
const SR = 48000, MAX_SECONDS = 20, MIN_SECONDS = 5, MAX_MB = 60, POLL_MS = 8000;
const $ = (id) => document.getElementById(id);
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const STATUS = {
  queued: 'In the queue',
  generating: 'Generating the dance…',
  ready: 'Ready',
  failed: 'No dance',
};
export const store = {   // the access code, shared with the live mode (js/live.js)
  get() { try { return localStorage.getItem('aheadance-code') || ''; } catch { return ''; } },
  set(v) {
    try { v ? localStorage.setItem('aheadance-code', v) : localStorage.removeItem('aheadance-code'); } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent('aheadance-code', { detail: v || '' }));
  },
};
// this browser's random id; kept across visits (in memory only when storage is blocked)
export const CLIENT = (() => {
  let id = '';
  try { id = localStorage.getItem('aheadance-client') || ''; } catch { /* storage unavailable */ }
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id)) {
    id = crypto.randomUUID ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('aheadance-client', id); } catch { /* storage unavailable */ }
  }
  return id;
})();

// ------------------------------------------------------------------ audio helpers
async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Off) throw new Error('This browser cannot decode audio.');
  const off = new Off(2, SR, SR);      // decoding through a 48 kHz context resamples to 48 kHz
  return new Promise((resolve, reject) => {
    const p = off.decodeAudioData(bytes, resolve, () => reject(new Error('This file could not be decoded as audio.')));
    if (p && p.then) p.then(resolve, () => reject(new Error('This file could not be decoded as audio.')));
  });
}
function wavHeader(dataBytes) {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 2, true);
  h.setUint32(24, SR, true); h.setUint32(28, SR * 4, true); h.setUint16(32, 4, true); h.setUint16(34, 16, true);
  str(36, 'data'); h.setUint32(40, dataBytes, true);
  return new Uint8Array(h.buffer);
}
// the excerpt as 16-bit stereo PCM WAV bytes (a mono file becomes two equal channels)
function excerptWav(buf, start, seconds) {
  const s0 = Math.round(start * SR), n = Math.max(0, Math.min(Math.round(seconds * SR), buf.length - s0));
  const l = buf.getChannelData(0), r = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0);
  const pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    pcm[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l[s0 + i] * 32768)));
    pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r[s0 + i] * 32768)));
  }
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(wavHeader(pcm.byteLength));
  out.set(new Uint8Array(pcm.buffer), 44);
  return out;
}
// the programme the model heard: lead silence + the excerpt + tail silence, as a WAV blob URL
function programmeWav(wav, lead, tail) {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let o = 12, data = null;
  while (o + 8 <= wav.length) {
    const id = String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]), size = v.getUint32(o + 4, true);
    if (id === 'data') { data = wav.subarray(o + 8, o + 8 + size); break; }
    o += 8 + size + (size % 2);
  }
  if (!data) throw new Error('The stored excerpt is not a WAV file.');
  const a = Math.round(lead * SR) * 4, b = Math.round(tail * SR) * 4;
  const out = new Uint8Array(44 + a + data.length + b);
  out.set(wavHeader(a + data.length + b));
  out.set(data, 44 + a);
  return URL.createObjectURL(new Blob([out], { type: 'audio/wav' }));
}

// ------------------------------------------------------------------ page module
export function initRequests(api) {
  const el = Object.fromEntries(['own-status', 'own-ask', 'code-form', 'code-input', 'code-line', 'code-who',
    'code-forget', 'send', 'send-form', 'send-file', 'send-pick', 'send-file-name', 'send-file-len', 'send-start',
    'send-window', 'send-listen', 'send-name', 'send-style', 'send-ok', 'send-go', 'send-msg', 'mine', 'mine-list',
    'mine-note', 'queue', 'queue-list'].map((k) => [k.replace(/-(\w)/g, (_, c) => c.toUpperCase()), $(k)]));
  const preview = new Audio();
  preview.addEventListener('ended', () => { el.sendListen.textContent = 'Listen to this part'; });
  const stop = () => { if (!preview.paused) { preview.pause(); el.sendListen.textContent = 'Listen to this part'; } };
  const S = { code: '', me: null, mine: [], all: [], decoded: null, file: null, busy: false, built: new Map(), timer: 0 };

  const call = async (path, opts = {}) => {
    const r = await fetch(API + path, { ...opts, headers: { 'X-Code': S.code, 'X-Client': CLIENT, ...(opts.headers || {}) } });
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      try { detail = (await r.json()).detail || detail; } catch { /* not JSON */ }
      const e = new Error(detail);
      e.status = r.status;
      throw e;
    }
    return r;
  };
  function setStatus(text) { el.ownStatus.textContent = text; }
  function showAsk() {
    el.ownAsk.hidden = false;
    el.ownAsk.replaceChildren();
    if (CONTACT) {
      const a = document.createElement('a');
      a.href = `mailto:${CONTACT}?subject=${encodeURIComponent('AHEADance: access code to send a song')}`;
      a.textContent = 'Email us for a code';
      el.ownAsk.append('No code? ', a, '.');
    } else el.ownAsk.textContent = 'No code? Ask the AHEADance team for one.';
  }
  function signedOut(msg) {
    clearTimeout(S.timer);
    Object.assign(S, { code: '', me: null, mine: [], all: [] });
    setStatus(msg || 'Sending a song needs an access code.');
    el.codeForm.hidden = false;
    el.codeLine.hidden = true;
    el.send.hidden = true;
    el.mine.hidden = true;
    showAsk();
  }

  // ---- access code
  async function useCode(code) {
    S.code = code.trim();
    if (!S.code) return signedOut();
    setStatus('Checking the code…');
    try {
      S.me = await (await call('/api/me')).json();
    } catch (e) {
      store.set('');
      return signedOut(e.status === 403 ? 'That code is not valid.' : `The song server cannot be reached (${e.message}).`);
    }
    store.set(S.code);
    el.codeForm.hidden = true;
    el.ownAsk.hidden = true;
    el.codeLine.hidden = false;
    el.codeWho.textContent = S.me.role === 'lab' ? 'Lab code' : S.me.shared ? 'Guest code'
      : `Code${S.me.label ? ` for ${S.me.label}` : ''}`;
    el.send.hidden = false;
    el.mine.hidden = false;
    await refresh();
  }
  el.codeForm.addEventListener('submit', (e) => { e.preventDefault(); useCode(el.codeInput.value); });
  el.codeForget.addEventListener('click', () => { store.set(''); el.codeInput.value = ''; signedOut(); });
  window.addEventListener('aheadance-code', (e) => {          // a code entered or dropped in the live panel
    if (e.detail === S.code) return;
    if (e.detail) useCode(e.detail); else signedOut();
  });

  async function refresh() {
    clearTimeout(S.timer);
    if (!S.code) return;
    try {
      S.mine = (await (await call('/api/songs')).json()).songs;
      if (S.me.today_left !== undefined) S.me = await (await call('/api/me')).json();
      if (S.me.role === 'lab') S.all = (await (await call('/api/songs?all=1')).json()).songs;
    } catch (e) {
      el.mineNote.textContent = `Your songs could not be loaded (${e.message}).`;
    }
    render();
    const busy = [...S.mine, ...S.all].some((s) => ['queued', 'generating'].includes(s.status));
    if (busy) S.timer = setTimeout(refresh, POLL_MS);
  }

  // ---- my songs
  function render() {
    if (!S.me) return;
    const n = S.mine.length, lab = S.me.role === 'lab', shared = S.me.shared;
    const own = lab ? Infinity : Math.max(0, S.me.limit - n), today = S.me.today_left ?? Infinity;
    const left = Math.min(own, today);
    setStatus(lab ? 'Lab code: send as many songs as you like. You also see everyone\'s songs.'
      : !own ? (shared ? `You have sent your ${S.me.limit} songs.` : `This code has sent its ${S.me.limit} songs.`)
        : !today ? 'The guest code has sent all its songs for today. Please try again tomorrow.'
          : `You can send ${left} more song${left > 1 ? 's' : ''} (${S.me.limit} per ${shared ? 'person' : 'code'}).`);
    const full = left === 0;
    el.sendForm.classList.toggle('full', full);
    el.sendGo.disabled = full || S.busy || !S.decoded;
    el.sendFile.disabled = full || S.busy;
    el.mineNote.textContent = n ? '' : 'Songs you send appear here, and their dances in the web demo under Your song.';
    el.mineList.replaceChildren(...S.mine.map(mineRow));
    for (const s of S.mine) if (s.status === 'ready') build(s, 'you').catch(() => {});
    if (lab) {
      el.queue.hidden = false;
      el.queueList.replaceChildren(...(S.all.length ? S.all.map(queueRow) : [Object.assign(document.createElement('li'), { textContent: 'No songs yet.' })]));
    } else el.queue.hidden = true;
  }
  function mineRow(s) {
    const li = document.createElement('li');
    li.className = `mine-row ${s.status}`;
    const text = document.createElement('div');
    text.className = 'text';
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = s.name;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = [s.style, s.seconds_music ? `${Number(s.seconds_music).toFixed(1)} s` : '', STATUS[s.status] || s.status,
      s.note || ''].filter(Boolean).join(' · ');
    text.append(t, sub);
    li.append(text);
    if (s.status === 'ready') li.append(playButton(() => build(s, 'you'), sub));
    else if (s.status === 'queued') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link';
      b.textContent = 'Withdraw';
      b.addEventListener('click', () => withdraw(s));
      li.append(b);
    }
    return li;
  }
  function queueRow(s) {
    const li = document.createElement('li');
    li.className = 'queue-row';
    const sub = document.createElement('span');
    sub.textContent = `${s.name} · ${s.mine ? 'you' : (s.who || 'guest')} · ${STATUS[s.status] || s.status}`;
    li.append(sub);
    if (s.status === 'ready') li.append(playButton(() => build(s, s.mine ? 'you' : (s.who || 'guest')), sub));
    return li;
  }
  function playButton(load, sub) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-small';
    b.textContent = 'Play';
    b.addEventListener('click', () => {
      b.textContent = 'Loading…';
      load().then((x) => { b.textContent = 'Play'; stop(); api.play(x.prog); })
        .catch((e) => { b.textContent = 'Play'; sub.textContent += ` · ${e.message}`; });
    });
    return b;
  }
  // a ready song becomes a programme in the web demo (only in this browser)
  function build(s, by) {
    const id = `mine_${s.key}`;
    if (S.built.has(id)) return Promise.resolve(S.built.get(id));
    const r = s.result;
    const job = Promise.all([call(`/api/songs/${s.key}/audio`).then((x) => x.arrayBuffer()),
      call(`/api/songs/${s.key}/motion`).then((x) => x.blob())]).then(([audio, motion]) => {
      const lead = r.lead, music = r.music_seconds;
      const prog = { id, section: 'yours', mine: true, duration: r.duration, display_delay_s: r.display_delay_s,
        segments: [{ kind: 'silence', t0: 0, t1: lead }, { kind: 'music', t0: lead, t1: lead + music, song: id },
          { kind: 'silence', t0: lead + music, t1: r.duration }],
        audio: programmeWav(new Uint8Array(audio), lead, r.tail), audio_type: 'audio/wav',
        motion: { ...r.motion, file: URL.createObjectURL(motion), base64: false } };
      const song = { id, name: s.name, style: s.style || 'Your song', genre: 'Mine', dataset: 'your upload',
        split: 'upload', seen_in_training: null, requested_by: by };
      const x = { prog, song };
      S.built.set(id, x);
      api.add(prog, song);
      return x;
    });
    S.built.set(id, job);
    job.catch(() => S.built.delete(id));
    return job;
  }
  async function withdraw(s) {
    if (S.busy || !confirm(`Withdraw "${s.name}"? Its upload is deleted and the slot is free again.`)) return;
    S.busy = true;
    try { await call(`/api/songs/${s.key}`, { method: 'DELETE' }); } catch (e) { el.sendMsg.textContent = `Could not withdraw (${e.message}).`; }
    S.busy = false;
    await refresh();
  }

  // ---- choosing the part to send
  function windowText() {
    if (!S.decoded) return;
    const start = Number(el.sendStart.value), len = Math.min(MAX_SECONDS, S.decoded.duration - start);
    el.sendWindow.textContent = `${fmt(start)} – ${fmt(start + len)} · ${len.toFixed(1)} s`;
    el.sendGo.disabled = len < MIN_SECONDS || S.busy || el.sendForm.classList.contains('full');
  }
  el.sendFile.addEventListener('change', async () => {
    const f = el.sendFile.files[0];
    stop();
    S.decoded = null;
    el.sendPick.hidden = true;
    el.sendMsg.textContent = '';
    if (!f) return;
    if (f.size > MAX_MB * 1e6) { el.sendMsg.textContent = `That file is larger than ${MAX_MB} MB.`; return; }
    el.sendMsg.textContent = 'Reading the file…';
    try {
      S.decoded = await decodeFile(f);
      S.file = f;
    } catch (e) { el.sendMsg.textContent = e.message; return; }
    const d = S.decoded.duration;
    if (d < MIN_SECONDS) { el.sendMsg.textContent = `The music must be at least ${MIN_SECONDS} s long.`; S.decoded = null; return; }
    el.sendMsg.textContent = '';
    el.sendFileName.textContent = f.name;
    el.sendFileLen.textContent = fmt(d);
    el.sendStart.max = String(Math.max(0, d - MIN_SECONDS).toFixed(1));
    el.sendStart.value = String(Math.max(0, Math.min(30, d - MAX_SECONDS)).toFixed(1));
    if (!el.sendName.value) el.sendName.value = f.name.replace(/\.[^.]+$/, '').slice(0, 60);
    el.sendPick.hidden = false;
    windowText();
  });
  el.sendStart.addEventListener('input', () => { stop(); windowText(); });
  el.sendListen.addEventListener('click', () => {
    if (!S.decoded) return;
    if (!preview.paused) { stop(); return; }
    api.pauseAll();
    const start = Number(el.sendStart.value);
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.src = URL.createObjectURL(new Blob([excerptWav(S.decoded, start, MAX_SECONDS)], { type: 'audio/wav' }));
    preview.play().then(() => { el.sendListen.textContent = 'Stop'; }).catch(() => {});
  });
  el.send.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!S.decoded || S.busy || !S.me) return;
    if (!el.sendOk.checked) { el.sendMsg.textContent = 'Please tick the box first.'; return; }
    const name = el.sendName.value.trim().slice(0, 60);
    if (!name) { el.sendMsg.textContent = 'Give the song a name.'; return; }
    stop();
    S.busy = true;
    render();
    const start = Number(el.sendStart.value), seconds = Math.min(MAX_SECONDS, S.decoded.duration - start);
    try {
      el.sendMsg.textContent = 'Uploading…';
      const wav = excerptWav(S.decoded, start, seconds);
      const q = new URLSearchParams({ name, style: el.sendStyle.value.trim().slice(0, 40), file: S.file.name.slice(0, 120),
        start: start.toFixed(2) });
      await call(`/api/songs?${q}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
      el.sendMsg.textContent = 'Sent. The dance is usually ready in about two minutes; this list updates by itself.';
      el.send.reset();
      el.sendPick.hidden = true;
      S.decoded = null;
    } catch (err) {
      el.sendMsg.textContent = `Not sent: ${err.message}`;
    } finally {
      S.busy = false;
      await refresh();
    }
  });

  const saved = store.get();
  if (saved) useCode(saved); else signedOut();
  return { stop };
}
