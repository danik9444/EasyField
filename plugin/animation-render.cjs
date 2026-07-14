// Packaged animation renderer for the Resolve plugin.
//
// The Vite development server uses vite-plugin-render.ts. The installed plugin
// cannot: it has neither the source tree nor the Remotion/HyperFrames CLIs and
// must not assume that `node`/`npx` exists on the user's PATH. Instead, this
// service drives a hidden page compiled into plugin/ui, captures deterministic
// frames with Electron's own Chromium, and streams raw BGRA frames to ffmpeg.
//
// Wiring from main.cjs (kept there so the main router owns authentication):
//   const animationRender = createAnimationRenderService({
//     BrowserWindow, origin: 'http://127.0.0.1:' + PORT,
//     ffmpegPath: FFMPEG, authorizeRequest: authorizeBridge,
//   });
//   if (animationRender.handleRequest(req, res, pathname)) return;
//   // on quit: animationRender.dispose();

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: defaultSpawn } = require('child_process');
const { pipeline } = require('stream/promises');

const RENDER_PATH = '/api/render';
const JOB_PATH_PREFIX = '/api/render/jobs/';
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_QUEUE = 2;
const DEFAULT_RENDER_TIMEOUT_MS = 15 * 60 * 1000;
const RENDER_SOCKET_GRACE_MS = 5_000;
const HOST_READY_TIMEOUT_MS = 20_000;
const FRAME_TIMEOUT_MS = 15_000;
const STDERR_TAIL_BYTES = 16 * 1024;
// Keep the decoded audio comfortably below the render endpoint's 64 MB JSON
// cap after base64 expansion (24 MB raw becomes at most 32 MB of base64).
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

const AUDIO_MIME_TYPES = Object.freeze({
    'audio/mpeg': { extension: 'mp3', format: 'mp3' },
    'audio/mp3': { extension: 'mp3', format: 'mp3' },
    'audio/wav': { extension: 'wav', format: 'wav' },
    'audio/wave': { extension: 'wav', format: 'wav' },
    'audio/x-wav': { extension: 'wav', format: 'wav' },
    'audio/vnd.wave': { extension: 'wav', format: 'wav' },
    'audio/mp4': { extension: 'm4a', format: 'mov' },
    'audio/x-m4a': { extension: 'm4a', format: 'mov' },
    'audio/aac': { extension: 'aac', format: 'aac' },
    'audio/ogg': { extension: 'ogg', format: 'ogg' },
    'audio/opus': { extension: 'opus', format: 'ogg' },
    'audio/webm': { extension: 'webm', format: 'matroska' },
    'audio/flac': { extension: 'flac', format: 'flac' },
    'audio/x-flac': { extension: 'flac', format: 'flac' },
    'audio/aiff': { extension: 'aiff', format: 'aiff' },
    'audio/x-aiff': { extension: 'aiff', format: 'aiff' },
});

const ALLOWED_SIZES = new Set([
    '1920x1080',
    '1080x1920',
    '1080x1080',
    '1080x1350',
]);
const ALLOWED_FPS = new Set([24, 30, 60]);
const ALLOWED_DURATIONS = new Set([3, 5, 8, 10, 15]);
const ALLOWED_MODES = new Set(['presets', 'prompt', 'assets']);
const ALLOWED_PRESETS = new Set(['Fade In', 'Slide Up', 'Pop Scale', 'Kinetic Type', 'Lower Third', 'Title Card']);
const ALLOWED_RECIPES = new Set(['custom', 'smart-captions', 'text-motion-graphics', 'product-video', 'intros-outros', 'overlays-graphics', 'website-to-video', 'audio-visualizer', 'data-to-video']);

class RenderError extends Error {
    constructor(message, code, status) {
        super(message);
        this.name = 'RenderError';
        this.code = code || 'RENDER_FAILED';
        this.status = status || 500;
    }
}

function abortError(signal) {
    if (signal && signal.reason instanceof RenderError) return signal.reason;
    return new RenderError('Render cancelled', 'RENDER_CANCELLED', 499);
}

