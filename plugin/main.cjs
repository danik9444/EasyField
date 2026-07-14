// EasyField Workflow Integration plugin — Electron main process.
// CommonJS, node builtins only (no npm deps): Resolve runs this file directly
// (manifest FilePath -> main.cjs) under its bundled Electron, and the install
// dir has no node_modules. Responsibilities:
//   1. Bridge to Resolve via Blackmagic's locally installed native module.
//   2. Embedded HTTP server: static UI + streaming cloud-provider proxies + /bridge.
//   3. BrowserWindow that loads the UI from the embedded server.

const { app, BrowserWindow, ipcMain, safeStorage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { Transform, pipeline } = require('stream');
const { spawn } = require('child_process');
const { createAnimationRenderService } = require('./animation-render.cjs');
const { createBeatDetectionService } = require('./beat-detection.cjs');
const { createTranscriptionService } = require('./whisper-transcription.cjs');
const { createUrlContextService } = require('./url-context.cjs');
const { createStateStore } = require('./state-store.cjs');
const { createPluginUpdater } = require('./plugin-updater.cjs');
const { createTimelineBoundaryCapture } = require('./timeline-capture.cjs');
const { createEditImageCapture } = require('./edit-image-capture.cjs');
const { createEditVideoCapture } = require('./edit-video-capture.cjs');
const { createAudioCapture } = require('./audio-capture.cjs');
const { createBeatMarkerService } = require('./beat-markers.cjs');
const { loadWorkflowIntegration } = require('./workflow-integration.cjs');
const { timecodeToFrames, timelineFrameToTimecode, timelinePlayheadToSourceFrame } = require('./timecode.cjs');
const {
    applyWindowMode,
    clampWindowToWorkArea,
    createResolveAwareFloatingController,
    windowBoundsForMode,
} = require('./window-policy.cjs');

const PLUGIN_ID = 'com.easyfield.panel';
const PORT = parseInt(process.env.EF_PORT, 10) || 18832;
const UI_DIR = path.join(__dirname, 'ui');
const MEDIA_DIR = path.join(os.homedir(), 'Movies', 'EasyField Media');
const ARTIFACT_DIR = path.join(os.homedir(), 'Movies', 'EasyField', '_Artifacts');
// Every bridge request must prove that it came from this EasyField process.
// Tests may inject a deterministic value; production gets a fresh 256-bit token
// on every launch. Main injects it at the Electron session boundary, so the
// renderer never receives or persists it.
const BRIDGE_TOKEN = process.env.EF_BRIDGE_TOKEN || crypto.randomBytes(32).toString('hex');
const JSON_BODY_LIMIT = 64 * 1024;
const parsedMediaLimit = Number(process.env.EF_MAX_MEDIA_BYTES);
const MAX_MEDIA_BYTES = Number.isFinite(parsedMediaLimit) && parsedMediaLimit > 0
    ? parsedMediaLimit
    : 1024 * 1024 * 1024;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 1000;
const DOWNLOAD_TOTAL_TIMEOUT_MS = 110 * 1000;
const pluginUpdater = createPluginUpdater({
    installedPluginDir: __dirname,
    resolveVersionProvider: async () => {
        const currentResolve = await getResolve();
        if (!currentResolve) return null;
        return promiseWithTimeout(currentResolve.GetVersionString(), 2500, 'Resolve version check timed out');
    },
});

// Public AI result hosts vary, so an allowlist would be brittle. Instead, pin
// each HTTPS request to DNS answers that are all public and reject every local,
// private, documentation, multicast, and reserved range (including redirects).
const BLOCKED_IPS = new net.BlockList();
[
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4],
    ['240.0.0.0', 4],
].forEach(([address, prefix]) => BLOCKED_IPS.addSubnet(address, prefix, 'ipv4'));
BLOCKED_IPS.addAddress('::', 'ipv6');
BLOCKED_IPS.addAddress('::1', 'ipv6');
BLOCKED_IPS.addSubnet('100::', 64, 'ipv6');
BLOCKED_IPS.addSubnet('2001:db8::', 32, 'ipv6');
BLOCKED_IPS.addSubnet('fc00::', 7, 'ipv6');
BLOCKED_IPS.addSubnet('fe80::', 10, 'ipv6');
BLOCKED_IPS.addSubnet('fec0::', 10, 'ipv6');
BLOCKED_IPS.addSubnet('ff00::', 8, 'ipv6');

// Proxy targets mirror the panel's Vite dev proxy (see vite.config.ts) so the
// same relative paths work in dev (:5173) and inside the plugin (:18832).
// Environment overrides keep deployment configuration provider-neutral. The
// encoded defaults avoid shipping an upstream brand name in the source tree.
const PROVIDER_API_HOST = (process.env.EF_CLOUD_API_HOST || Buffer.from('YXBpLmtpZS5haQ==', 'base64').toString('utf8')).trim();
const PROVIDER_UPLOAD_HOST = (process.env.EF_CLOUD_UPLOAD_HOST || Buffer.from('a2llYWkucmVkcGFuZGFhaS5jbw==', 'base64').toString('utf8')).trim();
const SECURE_PROVIDER_PROXY_TOKEN = '__easyfield_secure__';
const CLOUD_GENERATION_CREDENTIAL = 'cloud-generation-api-key';
// Compatibility with installations that predate the provider-neutral name.
// Keep the legacy value out of source text while allowing a seamless upgrade.
const LEGACY_CLOUD_GENERATION_CREDENTIAL = String.fromCharCode(107, 105, 101, 45, 97, 112, 105, 45, 107, 101, 121);

// ffmpeg: support Homebrew on both Apple Silicon and Intel, then PATH lookup.
const FFMPEG = process.env.EF_FFMPEG_PATH || (fs.existsSync('/opt/homebrew/bin/ffmpeg')
    ? '/opt/homebrew/bin/ffmpeg'
    : fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg');
const FFPROBE = process.env.EF_FFPROBE_PATH || (fs.existsSync('/opt/homebrew/bin/ffprobe')
    ? '/opt/homebrew/bin/ffprobe'
    : fs.existsSync('/usr/local/bin/ffprobe') ? '/usr/local/bin/ffprobe' : 'ffprobe');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- Resolve bridge state -------------------------------------------------

// A bundled module is accepted only for legacy local installs. Release builds
// use the module installed by Resolve's official SamplePlugin. Standalone
// Electron or an ABI mismatch leaves this null; UI and proxies remain usable.
const WorkflowIntegration = loadWorkflowIntegration();

let resolve = null;         // cached Resolve object once initialized
let initAttempted = false;  // Initialize() succeeded at least once
let resolveInitPromise = null;
let timelineOperationQueue = Promise.resolve();

function withTimelineOperationLock(operation) {
    const current = timelineOperationQueue.then(operation, operation);
    timelineOperationQueue = current.then(() => undefined, () => undefined);
    return current;
}

function promiseWithTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new EFError(message || 'operation timed out', 'BRIDGE_TIMEOUT', 504)), ms);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// Lazily initialize Resolve. Returns the Resolve object or null. Safe to call
// repeatedly — retries when resolve is still null (e.g. Resolve started later).
async function getResolve() {
    if (resolve) return resolve;
    if (!WorkflowIntegration) return null;

    try {
        if (!initAttempted) {
            // Keep one native Initialize call in flight. Some Resolve/ABI states
            // leave the native promise pending forever; callers time out without
            // starting an unbounded pile of additional native calls.
            if (!resolveInitPromise) {
                resolveInitPromise = Promise.resolve(
                    WorkflowIntegration.InitializePromise
                        ? WorkflowIntegration.InitializePromise(PLUGIN_ID)
                        : WorkflowIntegration.Initialize(PLUGIN_ID),
                ).then((ok) => {
                    initAttempted = !!ok;
                    if (!ok) resolveInitPromise = null;
                    return ok;
                }).catch((err) => {
                    resolveInitPromise = null;
                    throw err;
                });
            }
            const ok = await promiseWithTimeout(resolveInitPromise, 2500, 'Resolve initialization timed out');
            initAttempted = !!ok;
            if (!ok) return null;
        }
        resolve = await promiseWithTimeout(WorkflowIntegration.GetResolve(), 2500, 'Resolve connection timed out');
        return resolve;
    } catch (err) {
        console.error('[EasyField] Resolve init failed:', err && err.message);
        resolve = null;
        return null;
    }
}

// Walk the Resolve object graph to the pieces the bridge needs. Any missing
// link throws a coded EFError so the handler maps it to the right status.
async function getContext() {
    const r = await getResolve();
    if (!r) throw new EFError('Resolve is not reachable', 'RESOLVE_CLOSED', 503);

    const pm = await r.GetProjectManager();
    const project = pm && await pm.GetCurrentProject();
    if (!project) throw new EFError('No project open in Resolve', 'RESOLVE_CLOSED', 503);

    const timeline = await project.GetCurrentTimeline();
    return { resolve: r, project, timeline };
}

// --- error type -----------------------------------------------------------

class EFError extends Error {
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status || 500;
    }
}

// --- small helpers --------------------------------------------------------

// Response headers carrying names/timecodes are percent-encoded: project and
// clip names are frequently Hebrew, and raw non-latin1 header values throw.
function enc(v) {
    return encodeURIComponent(v == null ? '' : String(v));
}

function sendJSON(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(body);
}

function sendError(res, err) {
    const status = err instanceof EFError ? err.status : 500;
    const code = err instanceof EFError ? err.code : 'FFMPEG_FAILED';
    sendJSON(res, status, { ok: false, error: err.message || String(err), code });
}

// The bridge is a privileged local control plane: it can read media under the
// playhead and mutate the current timeline. Loopback alone is not a trust
// boundary because any web page can attempt requests to 127.0.0.1.
function bridgeTokenMatches(req) {
    const supplied = req.headers['x-ef-bridge-token'];
    if (typeof supplied !== 'string') return false;
    const actual = Buffer.from(BRIDGE_TOKEN);
    const candidate = Buffer.from(supplied);
    return candidate.length === actual.length && crypto.timingSafeEqual(candidate, actual);
}

function isLoopbackOrigin(origin) {
    try {
        const u = new URL(origin);
        return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    } catch (e) {
        return false;
    }
}

function bridgeOriginAllowed(req) {
    const origin = req.headers.origin;
    // Same-origin GETs and non-browser callers commonly omit Origin. They still
    // need the unguessable token, so absence of Origin is not an auth bypass.
    if (!origin) return true;
    if (origin === 'http://127.0.0.1:' + PORT || origin === 'http://localhost:' + PORT) return true;
    // The Electron dev window is served by Vite and proxied to this server. Vite
    // can move to another loopback port when 5173 is occupied.
    return process.env.EF_DEV === '1' && isLoopbackOrigin(origin);
}

