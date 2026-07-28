# Portable runtime packaging

EasyField's public release requires three local runtime components:

- FFmpeg and ffprobe;
- a self-contained CPython/librosa environment for Beat Detection;
- whisper.cpp's `whisper-cli` for local transcription.

The repository intentionally contains none of those binaries. The checked-in
[`plugin/runtime-packs.json`](../plugin/runtime-packs.json) is a fail-closed
catalog with `releaseReady: false`, no source location and no checksum. Local
Homebrew binaries, `PATH` lookup and `plugin/python/.venv` remain development
conveniences and cannot satisfy a production release.

## Release contract

A reviewed runtime payload is materialized below:

```text
plugin/runtime-packs/<component>/<architecture>/...
```

The catalog must contain both `arm64` and `x64` targets for every component. A
target inventories its exact regular-file tree in canonical path order. Every
entry records its byte size, lowercase SHA-256, whether it is Mach-O data and
whether it is executable. The fixed executable contracts are:

- `ffmpeg`: `ffmpeg`, `ffprobe`;
- `librosa-python`: `python3`;
- `whispercpp`: `whisper-cli`.

Required executables must be real Mach-O files rather than links or shell
wrappers. Every Mach-O file must support the declared architecture and pass
strict code-signature validation with a non-ad-hoc authority. The whole payload
must fit the updater's signed manifest limits.

Each component also carries reviewed SPDX package metadata. A single written
approval record under `docs/release-approvals/` must identify the exact source,
version/build recipe, signing provenance, licenses/notices and redistribution
decision for every component. FFmpeg approval must cover the exact configured
codec/library set; CPython/librosa approval must cover all bundled transitive
packages and native libraries; whisper.cpp and separately downloaded model
weights need their own applicable-terms review.

## Validation sequence

1. Obtain or build the approved payload outside this repository. Do not infer a
   URL, version, checksum or license.
2. Code-sign every Mach-O file as required and verify the signatures before it
   enters the plugin tree.
3. Generate the exact catalog inventory from those immutable bytes, record the
   approval evidence and only then set `releaseReady` to `true`.
4. Materialize both architecture trees before `npm run plugin:assemble`.
5. Run `npm run release:validate-runtimes`. It re-hashes every file, rejects
   links/special or extra files, checks architecture/signatures and proves that
   `plugin/update-manifest.json` authenticates the identical tree.
6. Generate the release SPDX document. It adds all six component/architecture
   packages as explicit dependencies of EasyField.
7. Exercise local inference, media probing, conversion, capture and animation
   export in the packaged Resolve host on an Intel Mac and an Apple-silicon Mac.

Both production artifact builders invoke the same validator directly. The only
alternate mode is the tightly bounded, non-tag GitHub CI structure build, which
requires an empty catalog and emits visibly non-distributable artifacts. The
production updater never accepts CI-only archive naming.

At launch, Main resolves the runtime executable paths from the signed catalog
and verifies their pinned size/hash/mode. Once a catalog is release-ready, any
missing or changed packaged executable fails closed; EasyField will not fall
back to Homebrew or a global executable.
