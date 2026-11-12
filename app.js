'use strict';
/* 수업 녹음 PWA
 * - 마이크 → 16kHz 모노 → MP3(32kbps)로 인코딩, 5초마다 휴대폰(IndexedDB)에 조각 저장
 *   → 앱이 꺼져도 직전 5초까지 남고, 다시 열면 같은 파일에 이어서 녹음 가능
 * - 종료하면 Google Drive에 업로드하고 Apps Script에 분석을 요청
 */

const RATE = 16000;
const KBPS = 32;
const FLUSH_SEC = 5;
const AUTO_SAVE_MS = 60 * 1000;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 설정(localStorage) ---------------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
const settings = () => store.get('settings', { url: '', key: '' });
const isConfigured = () => { const s = settings(); return !!(s.url && s.key); };

/* ---------------- IndexedDB ---------------- */
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('lecture-recorder', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('sessions', { keyPath: 'id' });
      const c = d.createObjectStore('chunks', { keyPath: ['sessionId', 'seq'] });
      c.createIndex('bySession', 'sessionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(storeName, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const putSession = (s) => tx('sessions', 'readwrite', (st) => { st.put(s); });
const getSession = (id) => tx('sessions', 'readonly', (st) => reqP(st.get(id)));
const allSessions = () => tx('sessions', 'readonly', (st) => reqP(st.getAll()));
const deleteSessionMeta = (id) => tx('sessions', 'readwrite', (st) => { st.delete(id); });
const putChunk = (c) => tx('chunks', 'readwrite', (st) => { st.put(c); });
const getChunks = (id) => tx('chunks', 'readonly', (st) => reqP(st.index('bySession').getAll(id)))
  .then((arr) => arr.sort((a, b) => a.seq - b.seq));
const deleteChunks = (id) => tx('chunks', 'readwrite', (st) => {
  const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
  st.delete(range);
});

/* ---------------- 공통 UI ---------------- */
let toastTimer = null;
function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- 녹음 ---------------- */
let rec = null;
let writeChain = Promise.resolve();

function micConstraints() {
  return { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } };
}

// iOS에서는 AudioContext를 사용자의 탭 안에서 '동기적으로' 만들어야 하므로 ctx를 밖에서 받아옵니다.
async function wireAudio(ctx) {
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints());
  await ctx.audioWorklet.addModule('recorder-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'recorder-processor', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: { targetRate: RATE },
  });
  node.port.onmessage = (e) => onSamples(e.data);
  source.connect(node);
  node.connect(ctx.destination); // 출력은 무음. 오디오 그래프가 계속 돌도록 연결만 해 둠
  const track = stream.getAudioTracks()[0];
  if (track) track.addEventListener('ended', () => markInterrupted('마이크가 끊겼어요.'));
  ctx.onstatechange = () => {
    if (rec && !rec.stopping && ctx.state !== 'running') setTimeout(checkAlive, 1500);
  };
  await ctx.resume();
  return { ctx, stream, source, node };
}

function newCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  return new AC();
}