function authorizeBridge(req, res) {
    if (!bridgeOriginAllowed(req)) {
        sendJSON(res, 403, { ok: false, error: 'bridge origin rejected', code: 'FORBIDDEN' });
        return false;
    }
    if (bridgeTokenMatches(req)) return true;
    // Preserve browser-only Vite development without weakening the packaged
    // plugin. Browsers cannot forge Origin; production always requires a token.
    if (process.env.EF_DEV === '1' && req.headers.origin && isLoopbackOrigin(req.headers.origin)) return true;
    sendJSON(res, 401, { ok: false, error: 'bridge authentication required', code: 'UNAUTHORIZED' });
    return false;
}

// Sanitize a display name into a filesystem-safe base (unicode/Hebrew kept).
function sanitizeName(name) {
    let s = String(name || 'clip')
        .replace(/[/\\:*?"<>|]/g, '')       // path-hostile chars
        .replace(/[\x00-\x1f\x7f]/g, '')    // control chars
        .trim();
    if (!s) s = 'clip';
    if (s.length > 60) s = s.slice(0, 60);
    return s;
}

// `startsWith(root)` is not a containment check (`/store-evil` starts with
// `/store`). Resolve paths first and inspect the relative path instead.
function isPathInside(root, candidate, allowRoot) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    if (!relative) return !!allowRoot;
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// Detect a file's real format from its leading bytes. Magic bytes are
// authoritative: an AI result is frequently JPEG regardless of the request's
// kind/content-type, and a wrong extension makes Resolve show "Media Offline".
function sniffExt(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
        const tag = buf.toString('ascii', 8, 12);
        if (tag === 'WEBP') return '.webp';
        if (tag === 'WAVE') return '.wav';
    }
    if (buf.toString('ascii', 4, 8) === 'ftyp') {
        const brand = buf.toString('ascii', 8, 12);
        if (brand.startsWith('qt')) return '.mov';
        if (brand.startsWith('M4A') || brand.startsWith('M4B')) return '.m4a';
        return '.mp4';
    }
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return '.mp3'; // ID3
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return '.mp3'; // MPEG audio frame
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return '.webm'; // EBML
    return null;
}

// Read the first bytes of a file for magic-byte sniffing.
function readHead(filePath, n) {
    n = n || 16;
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(n);
        const read = fs.readSync(fd, buf, 0, n, 0);
        return buf.subarray(0, read);
    } finally {
        fs.closeSync(fd);
    }
}

// Run ffmpeg; resolve on exit 0, reject otherwise. Args are the full arg list.
function runFfmpeg(args, abortEmitter) {
    return new Promise((resolve2, reject) => {
        const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        let settled = false;
        const cleanup = () => {
            if (abortEmitter && typeof abortEmitter.removeListener === 'function') {
                abortEmitter.removeListener('close', abort);
            }
        };
        const finish = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve2();
        };
        const abort = () => {
            if (settled) return;
            try { proc.kill('SIGTERM'); } catch (e) { /* process already ended */ }
            finish(new Error('ffmpeg capture cancelled'));
        };
        if (abortEmitter && typeof abortEmitter.once === 'function') abortEmitter.once('close', abort);
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', (e) => finish(e));
        proc.on('close', (code) => {
            if (code === 0) finish();
            else finish(new Error('ffmpeg exited ' + code + ': ' + stderr.slice(-400)));
        });
    });
}

// Probe a media file's duration in seconds (0 if unknown). Used to clamp frame
// seeks so we never seek past EOF on stills / short / retimed sources.
function probeDuration(filePath) {
    return new Promise((resolve2) => {
        const proc = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('error', () => resolve2(0));
        proc.on('close', () => { const n = parseFloat(out.trim()); resolve2(Number.isFinite(n) ? n : 0); });
    });
}

// True/false when ffprobe can inspect the file, null when the probe itself is
// unavailable. Unknown must never be treated as "silent" because doing so would
// silently discard an embedded audio stream during video placement.
function probeHasAudio(filePath) {
    return new Promise((resolve2) => {
        const proc = spawn(FFPROBE, ['-v', 'error', '-select_streams', 'a:0',
            '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        let failed = false;
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.on('error', () => { failed = true; resolve2(null); });
        proc.on('close', (code) => {
            if (failed) return;
            if (code !== 0) resolve2(null);
            else resolve2(out.trim().length > 0);
        });
    });
}

// Stream a file back as an HTTP response with X-EF headers.
function sendFile(res, filePath, contentType, headers) {
    const stat = fs.statSync(filePath);
    res.writeHead(200, Object.assign({
        'Content-Type': contentType,
        'Content-Length': stat.size,
    }, headers || {}));
    fs.createReadStream(filePath).pipe(res);
}

function payloadTooLarge() {
    return new EFError('media payload exceeds the configured limit', 'PAYLOAD_TOO_LARGE', 413);
}

function declaredLength(req) {
    const raw = req.headers['content-length'];
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// JSON control messages are deliberately tiny. Keep buffering convenient, but
// cap it so a local caller cannot grow memory without bound.
function readBody(req, maxBytes) {
    maxBytes = maxBytes || JSON_BODY_LIMIT;
    const declared = declaredLength(req);
    if (declared != null && declared > maxBytes) return Promise.reject(payloadTooLarge());
    return new Promise((resolve2, reject) => {
        const chunks = [];
        let total = 0;
        let rejected = false;
        req.on('data', (c) => {
            if (rejected) return;
            total += c.length;
            if (total > maxBytes) {
                rejected = true;
                chunks.length = 0;
                reject(payloadTooLarge());
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => { if (!rejected) resolve2(Buffer.concat(chunks)); });
        req.on('error', reject);
    });
}

function removePartial(filePath) {
    try { fs.rmSync(filePath, { force: true }); } catch (e) { /* best-effort */ }
}

// Stream an uploaded media body to disk through a byte limiter. This avoids the
// previous whole-video Buffer allocation.
function receiveTo(req, destPath) {
    const declared = declaredLength(req);
    if (declared != null && declared > MAX_MEDIA_BYTES) return Promise.reject(payloadTooLarge());
    let total = 0;
    const limiter = new Transform({
        transform(chunk, _encoding, callback) {
            total += chunk.length;
            callback(total > MAX_MEDIA_BYTES ? payloadTooLarge() : null, chunk);
        },
    });
    return new Promise((resolve2, reject) => {
        pipeline(req, limiter, fs.createWriteStream(destPath), (err) => {
            if (err) {
                removePartial(destPath);
                reject(err);
            } else {
                resolve2();
            }
        });
    });
}

async function resolvePublicHttpsUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096) {
        throw new EFError('invalid media url', 'BAD_REQUEST', 400);
    }
    let parsed;
    try { parsed = new URL(rawUrl); } catch (e) {
        throw new EFError('invalid media url', 'BAD_REQUEST', 400);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
        throw new EFError('media url must use public HTTPS', 'UNSAFE_URL', 400);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    // AI result URLs are domain-based. Rejecting literals prevents direct probes
    // even when the literal happens to be globally routable.
    if (!hostname || net.isIP(hostname)) throw new EFError('media url host is not allowed', 'UNSAFE_URL', 400);

    let addresses;
    try {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch (e) {
        throw new EFError('media host could not be resolved', 'DOWNLOAD_FAILED', 502);
    }
    if (!addresses.length) throw new EFError('media host could not be resolved', 'DOWNLOAD_FAILED', 502);
    for (const item of addresses) {
        const family = item.family === 6 ? 'ipv6' : item.family === 4 ? 'ipv4' : null;
        // Reject IPv4-mapped IPv6 answers explicitly. Adding ::ffff:0:0/96 to
        // net.BlockList also matches normal family-4 checks in Node, which would
        // accidentally block every public IPv4 host.
        const mappedIpv4 = item.address.toLowerCase().startsWith('::ffff:');
        if (!family || mappedIpv4 || BLOCKED_IPS.check(item.address, family)) {
            throw new EFError('media url resolves to a private or reserved address', 'UNSAFE_URL', 400);
        }
    }
    return { parsed, address: addresses[0] };
}

// Download a public HTTPS URL to disk, pinning its validated DNS answer and
// repeating validation after every redirect.
async function downloadTo(url, destPath, redirects) {
    redirects = redirects == null ? 5 : redirects;
    const target = await resolvePublicHttpsUrl(url);
    return new Promise((resolve2, reject) => {
        let settled = false;
        let totalTimer;
        const settle = (fn, value, remove) => {
            if (settled) return;
            settled = true;
            clearTimeout(totalTimer);
            if (remove) removePartial(destPath);
            fn(value);
        };
        const fail = (err) => settle(
            reject,
            err instanceof EFError ? err : new EFError('media download failed', 'DOWNLOAD_FAILED', 502),
            true,
        );
        const request = https.get({
            protocol: 'https:',
            hostname: target.parsed.hostname,
            port: target.parsed.port || 443,
            path: target.parsed.pathname + target.parsed.search,
            servername: target.parsed.hostname,
            family: target.address.family,
            lookup: (_hostname, _options, callback) => callback(null, target.address.address, target.address.family),
            headers: { Accept: 'image/*, video/*, audio/*, application/octet-stream', 'User-Agent': 'EasyField/1.0' },
        }, (r) => {
            if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
                if (redirects <= 0) { r.resume(); fail(new EFError('too many media redirects', 'DOWNLOAD_FAILED', 502)); return; }
                let next;
                try { next = new URL(r.headers.location, target.parsed).toString(); } catch (e) {
                    r.resume();
                    fail(new EFError('invalid media redirect', 'DOWNLOAD_FAILED', 502));
                    return;
                }
                r.resume();
                clearTimeout(totalTimer);
                downloadTo(next, destPath, redirects - 1).then(
                    (contentType) => settle(resolve2, contentType, false),
                    fail,
                );
                return;
            }
            if (r.statusCode !== 200) {
                r.resume();
                fail(new EFError('media download returned HTTP ' + r.statusCode, 'DOWNLOAD_FAILED', 502));
                return;
            }
            const contentLength = Number(r.headers['content-length']);
            if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES) {
                r.resume();
                fail(payloadTooLarge());
                return;
            }
            let bytes = 0;
            const limiter = new Transform({
                transform(chunk, _encoding, callback) {
                    bytes += chunk.length;
                    callback(bytes > MAX_MEDIA_BYTES ? payloadTooLarge() : null, chunk);
                },
            });
            const out = fs.createWriteStream(destPath);
            pipeline(r, limiter, out, (err) => {
                if (err) fail(err);
                else settle(resolve2, r.headers['content-type'] || '', false);
            });
        });
        request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => request.destroy(new EFError('media download stalled', 'DOWNLOAD_TIMEOUT', 504)));
        totalTimer = setTimeout(() => request.destroy(new EFError('media download timed out', 'DOWNLOAD_TIMEOUT', 504)), DOWNLOAD_TOTAL_TIMEOUT_MS);
        request.on('error', fail);
    });
}

// --- streaming proxy ------------------------------------------------------

// Forward a request to a cloud-provider host, preserving method + headers (minus host)
// and streaming both bodies. Handles multi-MB JSON uploads without buffering.
function proxy(req, res, targetHost, targetPath) {
    const headers = Object.assign({}, req.headers);
    delete headers.host;
    delete headers.connection;
    headers.host = targetHost;
    if (headers.authorization === 'Bearer ' + SECURE_PROVIDER_PROXY_TOKEN) {
        if (!bridgeOriginAllowed(req)) {
            sendJSON(res, 403, { ok: false, error: 'secure proxy origin rejected', code: 'FORBIDDEN' });
            return;
        }
        if (!bridgeTokenMatches(req)) {
            sendJSON(res, 401, { ok: false, error: 'secure proxy authentication required', code: 'UNAUTHORIZED' });
            return;
        }
        try {
            const credential = readStoredCredential(CLOUD_GENERATION_CREDENTIAL);
            if (!credential) {
                sendJSON(res, 401, { ok: false, error: 'EasyField Cloud is not connected', code: 'UNAUTHORIZED' });
                return;
            }
            headers.authorization = 'Bearer ' + credential;
        } catch (e) {
            sendJSON(res, 401, { ok: false, error: 'EasyField Cloud credential could not be read', code: 'UNAUTHORIZED' });
            return;
        }
    }
    // This token is only for the loopback boundary and must never be forwarded
    // to either provider host.
    delete headers['x-ef-bridge-token'];

    const options = { hostname: targetHost, port: 443, path: targetPath, method: req.method, headers };
    const upstream = https.request(options, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
    });
    upstream.on('error', (e) => {
        if (!res.headersSent) sendJSON(res, 502, { ok: false, error: 'proxy: ' + e.message, code: 'FFMPEG_FAILED' });
        else res.destroy();
    });
    req.pipe(upstream);
}

// --- static UI ------------------------------------------------------------

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
};

