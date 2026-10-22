import config
from flask import Flask, Response, json, redirect, render_template, request, jsonify
import librosa
import numpy as np
import subprocess, os, uuid
import psycopg2
from datetime import datetime, timedelta
from psycopg2.extras import RealDictCursor
import secrets
import shutil
import random

ADJECTIVES = [
    "Dizzy", "Velvet", "Rusty", "Sly", "Mellow", "Jumpy", "Lucky", "Breezy",
    "Spicy", "Fuzzy", "Golden", "Crooked", "Sneaky", "Silky", "Glowing",
    "Wobbly", "Bright", "Salty", "Quiet", "Electric", "Risky", "Tilted", "Pleasant",
]

NOUNS = [
    "Falcon", "Kazoo", "Comet", "Tambourine", "Pretzel", "Marmot", "Echo",
    "Panther", "Kettle", "Otter", "Harmonica", "Wombat", "Lantern", "Cobra",
    "Walrus", "Trumpet", "Badger", "Glacier", "Cymbal", "Penguin", "Goat", "Rain",
]

def generate_memo_name():
    return f"{random.choice(ADJECTIVES)} {random.choice(NOUNS)}"

AUDIO_DIR = "static/audio"
os.makedirs(AUDIO_DIR, exist_ok=True)

app = Flask(__name__)

def get_db_connection():
    return psycopg2.connect(os.environ["DATABASE_URL"])


"""
audio processing section
"""
####################################################################################
@app.route("/api/analyze", methods=["POST"])
def analyze():
    file = request.files["audio"]
    raw_path = f"/tmp/{uuid.uuid4()}.webm"
    file.save(raw_path)

    # Normalize to wav so librosa reads it consistently across browsers
    wav_path = raw_path.replace(".webm", ".wav")
    subprocess.run(["ffmpeg", "-i", raw_path, "-ar", "22050", wav_path], check=True)

    y, sr = librosa.load(wav_path, sr=22050)
    f0, voiced_flag, _ = librosa.pyin(
        y, fmin=librosa.note_to_hz('C2'), fmax=librosa.note_to_hz('C7')
    )

    notes = extract_notes(f0, voiced_flag, sr)

    final_filename = f"{uuid.uuid4()}.wav"
    final_path = os.path.join(AUDIO_DIR, final_filename)
    shutil.move(wav_path, final_path)

    # move the file into permanent storage, save path + notes to DB here
    os.remove(raw_path)

    user_id = get_user_id_from_session(request.cookies.get("session_id"))
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    title = generate_memo_name()
    duration = float(notes[-1]["end"]) if notes else 0

    cur.execute(
        """INSERT INTO recordings (user_id, filename, title, duration, notes, created_at)
        VALUES (%s, %s, %s, %s, %s, now())""",
        (user_id, final_filename, title, duration, json.dumps(notes)),
    )
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"notes": notes})