function teardownAudio(a) {
  if (!a) return;
  try { a.source.disconnect(); } catch (e) {}
  try { a.node.port.onmessage = null; a.node.disconnect(); } catch (e) {}
  try { a.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { a.ctx.onstatechange = null; a.ctx.close(); } catch (e) {}
}

async function startRecording(resumeId) {
  if (rec) return;
  const ctx = newCtx(); // 탭 직후 바로 생성 (iOS 요구사항)
  let audio;
  try {
    audio = await wireAudio(ctx);
  } catch (e) {
    try { ctx.close(); } catch (_) {}
    console.error(e);
    toast('마이크를 쓸 수 없어요. 설정 > Safari(또는 이 앱) > 마이크 허용을 확인해 주세요.', 6000);
    return;
  }

  let session;
  if (resumeId) {
    session = await getSession(resumeId);
    session.status = 'recording';
    session.gaps = session.gaps || [];
    session.gaps.push({ at: Math.round(session.durationSec), lostSec: null, reason: '앱 재시작' });
  } else {
    session = {
      id: 'r' + Date.now(), startedAt: Date.now(), status: 'recording',
      durationSec: 0, seq: 0, gaps: [], kind: null, title: null, metaReady: false,
    };
  }
  await putSession(session);

  rec = {
    session,
    audio,
    encoder: new lamejs.Mp3Encoder(1, RATE, KBPS),
    baseSec: session.durationSec || 0,
    samples: 0,
    pending: [],
    pendingSamples: 0,
    lastDataAt: Date.now(),
    interrupted: false,
    interruptAt: 0,
    stopping: false,
    wakeLock: null,
    watchdog: null,
  };

  $('recoverBanner').classList.add('hidden');
  showRecordingUI(true);
  requestWakeLock();
  rec.watchdog = setInterval(tick, 1000);
  tick();
}

function onSamples({ samples, peak }) {
  if (!rec || rec.stopping) return;
  const n = samples.length;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v = samples[i];
    v = v < -1 ? -1 : v > 1 ? 1 : v;
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const out = rec.encoder.encodeBuffer(pcm);
  if (out.length) rec.pending.push(new Uint8Array(out));
  rec.samples += n;
  rec.pendingSamples += n;
  rec.lastDataAt = Date.now();
  rec.peak = peak;
  if (rec.interrupted) recovered();
  if (rec.pendingSamples >= RATE * FLUSH_SEC) flushChunk();
}

const recordedSec = () => (rec ? rec.baseSec + rec.samples / RATE : 0);

function flushChunk(final) {
  if (!rec) return writeChain;
  const r = rec;
  if (final) {
    const tail = r.encoder.flush();
    if (tail.length) r.pending.push(new Uint8Array(tail));
  }
  const parts = r.pending;
  r.pending = [];
  r.pendingSamples = 0;
  const total = parts.reduce((a, p) => a + p.length, 0);
  r.session.durationSec = recordedSec();
  if (total > 0) {
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    r.session.seq = (r.session.seq || 0) + 1;
    const chunk = { sessionId: r.session.id, seq: r.session.seq, data: bytes.buffer };
    const snapshot = Object.assign({}, r.session);
    writeChain = writeChain.then(() => putChunk(chunk)).then(() => putSession(snapshot))
      .catch((e) => { console.error(e); toast('휴대폰 저장 공간에 쓰지 못했어요: ' + e.message, 6000); });
  }
  return writeChain;
}

function tick() {
  if (!rec) return;
  const sec = recordedSec();
  $('timer').textContent = fmt(sec);
  $('dimTime').textContent = fmt(sec);
  const level = Math.min(1, (rec.peak || 0) * 1.6);
  $('meterBar').style.width = Math.round(level * 100) + '%';
  const info = [];
  info.push(rec.wakeLock ? '화면 꺼짐 방지 켜짐' : '화면이 꺼지지 않게 해 주세요 (설정 > 디스플레이 > 자동 잠금)');
  const gaps = (rec.session.gaps || []).length;
  if (gaps) info.push(`중간에 ${gaps}번 끊겼다가 이어짐`);
  $('recInfo').innerHTML = info.join('<br>');
  checkAlive();
}

function checkAlive() {
  if (!rec || rec.stopping || rec.interrupted) return;
  if (Date.now() - rec.lastDataAt > 3000) markInterrupted();
}

function markInterrupted(msg) {
  if (!rec || rec.stopping || rec.interrupted) return;
  rec.interrupted = true;
  rec.interruptAt = rec.lastDataAt; // 마지막으로 소리가 들어온 시각부터 끊긴 것으로 계산
  flushChunk();
  $('interruptedMsg').innerHTML = (msg ? msg + '<br>' : '전화나 다른 앱 때문에 마이크가 끊겼어요.<br>') +
    '지금까지 녹음된 부분은 저장돼 있어요.';
  $('interrupted').classList.remove('hidden');
  $('recState').innerHTML = '일시 중단됨';
  if (document.visibilityState === 'visible') lightResume();
}

function recovered() {
  if (!rec || !rec.interrupted) return;
  const lost = Math.round((Date.now() - rec.interruptAt) / 1000);
  rec.interrupted = false;
  if (lost >= 3) rec.session.gaps.push({ at: Math.round(recordedSec()), lostSec: lost, reason: '중단' });
  $('interrupted').classList.add('hidden');
  $('recState').innerHTML = '<span class="dot"></span>녹음 중';
  requestWakeLock();
  toast('녹음을 이어서 하고 있어요');
}

// 사용자 탭 없이 시도하는 가벼운 재개 (통화 후 앱으로 돌아왔을 때)
async function lightResume() {
  if (!rec) return;
  try { if (rec.audio.ctx.state !== 'running') await rec.audio.ctx.resume(); } catch (e) {}
  const track = rec.audio.stream.getAudioTracks()[0];
  if (!track || track.readyState === 'ended') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(micConstraints());
      try { rec.audio.source.disconnect(); } catch (e) {}
      rec.audio.stream.getTracks().forEach((t) => t.stop());
      const source = rec.audio.ctx.createMediaStreamSource(stream);
      source.connect(rec.audio.node);
      rec.audio.stream = stream;
      rec.audio.source = source;
    } catch (e) { /* 버튼으로 재개하도록 둠 */ }
  }
}