function assertNotAborted(signal) {
    if (signal && signal.aborted) throw abortError(signal);
}

function positiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function validColour(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function validAssetUrl(value) {
    return typeof value === 'string' && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value);
}

function parseAudioDataUrl(value) {
    if (value == null) return null;
    if (typeof value !== 'string') {
        throw new RenderError('Animation audio must be an embedded base64 audio file', 'BAD_RENDER_REQUEST', 400);
    }

    const comma = value.indexOf(',');
    const header = comma >= 0 ? value.slice(0, comma) : '';
    const payload = comma >= 0 ? value.slice(comma + 1) : '';
    const match = /^data:(audio\/[a-z0-9.+-]+);base64$/i.exec(header);
    const mimeType = match ? match[1].toLowerCase() : '';
    const type = AUDIO_MIME_TYPES[mimeType];
    if (!type) {
        throw new RenderError('Animation audio must be a supported data:audio base64 URL', 'BAD_RENDER_REQUEST', 400);
    }

    // Reject URL-safe, whitespace-tolerant, percent-encoded and non-canonical
    // variants. Buffer.from(base64) is deliberately permissive, so validate the
    // grammar and round-trip before the bytes ever reach ffmpeg.
    const maximumEncodedBytes = 4 * Math.ceil(MAX_AUDIO_BYTES / 3);
    if (payload.length > maximumEncodedBytes) {
        throw new RenderError('Animation audio exceeds the 24 MB limit', 'PAYLOAD_TOO_LARGE', 413);
    }
    if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
        throw new RenderError('Animation audio contains invalid base64 data', 'BAD_RENDER_REQUEST', 400);
    }
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    const byteLength = (payload.length / 4) * 3 - padding;
    if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
        throw new RenderError('Animation audio is empty', 'BAD_RENDER_REQUEST', 400);
    }
    if (byteLength > MAX_AUDIO_BYTES) {
        throw new RenderError('Animation audio exceeds the 24 MB limit', 'PAYLOAD_TOO_LARGE', 413);
    }
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.length !== byteLength || bytes.toString('base64') !== payload) {
        throw new RenderError('Animation audio contains invalid base64 data', 'BAD_RENDER_REQUEST', 400);
    }
    return { mimeType, extension: type.extension, format: type.format, byteLength, bytes };
}

function validateRenderProps(value, meta) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RenderError('Remotion props are required', 'BAD_RENDER_REQUEST', 400);
    }
    const mode = value.mode;
    const recipe = value.recipe == null ? 'custom' : value.recipe;
    const text = value.text;
    const preset = value.preset;
    const accent = value.accent;
    const bg = value.bg;
    const assetUrls = value.assetUrls;

    if (!ALLOWED_MODES.has(mode)) throw new RenderError('Unsupported animation mode', 'BAD_RENDER_REQUEST', 400);
    if (!ALLOWED_RECIPES.has(recipe)) throw new RenderError('Unsupported animation recipe', 'BAD_RENDER_REQUEST', 400);
    if (typeof text !== 'string' || text.length > 240) throw new RenderError('Animation text is invalid', 'BAD_RENDER_REQUEST', 400);
    if (!ALLOWED_PRESETS.has(preset)) throw new RenderError('Unsupported animation preset', 'BAD_RENDER_REQUEST', 400);
    if (!validColour(accent) || !validColour(bg)) throw new RenderError('Animation colours are invalid', 'BAD_RENDER_REQUEST', 400);
    if (!Array.isArray(assetUrls) || assetUrls.length > 4 || !assetUrls.every(validAssetUrl)) {
        throw new RenderError('Animation assets must be embedded images', 'BAD_RENDER_REQUEST', 400);
    }

    // Only copy the props the composition understands. Dimensions and timing
    // come from validated top-level metadata so a conflicting nested value can
    // never allocate an unexpected render surface or frame count.
    return {
        mode,
        recipe,
        text,
        preset,
        accent,
        bg,
        assetUrls: assetUrls.slice(),
        fps: meta.fps,
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
    };
}

function validateRenderPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RenderError('Render request must be a JSON object', 'BAD_RENDER_REQUEST', 400);
    }

    const engine = value.engine;
    const width = Number(value.width);
    const height = Number(value.height);
    const fps = Number(value.fps);
    const durationSec = Number(value.durationSec);

    if (engine !== 'HyperFrames' && engine !== 'Remotion') {
        throw new RenderError('Unsupported animation engine', 'BAD_RENDER_REQUEST', 400);
    }
    if (!positiveInteger(width) || !positiveInteger(height) || !ALLOWED_SIZES.has(width + 'x' + height)) {
        throw new RenderError('Unsupported animation dimensions', 'BAD_RENDER_REQUEST', 400);
    }
    if (!ALLOWED_FPS.has(fps)) throw new RenderError('Unsupported animation frame rate', 'BAD_RENDER_REQUEST', 400);
    if (!ALLOWED_DURATIONS.has(durationSec)) throw new RenderError('Unsupported animation duration', 'BAD_RENDER_REQUEST', 400);

    const frameCount = Math.round(fps * durationSec);
    const meta = { engine, width, height, fps, durationSec, frameCount };
    if (frameCount < 1 || frameCount > 900) throw new RenderError('Animation is too long', 'BAD_RENDER_REQUEST', 400);

    const audio = parseAudioDataUrl(value.audioDataUrl);
    if (audio) {
        Object.assign(meta, {
            audioDataUrl: value.audioDataUrl,
            audioMimeType: audio.mimeType,
            audioFormat: audio.format,
            audioExtension: audio.extension,
            audioByteLength: audio.byteLength,
        });
    }

    if (engine === 'HyperFrames') {
        if (typeof value.html !== 'string' || value.html.length === 0) {
            throw new RenderError('HyperFrames HTML is required', 'BAD_RENDER_REQUEST', 400);
        }
        return Object.assign(meta, { html: value.html });
    }

    return Object.assign(meta, { props: validateRenderProps(value.props, meta) });
}

function sendJSON(res, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function sendRenderError(res, error) {
    if (res.headersSent || res.destroyed) {
        if (!res.destroyed) res.destroy();
        return;
    }
    const known = error instanceof RenderError;
    sendJSON(res, known ? error.status : 500, {
        ok: false,
        error: known ? error.message : (error && error.message) || String(error),
        code: known ? error.code : 'RENDER_FAILED',
    });
}

function parseConfiguredLimit(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveFfmpegPath(configured) {
    // GUI-launched macOS apps often do not inherit Homebrew's PATH. Respect an
    // explicit absolute override, otherwise cover both Apple Silicon and Intel
    // Homebrew before falling back to normal PATH lookup.
    if (configured && configured !== 'ffmpeg') return configured;
    if (process.env.EF_FFMPEG_PATH) return process.env.EF_FFMPEG_PATH;
    for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return configured || 'ffmpeg';
}

function readRequestBody(req, maxBytes, signal) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;

        const cleanup = () => {
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', onError);
            req.off('aborted', onAborted);
            if (signal) signal.removeEventListener('abort', onAborted);
        };
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };
        const onData = (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                // Drain the rest so the server can send a useful 413 response on
                // the existing keep-alive connection.
                req.pause();
                finish(reject, new RenderError('Render request is too large', 'PAYLOAD_TOO_LARGE', 413));
                req.resume();
                return;
            }
            chunks.push(chunk);
        };
        const onEnd = () => finish(resolve, Buffer.concat(chunks, size));
        const onError = (error) => finish(reject, error);
        const onAborted = () => finish(reject, abortError(signal));

        req.on('data', onData);
        req.once('end', onEnd);
        req.once('error', onError);
        req.once('aborted', onAborted);
        if (signal) signal.addEventListener('abort', onAborted, { once: true });
    });
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        assertNotAborted(signal);
        const timer = setTimeout(done, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(abortError(signal));
        };
        function done() {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

function withDeadline(promise, timeoutMs, signal, message) {
    return new Promise((resolve, reject) => {
        assertNotAborted(signal);
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            fn(value);
        };
        const onAbort = () => finish(reject, abortError(signal));
        const timer = setTimeout(() => finish(reject, new RenderError(message, 'RENDER_TIMEOUT', 504)), timeoutMs);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
}

function writeFrame(stream, pixels, signal) {
    return new Promise((resolve, reject) => {
        assertNotAborted(signal);
        const onAbort = () => {
            cleanup();
            reject(abortError(signal));
        };
        const cleanup = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        stream.write(pixels, (error) => {
            cleanup();
            if (error) reject(error);
            else resolve();
        });
    });
}

function buildEncoderArgs(job, outputPath, audioInput) {
    const args = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'rawvideo',
        '-pixel_format', 'bgra',
        '-video_size', job.width + 'x' + job.height,
        '-framerate', String(job.fps),
        '-i', 'pipe:0',
    ];
    if (audioInput) {
        // Pin the demuxer instead of asking ffmpeg to auto-detect arbitrary
        // bytes. This prevents an embedded playlist or network manifest from
        // turning a local render into an external fetch.
        args.push(
            '-f', audioInput.format,
            '-i', audioInput.path,
            '-map', '0:v:0',
            '-map', '1:a:0',
        );
    } else {
        // Keep the legacy silent command byte-for-byte identical.
        args.push('-an');
    }
    args.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
    );
    if (audioInput) {
        // apad fills short inputs with silence; -t truncates long inputs and
        // caps the padded mux to the exact validated video duration.
        args.push(
            '-c:a', 'aac',
            '-b:a', '192k',
            '-af', 'apad',
            '-t', String(job.durationSec),
        );
    }
    args.push(
        '-movflags', '+faststart',
        outputPath,
    );
    return args;
}

