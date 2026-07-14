// Local beat-analysis boundary shared by the packaged Electron server and the
// Vite development server. Uploaded bytes are written to an isolated temporary
// directory and passed to a managed Python/librosa process. This module never
// calls Resolve and exposes no timeline mutation operation.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_PROCESS_OUTPUT = 8 * 1024 * 1024;

class BeatDetectionError extends Error {
    constructor(message, code, status, details) {
        super(message);
        this.code = code || 'BEAT_ANALYSIS_FAILED';
        this.status = status || 500;
        this.details = details;
    }
}

function sendJSON(res, status, payload) {
    if (res.headersSent) return;
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp01(value) {
    return Math.max(0, Math.min(1, finite(value, 0)));
}

function normalizeBeatResult(payload) {
    if (!payload || payload.ok !== true) {
        const message = payload && typeof payload.error === 'string' ? payload.error : 'librosa did not return an analysis result.';
        const code = payload && typeof payload.code === 'string' ? payload.code : 'BEAT_ANALYSIS_FAILED';
        const status = code === 'BEAT_RUNTIME_MISSING' ? 503 : code === 'UNSUPPORTED_MEDIA' || code === 'EMPTY_AUDIO' ? 422 : 500;
        throw new BeatDetectionError(message, code, status);
    }
    const durationSeconds = Math.max(0, Math.min(24 * 60 * 60, finite(payload.durationSeconds, 0)));
    const bpm = Math.max(0, Math.min(600, finite(payload.bpm, 0)));
    const rawBeats = Array.isArray(payload.beats) ? payload.beats.slice(0, 100000) : [];
    const beats = [];
    let previous = -1;
    for (const beat of rawBeats) {
        const time = finite(beat && beat.time, -1);
        if (time < 0 || time < previous || (durationSeconds > 0 && time > durationSeconds + 0.1)) continue;
        beats.push({
            time: Math.round(time * 10000) / 10000,
            confidence: Math.round(clamp01(beat && beat.confidence) * 10000) / 10000,
        });
        previous = time;
    }
    return {
        ok: true,
        engine: 'librosa',
        engineVersion: typeof payload.engineVersion === 'string' ? payload.engineVersion.slice(0, 40) : 'unknown',
        bpm: Math.round(bpm * 100) / 100,
        confidence: Math.round(clamp01(payload.confidence) * 10000) / 10000,
        durationSeconds: Math.round(durationSeconds * 10000) / 10000,
        sampleRate: Math.max(0, Math.round(finite(payload.sampleRate, 0))),
        beats,
    };
}

function parseProcessJSON(output) {
    const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try { return JSON.parse(lines[index]); } catch (e) { /* try an earlier line */ }
    }
    return null;
}

function runProcess(command, args, options) {
    const timeoutMs = options && options.timeoutMs || DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        let timer;
        let child;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(Object.assign({ code: 1, stdout, stderr, timedOut: false, missing: false }, result));
        };
        try {
            child = spawn(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: Object.assign({}, process.env, options && options.env || {}),
            });
        } catch (error) {
            finish({ missing: error && error.code === 'ENOENT', error });
            return;
        }
        const append = (target, chunk) => {
            const next = target + chunk.toString();
            if (Buffer.byteLength(next) > MAX_PROCESS_OUTPUT) {
                try { child.kill('SIGKILL'); } catch (e) {}
                return target;
            }
            return next;
        };
        child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
        child.once('error', (error) => finish({ missing: error && error.code === 'ENOENT', error }));
        child.once('close', (code) => finish({ code: code == null ? 1 : code }));
        timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) {}
            finish({ code: 1, timedOut: true });
        }, timeoutMs);
    });
}

