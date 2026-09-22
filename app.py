import config
from flask import Flask, Response, redirect, render_template, request, jsonify
import librosa
import numpy as np
import subprocess, os, uuid

app = Flask(__name__)
UPLOAD_DIR = "static/audio"

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
    username = "John Doe"
    return render_template('index.html', name=username)

@app.route("/recording")
def recording():
    return render_template('recording.html')

@app.route("/create_account", methods=["GET"])
def create_account_get():
    """The signup page."""
    return render_template("create_account.html")

@app.route("/create_account", methods=["POST"])
def create_account_post():
    """Register a new customer and log them in."""
    username = request.form.get("username")
    password = request.form.get("password")

    email = request.form.get("email", "")

    if not username or not password:
        return render_template("error.html", error="Username and password are both required")

    # if get_user(username) is not None:
    #     return render_template("error.html", error="A user with that username already exists")

    # db.execute(
    #     "INSERT INTO users (username, password, email, address, balance) "
    #     "VALUES (%s, %s, %s, '', 100)",
    #     (username, password, email),
    # )

    # log.info("new account %s registered with email %s", username, email)

    response = redirect("/")
    # response.set_cookie("session_id", create_session_id(username) , samesite="Lax") # set the session_id cookie
    return response
if __name__ == "__main__":
    app.run(debug=True)