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

The environment is intentionally ignored by version control and is accepted
only in development. It is never considered release evidence or copied into a
public artifact. Release builds require the separate, exact-file runtime pack
catalog for Apple silicon and Intel, including checksums, Mach-O validation and
recorded redistribution approval. EasyField never installs Python packages
globally.