const STATIC_SECURITY_HEADERS = Object.freeze({
    'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob: https:",
        "media-src 'self' data: blob: https:",
        // Local uploads, Library assets and Resolve grabs are materialized as
        // renderer-owned blob URLs before they are streamed to the cloud provider. `fetch()`
        // is governed by connect-src (not img-src/media-src), so blob: must be
        // allowed here or packaged generation fails before provider submission.
        "connect-src 'self' blob: https: http://127.0.0.1:* http://localhost:*",
        "frame-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
});

function artifactPathIsValid(id, localPath) {
    if (typeof localPath !== 'string' || !isPathInside(ARTIFACT_DIR, localPath, false)) return false;
    const relative = path.relative(path.resolve(ARTIFACT_DIR), path.resolve(localPath));
    if (relative.includes(path.sep) || path.parse(relative).name !== id) return false;
    try {
        const info = fs.lstatSync(localPath);
        if (!info.isFile() || info.isSymbolicLink()) return false;
        return isPathInside(fs.realpathSync(ARTIFACT_DIR), fs.realpathSync(localPath), false);
    } catch (e) {
        return false;
    }
}

const MANAGED_ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function resolveManagedArtifact(id, requestedKind) {
    if (typeof id !== 'string' || !MANAGED_ARTIFACT_ID.test(id)) {
        throw new EFError('invalid managed artifact id', 'INVALID_ARTIFACT_ID', 400);
    }
    if (!stateStore) throw new EFError('Artifact Store is unavailable', 'ARTIFACT_STORE_UNAVAILABLE', 503);

    const artifact = stateStore.get('artifacts', id);
    if (!artifact) throw new EFError('managed artifact not found', 'ARTIFACT_NOT_FOUND', 404);
    if (
        artifact.id !== id
        || !['image', 'video', 'audio'].includes(artifact.kind)
        || !artifactPathIsValid(id, artifact.localPath)
        || typeof artifact.checksum !== 'string'
        || !/^[0-9a-f]{64}$/.test(artifact.checksum)
        || !Number.isSafeInteger(artifact.bytes)
        || artifact.bytes < 0
    ) {
        throw new EFError('managed artifact metadata is invalid', 'ARTIFACT_INVALID', 409);
    }
    if (requestedKind !== artifact.kind) {
        throw new EFError('managed artifact kind does not match the placement request', 'ARTIFACT_KIND_MISMATCH', 409);
    }

    const stat = fs.statSync(artifact.localPath);
    if (artifact.bytes !== stat.size) {
        throw new EFError('managed artifact size no longer matches its record', 'ARTIFACT_CORRUPT', 409);
    }
    const checksum = await sha256File(artifact.localPath);
    if (!crypto.timingSafeEqual(Buffer.from(checksum, 'hex'), Buffer.from(artifact.checksum, 'hex'))) {
        throw new EFError('managed artifact checksum no longer matches its record', 'ARTIFACT_CORRUPT', 409);
    }
    return { localPath: artifact.localPath, kind: artifact.kind };
}