function createEncoder(spawnProcess, ffmpegPath, job, outputPath, audioInput) {
    const args = buildEncoderArgs(job, outputPath, audioInput);
    const child = spawnProcess(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let terminalState = null;
    let resolveTerminal;
    const terminal = new Promise((resolve) => { resolveTerminal = resolve; });

    const settle = (state) => {
        if (terminalState) return;
        terminalState = state;
        resolveTerminal(state);
    };
    child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.once('error', (error) => settle({ error }));
    child.once('close', (code, signal) => settle({ code, signal }));

    return {
        child,
        terminal,
        getTerminalState: () => terminalState,
        getStderr: () => stderr,
        stop: () => {
            if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
            if (child.exitCode == null && !child.killed) child.kill('SIGKILL');
        },
    };
}

function writeAudioInput(job, tempDir) {
    if (!job.audioDataUrl) return null;
    const audio = parseAudioDataUrl(job.audioDataUrl);
    if (!audio) return null;
    const inputPath = path.join(tempDir, 'animation-audio.' + audio.extension);
    fs.writeFileSync(inputPath, audio.bytes, { flag: 'wx', mode: 0o600 });
    return { path: inputPath, format: audio.format };
}

function encoderFailure(state, stderr, ffmpegPath) {
    if (state && state.error) {
        const missing = state.error.code === 'ENOENT';
        const message = missing
            ? 'ffmpeg was not found at ' + ffmpegPath + '. Install ffmpeg and restart EasyField.'
            : 'Could not start ffmpeg: ' + state.error.message;
        return new RenderError(message, missing ? 'FFMPEG_MISSING' : 'FFMPEG_FAILED', missing ? 503 : 500);
    }
    const suffix = stderr ? ': ' + stderr.slice(-800) : '';
    return new RenderError('ffmpeg exited ' + ((state && state.code) == null ? 'unexpectedly' : state.code) + suffix, 'FFMPEG_FAILED', 500);
}

function isMp4(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const head = Buffer.alloc(12);
            const bytes = fs.readSync(fd, head, 0, head.length, 0);
            return bytes >= 12 && head.toString('ascii', 4, 8) === 'ftyp';
        } finally {
            fs.closeSync(fd);
        }
    } catch (error) {
        return false;
    }
}

