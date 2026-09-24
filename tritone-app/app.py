import config
from flask import Flask, Response, redirect, render_template, request, jsonify
import librosa
import numpy as np
import subprocess, os, uuid
import psycopg2
from datetime import datetime, timedelta
from psycopg2.extras import RealDictCursor
import secrets


app = Flask(__name__)
UPLOAD_DIR = "static/audio"

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

    # move the file into permanent storage, save path + notes to DB here
    os.remove(raw_path)

    return jsonify({"notes": notes})


def extract_notes(f0, voiced_flag, sr, hop_length=512):
    """Collapse a frame-by-frame pitch track into discrete note events."""
    notes = []
    current = None

    for i, (freq, voiced) in enumerate(zip(f0, voiced_flag)):
        t = librosa.frames_to_time(i, sr=sr, hop_length=hop_length)
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

####################################################################

@app.route("/")
def home():
    user = get_session_id(request.cookies.get("session_id"))
    if not user:
        return redirect("/login")
    return render_template('index.html', username=user["username"])

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
    response = redirect("/")
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
    cur.execute("INSERT into sessions (session_id, username, expires_at) VALUES (%s, %s, %s);", (session_id, username, datetime.now() + timedelta(hours=24)))
    conn.commit()
    cur.close()
    conn.close()
    return session_id


@app.route("/logout", methods=["GET"])
def logout():
    response = redirect("/login")
    response.delete_cookie("session_id")
    return response


if __name__ == "__main__":
    app.run(debug=True)