// Tritone: recording UI + upload
const recButtons = document.querySelectorAll('[data-rec]');   // phone + desktop buttons share this
const statusEl = document.querySelector('[data-status]');
const clockEl = document.querySelector('[data-clock]');
const roll = document.querySelector('.roll');
const recordings = document.getElementById('recordings');
const titleInput = document.getElementById('recording-title');
const heading = document.getElementById('header-title');

// Rows on the pitch roll, top to bottom (must match the labels in index.html)
const ROWS = ['E5', 'D5', 'C5', 'B4', 'A4', 'G4', 'F4', 'E4'];

let mediaRecorder, stream, chunks = [], timer = null, seconds = 0;

const fmt = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
document.addEventListener('DOMContentLoaded', getrecordings);

// delete a recording from the list and the server
recordings.addEventListener('click', async (e) => {
  console.log('bruh');
  const deleteBtn = e.target.closest('.delete');
  const playBtn = e.target.closest('.play');

  if(deleteBtn) {
    const id = deleteBtn.dataset.id;
    const li = deleteBtn.closest('.memo');

    try {
      const res = await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      li.remove(); // drop it from the UI without a full refetch

      if (String(id) === String(currentRecordingId)) {
        // they deleted the one currently open in the studio — clear it out
        currentRecordingId = null;
        heading.textContent = 'No recording selected';
        renderNotes([]);
      }
    } catch (err) {
      console.error('Delete failed:', err);
      alert('Could not delete that recording.');
    }
    return;
  }

  if (playBtn) {
    const recording = recordingsById[playBtn.dataset.id];
    if (recording) {
      loadRecording(recording);
      Playback.toggle();
    }
    return;
  }

  const li = e.target.closest('.memo');
  if (li) {
    const recording = recordingsById[li.dataset.id];
    if (recording) loadRecording(recording);
  }
});

let recordingsById = {};

function getrecordings(){
    fetch('/api/recordings')
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
        recordings.innerHTML = '';
        recordingsById = {}; // reset
        if (data.recordings.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'You have no recordings yet. Try recording something!';
            recordings.appendChild(li);
            return;
        }
        data.recordings.forEach(recording => {
            recordingsById[recording.id] = recording; // store for later lookup

            const li = document.createElement('li');
            li.className = 'memo';
            li.dataset.id = recording.id; // put the id on the row itself
            li.innerHTML = `
                <button class="play" type="button" data-id="${recording.id}" aria-label="Play ${recording.title}"></button>
                <button class="delete" data-id="${recording.id}" type="button" aria-label="Delete ${recording.title}">Delete</button>
                <div><b>${recording.title}</b><span class="meta">${new Date(recording.created_at).toLocaleString()} &middot; ${fmt(Math.trunc(recording.duration))}</span></div>
            `;
            recordings.appendChild(li);
        });
    })
    .catch(error => console.error('Error fetching recordings:', error));
}

function loadRecording(recording) {
  currentRecordingId = recording.id;
  heading.textContent = recording.title;
  heading.dataset.originalTitle = recording.title;
  renderNotes(recording.notes);
  Playback.load(`/static/audio/${recording.filename}`, recording.duration); 
}

