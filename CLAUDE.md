# Project guidance

## Filesystem access

Never stat or test a path and then act on that path again. Open it once and
work through that one file descriptor: inspect it with `fstatSync`, then read,
write, truncate, or change metadata through the descriptor. Handle `ENOENT`
from `openSync` instead of checking existence first.

Use these as the canonical implementations:

- `scripts/release-account-config.mjs`: `validateReleaseAccountConfigFile` for
  a validated read.
- `scripts/install-git-hooks.mjs`: `readRegularFile` for reads and the
  installation loop for descriptor-based `fchmodSync` and `writeSync`.

Use `O_NOFOLLOW` when the path must not be a symlink, such as a
security-sensitive release input. Omit it only when following symlinks is
deliberate existing behavior, as it is for git-hook installation; the
single-descriptor rule still applies.