// '이어서 녹음' 버튼: 오디오를 처음부터 다시 연결 (인코더는 유지 → 같은 파일에 이어붙음)
async function hardResume() {
  if (!rec) return;
  const ctx = newCtx();
  const old = rec.audio;
  try {
    teardownAudio(old);
    rec.audio = await wireAudio(ctx);
    rec.lastDataAt = Date.now();
    setTimeout(() => { if (rec && rec.interrupted && Date.now() - rec.lastDataAt > 2500) toast('아직 소리가 안 들어와요. 한 번 더 눌러 주세요.'); }, 2600);
  } catch (e) {
    console.error(e);
    toast('마이크를 다시 켜지 못했어요. 통화가 끝났는지 확인해 주세요.', 5000);
  }
}

async function requestWakeLock() {
  if (!rec) return;
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      if (rec.wakeLock && !rec.wakeLock.released) return;
      rec.wakeLock = await navigator.wakeLock.request('screen');
      rec.wakeLock.addEventListener('release', () => { if (rec) rec.wakeLock = null; });
    }
  } catch (e) { if (rec) rec.wakeLock = null; }
}

async function stopRecording() {
  if (!rec) return;
  const r = rec;
  r.stopping = true;
  clearInterval(r.watchdog);
  await flushChunk(true);
  teardownAudio(r.audio);
  try { if (r.wakeLock) r.wakeLock.release(); } catch (e) {}
  r.session.status = 'stopped';
  await putSession(r.session);
  rec = null;
  showRecordingUI(false);
  openSaveSheet(r.session.id);
}

function showRecordingUI(on) {
  $('recording').classList.toggle('hidden', !on);
  $('interrupted').classList.add('hidden');
  $('dim').classList.add('hidden');
  $('home').classList.toggle('hidden', on);
  $('homeHeader').classList.toggle('hidden', on);
  $('recState').innerHTML = '<span class="dot"></span>녹음 중';
  $('stopBtn').classList.remove('confirm');
  $('stopBtn').textContent = '종료';
  if (!on) renderList();
}

/* ---------------- 저장 시트 ---------------- */
let sheetSessionId = null;
let sheetTimer = null;
let selectedKind = store.get('lastKind', '수업');