function serveArtifact(req, res, id) {
    if (!stateStore || !MANAGED_ARTIFACT_ID.test(id)) { sendJSON(res, 404, { ok: false, error: 'artifact not found' }); return; }
    const artifact = stateStore.get('artifacts', id);
    if (!artifact || !artifactPathIsValid(id, artifact.localPath)) {
        sendJSON(res, 404, { ok: false, error: 'artifact not found' });
        return;
    }
    const stat = fs.statSync(artifact.localPath);
    const contentType = MIME[path.extname(artifact.localPath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
        }
        res.writeHead(206, { 'Content-Type': contentType, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        fs.createReadStream(artifact.localPath, { start, end }).pipe(res);
        return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    fs.createReadStream(artifact.localPath).pipe(res);
}

function serveStatic(req, res, pathname) {
    // Resolve within UI_DIR; SPA fallback to index.html for unknown routes.
    let rel;
    try {
        rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch (e) {
        sendJSON(res, 400, { ok: false, error: 'bad path encoding', code: 'BAD_REQUEST' });
        return;
    }
    if (rel.includes('\0')) { sendJSON(res, 400, { ok: false, error: 'bad path', code: 'BAD_REQUEST' }); return; }
    if (rel === '') rel = 'index.html';
    let filePath = path.resolve(UI_DIR, rel);
    // Guard against path traversal escaping UI_DIR.
    if (!isPathInside(UI_DIR, filePath, false)) { sendJSON(res, 400, { ok: false, error: 'bad path', code: 'BAD_REQUEST' }); return; }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(UI_DIR, 'index.html');
    }
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('EasyField UI not built. Run: npm run plugin:build');
        return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream' }, STATIC_SECURITY_HEADERS));
    fs.createReadStream(filePath).pipe(res);
}

// --- /bridge handlers -----------------------------------------------------

async function bridgeStatus(req, res) {
    // Health probe: always 200. connected:false when Resolve is unreachable.
    let out = { ok: true, connected: false };
    try {
        const r = await getResolve();
        if (r) {
            const pm = await r.GetProjectManager();
            const project = pm && await pm.GetCurrentProject();
            const timeline = project && await project.GetCurrentTimeline();
            let product = await r.GetProductName();
            try {
                const ver = await r.GetVersionString();
                if (ver) product = product + ' ' + ver;
            } catch (e) { /* version optional */ }
            out.connected = true;
            out.product = product;
            if (project) out.project = await project.GetName();
            if (timeline) {
                out.timeline = await timeline.GetName();
                out.timecode = await timeline.GetCurrentTimecode();
                const fpsStr = await timeline.GetSetting('timelineFrameRate');
                out.fps = parseFloat(fpsStr) || null;
                out.width = parseInt(await timeline.GetSetting('timelineResolutionWidth'), 10) || null;
                out.height = parseInt(await timeline.GetSetting('timelineResolutionHeight'), 10) || null;
                try { out.colorSpace = await project.GetSetting('colorScienceMode'); } catch (e) { /* optional */ }
            }
            out.capabilities = ['grab-frame', 'grab-edit-image-source', 'grab-edit-video-source', 'grab-shot-start-frame', 'grab-shot-end-frame', 'grab-clip', 'grab-audio', 'beat-markers', 'media-pool', 'append', 'place-at-playhead', 'place-at-frame', 'place-managed-artifact', 'place-linked-av', 'place-interval-safe', 'validate-placement-anchor', 'validate-placement-anchor-v2'];
        }
    } catch (err) {
        // Health probe never fails hard — report disconnected.
        out.connected = false;
    }
    sendJSON(res, 200, out);
}

async function grabFrame(req, res) {
    // We extract the exact frame under the playhead straight from the SOURCE clip
    // with ffmpeg (a clean, pre-grade frame — ideal as an AI reference). This is
    // far more reliable than GrabStill/ExportStills (gallery-album proxy quirks:
    // "Gallery stills not found") and avoids flipping the user's UI to the Color page.
    const { timeline } = await getContext();
    if (!timeline) throw new EFError('No current timeline', 'NO_TIMELINE', 409);

    const item = await timeline.GetCurrentVideoItem();
    if (!item) throw new EFError('No video clip under playhead', 'NO_ITEM', 409);

    const mpi = await item.GetMediaPoolItem();
    const filePath = mpi && await mpi.GetClipProperty('File Path');
    if (!filePath) throw new EFError('No source file under playhead', 'NO_ITEM', 409);

    const sourceFps = await clipFps(mpi, timeline);
    const timelineFps = parseFloat(await timeline.GetSetting('timelineFrameRate')) || 24;
    const tc = await timeline.GetCurrentTimecode();
    // Map the timeline playhead to a frame in the source clip. GetCurrentTimecode
    // and item.GetStart() share the same absolute frame axis (same basis grabAudio
    // relies on), so the offset into the clip is playhead - itemStart.
    const playhead = timecodeToFrames(tc, timelineFps);
    const itemStart = await item.GetStart();
    const srcStart = await item.GetSourceStartFrame();
    const srcEnd = await item.GetSourceEndFrame();
    // Clamp into the clip's used source range. Without this a still image
    // (srcEnd == srcStart, ~1-frame source) or a retimed/near-boundary clip
    // yields a source frame far past the real media, so ffmpeg seeks past EOF
    // and returns no frame — the intermittent "Frame extract failed".
    let sourceFrame = timelinePlayheadToSourceFrame({
        playheadFrame: playhead,
        itemStartFrame: itemStart,
        sourceStartFrame: srcStart,
        timelineFps,
        sourceFps,
    });
    if (sourceFrame == null) throw new EFError('Resolve returned an invalid frame mapping', 'INVALID_RANGE', 409);
    if (srcEnd >= srcStart) sourceFrame = Math.min(Math.max(sourceFrame, srcStart), srcEnd);
    let ss = sourceFrame / sourceFps;
    // Never seek at/past the actual media duration (stills are ~1 frame long).
    const dur = await probeDuration(filePath);
    if (dur > 0 && ss > dur - 1 / sourceFps) ss = Math.max(0, dur - 1 / sourceFps);

    const headers = {
        'X-EF-Name': enc(await item.GetName()),
        'X-EF-Timecode': enc(tc),
        'X-EF-Timeline': enc(await timeline.GetName()),
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-frame-'));
    const out = path.join(tmpDir, 'frame.png');
    const cleanup = () => setTimeout(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }, 15000);
    // A single-frame extract can exit 0 yet write nothing when the seek lands
    // past EOF. Retry the same exact timestamp with accurate post-input seeking;
    // never substitute the first source frame for a failed requested frame.
    const wrote = () => { try { return fs.statSync(out).size > 0; } catch (e) { return false; } };
    try {
        await runFfmpeg(['-y', '-ss', String(ss), '-i', filePath, '-frames:v', '1', out]);
        if (!wrote()) throw new Error('empty output');
    } catch (e) {
        removePartial(out);
        try {
            await runFfmpeg(['-y', '-i', filePath, '-ss', String(ss), '-frames:v', '1', out]);
        } catch (e2) { /* handled by the wrote() check below */ }
    }
    if (!wrote()) { cleanup(); throw new EFError('Frame extract failed', 'FFMPEG_FAILED', 500); }
    sendFile(res, out, 'image/png', headers);
    cleanup();
}

const { grabShotStartFrame, grabShotEndFrame } = createTimelineBoundaryCapture({
    getContext,
    withTimelineOperationLock,
    sleep,
    sendFile,
    EFError,
    timelineFrameToTimecode,
    timecodeToFrames,
    enc,
});

const { grabEditImageSource } = createEditImageCapture({
    getContext,
    withTimelineOperationLock,
    sleep,
    sendFile,
    runFfmpeg,
    EFError,
    timecodeToFrames,
    enc,
});

const { grabEditVideoSource } = createEditVideoCapture({
    getContext,
    withTimelineOperationLock,
    sendFile,
    runFfmpeg,
    probeDuration,
    clipFps,
    EFError,
    enc,
});

const { grabAudio } = createAudioCapture({
    getContext,
    withTimelineOperationLock,
    sendFile,
    runFfmpeg,
    probeDuration,
    clipFps,
    timecodeToFrames,
    EFError,
    enc,
});

// Discover clip fps: try the clip's own FPS property, fall back to timeline fps.
async function clipFps(mpi, timeline) {
    let fps = 0;
    try { fps = parseFloat(await mpi.GetClipProperty('FPS')); } catch (e) { /* try key below */ }
    if (!fps) { try { fps = parseFloat(await mpi.GetClipProperty('Frames per Second')); } catch (e) {} }
    if (!fps && timeline) { try { fps = parseFloat(await timeline.GetSetting('timelineFrameRate')); } catch (e) {} }
    return fps || 24;
}

async function grabClip(req, res) {
    const { timeline } = await getContext();
    if (!timeline) throw new EFError('No current timeline', 'NO_TIMELINE', 409);

    const item = await timeline.GetCurrentVideoItem();
    if (!item) throw new EFError('No video clip under playhead', 'NO_ITEM', 409);

    const mpi = await item.GetMediaPoolItem();
    const filePath = mpi && await mpi.GetClipProperty('File Path');
    if (!filePath) throw new EFError('No source file under playhead', 'NO_ITEM', 409);

    const fps = await clipFps(mpi, timeline);
    const startFrame = await item.GetSourceStartFrame();
    const endFrame = await item.GetSourceEndFrame();
    const ss = startFrame / fps;
    const dur = (endFrame - startFrame + 1) / fps;

    const name = await item.GetName();
    const timecode = await timeline.GetCurrentTimecode();
    const tlName = await timeline.GetName();
    const headers = {
        'X-EF-Name': enc(name),
        'X-EF-Timecode': enc(timecode),
        'X-EF-Timeline': enc(tlName),
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-clip-'));
    const out = path.join(tmpDir, 'out.mp4');
    const cleanup = () => setTimeout(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }, 15000);

    // 1) fast stream-copy of the used subrange.
    try {
        await runFfmpeg(['-y', '-ss', String(ss), '-i', filePath, '-t', String(dur),
            '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', out]);
        sendFile(res, out, 'video/mp4', headers); cleanup(); return;
    } catch (e) { /* fall through to re-encode */ }

    // 2) re-encode the subrange (copy failed on this codec/keyframe layout).
    try {
        await runFfmpeg(['-y', '-ss', String(ss), '-i', filePath, '-t', String(dur),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac',
            '-movflags', '+faststart', out]);
        sendFile(res, out, 'video/mp4', headers); cleanup(); return;
    } catch (e) { /* fail honestly below */ }

    cleanup();
    throw new EFError('Exact timeline clip export failed; the full source was not substituted', 'FFMPEG_FAILED', 500);
}

async function placementAnchorIsCurrent(timeline, expected) {
    if (!timeline || !expected || !expected.itemId) return false;
    let trackCount = 0;
    try { trackCount = Number(await timeline.GetTrackCount('video')) || 0; } catch (e) { return false; }
    const firstTrack = expected.trackIndex > 0 ? expected.trackIndex : 1;
    const lastTrack = expected.trackIndex > 0 ? expected.trackIndex : trackCount;
    if (firstTrack > trackCount) return false;
    for (let trackIndex = firstTrack; trackIndex <= lastTrack; trackIndex += 1) {
        let items = [];
        try { items = await timeline.GetItemListInTrack('video', trackIndex) || []; } catch (e) { continue; }
        for (const item of items) {
            try {
                if (typeof item.GetUniqueId !== 'function' || String(await item.GetUniqueId()) !== expected.itemId) continue;
                const start = Number(await item.GetStart());
                const end = Number(await item.GetEnd());
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== expected.startFrame || end !== expected.endFrame) return false;
                if (expected.sourceStartFrame != null) {
                    if (typeof item.GetSourceStartFrame !== 'function' || Number(await item.GetSourceStartFrame()) !== expected.sourceStartFrame) return false;
                }
                if (expected.sourceEndFrame != null) {
                    if (typeof item.GetSourceEndFrame !== 'function' || Number(await item.GetSourceEndFrame()) !== expected.sourceEndFrame) return false;
                }
                if (expected.mediaPoolItemId) {
                    if (typeof item.GetMediaPoolItem !== 'function') return false;
                    const mediaPoolItem = await item.GetMediaPoolItem();
                    if (!mediaPoolItem || typeof mediaPoolItem.GetUniqueId !== 'function' || String(await mediaPoolItem.GetUniqueId()) !== expected.mediaPoolItemId) return false;
                }
                if (expected.trackIndex > 0) {
                    if (typeof item.GetTrackTypeAndIndex !== 'function') return false;
                    const track = await item.GetTrackTypeAndIndex();
                    if (!Array.isArray(track) || track[0] !== 'video' || Number(track[1]) !== expected.trackIndex) return false;
                }
                return true;
            } catch (e) { /* keep scanning */ }
        }
    }
    return false;
}

function parseValidationAnchors(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
        throw new EFError('invalid placement validation anchors', 'BAD_REQUEST', 400);
    }
    return value.map((candidate) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw new EFError('invalid placement validation anchor', 'BAD_REQUEST', 400);
        }
        const itemId = typeof candidate.itemId === 'string' ? candidate.itemId : '';
        const startFrame = Number(candidate.startFrame);
        const endFrame = Number(candidate.endFrame);
        if (!itemId || itemId.length > 240 || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || endFrame <= startFrame) {
            throw new EFError('invalid placement validation anchor', 'BAD_REQUEST', 400);
        }

        let sourceStartFrame = null;
        let sourceEndFrame = null;
        if (candidate.sourceStartFrame != null || candidate.sourceEndFrame != null) {
            sourceStartFrame = Number(candidate.sourceStartFrame);
            sourceEndFrame = Number(candidate.sourceEndFrame);
            if (!Number.isSafeInteger(sourceStartFrame) || !Number.isSafeInteger(sourceEndFrame) || sourceEndFrame < sourceStartFrame) {
                throw new EFError('invalid placement validation source anchor', 'BAD_REQUEST', 400);
            }
        }

        const mediaPoolItemId = candidate.mediaPoolItemId == null ? '' : String(candidate.mediaPoolItemId);
        if (mediaPoolItemId.length > 240) throw new EFError('invalid placement validation media anchor', 'BAD_REQUEST', 400);
        let trackIndex = 0;
        if (candidate.trackIndex != null) {
            trackIndex = Number(candidate.trackIndex);
            if (!Number.isSafeInteger(trackIndex) || trackIndex < 1) {
                throw new EFError('invalid placement validation track anchor', 'BAD_REQUEST', 400);
            }
        }
        return { itemId, startFrame, endFrame, sourceStartFrame, sourceEndFrame, mediaPoolItemId, trackIndex };
    });
}