def get_user_id_from_session(session_id):
    """Return the user_id associated with a session_id."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT user_id FROM sessions WHERE session_id = %s;", (session_id,))
    result = cur.fetchone()
    cur.close()
    conn.close()
    return result["user_id"] if result else None

def extract_notes(f0, voiced_flag, sr, hop_length=512):
    """Collapse a frame-by-frame pitch track into discrete note events."""
    notes = []
    current = None

    for i, (freq, voiced) in enumerate(zip(f0, voiced_flag)):
        t = float(librosa.frames_to_time(i, sr=sr, hop_length=hop_length))
        if voiced and not np.isnan(freq):
            name = librosa.hz_to_note(freq)
            if current and current["note"] == name:
                current["end"] = t
            else:
                if current:
                    notes.append(current)
                current = {"note": name, "start": t, "end": t}
        else:
            if current:
                notes.append(current)
                current = None
    if current:
        notes.append(current)
    return notes

# update recording titles if they wish
@app.route("/api/recordings/<int:recording_id>", methods=["PATCH"])
def rename_recording(recording_id):
    user_id = get_user_id_from_session(request.cookies.get("session_id"))
    if not user_id:
        return jsonify({"error": "Not signed in"}), 401

    new_title = request.json.get("title", "").strip()
    if not new_title:
        return jsonify({"error": "Title cannot be empty"}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        "UPDATE recordings SET title = %s WHERE id = %s AND user_id = %s;",
        (new_title, recording_id, user_id),
    )
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"title": new_title})

####################################################################

@app.route("/")
def home():
    user = get_session_id(request.cookies.get("session_id"))
    if not user:
        return redirect("/login")
    return redirect("/recording")

@app.route("/recording")
def recording():
    session_id = get_session_id(request.cookies.get("session_id"))
    if not session_id:
        return redirect("/login")
    return render_template('recording.html')

@app.route("/login", methods=["GET"])
def login_get():
    """The login page."""
    return render_template("login.html")

@app.route("/login", methods=["POST"])
def login_post():
    """Log in a user."""
    username = request.form.get("username")
    password = request.form.get("password")

    user = get_user(username)
    if not user or user.get("password") != password:
        return render_template("error.html", error="Invalid username or password")

    response = redirect("/recording")
    response.set_cookie("session_id", create_session_id(username))
    return response

@app.route("/create_account", methods=["GET"])
def create_account_get():
    """The signup page."""
    return render_template("create_account.html")

@app.route("/create_account", methods=["POST"])
def create_account_post():
    """Register a new customer and log them in."""
    username = request.form.get("username")
    password = request.form.get("password")

    if not username or not password:
        return render_template("error.html", error="Username and password are both required")

    if get_user(username) is not None:
        return render_template("error.html", error="A user with that username already exists")


    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("INSERT INTO users (username, password) VALUES (%s, %s);", (username, password))
    conn.commit()
    cur.close()
    conn.close()
    response = redirect("/recording")
    response.set_cookie("session_id", create_session_id(username))
    return response

def get_session_id(session_id):
    """Return a user dict from the database, or None if not found."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT * FROM sessions WHERE session_id = %s;", (session_id,))
    user = cur.fetchone()
    cur.close()
    conn.close()
    return user if user else None

def get_user(username):
    """Return a user dict from the database, or None if not found."""
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT * FROM users WHERE username = %s;", (username,))
    user = cur.fetchone()
    cur.close()
    conn.close()
    return user if user else None

def create_session_id(username):
    """Create a new session ID for the given username."""
    session_id = secrets.token_hex(32)
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT * FROM users WHERE username = %s;", (username,))
    user = cur.fetchone()
    cur.execute("INSERT into sessions (session_id, user_id, expires_at) VALUES (%s, %s, %s);", (session_id, user["id"], datetime.now() + timedelta(hours=24)))
    conn.commit()
    cur.close()
    conn.close()
    return session_id


@app.route("/logout", methods=["GET"])
def logout():
    response = redirect("/login")
    response.delete_cookie("session_id")
    return response

@app.route("/test", methods=["GET"])
def test():
    return render_template("test.html")

@app.route("/api/recordings", methods=["GET"])
def get_recordings():
    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute("SELECT * FROM recordings WHERE user_id = %s;", (get_session_id(request.cookies.get("session_id"))["user_id"],))
    recordings = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify({"recordings": recordings})

@app.route("/api/recordings/<int:recording_id>", methods=["DELETE"])
def delete_recording(recording_id):
    user_id = get_user_id_from_session(request.cookies.get("session_id"))
    if not user_id:
        return jsonify({"error": "Not signed in"}), 401

    conn = get_db_connection()
    cur = conn.cursor(cursor_factory=RealDictCursor)

    # fetch first, so we only delete a file that belongs to this user
    cur.execute(
        "SELECT filename FROM recordings WHERE id = %s AND user_id = %s;",
        (recording_id, user_id),
    )
    row = cur.fetchone()
    if not row:
        cur.close()
        conn.close()
        return jsonify({"error": "Not found"}), 404

    cur.execute(
        "DELETE FROM recordings WHERE id = %s AND user_id = %s;",
        (recording_id, user_id),
    )
    conn.commit()
    cur.close()
    conn.close()

    # remove the audio file from disk too so it doesn't pile up orphaned
    file_path = os.path.join(AUDIO_DIR, row["filename"])
    if os.path.exists(file_path):
        os.remove(file_path)

    return jsonify({"deleted": recording_id})

if __name__ == "__main__":
    app.run(debug=True)