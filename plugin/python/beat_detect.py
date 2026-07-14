#!/usr/bin/env python3
"""Local beat analysis for EasyField.

The script deliberately has a tiny JSON contract so Electron can keep Python
and its dependencies outside the renderer.  It never receives an arbitrary
output path and never writes to a Resolve project.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path


def emit(payload: dict, *, exit_code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(exit_code)


def load_runtime():
    try:
        import librosa  # type: ignore
        import numpy as np  # type: ignore
    except Exception as error:  # dependency/import diagnostics only
        emit(
            {
                "ok": False,
                "code": "BEAT_RUNTIME_MISSING",
                "error": "The managed librosa runtime is not installed.",
                "detail": str(error),
            },
            exit_code=3,
        )
    return librosa, np


def finite_number(value, fallback: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def analyze(media_path: Path) -> dict:
    librosa, np = load_runtime()
    try:
        audio, sample_rate = librosa.load(str(media_path), sr=None, mono=True)
    except Exception as error:
        emit(
            {
                "ok": False,
                "code": "UNSUPPORTED_MEDIA",
                "error": "The selected file could not be decoded as audio.",
                "detail": str(error),
            },
            exit_code=4,
        )

    if sample_rate <= 0 or audio.size == 0:
        emit(
            {
                "ok": False,
                "code": "EMPTY_AUDIO",
                "error": "The selected file does not contain analyzable audio.",
            },
            exit_code=4,
        )

    duration = finite_number(librosa.get_duration(y=audio, sr=sample_rate))
    try:
        onset_envelope = librosa.onset.onset_strength(y=audio, sr=sample_rate)
        tempo, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_envelope,
            sr=sample_rate,
            units="frames",
        )
        beat_frames = np.asarray(beat_frames, dtype=int)
        beat_times = librosa.frames_to_time(beat_frames, sr=sample_rate)
    except Exception as error:
        emit(
            {
                "ok": False,
                "code": "BEAT_ANALYSIS_FAILED",
                "error": "librosa could not complete beat tracking.",
                "detail": str(error),
            },
            exit_code=5,
        )

    bpm = finite_number(np.asarray(tempo).reshape(-1)[0] if np.asarray(tempo).size else 0)
    strengths = np.asarray(onset_envelope, dtype=float)
    valid_frames = beat_frames[(beat_frames >= 0) & (beat_frames < strengths.size)]

    # Confidence is an interpretable local quality score, not a claim of
    # statistical certainty.  It combines onset prominence at detected beats
    # with temporal regularity, while retaining per-beat prominence below.
    if strengths.size and valid_frames.size:
        floor = finite_number(np.percentile(strengths, 25))
        ceiling = finite_number(np.percentile(strengths, 95), fallback=floor + 1.0)
        scale = max(ceiling - floor, 1e-9)
        per_beat = np.clip((strengths[valid_frames] - floor) / scale, 0.0, 1.0)
    else:
        per_beat = np.zeros(len(beat_times), dtype=float)

    intervals = np.diff(np.asarray(beat_times, dtype=float))
    if intervals.size >= 2 and finite_number(np.mean(intervals)) > 0:
        regularity = max(0.0, 1.0 - min(1.0, finite_number(np.std(intervals) / np.mean(intervals))))
    elif len(beat_times) >= 2:
        regularity = 0.5
    else:
        regularity = 0.0
    prominence = finite_number(np.mean(per_beat)) if per_beat.size else 0.0
    confidence = max(0.0, min(1.0, prominence * 0.65 + regularity * 0.35))

    beat_payload = []
    for index, value in enumerate(np.asarray(beat_times, dtype=float)):
        time_seconds = finite_number(value, fallback=-1.0)
        if time_seconds < 0 or time_seconds > duration + 0.1:
            continue
        beat_payload.append(
            {
                "time": round(time_seconds, 4),
                "confidence": round(finite_number(per_beat[index]) if index < per_beat.size else confidence, 4),
            }
        )

    return {
        "ok": True,
        "engine": "librosa",
        "engineVersion": str(getattr(librosa, "__version__", "unknown")),
        "bpm": round(bpm, 2),
        "confidence": round(confidence, 4),
        "durationSeconds": round(duration, 4),
        "sampleRate": int(sample_rate),
        "beats": beat_payload,
    }


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("media", nargs="?")
    args = parser.parse_args()

    if args.probe:
        librosa, _np = load_runtime()
        emit(
            {
                "ok": True,
                "available": True,
                "engine": "librosa",
                "engineVersion": str(getattr(librosa, "__version__", "unknown")),
            }
        )

    if not args.media:
        emit({"ok": False, "code": "BAD_REQUEST", "error": "Missing media path."}, exit_code=2)
    media_path = Path(args.media).expanduser().resolve()
    if not media_path.is_file():
        emit({"ok": False, "code": "BAD_REQUEST", "error": "Media file was not found."}, exit_code=2)
    emit(analyze(media_path))


if __name__ == "__main__":
    main()