function openSaveSheet(id) {
  sheetSessionId = id;
  $('titleInput').value = '';
  setKind(selectedKind);
  const recent = store.get('recentTitles', []);
  $('recentTitles').innerHTML = '';
  recent.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = t;
    b.onclick = () => { $('titleInput').value = t; };
    $('recentTitles').appendChild(b);
  });
  $('uploadStatus').textContent = isConfigured() ? '업로드 준비 중…' : '연결 설정 전이라 휴대폰에 보관해 둘게요.';
  $('saveSheet').classList.remove('hidden');
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => saveMeta(), AUTO_SAVE_MS);
  processQueue();
}

function setKind(k) {
  selectedKind = k;
  document.querySelectorAll('#kindChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.kind === k));
}

async function saveMeta() {
  clearTimeout(sheetTimer);
  const id = sheetSessionId;
  if (!id) return;
  sheetSessionId = null;
  const s = await getSession(id);
  if (s) {
    const title = $('titleInput').value.trim();
    s.kind = selectedKind;
    s.title = title || null;
    s.metaReady = true;
    await putSession(s);
    store.set('lastKind', selectedKind);
    if (title) {
      const recent = [title].concat(store.get('recentTitles', []).filter((t) => t !== title)).slice(0, 8);
      store.set('recentTitles', recent);
    }
  }
  $('saveSheet').classList.add('hidden');
  renderList();
  processQueue();
}

/* ---------------- 서버 통신 ---------------- */
async function api(action, payload) {
  const { url, key } = settings();
  if (!url || !key) throw new Error('연결 설정이 필요해요');
  let res;
  if (action === 'done') {
    // text/plain 으로 보내야 CORS 사전요청 없이 Apps Script에 전달됩니다
    res = await fetch(url, { method: 'POST', body: JSON.stringify(Object.assign({ action, key }, payload)) });
  } else {
    const q = new URLSearchParams(Object.assign({ action, key }, payload || {}));
    res = await fetch(url + (url.includes('?') ? '&' : '?') + q.toString());
  }
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('Apps Script 응답을 읽지 못했어요 (배포 설정의 액세스 권한이 "모든 사용자"인지 확인)'); }
  if (!j.ok) throw new Error(j.error || '알 수 없는 오류');
  return j;
}

function uploadToDrive(token, folderId, name, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const boundary = 'b' + Math.random().toString(36).slice(2);
    const meta = { name, parents: [folderId], mimeType: 'audio/mpeg' };
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: audio/mpeg\r\n\r\n`, blob, `\r\n--${boundary}--`,
    ]);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('Content-Type', 'multipart/related; boundary=' + boundary);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText).id); } catch (e) { reject(e); }
      } else reject(new Error('Drive 업로드 실패 (' + xhr.status + ')'));
    };
    xhr.onerror = () => reject(new Error('네트워크 오류'));
    xhr.send(body);
  });
}

let queueRunning = false;
async function processQueue() {
  if (queueRunning || !isConfigured() || !navigator.onLine) return;
  queueRunning = true;
  try {
    const sessions = (await allSessions()).sort((a, b) => a.startedAt - b.startedAt);
    for (const s of sessions) {
      if (rec && rec.session.id === s.id) continue;
      try {
        if (s.status === 'stopped') {
          const chunks = await getChunks(s.id);
          if (!chunks.length) { s.status = 'empty'; await putSession(s); continue; }
          const blob = new Blob(chunks.map((c) => c.data), { type: 'audio/mpeg' });
          const t = await api('token');
          const d = new Date(s.startedAt);
          const p = (n) => String(n).padStart(2, '0');
          const name = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())} 녹음.mp3`;
          const showProgress = (f) => { if (sheetSessionId === s.id) $('uploadStatus').textContent = `업로드 중… ${Math.round(f * 100)}%`; };
          s.driveFileId = await uploadToDrive(t.token, t.folderId, name, blob, showProgress);
          s.status = 'uploaded';
          await putSession(s);
          if (sheetSessionId === s.id) $('uploadStatus').textContent = 'Drive 업로드 완료 ✓';
          renderList();
        }
        // 제목 입력 화면을 닫지 않고 앱을 나가 버린 녹음은 기본값(마지막 종류, 날짜·시간 제목)으로 분석 요청
        if (s.status === 'uploaded' && !s.metaReady && sheetSessionId !== s.id) {
          s.kind = s.kind || store.get('lastKind', '수업');
          s.metaReady = true;
          await putSession(s);
        }
        if (s.status === 'uploaded' && s.metaReady) {
          await api('done', {
            fileId: s.driveFileId, title: s.title || '', kind: s.kind || '수업',
            startedAt: s.startedAt, durationSec: Math.round(s.durationSec), gaps: s.gaps || [],
          });
          s.status = 'sent';
          s.sentAt = Date.now();
          s.lastError = null;
          await putSession(s);
          await deleteChunks(s.id); // Drive에 안전하게 올라갔으니 휴대폰 사본 삭제
          renderList();
        }
      } catch (e) {
        console.error(e);
        s.lastError = e.message;
        await putSession(s);
        if (sheetSessionId === s.id) $('uploadStatus').textContent = '업로드 실패: ' + e.message + ' (자동으로 다시 시도해요)';
      }
    }
  } finally {
    queueRunning = false;
  }
  renderList();
}

