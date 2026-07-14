# EasyField beat-analysis runtime

Beat Detection runs locally through `librosa`; media is never uploaded. The
Electron main process looks for this project-managed environment first:

```sh
python3 -m venv plugin/python/.venv
plugin/python/.venv/bin/python3 -m pip install -r plugin/python/requirements-beat.txt
```

Verify the runtime without analyzing media:

```sh
plugin/python/.venv/bin/python3 plugin/python/beat_detect.py --probe
```

The environment is intentionally ignored by version control. Release builds
should bundle architecture-specific managed runtimes for Apple Silicon and
Intel, or install the matching runtime during onboarding. EasyField never
installs Python packages globally.