async function waitForRenderHost(win, signal) {
    const deadline = Date.now() + HOST_READY_TIMEOUT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
        assertNotAborted(signal);
        if (win.isDestroyed()) throw new RenderError('Animation render window closed unexpectedly', 'RENDER_HOST_FAILED', 500);
        try {
            const state = await withDeadline(
                win.webContents.executeJavaScript(`(() => {
                    const host = globalThis.__easyfieldRenderHost;
                    return host ? { ready: host.ready === true, error: host.error || null } : null;
                })()`, true),
                2_000,
                signal,
                'Animation render host did not respond',
            );
            if (state && state.error) throw new RenderError(String(state.error), 'RENDER_HOST_FAILED', 422);
            if (state && state.ready) return;
        } catch (error) {
            if (error instanceof RenderError && (error.code === 'RENDER_CANCELLED' || error.code === 'RENDER_HOST_FAILED')) throw error;
            lastError = error;
        }
        await delay(50, signal);
    }
    const detail = lastError && lastError.message ? ': ' + lastError.message : '';
    throw new RenderError('Animation render host timed out' + detail, 'RENDER_TIMEOUT', 504);
}

function createAnimationRenderService(options) {
    if (!options || typeof options.BrowserWindow !== 'function') throw new TypeError('BrowserWindow is required');
    if (typeof options.origin !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(options.origin)) {
        throw new TypeError('A loopback plugin origin is required');
    }

    const BrowserWindow = options.BrowserWindow;
    const ffmpegPath = resolveFfmpegPath(options.ffmpegPath);
    const spawnProcess = options.spawnProcess || defaultSpawn;
    const authorizeRequest = options.authorizeRequest;
    const maxBodyBytes = parseConfiguredLimit(options.maxBodyBytes || process.env.EF_MAX_RENDER_BYTES, DEFAULT_MAX_BODY_BYTES);
    const maxQueue = parseConfiguredLimit(options.maxQueue || process.env.EF_MAX_RENDER_QUEUE, DEFAULT_MAX_QUEUE);
    const renderTimeoutMs = parseConfiguredLimit(options.renderTimeoutMs || process.env.EF_RENDER_TIMEOUT_MS, DEFAULT_RENDER_TIMEOUT_MS);
    const logger = options.logger || console;
    const jobs = new Map();
    const activeControllers = new Set();
    let queueTail = Promise.resolve();
    let queuedCount = 0;
    let disposed = false;

    const enqueue = (task) => {
        if (disposed) return Promise.reject(new RenderError('Animation renderer is shutting down', 'RENDER_UNAVAILABLE', 503));
        if (queuedCount >= maxQueue) return Promise.reject(new RenderError('Another animation render is already queued', 'RENDER_BUSY', 429));
        queuedCount += 1;
        const run = queueTail.then(task, task);
        queueTail = run.catch(() => {}).finally(() => { queuedCount -= 1; });
        return run;
    };

    const renderToFile = async (job, signal, tempDir) => {
        assertNotAborted(signal);
        const jobId = crypto.randomUUID();
        const outputPath = path.join(tempDir, 'animation.mp4');
        // The hidden renderer only needs visual composition data. Do not expose
        // the potentially large attached audio blob through the job endpoint.
        const renderHostJob = Object.assign({}, job);
        delete renderHostJob.audioDataUrl;
        delete renderHostJob.audioMimeType;
        delete renderHostJob.audioFormat;
        delete renderHostJob.audioExtension;
        delete renderHostJob.audioByteLength;
        jobs.set(jobId, renderHostJob);

        let win = null;
        let encoder = null;
        try {
            const audioInput = writeAudioInput(job, tempDir);
            win = new BrowserWindow({
                show: false,
                width: job.width,
                height: job.height,
                useContentSize: true,
                paintWhenInitiallyHidden: true,
                backgroundColor: '#000000',
                webPreferences: {
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                    backgroundThrottling: false,
                },
            });
            if (typeof win.setMenu === 'function') win.setMenu(null);
            const hostUrl = options.origin + '/render-host?efRenderJob=' + encodeURIComponent(jobId);
            const hostOrigin = new URL(options.origin).origin;
            if (win.webContents && typeof win.webContents.setWindowOpenHandler === 'function') {
                win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
            }
            if (win.webContents && typeof win.webContents.on === 'function') {
                win.webContents.on('will-navigate', (event, targetUrl) => {
                    let targetOrigin = '';
                    try { targetOrigin = new URL(targetUrl).origin; } catch (e) { /* rejected below */ }
                    if (targetOrigin !== hostOrigin) event.preventDefault();
                });
                win.webContents.on('will-attach-webview', (event) => event.preventDefault());
            }
            await withDeadline(win.loadURL(hostUrl), HOST_READY_TIMEOUT_MS, signal, 'Animation render page did not load');
            await waitForRenderHost(win, signal);

            encoder = createEncoder(spawnProcess, ffmpegPath, job, outputPath, audioInput);
            for (let frame = 0; frame < job.frameCount; frame += 1) {
                assertNotAborted(signal);
                const terminalState = encoder.getTerminalState();
                if (terminalState) throw encoderFailure(terminalState, encoder.getStderr(), ffmpegPath);

                const result = await withDeadline(
                    win.webContents.executeJavaScript(`globalThis.__easyfieldRenderHost.seek(${frame})`, true),
                    FRAME_TIMEOUT_MS,
                    signal,
                    'Timed out rendering animation frame ' + frame,
                );
                if (!result || result.frame !== frame) {
                    throw new RenderError('Animation host returned the wrong frame', 'RENDER_HOST_FAILED', 500);
                }

                let image = await withDeadline(
                    win.webContents.capturePage({ x: 0, y: 0, width: job.width, height: job.height }, { stayHidden: true }),
                    FRAME_TIMEOUT_MS,
                    signal,
                    'Timed out capturing animation frame ' + frame,
                );
                const size = image.getSize();
                if (size.width !== job.width || size.height !== job.height) {
                    image = image.resize({ width: job.width, height: job.height, quality: 'best' });
                }
                const pixels = image.toBitmap();
                if (pixels.length !== job.width * job.height * 4) {
                    throw new RenderError('Animation frame has an unexpected pixel size', 'RENDER_HOST_FAILED', 500);
                }
                await withDeadline(
                    writeFrame(encoder.child.stdin, pixels, signal),
                    FRAME_TIMEOUT_MS,
                    signal,
                    'Timed out encoding animation frame ' + frame,
                );
            }

            encoder.child.stdin.end();
            const state = await withDeadline(encoder.terminal, 120_000, signal, 'ffmpeg did not finish the animation');
            if (state.error || state.code !== 0) throw encoderFailure(state, encoder.getStderr(), ffmpegPath);
            if (!isMp4(outputPath)) throw new RenderError('ffmpeg did not create a valid MP4', 'FFMPEG_FAILED', 500);
            return outputPath;
        } finally {
            jobs.delete(jobId);
            if (encoder && encoder.getTerminalState() == null) encoder.stop();
            if (win && !win.isDestroyed()) win.destroy();
        }
    };

    const handleJob = (req, res, pathname) => {
        if (req.method !== 'GET') {
            sendJSON(res, 405, { ok: false, error: 'GET required', code: 'METHOD_NOT_ALLOWED' });
            return;
        }
        const jobId = pathname.slice(JOB_PATH_PREFIX.length);
        if (!/^[0-9a-f-]{36}$/i.test(jobId) || !jobs.has(jobId)) {
            sendJSON(res, 404, { ok: false, error: 'Render job not found', code: 'NOT_FOUND' });
            return;
        }
        sendJSON(res, 200, jobs.get(jobId));
    };

    const handleRender = async (req, res) => {
        if (req.method !== 'POST') {
            sendJSON(res, 405, { ok: false, error: 'POST required', code: 'METHOD_NOT_ALLOWED' });
            return;
        }
        if (typeof authorizeRequest === 'function' && !authorizeRequest(req, res)) return;
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('application/json')) {
            sendJSON(res, 415, { ok: false, error: 'application/json required', code: 'UNSUPPORTED_MEDIA' });
            return;
        }
        const declaredLength = Number.parseInt(req.headers['content-length'], 10);
        if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
            sendJSON(res, 413, { ok: false, error: 'Render request is too large', code: 'PAYLOAD_TOO_LARGE' });
            req.resume();
            return;
        }

        const controller = new AbortController();
        activeControllers.add(controller);
        const onAborted = () => controller.abort();
        const onClosed = () => { if (!res.writableEnded) controller.abort(); };
        const socket = req.socket;
        const previousSocketTimeout = Number.isFinite(socket.timeout) ? socket.timeout : 0;
        // The main HTTP server uses a much shorter timeout for ordinary bridge
        // calls. A 900-frame render can legitimately be silent for longer, so
        // extend only this request's socket while retaining a hard overall cap.
        // Let our overall timer fire first so a still-open request gets a
        // structured 504 instead of an opaque socket reset.
        socket.setTimeout(renderTimeoutMs + RENDER_SOCKET_GRACE_MS);
        const overallTimer = setTimeout(() => {
            const timeoutError = new RenderError('Animation render exceeded the time limit', 'RENDER_TIMEOUT', 504);
            controller.abort(timeoutError);
            // During the final file stream headers may already be committed, in
            // which case there is no JSON 504 left to send.
            if (res.headersSent && !res.writableEnded && !res.destroyed) res.destroy(timeoutError);
        }, renderTimeoutMs);
        if (typeof overallTimer.unref === 'function') overallTimer.unref();
        req.once('aborted', onAborted);
        res.once('close', onClosed);

        let tempDir = null;
        try {
            const body = await readRequestBody(req, maxBodyBytes, controller.signal);
            let parsed;
            try {
                parsed = JSON.parse(body.toString('utf8'));
            } catch (error) {
                throw new RenderError('Render request contains invalid JSON', 'BAD_RENDER_REQUEST', 400);
            }
            const job = validateRenderPayload(parsed);
            tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-animation-'));
            const outputPath = await enqueue(() => renderToFile(job, controller.signal, tempDir));
            assertNotAborted(controller.signal);
            const stat = fs.statSync(outputPath);
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': stat.size,
                'Content-Disposition': 'inline; filename="easyfield-animation.mp4"',
                'Cache-Control': 'no-store',
            });
            await pipeline(fs.createReadStream(outputPath), res, { signal: controller.signal });
        } catch (error) {
            if (error && error.code !== 'RENDER_CANCELLED') {
                if (logger && typeof logger.error === 'function' && !(error instanceof RenderError && error.status < 500)) {
                    logger.error('[EasyField] animation render failed:', error.message || error);
                }
                sendRenderError(res, error);
            }
        } finally {
            req.off('aborted', onAborted);
            res.off('close', onClosed);
            clearTimeout(overallTimer);
            if (!socket.destroyed) {
                socket.setTimeout(Number.isFinite(previousSocketTimeout) ? previousSocketTimeout : 0);
            }
            activeControllers.delete(controller);
            if (tempDir) {
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                } catch (cleanupError) {
                    if (logger && typeof logger.warn === 'function') {
                        logger.warn('[EasyField] could not remove animation temp directory:', cleanupError.message || cleanupError);
                    }
                }
            }
        }
    };

    return {
        handleRequest(req, res, pathname) {
            if (pathname === RENDER_PATH) {
                void handleRender(req, res);
                return true;
            }
            if (pathname.startsWith(JOB_PATH_PREFIX)) {
                handleJob(req, res, pathname);
                return true;
            }
            return false;
        },
        dispose() {
            disposed = true;
            for (const controller of activeControllers) controller.abort();
            jobs.clear();
        },
    };
}

module.exports = {
    MAX_AUDIO_BYTES,
    RenderError,
    buildEncoderArgs,
    createAnimationRenderService,
    validateRenderPayload,
};
