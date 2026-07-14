# Resolve bridge guarantees and API limits

This note records what EasyField can prove through the DaVinci Resolve 20/21
Scripting API and where the public API does not expose enough information. The
bridge fails closed when it cannot preserve the requested timeline semantics.

## Native host boundary

`WorkflowIntegration.node` belongs to Blackmagic Design and is not source,
dependency or release content of EasyField. The production bridge loads the
signed universal module from Resolve's official SDK SamplePlugin installation.
CI intentionally builds and tests a clean checkout without that binary; bridge
contract tests use strict fakes. Native integration remains an on-device release
matrix requirement.

## Timeline capture

- `Grab frame` returns a clean source-media frame, not the graded/composited
  viewer output. The bridge converts the playhead offset using timeline FPS and
  then converts that elapsed time to source FPS.
- Resolve does not expose a public per-frame time-warp map. Source-frame capture
  is therefore exact for ordinary constant-speed forward clips, but it cannot
  reconstruct speed ramps, reverse segments, Fusion timing, or nested timeline
  timing from the scripting API. Rendered Transition boundary capture uses
  `ExportCurrentFrameAsStill` and is the supported path when the timeline result
  (grades, effects, transforms, composites) is required.
- Exact clip grabs are supported only for file-backed media with usable source
  bounds. EasyField attempts stream-copy and then an exact re-encode of that
  range. If both fail, the request fails; it never substitutes the whole source.
- `GetCurrentVideoItem()` exposes the item Resolve considers current at the
  playhead. With overlapping video layers, users must place the playhead on the
  intended shot. Boundary capture rechecks the item identity, timeline/source
  bounds, Media Pool identity and track after moving the playhead and aborts if
  any of them changed.

## Placement

- Managed placement checks the complete output interval against every item on a
  candidate EasyField track. Locked or disabled tracks are never reused when
  `GetIsTrackLocked` / `GetIsTrackEnabled` are available. A new managed track is
  created when no existing one is safe.
- Non-still placement requires a trustworthy duration from ffprobe or Resolve
  clip metadata. If duration is unknown, placement stops instead of assuming a
  one-frame interval.
- Video and embedded audio are placed as separate video-only/audio-only clip
  entries, using Resolve's documented `GetAudioMapping()` shape, and are linked
  with `SetClipsLinked`. A partial append or failed link is deleted without
  ripple; if Resolve cannot confirm rollback, the operation reports a hard
  failure for manual review.
- Transition placement freezes both captured shots. Immediately before placing,
  the bridge verifies project, timeline, item IDs, record/source bounds, Media
  Pool item IDs and track indexes. It aborts if either shot was trimmed, moved,
  relinked, or moved to another track. The API does not provide a transactional
  timeline lock, so this validation is optimistic and intentionally fails on
  concurrent edits.

## Release validation still required

Contract tests use a strict fake of the documented Resolve API. A release still
needs an on-device matrix in Resolve Studio on Intel and Apple silicon covering
different timeline/source FPS pairs, embedded stereo audio, locked/disabled
tracks, overlays, linked A/V, HDR/Rec.709 projects, and restart/undo behavior.
