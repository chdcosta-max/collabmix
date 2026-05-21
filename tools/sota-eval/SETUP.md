# sota-eval — Python sandbox for evaluating SOTA beat trackers

Isolated from production. Nothing here touches `src/` or the Node test harness.

## Install (Mac, Python 3.9)

```bash
cd tools/sota-eval
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip wheel
pip install 'setuptools<81'        # madmom imports `pkg_resources`, removed in setuptools 81+
pip install Cython 'numpy<1.24'    # madmom 0.16.1 uses removed `np.float`, also needs Cython pre-installed
pip install --no-build-isolation madmom
```

## Audio loading — ffmpeg requirement

madmom's `load_audio_file` shells out to `ffmpeg` or `avconv`. Use the
existing `ffmpeg-static` binary from the harness rather than installing
ffmpeg system-wide:

```bash
export PATH=/Users/chad/Desktop/collabmix/tools/bpm-test-harness/node_modules/ffmpeg-static:$PATH
```

Wrap-script `madmom_run.py` already sets this up so the activation step alone is enough.

## Verify

```bash
source venv/bin/activate
export PATH=/Users/chad/Desktop/collabmix/tools/bpm-test-harness/node_modules/ffmpeg-static:$PATH
python -c "
from madmom.features.downbeats import DBNDownBeatTrackingProcessor, RNNDownBeatProcessor
proc = RNNDownBeatProcessor()
dbn = DBNDownBeatTrackingProcessor(beats_per_bar=[4], fps=100)
beats = dbn(proc('/Users/chad/Music/PioneerDJ/Demo Tracks/Demo Track 1.mp3'))
print('first downbeat:', beats[beats[:,1]==1][0])
"
```

Expected: first downbeat ≈ 0.02 s. Rekordbox truth for that track is 0.025 s.

## Pinned versions actually installed

- madmom 0.16.1
- numpy 1.23.5
- scipy 1.13.1
- Cython 3.2.4
- mido 1.3.3
- setuptools 80.10.2

## Performance note

RNN inference: ~11 s/track (CPU only, no GPU acceleration in madmom).
DBN tracking: ~0.5 s/track.
End-to-end: ~12 s/track.

For 10,000 tracks single-threaded: **~33 hours**. Parallelizable across CPU
cores via process pool — wall clock on an 8-core machine: **~4 hours**.