/* ---------------- 목록 ---------------- */
let serverStatus = {};
async function refreshServerStatus(sessions) {
  const ids = sessions.filter((s) => s.status === 'sent').slice(0, 15).map((s) => s.driveFileId);
  if (!ids.length || !isConfigured() || !navigator.onLine) return;
  try {
    const j = await api('status', { ids: ids.join(',') });
    serverStatus = j.jobs || {};
    drawList(sessions);
  } catch (e) { /* 다음에 다시 */ }
}

async function renderList() {
  let sessions = await allSessions();
  const cutoff = Date.now() - 30 * 86400000;
  for (const s of sessions) {
    if ((s.status === 'sent' && s.sentAt < cutoff) || s.status === 'empty') await deleteSessionMeta(s.id);
  }
  sessions = sessions.filter((s) => !((s.status === 'sent' && s.sentAt < cutoff) || s.status === 'empty'))
    .sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
  drawList(sessions);
  $('setupBanner').classList.toggle('hidden', isConfigured());
  refreshServerStatus(sessions);
}

function badgeFor(s) {
  if (s.status === 'recording') return ['wait', '녹음 중단됨'];
  if (s.status === 'stopped') return ['wait', s.lastError ? '업로드 재시도 대기' : '업로드 대기'];
  if (s.status === 'uploaded') return ['wait', s.lastError ? '분석 요청 재시도 대기' : '분석 요청 대기'];
  const j = serverStatus[s.driveFileId];
  if (!j) return ['wait', '분석 대기'];
  if (j.step === 'done') return ['link', '문서 열기', j.docUrl];
  if (j.step === 'error') return ['err', '분석 오류'];
  return ['wait', j.label || '분석 중'];
}

function drawList(sessions) {
  const ul = $('list');
  ul.innerHTML = '';
  $('emptyList').classList.toggle('hidden', sessions.length > 0);
  for (const s of sessions) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = s.title || `${s.kind || '녹음'} ${fmtDate(s.startedAt)}`;
    const sub = document.createElement('div');
    sub.className = 's';
    sub.textContent = `${fmtDate(s.startedAt)} · ${fmt(s.durationSec || 0)}`;
    left.append(t, sub);
    const [cls, label, href] = badgeFor(s);
    let b;
    if (cls === 'link') { b = document.createElement('a'); b.href = href; b.target = '_blank'; b.rel = 'noopener'; }
    else b = document.createElement('span');
    b.className = 'badge ' + (cls === 'link' ? '' : cls);
    b.textContent = label;
    if (cls === 'err') b.title = (serverStatus[s.driveFileId] || {}).error || '';
    if (s.lastError && s.status !== 'sent') {
      b.style.cursor = 'pointer';
      b.onclick = () => { toast('마지막 오류: ' + s.lastError + ' · 다시 시도할게요', 5000); processQueue(); };
    }
    li.append(left, b);
    ul.appendChild(li);
  }
}