let currentRecordingId = null;
heading.addEventListener('blur', async () => {
  if (!currentRecordingId) return; // nothing loaded yet, nothing to rename
  const newTitle = heading.textContent.trim();
  if (!newTitle) {
    heading.textContent = heading.title; // revert if they cleared it
    return;
  }
  await fetch(`/api/recordings/${heading.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle }),
  });
  heading.dataset.originalTitle = newTitle; // update the original title to the new one
});


// One function keeps every record button and the page in sync
function setRecording(on) {
  if (on) seconds=0;
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
    getrecordings();
    // loadRecording(data); //we'll worry about this soon, without configuring ts a fresh recording won't play
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
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function midiToNote(midi) {
  const name = NOTE_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}
function buildRows(notes) {
  if (!notes.length) return ['C4']; // fallback for an empty roll
  const midis = notes.map(n => toMidi(n.note)).filter(m => m !== null);
  const min = Math.min(...midis) - 1;
  const max = Math.max(...midis) + 1;
  
  const MAX_SPAN = 24; // 2 octaves
  if (max - min > MAX_SPAN) {
    const center = Math.round((max + min) / 2);
    min = center - MAX_SPAN / 2;
    max = center + MAX_SPAN / 2;
  }
  const rows = [];
  for (let m = max; m >= min; m--) rows.push(midiToNote(m)); // top to bottom, high to low
  return rows;
}

let currentRows = [];

function renderNotes(notes) {
  currentRows = buildRows(notes);

  // Row labels
  const keysEl = document.getElementById('roll-keys');
  keysEl.innerHTML = currentRows
    .map(n => `<span class="${n.includes('♯') ? 'is-black' : ''}">${n}</span>`)
    .join('');

  // Match CSS row height to however many rows we actually have
  roll.style.setProperty('--row-count', currentRows.length);

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

function noteToRow(name) {
  return currentRows.indexOf(name); // exact match now, since rows are built from real notes
}

// Auth dialog (only if those elements exist on the page)
const auth = document.getElementById('auth');
const openAuth = document.querySelector('[data-open-auth]');
if (auth && openAuth) openAuth.addEventListener('click', () => auth.showModal());

// Playback: the pitch roll is the scrubber (tap, click or drag to choose where to play from)
const Playback = (() => {
  const roll = document.querySelector('.roll');
  const playBtn = document.querySelector('.transport .play');
  const timeEl = document.querySelector('.transport .time');
  const audio = new Audio();
  let duration = 0, dragging = false, raf = null;

  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const recording = () => document.body.classList.contains('is-recording');

  function render() {
    const t = audio.currentTime || 0;
    roll.style.setProperty('--pos', duration ? Math.min(100, (t / duration) * 100) : 0);
    roll.setAttribute('aria-valuenow', t.toFixed(1));
    roll.setAttribute('aria-valuetext', `${fmt(t)} of ${fmt(duration)}`);
    timeEl.textContent = `${fmt(t)} / ${fmt(duration)}`;
  }

  // Smooth playhead (timeupdate only fires ~4x per second)
  function loop() { render(); if (!audio.paused) raf = requestAnimationFrame(loop); }
  function setPlaying(on) {
    playBtn.setAttribute('aria-pressed', on);
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    cancelAnimationFrame(raf);
    if (on) loop(); else render();
  }
  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('ended', () => setPlaying(false));
  audio.addEventListener('loadedmetadata', () => {
    if (!duration && isFinite(audio.duration)) { duration = audio.duration; roll.setAttribute('aria-valuemax', duration); render(); }
  });

  // Pass the stored duration: MediaRecorder webm files often report Infinity
  function load(url, seconds = 0) {
    audio.pause();
    audio.src = url;
    duration = seconds;
    roll.setAttribute('aria-valuemax', duration);
    audio.currentTime = 0;
    render();
  }

  function toggle() {
    if (!audio.src || recording()) return;
    audio.paused ? audio.play() : audio.pause();
  }

  function seek(seconds) {
    if (!audio.src || !duration) return;
    audio.currentTime = Math.min(duration, Math.max(0, seconds));
    render();
  }
  const pctFromEvent = e => {
    const r = roll.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  roll.addEventListener('pointerdown', e => {
    if (recording() || !duration) return;
    dragging = true;
    roll.setPointerCapture(e.pointerId);
    seek(pctFromEvent(e) * duration);
  });
  roll.addEventListener('pointermove', e => { if (dragging) seek(pctFromEvent(e) * duration); });
  ['pointerup', 'pointercancel'].forEach(t => roll.addEventListener(t, () => { dragging = false; }));

  roll.addEventListener('keydown', e => {
    const step = e.shiftKey ? 5 : 1;
    const keys = {
      ArrowLeft: () => seek(audio.currentTime - step),
      ArrowRight: () => seek(audio.currentTime + step),
      Home: () => seek(0),
      End: () => seek(duration),
      ' ': toggle,
      Enter: toggle,
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });

  playBtn.addEventListener('click', toggle);
  return { load, toggle, seek };
})();