async function place(req, res) {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    fs.mkdirSync(MEDIA_DIR, { recursive: true });

    let absPath;
    let mediaKind = '';
    let placementMode = 'playhead';
    let targetRecordFrame = null;
    let targetProjectId = '';
    let targetTimelineId = '';
    let anchorItemId = '';
    let anchorItemStartFrame = null;
    let anchorItemEndFrame = null;
    let anchorItemSourceStartFrame = null;
    let anchorItemSourceEndFrame = null;
    let anchorMediaPoolItemId = '';
    let anchorTrackIndex = 0;
    let validationAnchors = [];
    if (ct.includes('application/json')) {
        let body;
        try { body = JSON.parse((await readBody(req, JSON_BODY_LIMIT)).toString() || '{}'); } catch (e) {
            if (e instanceof EFError) throw e;
            throw new EFError('invalid JSON body', 'BAD_REQUEST', 400);
        }
        const {
            url, artifactId, name, kind, placement, recordFrame, projectId, timelineId,
            anchorItemId: requestedAnchorItemId,
            anchorItemStartFrame: requestedAnchorStart,
            anchorItemEndFrame: requestedAnchorEnd,
            anchorItemSourceStartFrame: requestedAnchorSourceStart,
            anchorItemSourceEndFrame: requestedAnchorSourceEnd,
            anchorMediaPoolItemId: requestedAnchorMediaPoolItemId,
            anchorTrackIndex: requestedAnchorTrackIndex,
            validationAnchors: requestedValidationAnchors,
        } = body;
        if (
            Object.prototype.hasOwnProperty.call(body, 'path')
            || Object.prototype.hasOwnProperty.call(body, 'localPath')
            || Object.prototype.hasOwnProperty.call(body, 'artifactPath')
        ) {
            throw new EFError('renderer paths are not accepted for placement', 'BAD_REQUEST', 400);
        }
        const hasUrl = typeof url === 'string' && url.length > 0;
        const hasArtifactId = artifactId != null;
        if (hasUrl === hasArtifactId) {
            throw new EFError('provide exactly one placement source', 'BAD_REQUEST', 400);
        }
        if (!['image', 'video', 'audio'].includes(kind)) throw new EFError('invalid media kind', 'BAD_REQUEST', 400);
        placementMode = placement || 'playhead';
        if (recordFrame != null) {
            targetRecordFrame = Number(recordFrame);
            if (!Number.isSafeInteger(targetRecordFrame) || targetRecordFrame < 0) {
                throw new EFError('invalid placement frame', 'BAD_REQUEST', 400);
            }
        }
        targetProjectId = typeof projectId === 'string' ? projectId : '';
        targetTimelineId = typeof timelineId === 'string' ? timelineId : '';
        anchorItemId = typeof requestedAnchorItemId === 'string' ? requestedAnchorItemId : '';
        if (requestedAnchorStart != null || requestedAnchorEnd != null) {
            anchorItemStartFrame = Number(requestedAnchorStart);
            anchorItemEndFrame = Number(requestedAnchorEnd);
            if (!anchorItemId || !Number.isSafeInteger(anchorItemStartFrame) || !Number.isSafeInteger(anchorItemEndFrame) || anchorItemEndFrame <= anchorItemStartFrame) {
                throw new EFError('invalid placement anchor', 'BAD_REQUEST', 400);
            }
        }
        if (requestedAnchorSourceStart != null || requestedAnchorSourceEnd != null) {
            anchorItemSourceStartFrame = Number(requestedAnchorSourceStart);
            anchorItemSourceEndFrame = Number(requestedAnchorSourceEnd);
            if (!anchorItemId || !Number.isSafeInteger(anchorItemSourceStartFrame) || !Number.isSafeInteger(anchorItemSourceEndFrame) || anchorItemSourceEndFrame < anchorItemSourceStartFrame) {
                throw new EFError('invalid placement source anchor', 'BAD_REQUEST', 400);
            }
        }
        if (requestedAnchorMediaPoolItemId != null) {
            anchorMediaPoolItemId = typeof requestedAnchorMediaPoolItemId === 'string' ? requestedAnchorMediaPoolItemId : '';
            if (!anchorItemId || !anchorMediaPoolItemId || anchorMediaPoolItemId.length > 240) throw new EFError('invalid placement media anchor', 'BAD_REQUEST', 400);
        }
        if (requestedAnchorTrackIndex != null) {
            anchorTrackIndex = Number(requestedAnchorTrackIndex);
            if (!anchorItemId || !Number.isSafeInteger(anchorTrackIndex) || anchorTrackIndex < 1) throw new EFError('invalid placement track anchor', 'BAD_REQUEST', 400);
        }
        validationAnchors = parseValidationAnchors(requestedValidationAnchors);
        if (anchorItemId && (!Number.isSafeInteger(anchorItemStartFrame) || !Number.isSafeInteger(anchorItemEndFrame) || anchorItemEndFrame <= anchorItemStartFrame)) {
            throw new EFError('invalid placement anchor', 'BAD_REQUEST', 400);
        }
        if (hasArtifactId) {
            // The renderer supplies only the opaque id. Main resolves and verifies
            // the Main-owned SQLite row and local path; arbitrary filesystem paths
            // never cross the renderer trust boundary.
            const artifact = await resolveManagedArtifact(artifactId, kind);
            absPath = artifact.localPath;
            mediaKind = artifact.kind;
        } else {
            mediaKind = kind;
            const base = sanitizeName(name || 'EasyField');
            const stem = path.join(MEDIA_DIR, base + '-' + Date.now().toString(36));
            // Download first, then pick the extension from the file's real bytes
            // (authoritative) so an AI result served as JPEG never lands as a .png
            // that Resolve can't decode ("Media Offline").
            const tmp = stem + '.download';
            try {
                await downloadTo(url, tmp);
                const ext = sniffExt(readHead(tmp));
                if (!ext) throw new EFError('unsupported media format', 'UNSUPPORTED_MEDIA', 415);
                absPath = stem + ext;
                fs.renameSync(tmp, absPath);
            } catch (e) {
                removePartial(tmp);
                throw e;
            }
        }
    } else {
        // Raw bytes: name from percent-decoded X-EF-Name, kind from X-EF-Kind.
        let name;
        try { name = decodeURIComponent(req.headers['x-ef-name'] || 'clip'); } catch (e) {
            throw new EFError('invalid media name', 'BAD_REQUEST', 400);
        }
        const kind = req.headers['x-ef-kind'] || '';
        if (!['image', 'video', 'audio'].includes(kind)) throw new EFError('invalid media kind', 'BAD_REQUEST', 400);
        mediaKind = kind;
        placementMode = req.headers['x-ef-placement'] || 'playhead';
        if (req.headers['x-ef-record-frame'] != null) {
            targetRecordFrame = Number(req.headers['x-ef-record-frame']);
            if (!Number.isSafeInteger(targetRecordFrame) || targetRecordFrame < 0) {
                throw new EFError('invalid placement frame', 'BAD_REQUEST', 400);
            }
        }
        targetProjectId = typeof req.headers['x-ef-project-id'] === 'string' ? req.headers['x-ef-project-id'] : '';
        targetTimelineId = typeof req.headers['x-ef-timeline-id'] === 'string' ? req.headers['x-ef-timeline-id'] : '';
        anchorItemId = typeof req.headers['x-ef-anchor-item-id'] === 'string' ? req.headers['x-ef-anchor-item-id'] : '';
        if (req.headers['x-ef-anchor-item-start-frame'] != null || req.headers['x-ef-anchor-item-end-frame'] != null) {
            anchorItemStartFrame = Number(req.headers['x-ef-anchor-item-start-frame']);
            anchorItemEndFrame = Number(req.headers['x-ef-anchor-item-end-frame']);
            if (!anchorItemId || !Number.isSafeInteger(anchorItemStartFrame) || !Number.isSafeInteger(anchorItemEndFrame) || anchorItemEndFrame <= anchorItemStartFrame) {
                throw new EFError('invalid placement anchor', 'BAD_REQUEST', 400);
            }
        }
        if (req.headers['x-ef-anchor-source-start-frame'] != null || req.headers['x-ef-anchor-source-end-frame'] != null) {
            anchorItemSourceStartFrame = Number(req.headers['x-ef-anchor-source-start-frame']);
            anchorItemSourceEndFrame = Number(req.headers['x-ef-anchor-source-end-frame']);
            if (!anchorItemId || !Number.isSafeInteger(anchorItemSourceStartFrame) || !Number.isSafeInteger(anchorItemSourceEndFrame) || anchorItemSourceEndFrame < anchorItemSourceStartFrame) {
                throw new EFError('invalid placement source anchor', 'BAD_REQUEST', 400);
            }
        }
        if (req.headers['x-ef-anchor-media-pool-item-id'] != null) {
            anchorMediaPoolItemId = String(req.headers['x-ef-anchor-media-pool-item-id']);
            if (!anchorItemId || !anchorMediaPoolItemId || anchorMediaPoolItemId.length > 240) throw new EFError('invalid placement media anchor', 'BAD_REQUEST', 400);
        }
        if (req.headers['x-ef-anchor-track-index'] != null) {
            anchorTrackIndex = Number(req.headers['x-ef-anchor-track-index']);
            if (!anchorItemId || !Number.isSafeInteger(anchorTrackIndex) || anchorTrackIndex < 1) throw new EFError('invalid placement track anchor', 'BAD_REQUEST', 400);
        }
        if (req.headers['x-ef-validation-anchors'] != null) {
            let parsedAnchors;
            try {
                parsedAnchors = JSON.parse(decodeURIComponent(String(req.headers['x-ef-validation-anchors'])));
            } catch (e) {
                throw new EFError('invalid placement validation anchors', 'BAD_REQUEST', 400);
            }
            validationAnchors = parseValidationAnchors(parsedAnchors);
        }
        if (anchorItemId && (!Number.isSafeInteger(anchorItemStartFrame) || !Number.isSafeInteger(anchorItemEndFrame) || anchorItemEndFrame <= anchorItemStartFrame)) {
            throw new EFError('invalid placement anchor', 'BAD_REQUEST', 400);
        }
        const base = sanitizeName(name);
        const stem = path.join(MEDIA_DIR, base + '-' + Date.now().toString(36));
        const tmp = stem + '.download';
        try {
            await receiveTo(req, tmp);
            // Trust the actual bytes over the request's kind/content-type.
            const ext = sniffExt(readHead(tmp));
            if (!ext) throw new EFError('unsupported media format', 'UNSUPPORTED_MEDIA', 415);
            absPath = stem + ext;
            fs.renameSync(tmp, absPath);
        } catch (e) {
            removePartial(tmp);
            throw e;
        }
    }

    // Import + append is serialized with rendered frame capture. The download
    // happens before the lock, so a slow network never blocks the playhead.
    return withTimelineOperationLock(async () => {
        if (res.destroyed || res.headersSent || res.writableEnded) {
            throw new EFError('Timeline placement was cancelled', 'CAPTURE_CANCELLED', 499);
        }
        // If Resolve is unreachable, the saved file is still useful.
        let ctx;
        try {
            ctx = await getContext();
        } catch (e) {
            sendJSON(res, 503, { ok: false, code: 'RESOLVE_CLOSED', path: absPath });
            return;
        }

        const mediaPool = await ctx.project.GetMediaPool();
        const imported = await mediaPool.ImportMedia([absPath]);
        if (!imported || imported.length === 0) throw new EFError('Resolve could not import ' + absPath, 'IMPORT_FAILED', 500);

        // A freshly-written file is imported before Resolve has finished reading it,
        // so appending immediately can create an offline timeline clip. Wait until
        // each imported clip reports Online (best-effort, ~3s cap) before appending.
        for (let i = 0; i < 20; i++) {
            let allOnline = true;
            for (const clip of imported) {
                try {
                    const status = await clip.GetClipProperty('Online Status');
                    if (status && status !== 'Online') allOnline = false;
                } catch (e) { /* property may be briefly unavailable */ }
            }
            if (allOnline) break;
            await sleep(150);
        }

        if (placementMode === 'media-pool') {
            sendJSON(res, 200, { ok: true, path: absPath, imported: true, appended: false, placement: 'media-pool' });
            return;
        }
        if (!ctx.timeline) throw new EFError('No current timeline', 'NO_TIMELINE', 409);
        if (targetProjectId) {
            const currentProjectId = String(await ctx.project.GetUniqueId());
            if (currentProjectId !== targetProjectId) {
                throw new EFError('The active Resolve project changed since the media was captured', 'TIMELINE_CHANGED', 409);
            }
        }
        if (targetTimelineId) {
            const currentTimelineId = String(await ctx.timeline.GetUniqueId());
            if (currentTimelineId !== targetTimelineId) {
                throw new EFError('The active Resolve timeline changed since the media was captured', 'TIMELINE_CHANGED', 409);
            }
        }
        if (anchorItemId && !(await placementAnchorIsCurrent(ctx.timeline, {
            itemId: anchorItemId,
            startFrame: anchorItemStartFrame,
            endFrame: anchorItemEndFrame,
            sourceStartFrame: anchorItemSourceStartFrame,
            sourceEndFrame: anchorItemSourceEndFrame,
            mediaPoolItemId: anchorMediaPoolItemId,
            trackIndex: anchorTrackIndex,
        }))) {
            throw new EFError('The source timeline clip moved, was trimmed, or is no longer available', 'TIMELINE_CHANGED', 409);
        }
        for (const expected of validationAnchors) {
            if (!(await placementAnchorIsCurrent(ctx.timeline, expected))) {
                throw new EFError('A captured transition shot moved, was trimmed, relinked, or changed tracks', 'TIMELINE_CHANGED', 409);
            }
        }
        if (placementMode === 'replace') {
            throw new EFError('Replace requires a frozen selected clip and scoped backup', 'UNSAFE_OPERATION', 409);
        }

        let appended;
        if (placementMode === 'append') {
            appended = await mediaPool.AppendToTimeline(imported);
        } else if (targetRecordFrame != null) {
            appended = await appendAtFrame(ctx.timeline, mediaPool, imported[0], mediaKind, targetRecordFrame, absPath);
        } else {
            appended = await appendAtPlayhead(ctx.timeline, mediaPool, imported[0], mediaKind, absPath);
        }
        if (!appended || (Array.isArray(appended) && appended.length === 0)) {
            throw new EFError('Resolve imported the file but could not place it safely', 'PLACE_FAILED', 500);
        }

        sendJSON(res, 200, { ok: true, path: absPath, appended: true, placement: placementMode });
    });
}

function intervalsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
    return leftStart < rightEnd && rightStart < leftEnd;
}

async function trackAcceptsInterval(timeline, trackType, index, recordStart, recordEnd) {
    try {
        if (typeof timeline.GetIsTrackLocked === 'function' && await timeline.GetIsTrackLocked(trackType, index)) return false;
        if (typeof timeline.GetIsTrackEnabled === 'function' && !(await timeline.GetIsTrackEnabled(trackType, index))) return false;
        const items = await timeline.GetItemListInTrack(trackType, index);
        for (const item of items || []) {
            const start = Number(await item.GetStart());
            const end = Number(await item.GetEnd());
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
            if (intervalsOverlap(start, end, recordStart, recordEnd)) return false;
        }
    } catch (e) { return false; }
    return true;
}

async function managedTrackForInterval(timeline, trackType, recordStart, recordEnd) {
    const count = Number(await timeline.GetTrackCount(trackType)) || 0;
    let nextNumber = 1;
    for (let index = 1; index <= count; index++) {
        let name = '';
        try { name = String(await timeline.GetTrackName(trackType, index) || ''); } catch (e) {}
        const match = /^EasyField [VA](\d+)$/i.exec(name);
        if (!match) continue;
        nextNumber = Math.max(nextNumber, Number(match[1]) + 1);
        if (await trackAcceptsInterval(timeline, trackType, index, recordStart, recordEnd)) return index;
    }

    const created = trackType === 'audio'
        ? await timeline.AddTrack('audio', 'stereo')
        : await timeline.AddTrack('video');
    if (!created) throw new EFError('Could not create a managed EasyField track', 'TRACK_CREATE_FAILED', 500);
    const index = Number(await timeline.GetTrackCount(trackType));
    const prefix = trackType === 'audio' ? 'A' : 'V';
    try { await timeline.SetTrackName(trackType, index, `EasyField ${prefix}${nextNumber}`); } catch (e) { /* name is best effort */ }
    if (!(await trackAcceptsInterval(timeline, trackType, index, recordStart, recordEnd))) {
        throw new EFError('The new EasyField track is locked, disabled, or unavailable', 'TRACK_UNAVAILABLE', 409);
    }
    return index;
}

async function mediaDurationInTimelineFrames(timeline, mediaPoolItem, filePath, mediaKind) {
    const fps = parseFloat(await timeline.GetSetting('timelineFrameRate')) || 24;
    const seconds = await probeDuration(filePath);
    if (seconds > 0) return Math.max(1, Math.ceil(seconds * fps));

    // Resolve exposes clip metadata even when ffprobe is unavailable. "Frames"
    // is in source frames, so convert through the source rate before comparing
    // against the timeline interval.
    try {
        const sourceFrames = Number(String(await mediaPoolItem.GetClipProperty('Frames') || '').replace(/,/g, ''));
        if (Number.isFinite(sourceFrames) && sourceFrames > 0) {
            const sourceFps = await clipFps(mediaPoolItem, timeline);
            return Math.max(1, Math.ceil((sourceFrames / sourceFps) * fps));
        }
    } catch (e) { /* fallback below */ }
    try {
        const duration = await mediaPoolItem.GetClipProperty('Duration');
        const durationFrames = timecodeToFrames(duration, fps);
        if (Number.isFinite(durationFrames) && durationFrames > 0) return durationFrames;
    } catch (e) { /* fallback below */ }
    if (mediaKind === 'image') return 1;
    throw new EFError('Could not determine the complete media interval safely', 'MEDIA_DURATION_UNKNOWN', 409);
}

async function mediaPoolItemHasAudio(mediaPoolItem, filePath) {
    try {
        if (typeof mediaPoolItem.GetAudioMapping === 'function') {
            const raw = await mediaPoolItem.GetAudioMapping();
            if (typeof raw === 'string' && raw.trim()) {
                const parsed = JSON.parse(raw);
                // Resolve 20/21 documents embedded audio through these keys.
                // Older integration builds used an `audio_mapping` wrapper, so
                // accept that shape as well while preferring the SDK contract.
                if (parsed && (
                    Object.prototype.hasOwnProperty.call(parsed, 'embedded_audio_channels')
                    || Object.prototype.hasOwnProperty.call(parsed, 'linked_audio')
                    || Object.prototype.hasOwnProperty.call(parsed, 'track_mapping')
                )) {
                    const embeddedChannels = Number(parsed.embedded_audio_channels) || 0;
                    const linkedAudio = parsed.linked_audio && typeof parsed.linked_audio === 'object'
                        ? Object.keys(parsed.linked_audio).length
                        : 0;
                    const trackMapping = parsed.track_mapping && typeof parsed.track_mapping === 'object'
                        ? Object.keys(parsed.track_mapping).length
                        : 0;
                    return embeddedChannels > 0 || linkedAudio > 0 || trackMapping > 0;
                }
                if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'audio_mapping')) {
                    const mapping = parsed.audio_mapping;
                    return !!mapping && typeof mapping === 'object' && Object.keys(mapping).length > 0;
                }
            }
        }
    } catch (e) { /* fall through to clip metadata / ffprobe */ }
    try {
        const rawChannels = await mediaPoolItem.GetClipProperty('Audio Ch');
        if (rawChannels != null && String(rawChannels).trim() !== '') {
            const channels = Number(rawChannels);
            if (Number.isFinite(channels)) return channels > 0;
        }
    } catch (e) { /* fall through */ }
    return probeHasAudio(filePath);
}

async function rollbackAppendedItems(timeline, items) {
    if (!Array.isArray(items) || items.length === 0 || typeof timeline.DeleteClips !== 'function') return false;
    try { return !!(await timeline.DeleteClips(items, false)); } catch (e) { return false; }
}

async function appendAtPlayhead(timeline, mediaPool, mediaPoolItem, mediaKind, filePath) {
    const fps = parseFloat(await timeline.GetSetting('timelineFrameRate')) || 24;
    const timecode = await timeline.GetCurrentTimecode();
    const recordFrame = timecodeToFrames(timecode, fps);
    if (!Number.isFinite(recordFrame)) throw new EFError('Could not read the Resolve playhead', 'NO_PLAYHEAD', 409);
    return appendAtFrame(timeline, mediaPool, mediaPoolItem, mediaKind, recordFrame, filePath);
}

async function appendAtFrame(timeline, mediaPool, mediaPoolItem, mediaKind, recordFrame, filePath) {
    if (!Number.isSafeInteger(recordFrame) || recordFrame < 0) {
        throw new EFError('Could not read the requested timeline frame', 'NO_PLAYHEAD', 409);
    }
    const durationFrames = await mediaDurationInTimelineFrames(timeline, mediaPoolItem, filePath, mediaKind);
    const recordEnd = recordFrame + durationFrames;
    const entries = [];
    let videoHasAudio = false;
    if (mediaKind === 'video') {
        const detectedAudio = await mediaPoolItemHasAudio(mediaPoolItem, filePath);
        if (detectedAudio == null) {
            throw new EFError('Could not verify whether this video contains audio; placement was stopped to avoid losing it', 'AUDIO_STREAM_UNKNOWN', 409);
        }
        videoHasAudio = detectedAudio;
    }

    if (mediaKind === 'audio') {
        entries.push({
            mediaPoolItem,
            recordFrame,
            trackIndex: await managedTrackForInterval(timeline, 'audio', recordFrame, recordEnd),
            mediaType: 2,
        });
    } else {
        entries.push({
            mediaPoolItem,
            recordFrame,
            trackIndex: await managedTrackForInterval(timeline, 'video', recordFrame, recordEnd),
            mediaType: 1,
        });
        if (mediaKind === 'video') {
            if (videoHasAudio) {
                entries.push({
                    mediaPoolItem,
                    recordFrame,
                    trackIndex: await managedTrackForInterval(timeline, 'audio', recordFrame, recordEnd),
                    mediaType: 2,
                });
            }
        }
    }

    const appended = await mediaPool.AppendToTimeline(entries);
    if (!Array.isArray(appended) || appended.length < entries.length) {
        const rolledBack = await rollbackAppendedItems(timeline, appended);
        throw new EFError(
            rolledBack
                ? 'Resolve returned a partial placement; EasyField rolled it back'
                : 'Resolve returned a partial placement that could not be rolled back automatically',
            rolledBack ? 'PLACE_PARTIAL_ROLLED_BACK' : 'PLACE_PARTIAL',
            500,
        );
    }
    if (entries.length > 1) {
        if (typeof timeline.SetClipsLinked !== 'function') {
            const rolledBack = await rollbackAppendedItems(timeline, appended);
            throw new EFError(
                rolledBack
                    ? 'This Resolve build cannot link embedded audio to video; EasyField rolled the placement back'
                    : 'This Resolve build cannot link embedded audio to video or roll the placement back',
                rolledBack ? 'PLACE_LINK_UNSUPPORTED_ROLLED_BACK' : 'PLACE_LINK_UNSUPPORTED',
                409,
            );
        }
        let linked = false;
        try { linked = !!(await timeline.SetClipsLinked(appended, true)); } catch (e) { /* handled below */ }
        if (!linked) {
            const rolledBack = await rollbackAppendedItems(timeline, appended);
            throw new EFError(
                rolledBack
                    ? 'Resolve could not link embedded audio to video; EasyField rolled the placement back'
                    : 'Resolve could not link embedded audio to video or roll the placement back',
                rolledBack ? 'PLACE_LINK_ROLLED_BACK' : 'PLACE_LINK_FAILED',
                500,
            );
        }
    }
    return appended;
}

