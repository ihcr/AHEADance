# AHEADance

The project page for AHEADance (UCL Humanoid Robotics Lab): a Unitree G1 humanoid that dances to what it hears, improvising as the music plays, in the music's own style. Contact: chengxu.zhou@ucl.ac.uk.

The site is static, so GitHub Pages serves it as is. `index.html` is the page.

## Contents

| Path | What it is |
|---|---|
| `index.html` | The page |
| `js/app.js` | Web demo: 3D robot, player, set list, timeline |
| `js/fk.js` | G1 forward kinematics (matches MuJoCo to about 1 µm) |
| `js/requests.js` | "Your song": send 30 s of music with an access code |
| `js/live.js` | "Live": the model dances to a music file as it plays |
| `js/strip.js` | The strip under the stage: rhythm, spectrogram, volume and spectrum of the music, and the robot's joint speed (replays and Live) |

Replays have two motions on one clock: `motion` (what the deployed model generated) and `motion_sim` (SONIC, the whole-body controller our robot runs, executing that same generated motion in headless MuJoCo; AudioMimic `project_page/tools/sonic_replays.py` and `sonic_to_page.py`). The page shows `motion_sim` by default (switch label "SONIC tracker") with a switch to the generated motion ("Generated motion"); Live and the songs visitors send show the generated motion.
| `assets/` | G1 model from the Unitree MJCF (BSD-3-Clause): `g1.json` (tree) and `g1_meshes.bin` (int16 meshes) |
| `clips/manifest.json`, `clips/*.bin` | One entry per dance in the web demo: segments, plus 30 fps motion (root position, root quaternion, 29 joint angles) as int16 with per-channel scales |
| `audio/*.mp3` | The audio each dance was generated from (96 kb/s) |
| `media/` | Real-robot videos and their posters. `style_*.mp4`: the eight multi-style runs, each from 1 s before its music to 2 s after it, with the camera's own sound |

Every dance in the web demo is one run of the deployed model on exactly the audio you hear: seed 1234, except the three "Same song" takes (one unseen song, seeds 1234, 1235 and 1236, fixed in advance) and Live (a new seed each session). Each replay starts 1 s before its music: the longer silence the model heard first is skipped by starting the same run later (`lead_cut_s` in the manifest), never by joining runs. The page shows the generated motion 1.24 s behind the music, as on the real robot.

## Your song

`js/requests.js` talks to the song server at the `API` address in that file. The server runs on Modal and its code lives in the lab's research repository, not here.

- Visitors sign in with their email: the server emails a 6-digit code, and the page keeps a personal access token in that browser.
- Each email address can send 2 songs and sees only its own songs, on every device it signs in on. The lab can give an address more songs when asked.
- A lab access code has no limit and sees everyone's songs.
- The mail goes out through the SMTP account in the Modal Secret `aheadance-mail`.
- The server adds 2 s of silence before the music and 4 s after it, runs the same model, and sends the dance back. This takes about two minutes.

## Live

The Live tab plays a music file in the browser and streams exactly what it plays to the live server (`LIVE` in `js/live.js`). Paused music streams as silence. The server runs the same feature service and generator as the real robot, one 0.533 s chunk at a time. Each chunk comes back to the page, which shows it 1.24 s behind the music.

- It needs the same sign-in as Your song.
- Every session draws a new random seed, so the same music gives a new dance each time.
- Microphone (beta): the music plays on another device, such as a phone, and the browser streams what the computer's microphone hears (echo cancelling, noise suppression and gain control off; never played back). The server runs the real robot's microphone chain on it (a music gate that first learns the room for 4.7 s). Recordings are kept only if the visitor ticks the box.
- One visitor at a time, at most 1 minute per session. Others wait in line (up to 5), with their place and an estimated wait.
- Each email address gets 2 live sessions a day. Lab codes have no limit.
- The first visitor in a while waits about a minute while the cloud GPU starts.
- The audio is not kept.

## Local preview

```
python -m http.server 8000
```

Then open http://127.0.0.1:8000/.

When you change anything in `js/`, change the version `v=` in `index.html`, `js/app.js` and `js/live.js` (all the same) so browsers do not mix a new page with old scripts. The song server accepts requests from this address and from https://ihcr.github.io.