/* ---------------- 시작 시 복구 ---------------- */
let recoverId = null;
async function checkRecovery() {
  const sessions = (await allSessions()).filter((s) => s.status === 'recording').sort((a, b) => b.startedAt - a.startedAt);
  // 가장 최근 것만 '이어서 녹음' 제안, 더 오래된 것은 바로 저장 처리
  for (const s of sessions.slice(1)) { s.status = 'stopped'; s.metaReady = true; s.kind = s.kind || '수업'; await putSession(s); }
  if (sessions[0]) {
    recoverId = sessions[0].id;
    $('recoverLen').textContent = `${fmtDate(sessions[0].startedAt)} 시작, ${fmt(sessions[0].durationSec)} 녹음됨`;
    $('recoverBanner').classList.remove('hidden');
  }
}

/* ---------------- 이벤트 ---------------- */
$('startBtn').addEventListener('click', () => startRecording());
$('recoverContinue').addEventListener('click', () => { const id = recoverId; recoverId = null; startRecording(id); });
$('recoverFinish').addEventListener('click', async () => {
  const s = await getSession(recoverId);
  recoverId = null;
  $('recoverBanner').classList.add('hidden');
  if (s) { s.status = 'stopped'; await putSession(s); openSaveSheet(s.id); }
});

let stopArmTimer = null;
$('stopBtn').addEventListener('click', () => {
  const b = $('stopBtn');
  if (b.classList.contains('confirm')) { clearTimeout(stopArmTimer); stopRecording(); return; }
  b.classList.add('confirm');
  b.textContent = '한 번 더 누르면 종료';
  stopArmTimer = setTimeout(() => { b.classList.remove('confirm'); b.textContent = '종료'; }, 3000);
});
$('dimBtn').addEventListener('click', () => $('dim').classList.remove('hidden'));
$('dim').addEventListener('click', () => $('dim').classList.add('hidden'));
$('resumeBtn').addEventListener('click', () => hardResume());
$('finishFromInterruptBtn').addEventListener('click', () => stopRecording());

document.querySelectorAll('#kindChips .chip').forEach((c) => c.addEventListener('click', () => setKind(c.dataset.kind)));
$('saveBtn').addEventListener('click', () => saveMeta());

$('settingsBtn').addEventListener('click', () => {
  const s = settings();
  $('urlInput').value = s.url;
  $('keyInput').value = s.key;
  $('testResult').textContent = '';
  $('settingsSheet').classList.remove('hidden');
});
$('closeSettingsBtn').addEventListener('click', () => $('settingsSheet').classList.add('hidden'));
function readSettingsForm() {
  return { url: $('urlInput').value.trim(), key: $('keyInput').value.replace(/\s/g, '') };
}
$('saveSettingsBtn').addEventListener('click', () => {
  store.set('settings', readSettingsForm());
  $('settingsSheet').classList.add('hidden');
  toast('저장했어요');
  renderList();
  processQueue();
});
$('testBtn').addEventListener('click', async () => {
  const prev = settings();
  store.set('settings', readSettingsForm());
  $('testResult').textContent = '확인 중…';
  try {
    const j = await api('ping');
    $('testResult').textContent = '연결 성공 ✓ ' + (j.message || '');
  } catch (e) {
    $('testResult').textContent = '실패: ' + e.message;
    store.set('settings', prev);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (rec) flushChunk();
  } else {
    if (rec) {
      requestWakeLock();
      if (rec.interrupted || Date.now() - rec.lastDataAt > 2000) lightResume();
    } else {
      renderList();
      processQueue();
    }
  }
});
window.addEventListener('pagehide', () => { if (rec) flushChunk(); });
window.addEventListener('online', () => processQueue());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

(async function init() {
  await checkRecovery();
  await renderList();
  processQueue();
  setInterval(() => { if (!rec) { renderList(); processQueue(); } }, 60000);
})();