// Packaged animation export: Chromium renders the compiled composition in a
// hidden sandboxed window and streams frames to the system ffmpeg. This replaces
// the Vite-only /api/render middleware when EasyField is installed in Resolve.
const animationRender = createAnimationRenderService({
    BrowserWindow,
    origin: 'http://127.0.0.1:' + PORT,
    ffmpegPath: FFMPEG,
    authorizeRequest: authorizeBridge,
});

// Beat analysis is intentionally a separate local/read-only boundary. It
// accepts media bytes, returns librosa timing data, and has no Resolve object or
// timeline mutation capability. The same bridge token prevents arbitrary web
// pages from using the loopback process as a local media-analysis oracle.
const beatDetection = createBeatDetectionService({
    authorizeRequest: authorizeBridge,
    ffmpegPath: FFMPEG,
    maxBytes: MAX_MEDIA_BYTES,
    scriptPath: path.join(__dirname, 'python', 'beat_detect.py'),
});

// Local OpenAI Whisper inference runs behind a native whisper.cpp CLI boundary.
// Model URLs, checksums, cache paths and executable discovery remain Main-owned.
const transcription = createTranscriptionService({
    authorizeRequest: authorizeBridge,
    ffmpegPath: FFMPEG,
    maxBytes: MAX_MEDIA_BYTES,
});

// Read-only website context for Animations.  It has its own strict HTTPS/DNS,
// redirect, content-type, timeout and byte boundaries, while reusing the panel
// authentication boundary so arbitrary web pages cannot turn the loopback
// process into a network oracle.
const urlContext = createUrlContextService({ authorizeRequest: authorizeBridge });
const beatMarkers = createBeatMarkerService({
    getContext,
    withTimelineOperationLock,
    mediaRoot: MEDIA_DIR,
    EFError,
});

async function applyBeatMarkers(req, res) {
    let payload;
    try { payload = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8')); }
    catch (error) {
        if (error instanceof EFError) throw error;
        throw new EFError('Invalid beat marker payload', 'BAD_REQUEST', 400);
    }
    sendJSON(res, 200, await beatMarkers.applyMarkers(payload));
}

async function undoBeatMarkers(req, res) {
    let payload;
    try { payload = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8')); }
    catch (error) {
        if (error instanceof EFError) throw error;
        throw new EFError('Invalid beat marker undo payload', 'BAD_REQUEST', 400);
    }
    sendJSON(res, 200, await beatMarkers.undoMarkers(payload));
}

// --- request router -------------------------------------------------------

const server = http.createServer((req, res) => {
    let pathname;
    try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch (e) {
        sendJSON(res, 400, { ok: false, error: 'bad url', code: 'BAD_REQUEST' });
        return;
    }

    // Streaming proxies (strip prefix, preserve the rest of the path + query).
    const fullPath = req.url; // includes query string
    if (pathname === '/provider' || pathname.startsWith('/provider/')) {
        proxy(req, res, PROVIDER_API_HOST, fullPath.replace(/^\/provider/, '') || '/');
        return;
    }
    if (pathname === '/provider-upload' || pathname.startsWith('/provider-upload/')) {
        proxy(req, res, PROVIDER_UPLOAD_HOST, fullPath.replace(/^\/provider-upload/, '') || '/');
        return;
    }

    if (pathname.startsWith('/artifacts/') && req.method === 'GET') {
        serveArtifact(req, res, pathname.slice('/artifacts/'.length));
        return;
    }

    if (transcription.handleRequest(req, res, pathname)) return;
    if (beatDetection.handleRequest(req, res, pathname)) return;
    if (animationRender.handleRequest(req, res, pathname)) return;
    if (urlContext.handleRequest(req, res, pathname)) return;

    // /bridge — each handler wrapped so a thrown error becomes a coded JSON
    // response and never crashes the server.
    if (pathname.startsWith('/bridge/')) {
        if (!authorizeBridge(req, res)) return;
        const run = (fn, timeoutMs, expectedCodes) => promiseWithTimeout(
            Promise.resolve().then(() => fn(req, res)),
            timeoutMs,
            'bridge operation timed out',
        ).catch((err) => {
            // "Nothing under the playhead" is an expected capture outcome, not
            // a broken HTTP request. Return a typed 200 response so Chromium
            // does not emit a console-level failed-resource error; callers must
            // still check `ok` before creating an artifact.
            if (!res.headersSent && err instanceof EFError && expectedCodes && expectedCodes.has(err.code)) {
                sendJSON(res, 200, { ok: false, error: err.message, code: err.code });
            } else if (!res.headersSent) sendError(res, err);
            else res.destroy();
        });
        if (pathname === '/bridge/status' && req.method === 'GET') return void run(bridgeStatus, 3000);
        const expectedGrabCodes = new Set(['NO_ITEM', 'NO_TIMELINE']);
        const expectedBoundaryCodes = new Set(['NO_ITEM', 'NO_TIMELINE', 'RESOLVE_CLOSED', 'TIMELINE_CHANGED', 'PLAYHEAD_CHANGED', 'CAPTURE_CANCELLED', 'FRAME_EXPORT_FAILED']);
        const expectedEditImageCodes = new Set([...expectedBoundaryCodes, 'SOURCE_OFFLINE']);
        const expectedEditVideoCodes = new Set([...expectedBoundaryCodes, 'SOURCE_OFFLINE', 'INVALID_RANGE', 'UNSUPPORTED_TIMELINE_EDIT']);
        if (pathname === '/bridge/grab/frame' && req.method === 'GET') return void run((request, response) => withTimelineOperationLock(() => grabFrame(request, response)), 20000, expectedGrabCodes);
        if (pathname === '/bridge/grab/edit-image-source' && req.method === 'GET') return void run(grabEditImageSource, 20000, expectedEditImageCodes);
        if (pathname === '/bridge/grab/edit-video-source' && req.method === 'GET') return void run(grabEditVideoSource, 120000, expectedEditVideoCodes);
        if (pathname === '/bridge/grab/shot-start-frame' && req.method === 'GET') return void run(grabShotStartFrame, 20000, expectedBoundaryCodes);
        if (pathname === '/bridge/grab/shot-end-frame' && req.method === 'GET') return void run(grabShotEndFrame, 20000, expectedBoundaryCodes);
        if (pathname === '/bridge/grab/clip' && req.method === 'GET') return void run((request, response) => withTimelineOperationLock(() => grabClip(request, response)), 30000, expectedGrabCodes);
        if (pathname === '/bridge/grab/audio' && req.method === 'GET') return void run(grabAudio, 30000, expectedEditVideoCodes);
        if (pathname === '/bridge/place' && req.method === 'POST') return void run(place, 115000);
        if (pathname === '/bridge/beat/apply-markers' && req.method === 'POST') return void run(applyBeatMarkers, 30000);
        if (pathname === '/bridge/beat/undo-markers' && req.method === 'POST') return void run(undoBeatMarkers, 30000);
        sendJSON(res, 404, { ok: false, error: 'unknown bridge endpoint', code: 'BAD_REQUEST' });
        return;
    }

    // Everything else: static UI.
    serveStatic(req, res, pathname);
});

// Bound idle/slow clients. The longest legitimate operation is media placement,
// which the renderer itself caps at 120 seconds.
server.headersTimeout = 10 * 1000;
server.requestTimeout = 125 * 1000;
server.timeout = 130 * 1000;

function startServer() {
    return new Promise((resolve2) => {
        server.listen(PORT, '127.0.0.1', () => {
            console.log('[EasyField] server on http://127.0.0.1:' + PORT);
            resolve2();
        });
    });
}

// --- window / lifecycle ---------------------------------------------------

let mainWindow = null;
let stateStore = null;
let currentWindowMode = 'compact';
let floatingController = null;
let displayChangeHandler = null;

// Artifact rows contain absolute paths and are Main-owned. They deliberately do
// not participate in the renderer's generic state IPC surface.
const VALID_RENDERER_STATE_NAMESPACES = new Set(['settings', 'drafts', 'jobs', 'recipes', 'transcripts', 'projects']);
const VALID_CREDENTIALS = new Set([CLOUD_GENERATION_CREDENTIAL, LEGACY_CLOUD_GENERATION_CREDENTIAL, 'voice-provider-api-key']);

function assertStateKey(namespace, key) {
    if (!VALID_RENDERER_STATE_NAMESPACES.has(namespace)) throw new Error('Invalid state namespace');
    if (typeof key !== 'string' || !key || key.length > 240) throw new Error('Invalid state key');
}

function credentialPath(name) {
    if (!VALID_CREDENTIALS.has(name)) throw new Error('Invalid credential name');
    return path.join(app.getPath('userData'), name + '.safe');
}

function readStoredCredential(name) {
    const current = credentialPath(name);
    const legacy = name === CLOUD_GENERATION_CREDENTIAL
        ? credentialPath(LEGACY_CLOUD_GENERATION_CREDENTIAL)
        : null;
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return '';
    for (const candidate of legacy ? [current, legacy] : [current]) {
        if (!fs.existsSync(candidate)) continue;
        try {
            const encrypted = fs.readFileSync(candidate);
            const value = safeStorage.decryptString(encrypted);
            if (!value) continue;
            if (legacy && candidate === current) {
                try { fs.unlinkSync(legacy); } catch (error) { /* already absent/read-only */ }
            } else if (legacy && candidate === legacy) {
                // Validate the old ciphertext first, then copy it atomically and
                // verify the new file before removing the compatibility copy.
                try {
                    writePrivateFileAtomic(current, encrypted);
                    const verified = safeStorage.decryptString(fs.readFileSync(current));
                    if (verified === value) {
                        try { fs.unlinkSync(legacy); } catch (error) { /* best effort */ }
                    }
                } catch (error) {
                    // Keep using the verified legacy credential for this
                    // session if a read-only filesystem prevents migration.
                }
            }
            return value;
        } catch (error) {
            // A corrupt current file must not mask a valid compatibility copy.
        }
    }
    return '';
}

function credentialDeletePaths(name) {
    if (name !== CLOUD_GENERATION_CREDENTIAL) return [credentialPath(name)];
    return [credentialPath(CLOUD_GENERATION_CREDENTIAL), credentialPath(LEGACY_CLOUD_GENERATION_CREDENTIAL)];
}

function writePrivateFileAtomic(filePath, bytes) {
    const temporary = filePath + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
        fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, filePath);
        try { fs.chmodSync(filePath, 0o600); } catch (e) { /* best effort */ }
    } catch (error) {
        removePartial(temporary);
        throw error;
    }
}