function defaultPythonCandidates(scriptPath) {
    const pluginDir = path.resolve(path.dirname(scriptPath), '..');
    return [
        process.env.EF_BEAT_PYTHON,
        path.join(path.dirname(scriptPath), '.venv', 'bin', 'python3'),
        path.join(os.homedir(), 'Library', 'Application Support', 'EasyField', 'runtime', 'python', 'bin', 'python3'),
        path.join(pluginDir, '..', '.venv', 'bin', 'python3'),
        'python3',
    ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
}

async function probeBeatRuntime(options) {
    const scriptPath = options && options.scriptPath || path.join(__dirname, 'python', 'beat_detect.py');
    const candidates = options && options.pythonCandidates || defaultPythonCandidates(scriptPath);
    let lastPayload = null;
    for (const python of candidates) {
        if (python.includes(path.sep) && !fs.existsSync(python)) continue;
        const result = await runProcess(python, [scriptPath, '--probe'], { timeoutMs: 15000 });
        const payload = parseProcessJSON(result.stdout);
        if (result.code === 0 && payload && payload.ok === true) {
            return {
                available: true,
                engine: 'librosa',
                engineVersion: typeof payload.engineVersion === 'string' ? payload.engineVersion.slice(0, 40) : 'unknown',
                python,
            };
        }
        if (payload) lastPayload = payload;
    }
    return {
        available: false,
        engine: 'librosa',
        code: 'BEAT_RUNTIME_MISSING',
        error: lastPayload && typeof lastPayload.error === 'string'
            ? lastPayload.error
            : 'The managed librosa runtime is not installed.',
        setupGuide: 'plugin/python/README.md',
    };
}

async function decodeForAnalysis(inputPath, outputPath, ffmpegPath) {
    if (!ffmpegPath) return inputPath;
    const result = await runProcess(ffmpegPath, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
        '-vn', '-ac', '1', '-ar', '44100', outputPath,
    ], { timeoutMs: 120000 });
    if (result.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return outputPath;
    // librosa/soundfile may still understand the original file. Preserve that
    // fallback so a missing ffmpeg does not incorrectly look like missing librosa.
    return inputPath;
}

async function analyzeBeatFile(inputPath, options) {
    const runtime = await probeBeatRuntime(options);
    if (!runtime.available) {
        throw new BeatDetectionError(runtime.error, 'BEAT_RUNTIME_MISSING', 503, { setupGuide: runtime.setupGuide });
    }
    const temporaryWav = path.join(path.dirname(inputPath), 'analysis.wav');
    const analysisPath = await decodeForAnalysis(inputPath, temporaryWav, options && options.ffmpegPath);
    const scriptPath = options && options.scriptPath || path.join(__dirname, 'python', 'beat_detect.py');
    const result = await runProcess(runtime.python, [scriptPath, analysisPath], {
        timeoutMs: options && options.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    const payload = parseProcessJSON(result.stdout);
    if (result.timedOut) throw new BeatDetectionError('Beat analysis timed out.', 'BEAT_ANALYSIS_TIMEOUT', 504);
    if (!payload) throw new BeatDetectionError('librosa returned an unreadable result.', 'BEAT_ANALYSIS_FAILED', 500);
    return normalizeBeatResult(payload);
}

function extensionFromHeader(value) {
    let decoded = '';
    try { decoded = decodeURIComponent(String(value || '')); } catch (e) { decoded = String(value || ''); }
    const extension = path.extname(path.basename(decoded)).toLowerCase();
    return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.media';
}

function receiveRequest(req, destination, maxBytes) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
        req.resume();
        return Promise.reject(new BeatDetectionError('The selected media is too large to analyze.', 'PAYLOAD_TOO_LARGE', 413));
    }
    return new Promise((resolve, reject) => {
        let total = 0;
        let done = false;
        const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
        const fail = (error) => {
            if (done) return;
            done = true;
            output.destroy();
            try { fs.rmSync(destination, { force: true }); } catch (e) {}
            reject(error);
        };
        output.on('error', fail);
        output.on('finish', () => {
            if (done) return;
            done = true;
            resolve(total);
        });
        req.on('aborted', () => fail(new BeatDetectionError('Upload cancelled.', 'UPLOAD_CANCELLED', 499)));
        req.on('error', fail);
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                fail(new BeatDetectionError('The selected media is too large to analyze.', 'PAYLOAD_TOO_LARGE', 413));
                req.destroy();
                return;
            }
            if (!output.write(chunk)) req.pause(), output.once('drain', () => req.resume());
        });
        req.on('end', () => output.end());
    });
}

function createBeatDetectionService(options) {
    const scriptPath = options && options.scriptPath || path.join(__dirname, 'python', 'beat_detect.py');
    const maxBytes = Math.max(1, finite(options && options.maxBytes, DEFAULT_MAX_BYTES));
    const analysisOptions = {
        scriptPath,
        pythonCandidates: options && options.pythonCandidates,
        ffmpegPath: options && options.ffmpegPath,
        timeoutMs: options && options.timeoutMs,
    };
    let statusCache = null;
    let statusCacheAt = 0;

    async function runtimeStatus() {
        if (statusCache && Date.now() - statusCacheAt < 10000) return statusCache;
        statusCache = await probeBeatRuntime(analysisOptions);
        statusCacheAt = Date.now();
        return statusCache;
    }

    function authorize(req, res) {
        return !options || typeof options.authorizeRequest !== 'function' || options.authorizeRequest(req, res);
    }

    function handleRequest(req, res, pathname) {
        if (pathname !== '/api/beat-detect' && pathname !== '/api/beat-detect/status') return false;
        if (!authorize(req, res)) return true;
        const endpointTimeout = Math.max(30000, finite(analysisOptions.timeoutMs, DEFAULT_TIMEOUT_MS) + 30000);
        // Beat tracking can legitimately stay CPU-bound while producing no
        // network traffic. Extend inactivity only for this authenticated route.
        if (typeof req.setTimeout === 'function') req.setTimeout(endpointTimeout);
        if (typeof res.setTimeout === 'function') res.setTimeout(endpointTimeout);

        if (pathname === '/api/beat-detect/status' && req.method === 'GET') {
            runtimeStatus().then((runtime) => {
                // Interpreter paths stay in the main process; the renderer only
                // needs capability/version diagnostics.
                const { python: _python, ...publicRuntime } = runtime;
                sendJSON(res, 200, { ok: true, ...publicRuntime });
            }).catch((error) => {
                sendJSON(res, 500, { ok: false, available: false, code: 'BEAT_RUNTIME_CHECK_FAILED', error: error.message });
            });
            return true;
        }
        if (pathname !== '/api/beat-detect' || req.method !== 'POST') {
            sendJSON(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Use POST to analyze media.' });
            return true;
        }

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-beat-'));
        const input = path.join(dir, 'source' + extensionFromHeader(req.headers['x-ef-file-name']));
        receiveRequest(req, input, maxBytes).then((bytes) => {
            if (!bytes) throw new BeatDetectionError('The selected file is empty.', 'EMPTY_AUDIO', 422);
            return analyzeBeatFile(input, analysisOptions);
        }).then((result) => {
            sendJSON(res, 200, result);
        }).catch((error) => {
            const known = error instanceof BeatDetectionError;
            sendJSON(res, known ? error.status : 500, {
                ok: false,
                code: known ? error.code : 'BEAT_ANALYSIS_FAILED',
                error: error && error.message || 'Beat analysis failed.',
                ...(known && error.details ? error.details : {}),
            });
        }).finally(() => {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
        });
        return true;
    }

    return { handleRequest, runtimeStatus };
}

module.exports = {
    BeatDetectionError,
    analyzeBeatFile,
    createBeatDetectionService,
    normalizeBeatResult,
    probeBeatRuntime,
};
