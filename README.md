# AHEADance

The project page for AHEADance (UCL Humanoid Robotics Lab): a Unitree G1 humanoid that hears the style in the music and improvises a dance to it, never quite the same twice. Contact: chengxu.zhou@ucl.ac.uk.

The site is static, so GitHub Pages serves it as is. `index.html` is the page.

## Contents

| Path | What it is |
|---|---|
| `index.html` | The page |
| `js/app.js` | Web demo: 3D robot, player, set list, timeline |
| `js/fk.js` | G1 forward kinematics (matches MuJoCo to about 1 µm) |
| `js/requests.js` | "Your song": send 20 s of music with an access code |
| `js/live.js` | "Live": the model dances to a music file as it plays |
| `assets/` | G1 model from the Unitree MJCF (BSD-3-Clause): `g1.json` (tree) and `g1_meshes.bin` (int16 meshes) |
| `clips/manifest.json`, `clips/*.bin` | One entry per dance in the web demo: segments, plus 30 fps motion (root position, root quaternion, 29 joint angles) as int16 with per-channel scales |
| `audio/*.mp3` | The audio each dance was generated from (96 kb/s) |
| `media/` | Real-robot videos and their posters. `style_*.mp4`: the eight multi-style runs, each from 1 s before its music to 2 s after it, with the camera's own sound |

Every dance in the web demo is one run of the deployed model on exactly the audio you hear: seed 1234, except the three "Same song" takes (one unseen song, seeds 1234, 1235 and 1236, fixed in advance) and Live (a new seed each session). Each replay starts 1 s before its music: the longer silence the model heard first is skipped by starting the same run later (`lead_cut_s` in the manifest), never by joining runs. The page shows the generated motion 1.24 s behind the music, as on the real robot.

## Your song

`js/requests.js` talks to the song server at the `API` address in that file. The server runs on Modal and its code lives in the lab's research repository, not here.

- Every request needs an access code.
- A lab code has no limit and sees everyone's songs.
- A guest code can send 2 songs and sees only its own.
- A shared guest code works for anyone who has it. Each browser counts as one person, with 2 songs, and sees only its own songs. All its users together send at most 10 songs a day.
- The server adds 2 s of silence before the music and 4 s after it, runs the same model, and sends the dance back. This takes about two minutes.

## Live

The Live tab plays a music file in the browser and streams exactly what it plays to the live server (`LIVE` in `js/live.js`). Paused music streams as silence. The server runs the same feature service and generator as the real robot, one 0.533 s chunk at a time. Each chunk comes back to the page, which shows it 1.24 s behind the music.

- It needs an access code, the same as Your song.
- Every session draws a new random seed, so the same music gives a new dance each time.
- One visitor at a time, at most 3 minutes per session.
- Guest codes together get 10 live sessions a day. Lab codes have no limit.
- The first visitor in a while waits about a minute while the cloud GPU starts.
- The audio is not kept.

## Local preview

```
python -m http.server 8000
```

Then open http://127.0.0.1:8000/. The song server accepts requests from this address and from https://ihcr.github.io.