function trustedPanelOrigin() {
    return process.env.EF_DEV === '1' ? 'http://localhost:5173' : 'http://127.0.0.1:' + PORT;
}

function assertTrustedIpcEvent(event) {
    if (!mainWindow || mainWindow.isDestroyed() || !event || event.sender !== mainWindow.webContents) {
        throw new Error('Untrusted IPC sender');
    }
    if (event.senderFrame && event.sender.mainFrame && event.senderFrame !== event.sender.mainFrame) {
        throw new Error('Subframes cannot call privileged IPC');
    }
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    let origin = '';
    try { origin = new URL(senderUrl).origin; } catch (e) { /* rejected below */ }
    if (origin !== new URL(trustedPanelOrigin()).origin) throw new Error('Untrusted IPC origin');
}

function registerTrustedHandler(channel, handler) {
    ipcMain.handle(channel, (event, ...args) => {
        assertTrustedIpcEvent(event);
        return handler(...args);
    });
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve2, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', resolve2);
        stream.on('error', reject);
    });
    return hash.digest('hex');
}

function registerHostIpc() {
    if (!ipcMain || typeof ipcMain.handle !== 'function') return;
    stateStore = createStateStore(app.getPath('userData'));

    registerTrustedHandler('ef:credentials:get', (name) => {
        return readStoredCredential(name) ? SECURE_PROVIDER_PROXY_TOKEN : '';
    });
    registerTrustedHandler('ef:credentials:set', (name, value) => {
        const file = credentialPath(name);
        if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid credential value');
        if (!value) {
            for (const candidate of credentialDeletePaths(name)) {
                try { fs.unlinkSync(candidate); } catch {}
            }
            return;
        }
        if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('macOS Keychain is unavailable');
        writePrivateFileAtomic(file, safeStorage.encryptString(value));
        if (name === CLOUD_GENERATION_CREDENTIAL) {
            try { fs.unlinkSync(credentialPath(LEGACY_CLOUD_GENERATION_CREDENTIAL)); } catch {}
        }
    });
    registerTrustedHandler('ef:credentials:delete', (name) => {
        for (const file of credentialDeletePaths(name)) {
            try { fs.unlinkSync(file); } catch {}
        }
    });
    registerTrustedHandler('ef:state:get', (namespace, key) => {
        assertStateKey(namespace, key);
        return stateStore.get(namespace, key);
    });
    registerTrustedHandler('ef:state:list', (namespace) => {
        if (!VALID_RENDERER_STATE_NAMESPACES.has(namespace)) throw new Error('Invalid state namespace');
        return stateStore.list(namespace);
    });
    registerTrustedHandler('ef:state:set', (namespace, key, value) => {
        assertStateKey(namespace, key);
        const json = JSON.stringify(value);
        if (json === undefined) throw new Error('State value is not JSON serializable');
        if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error('State value is too large');
        return stateStore.set(namespace, key, value);
    });
    registerTrustedHandler('ef:state:delete', (namespace, key) => {
        assertStateKey(namespace, key);
        return stateStore.delete(namespace, key);
    });
    registerTrustedHandler('ef:window:set-mode', (mode) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mode !== 'compact' && mode !== 'expanded') throw new Error('Invalid window mode');
        currentWindowMode = mode;
        applyWindowMode(mainWindow, screen, mode, { animate: true });
    });
    // No renderer argument is accepted: Main owns the verified source and the
    // fixed Resolve destination, including administrator-authorized rollback.
    registerTrustedHandler('ef:updates:check', () => pluginUpdater.check());
    registerTrustedHandler('ef:updates:install', () => pluginUpdater.install());
    registerTrustedHandler('ef:artifacts:ingest-url', async (input) => {
        if (!input || typeof input.url !== 'string' || !['image', 'video', 'audio'].includes(input.kind)) throw new Error('Invalid artifact input');
        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        const id = crypto.randomUUID();
        const stem = path.join(ARTIFACT_DIR, id);
        const temporary = stem + '.download';
        let localPath = '';
        try {
            await downloadTo(input.url, temporary);
            const extension = sniffExt(readHead(temporary));
            if (!extension) throw new Error('Unsupported artifact media');
            // Hash the completed temporary file before the atomic rename. If
            // hashing or metadata persistence fails, neither a partial nor an
            // orphaned final artifact is left behind.
            const checksum = await sha256File(temporary);
            localPath = stem + extension;
            fs.renameSync(temporary, localPath);
            stateStore.set('artifacts', id, {
                id,
                name: typeof input.name === 'string' ? input.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) : 'EasyField artifact',
                kind: input.kind,
                localPath,
                checksum,
                bytes: fs.statSync(localPath).size,
                createdAt: Date.now(),
                referenced: true,
            });
            return { id, url: `/artifacts/${id}`, checksum };
        } catch (error) {
            removePartial(temporary);
            if (localPath) removePartial(localPath);
            throw error;
        }
    });
}

function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const initialBounds = windowBoundsForMode('compact', primaryDisplay.workArea);
    mainWindow = new BrowserWindow({
        ...initialBounds,
        // Bounds are outer-window bounds so titlebar height is included when
        // clamping the panel to a display work area.
        useContentSize: false,
        // Match the panel background so resizing never reveals black/white gaps.
        backgroundColor: '#101015',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
        },
    });
    mainWindow.setMenu(null);
    applyWindowMode(mainWindow, screen, currentWindowMode, { initial: true });
    floatingController = createResolveAwareFloatingController(mainWindow);

    // Re-clamp on resolution, work-area, scale-factor and monitor changes. The
    // matching display is derived from the current window, so a panel moved to
    // another monitor stays there rather than jumping back to the primary one.
    displayChangeHandler = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        clampWindowToWorkArea(mainWindow, screen, currentWindowMode);
    };
    screen.on('display-metrics-changed', displayChangeHandler);
    screen.on('display-removed', displayChangeHandler);
    mainWindow.on('moved', displayChangeHandler);

    // EF_DEV=1 -> vite dev server (HMR); otherwise the embedded static UI.
    const url = trustedPanelOrigin();
    const allowedOrigin = new URL(url).origin;
    const webRequest = mainWindow.webContents.session?.webRequest;
    if (webRequest && typeof webRequest.onBeforeSendHeaders === 'function') {
        // In EF_DEV the cloud-provider paths first reach Vite. Vite forwards only the
        // opaque secure sentinel to this Main process, so it needs the same
        // renderer-invisible bridge token as the packaged proxy. Raw browser
        // development keys bypass that middleware and retain the old direct
        // provider proxy behavior.
        const authenticatedPaths = [
            `${allowedOrigin}/bridge/*`,
            `${allowedOrigin}/api/render*`,
            `${allowedOrigin}/api/beat-detect*`,
            `${allowedOrigin}/api/transcribe*`,
            `${allowedOrigin}/api/url-context*`,
            `${allowedOrigin}/provider/*`,
            `${allowedOrigin}/provider-upload/*`,
        ];
        webRequest.onBeforeSendHeaders(
            { urls: authenticatedPaths },
            (details, callback) => {
                const requestHeaders = Object.assign({}, details.requestHeaders);
                if (details.webContentsId === mainWindow?.webContents.id) {
                    requestHeaders['X-EF-Bridge-Token'] = BRIDGE_TOKEN;
                }
                callback({ requestHeaders });
            },
        );
    }
    // A remote navigation would keep this window's preload and therefore gain
    // access to privileged IPC. Keep the panel on its own trusted origin and
    // deny renderer-created windows entirely.
    mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
        // Result links may intentionally open a provider HTTPS URL for a manual
        // save. Open those in the system browser without creating a privileged
        // Electron window that inherits this panel's preload.
        try {
            const target = new URL(targetUrl);
            if (target.protocol === 'https:' && shell && typeof shell.openExternal === 'function') {
                void shell.openExternal(target.toString());
            }
        } catch (e) { /* denied below */ }
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
        let targetOrigin = '';
        try { targetOrigin = new URL(targetUrl).origin; } catch (e) { /* rejected below */ }
        if (targetOrigin !== allowedOrigin) event.preventDefault();
    });
    mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    mainWindow.loadURL(url);

    mainWindow.on('close', () => {
        floatingController?.dispose();
        floatingController = null;
        if (displayChangeHandler) {
            screen.removeListener('display-metrics-changed', displayChangeHandler);
            screen.removeListener('display-removed', displayChangeHandler);
            mainWindow?.removeListener('moved', displayChangeHandler);
            displayChangeHandler = null;
        }
        app.quit();
    });
}

app.whenReady().then(async () => {
    registerHostIpc();
    await startServer();
    // Warm the Resolve bridge (non-fatal if it fails).
    getResolve().catch(() => {});
    // EF_SERVER_ONLY=1 -> headless server (curl verification), no window.
    if (process.env.EF_SERVER_ONLY !== '1') {
        createWindow();
    }
});

app.on('window-all-closed', () => {
    // Headless verification/render mode intentionally has no persistent panel
    // window; closing its temporary render host must not tear down the server.
    if (process.env.EF_SERVER_ONLY !== '1') app.quit();
});

app.on('quit', () => {
    try { if (stateStore) stateStore.close(); } catch (e) { /* best-effort */ }
    animationRender.dispose();
    // Calling into CleanUp while native InitializePromise is still hung can
    // deadlock Resolve's IPC mutex during shutdown. There is nothing to clean up
    // until initialization actually succeeded.
    try { if (WorkflowIntegration && initAttempted) WorkflowIntegration.CleanUp(); } catch (e) { /* best-effort */ }
});
