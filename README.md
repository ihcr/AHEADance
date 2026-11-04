# AHEADance

The project page for AHEADance: a Unitree G1 humanoid that dances to the music it hears, stops when the music stops, and dances again when it comes back.

The site is static, so GitHub Pages serves it as is. `index.html` is the page.

## Contents

| Path | What it is |
|---|---|
| `index.html` | The page |
| `js/app.js` | Web demo: 3D robot, player, set list, timeline |
| `js/fk.js` | G1 forward kinematics (matches MuJoCo to about 1 µm) |
| `js/requests.js` | "Your song": send 20 s of music with an access code |
| `assets/` | G1 model from the Unitree MJCF (BSD-3-Clause): `g1.json` (tree) and `g1_meshes.bin` (int16 meshes) |
| `clips/manifest.json`, `clips/*.bin` | One entry per dance in the web demo: segments, plus 30 fps motion (root position, root quaternion, 29 joint angles) as int16 with per-channel scales |
| `audio/*.mp3` | The audio each dance was generated from (96 kb/s) |
| `media/` | Real-robot videos and their posters |

Every dance in the web demo is one run of the deployed model (seed 1234) on exactly the audio you hear. The page shows the generated motion 1.24 s behind the music, as on the real robot.

## Your song

`js/requests.js` talks to the song server at the `API` address in that file. The server runs on Modal and its code lives in the lab's research repository, not here.

- Every request needs an access code.
- A lab code has no limit and sees everyone's songs.
- A guest code can send 2 songs and sees only its own.
- A shared guest code works for anyone who has it. Each browser counts as one person, with 2 songs, and sees only its own songs. All its users together send at most 10 songs a day.
- The server adds 2 s of silence before the music and 4 s after it, runs the same model, and sends the dance back. This takes about two minutes.

## Local preview

```
python -m http.server 8000
```

Then open http://127.0.0.1:8000/. The song server accepts requests from this address and from https://ihcr.github.io.
