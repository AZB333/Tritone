// Pitch Memos: recording UI + upload
const recButtons = document.querySelectorAll('[data-rec]');   // phone + desktop buttons share this
const statusEl = document.querySelector('[data-status]');
const clockEl = document.querySelector('[data-clock]');
const roll = document.querySelector('.roll');

// Rows on the pitch roll, top to bottom (must match the labels in index.html)
const ROWS = ['E5', 'D5', 'C5', 'B4', 'A4', 'G4', 'F4', 'E4'];

let mediaRecorder, stream, chunks = [], timer = null, seconds = 0;

const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// One function keeps every record button and the page in sync
function setRecording(on) {
  document.body.classList.toggle('is-recording', on);
  recButtons.forEach(btn => {
    btn.setAttribute('aria-pressed', on);
    if (btn.classList.contains('rec')) btn.setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
    const label = btn.querySelector('.rec-label');
    if (label) label.textContent = on ? `Stop recording ${fmt(seconds)}` : 'Record new';
  });
  if (statusEl) statusEl.textContent = on ? 'Recording' : 'Ready';
  if (clockEl) clockEl.textContent = fmt(seconds);

  clearInterval(timer);
  if (on) {
    seconds = 0;
    timer = setInterval(() => { seconds++; setRecording.tick(); }, 1000);
  }
}
setRecording.tick = () => {
  if (clockEl) clockEl.textContent = fmt(seconds);
  document.querySelectorAll('.rec-label').forEach(l => {
    if (document.body.classList.contains('is-recording')) l.textContent = `Stop recording ${fmt(seconds)}`;
  });
};

recButtons.forEach(btn => btn.addEventListener('click', async () => {
  const on = btn.getAttribute('aria-pressed') !== 'true';
  if (on) {
    try { await startRecording(); setRecording(true); }
    catch (err) { setRecording(false); if (statusEl) statusEl.textContent = 'Mic blocked'; }
  } else {
    stopRecording();
    setRecording(false);
  }
}));

async function startRecording() {
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);
  chunks = [];
  mediaRecorder.ondataavailable = e => chunks.push(e.data);
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());   // release the mic
    uploadRecording();
  };
  mediaRecorder.start();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

async function uploadRecording() {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const formData = new FormData();
  formData.append('audio', blob, 'memo.webm');
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    renderNotes(data.notes);
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Analysis failed';
  }
}

// "A#4" -> MIDI number, so sharps/flats snap to the nearest row
function toMidi(name) {
  const m = /^([A-G])([#b♯♭]?)(-?\d)$/.exec(name);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  const acc = /[#♯]/.test(m[2]) ? 1 : /[b♭]/.test(m[2]) ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + acc;
}
function noteToRow(name) {
  const midi = toMidi(name);
  if (midi === null) return 0;
  let best = 0;
  ROWS.forEach((r, i) => { if (Math.abs(toMidi(r) - midi) < Math.abs(toMidi(ROWS[best]) - midi)) best = i; });
  return best;
}

// Matches the CSS: bars use --row (0-7), --x and --w (percent of the roll)
function renderNotes(notes) {
  roll.querySelectorAll('.bar').forEach(el => el.remove());
  const total = notes.length ? notes[notes.length - 1].end : 1;
  notes.forEach(n => {
    const el = document.createElement('i');
    el.className = 'bar';
    el.title = n.note;
    el.style.setProperty('--x', (n.start / total) * 100);
    el.style.setProperty('--w', ((n.end - n.start) / total) * 100);
    el.style.setProperty('--row', noteToRow(n.note));
    roll.appendChild(el);
  });
  const list = document.querySelector('.note-list');
  if (list) list.textContent = notes.map(n => n.note).join(' · ');
}

// Auth dialog (only if those elements exist on the page)
const auth = document.getElementById('auth');
const openAuth = document.querySelector('[data-open-auth]');
if (auth && openAuth) openAuth.addEventListener('click', () => auth.showModal());