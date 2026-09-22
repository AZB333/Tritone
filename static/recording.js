const rec = document.getElementById('rec');
const hint = document.getElementById('dock-hint');
const timeEl = document.getElementById('dock-time');
let timer = null, seconds = 0;

rec.addEventListener('click', () => {
    const on = rec.getAttribute('aria-pressed') !== 'true';
    rec.setAttribute('aria-pressed', on);
    on ? startRecording() : stopRecording();
});

let mediaRecorder, chunks = [];

async function startRecording() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    chunks = [];

    mediaRecorder.ondataavailable = e => chunks.push(e.data);
    mediaRecorder.onstop = uploadRecording;

    mediaRecorder.start();
}

function stopRecording() {
    mediaRecorder.stop();
}

async function uploadRecording() {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('audio', blob, 'memo.webm');

    const response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData
    });

    const data = await response.json();
    renderNotes(data.notes);
}

function renderNotes(notes) {
    const grid = document.querySelector('.roll-grid');
    grid.querySelectorAll('.note').forEach(el => el.remove());

    const totalDuration = notes.length ? notes[notes.length - 1].end : 1;

    notes.forEach(n => {
        const el = document.createElement('span');
        el.className = 'note';
        el.textContent = n.note;
        el.style.setProperty('--start', (n.start / totalDuration) * 100);
        el.style.setProperty('--len', ((n.end - n.start) / totalDuration) * 100);
        el.style.setProperty('--row', noteToRow(n.note)); // map note name to a row index in your `keys` list
        grid.appendChild(el);
    });
}

const auth = document.getElementById('auth');
document.querySelector('[data-open-auth]').addEventListener('click', () => auth.showModal());
