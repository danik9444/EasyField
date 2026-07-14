'use strict';

// Main-owned local transcription boundary. The renderer can submit raw media
// and a small, validated set of decoding controls, but it can never choose an
// executable, filesystem path, model URL or output path.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ENGINE = 'whisper.cpp';
const MODELS = Object.freeze({
    tiny: Object.freeze({ file: 'ggml-tiny.bin', bytes: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' }),
    base: Object.freeze({ file: 'ggml-base.bin', bytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' }),
    small: Object.freeze({ file: 'ggml-small.bin', bytes: 487601967, sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' }),
    medium: Object.freeze({ file: 'ggml-medium.bin', bytes: 1533763059, sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208' }),
    large: Object.freeze({ file: 'ggml-large-v3.bin', bytes: 3095033483, sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2' }),
    turbo: Object.freeze({ file: 'ggml-large-v3-turbo.bin', bytes: 1624555275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69' }),
});
const MODEL_IDS = Object.freeze(Object.keys(MODELS));
// Canonical language identifiers from OpenAI Whisper's tokenizer, kept in
// token order so this list can be compared directly with upstream. Most are
// ISO 639-1; Whisper also uses the canonical ISO 639-3 identifiers `haw` and
// `yue`. `auto` is an EasyField/whisper.cpp detection mode, not a language.
const WHISPER_LANGUAGES = Object.freeze({
    en: 'english',
    zh: 'chinese',
    de: 'german',
    es: 'spanish',
    ru: 'russian',
    ko: 'korean',
    fr: 'french',
    ja: 'japanese',
    pt: 'portuguese',
    tr: 'turkish',
    pl: 'polish',
    ca: 'catalan',
    nl: 'dutch',
    ar: 'arabic',
    sv: 'swedish',
    it: 'italian',
    id: 'indonesian',
    hi: 'hindi',
    fi: 'finnish',
    vi: 'vietnamese',
    he: 'hebrew',
    uk: 'ukrainian',
    el: 'greek',
    ms: 'malay',
    cs: 'czech',
    ro: 'romanian',
    da: 'danish',
    hu: 'hungarian',
    ta: 'tamil',
    no: 'norwegian',
    th: 'thai',
    ur: 'urdu',
    hr: 'croatian',
    bg: 'bulgarian',
    lt: 'lithuanian',
    la: 'latin',
    mi: 'maori',
    ml: 'malayalam',
    cy: 'welsh',
    sk: 'slovak',
    te: 'telugu',
    fa: 'persian',
    lv: 'latvian',
    bn: 'bengali',
    sr: 'serbian',
    az: 'azerbaijani',
    sl: 'slovenian',
    kn: 'kannada',
    et: 'estonian',
    mk: 'macedonian',
    br: 'breton',
    eu: 'basque',
    is: 'icelandic',
    hy: 'armenian',
    ne: 'nepali',
    mn: 'mongolian',
    bs: 'bosnian',
    kk: 'kazakh',
    sq: 'albanian',
    sw: 'swahili',
    gl: 'galician',
    mr: 'marathi',
    pa: 'punjabi',
    si: 'sinhala',
    km: 'khmer',
    sn: 'shona',
    yo: 'yoruba',
    so: 'somali',
    af: 'afrikaans',
    oc: 'occitan',
    ka: 'georgian',
    be: 'belarusian',
    tg: 'tajik',
    sd: 'sindhi',
    gu: 'gujarati',
    am: 'amharic',
    yi: 'yiddish',
    lo: 'lao',
    uz: 'uzbek',
    fo: 'faroese',
    ht: 'haitian creole',
    ps: 'pashto',
    tk: 'turkmen',
    nn: 'nynorsk',
    mt: 'maltese',
    sa: 'sanskrit',
    lb: 'luxembourgish',
    my: 'myanmar',
    bo: 'tibetan',
    tl: 'tagalog',
    mg: 'malagasy',
    as: 'assamese',
    tt: 'tatar',
    haw: 'hawaiian',
    ln: 'lingala',
    ha: 'hausa',
    ba: 'bashkir',
    jw: 'javanese',
    su: 'sundanese',
    yue: 'cantonese',
});
const WHISPER_LANGUAGE_CODES = Object.freeze(Object.keys(WHISPER_LANGUAGES));
const LANGUAGES = new Set(['auto', ...WHISPER_LANGUAGE_CODES]);
const TASKS = new Set(['transcribe', 'translate']);
const DEFAULT_MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MODEL_DOWNLOAD_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_PROCESS_OUTPUT = 8 * 1024 * 1024;
const MAX_RESULT_JSON_BYTES = 256 * 1024 * 1024;
const MAX_SEGMENTS = 250000;
const MAX_WORDS = 1000000;
const ALLOWED_DOWNLOAD_HOSTS = new Set(['huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co']);

class TranscriptionError extends Error {
    constructor(message, code = 'TRANSCRIPTION_FAILED', status = 500, details) {
        super(message);
        this.name = 'TranscriptionError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function sendJSON(res, status, payload) {
    if (res.headersSent || res.writableEnded) return;
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function safeText(value, max) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}

function boolValue(value, fallback) {
    if (value == null || value === '') return fallback;
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    throw new TranscriptionError('Invalid boolean transcription option.', 'INVALID_OPTIONS', 400);
}

function parseOptions(input) {
    const model = String(input && input.model || 'base').toLowerCase();
    const language = String(input && input.language || 'auto').toLowerCase();
    const task = String(input && input.task || 'transcribe').toLowerCase();
    if (!MODEL_IDS.includes(model)) throw new TranscriptionError('Unsupported Whisper model.', 'INVALID_MODEL', 400);
    if (!LANGUAGES.has(language)) throw new TranscriptionError('Unsupported Whisper language code.', 'INVALID_LANGUAGE', 400);
    if (!TASKS.has(task)) throw new TranscriptionError('Task must be transcribe or translate.', 'INVALID_TASK', 400);
    // Cantonese was added as language token 100 in Whisper large-v3. Earlier
    // model vocabularies contain only the original 99 language tokens.
    if (language === 'yue' && model !== 'large' && model !== 'turbo') {
        throw new TranscriptionError('Cantonese requires Whisper Large v3 or Turbo.', 'UNSUPPORTED_LANGUAGE_MODEL', 400);
    }
    if (model === 'turbo' && task === 'translate') {
        throw new TranscriptionError('Whisper Turbo does not support translation.', 'UNSUPPORTED_TASK', 400);
    }
    const beamSize = Math.round(finite(input && input.beamSize, 5));
    const temperature = finite(input && input.temperature, 0);
    if (beamSize < 1 || beamSize > 10) throw new TranscriptionError('Beam size must be between 1 and 10.', 'INVALID_OPTIONS', 400);
    if (temperature < 0 || temperature > 1) throw new TranscriptionError('Temperature must be between 0 and 1.', 'INVALID_OPTIONS', 400);
    // This value travels in one authenticated request header alongside raw
    // media. Keep even worst-case percent-encoded UTF-8 safely below Node's
    // aggregate header ceiling.
    const initialVocabulary = safeText(input && input.initialVocabulary, 1200).trim();
    if (Buffer.byteLength(initialVocabulary, 'utf8') > 2400) {
        throw new TranscriptionError('Initial vocabulary is too long.', 'INVALID_OPTIONS', 400);
    }
    return Object.freeze({
        model,
        language,
        task,
        wordTimestamps: boolValue(input && input.wordTimestamps, true),
        initialVocabulary,
        beamSize,
        temperature: Math.round(temperature * 1000) / 1000,
        conditionOnPreviousText: boolValue(input && input.conditionOnPreviousText, true),
    });
}

function optionsFromHeaders(headers) {
    const decoded = (name) => {
        const value = headers[name];
        if (value == null) return undefined;
        try { return decodeURIComponent(String(value)); } catch { return String(value); }
    };
    return parseOptions({
        model: decoded('x-ef-whisper-model'),
        language: decoded('x-ef-whisper-language'),
        task: decoded('x-ef-whisper-task'),
        wordTimestamps: decoded('x-ef-whisper-word-timestamps'),
        initialVocabulary: decoded('x-ef-whisper-initial-vocabulary'),
        beamSize: decoded('x-ef-whisper-beam-size'),
        temperature: decoded('x-ef-whisper-temperature'),
        conditionOnPreviousText: decoded('x-ef-whisper-condition-on-previous-text'),
    });
}

function parseJSONBody(req, maxBytes = MAX_JSON_BYTES) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
            req.resume();
            reject(new TranscriptionError('Request body is too large.', 'PAYLOAD_TOO_LARGE', 413));
            return;
        }
        let total = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new TranscriptionError('Request body is too large.', 'PAYLOAD_TOO_LARGE', 413));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('aborted', () => reject(new TranscriptionError('Request cancelled.', 'CANCELLED', 499)));
        req.on('error', reject);
        req.on('end', () => {
            try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
            catch { reject(new TranscriptionError('Invalid JSON request.', 'BAD_REQUEST', 400)); }
        });
    });
}

function receiveMedia(req, destination, maxBytes, signal) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && (declared <= 0 || declared > maxBytes)) {
        req.resume();
        return Promise.reject(new TranscriptionError('Selected media is empty or too large.', 'PAYLOAD_TOO_LARGE', 413));
    }
    return new Promise((resolve, reject) => {
        let total = 0;
        let settled = false;
        const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
        const fail = (error) => {
            if (settled) return;
            settled = true;
            output.destroy();
            try { fs.rmSync(destination, { force: true }); } catch { /* best effort */ }
            reject(error);
        };
        const abort = () => fail(new TranscriptionError('Transcription was cancelled.', 'CANCELLED', 499));
        if (signal) signal.addEventListener('abort', abort, { once: true });
        output.on('error', fail);
        output.on('finish', () => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener('abort', abort);
            if (!total) reject(new TranscriptionError('Selected media is empty.', 'EMPTY_MEDIA', 422));
            else resolve(total);
        });
        req.on('aborted', abort);
        req.on('error', fail);
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                fail(new TranscriptionError('Selected media is too large.', 'PAYLOAD_TOO_LARGE', 413));
                req.destroy();
                return;
            }
            if (!output.write(chunk)) req.pause(), output.once('drain', () => req.resume());
        });
        req.on('end', () => output.end());
    });
}

function childEnvironment(extra) {
    const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'OMP_NUM_THREADS', 'GGML_METAL_PATH_RESOURCES'];
    const env = {};
    for (const name of allowed) {
        if (typeof process.env[name] === 'string') env[name] = process.env[name];
    }
    return Object.assign(env, extra || {});
}

function runProcess(command, args, options = {}) {
    return new Promise((resolve) => {
        let child;
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let timer;
        const timeoutMs = options.timeoutMs || DEFAULT_PROCESS_TIMEOUT_MS;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (options.signal) options.signal.removeEventListener('abort', abort);
            resolve({ code: 1, stdout, stderr, timedOut, cancelled: false, missing: false, ...result });
        };
        const abort = () => {
            try { child && child.kill('SIGKILL'); } catch { /* best effort */ }
            finish({ cancelled: true });
        };
        try {
            child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(options.env) });
        } catch (error) {
            finish({ missing: error && error.code === 'ENOENT', error });
            return;
        }
        const append = (current, chunk) => {
            const next = current + chunk.toString();
            if (Buffer.byteLength(next) > MAX_PROCESS_OUTPUT) {
                try { child.kill('SIGKILL'); } catch { /* best effort */ }
                return current;
            }
            return next;
        };
        child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
        child.once('error', (error) => finish({ missing: error && error.code === 'ENOENT', error }));
        child.once('close', (code) => finish({ code: code == null ? 1 : code }));
        timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch { /* best effort */ }
            finish({ timedOut: true });
        }, timeoutMs);
        if (options.signal) {
            if (options.signal.aborted) abort();
            else options.signal.addEventListener('abort', abort, { once: true });
        }
    });
}

function runtimeCandidates(runtimeRoot, extraCandidates) {
    // An explicit candidate list is dependency injection (used by packaged
    // runtime probes and tests), so do not silently fall through to an
    // unrelated Homebrew/global installation when it is provided.
    if (Array.isArray(extraCandidates)) {
        return extraCandidates.filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
    }
    return [
        process.env.EF_WHISPER_CLI,
        path.join(runtimeRoot, 'bin', 'whisper-cli'),
        path.join(__dirname, 'bin', 'whisper-cli'),
        '/opt/homebrew/bin/whisper-cli',
        '/usr/local/bin/whisper-cli',
        'whisper-cli',
        'whisper-cpp',
    ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
}

async function probeRuntime(options = {}) {
    const candidates = runtimeCandidates(options.runtimeRoot, options.cliCandidates);
    for (const candidate of candidates) {
        if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
        const versionResult = await runProcess(candidate, ['--version'], { timeoutMs: 10000 });
        const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
        const exactVersion = versionOutput.match(/whisper\.cpp\s+version\s*:\s*([0-9][^\s,]*)/i)?.[1];
        if (versionResult.code === 0 && exactVersion) {
            return { available: true, command: candidate, engineVersion: safeText(exactVersion, 80) };
        }
        const result = await runProcess(candidate, ['--help'], { timeoutMs: 10000 });
        const output = `${result.stdout}\n${result.stderr}`;
        if (result.code === 0 && /whisper|usage/i.test(output)) {
            return { available: true, command: candidate, engineVersion: 'available' };
        }
    }
    return { available: false, code: 'WHISPER_RUNTIME_MISSING', error: 'The managed whisper.cpp runtime is not installed.' };
}

function modelPaths(modelRoot, model) {
    const definition = MODELS[model];
    return {
        file: path.join(modelRoot, definition.file),
        marker: path.join(modelRoot, `.easyfield-${model}.ready.json`),
    };
}

function modelReady(modelRoot, model) {
    const definition = MODELS[model];
    const paths = modelPaths(modelRoot, model);
    try {
        const marker = JSON.parse(fs.readFileSync(paths.marker, 'utf8'));
        const stat = fs.statSync(paths.file);
        return stat.isFile() && stat.size === definition.bytes && marker.sha256 === definition.sha256 && marker.bytes === definition.bytes;
    } catch { return false; }
}

function publicModelState(modelRoot, downloading) {
    return Object.fromEntries(MODEL_IDS.map((model) => [model, {
        state: downloading.has(model) ? 'downloading' : modelReady(modelRoot, model) ? 'ready' : 'missing',
        bytes: MODELS[model].bytes,
    }]));
}

function downloadURL(model) {
    return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODELS[model].file}`;
}

function safeDownloadURL(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname) && !url.hostname.endsWith('.xethub.hf.co') && !url.hostname.endsWith('.cdn.hf.co'))) {
        throw new TranscriptionError('Model download redirected to an untrusted host.', 'MODEL_DOWNLOAD_FAILED', 502);
    }
    return url;
}

function streamDownload(urlValue, destination, expected, signal, redirects = 0) {
    return new Promise((resolve, reject) => {
        let request;
        const fail = (error) => {
            try { request && request.destroy(); } catch { /* best effort */ }
            reject(error);
        };
        let url;
        try { url = safeDownloadURL(urlValue); } catch (error) { reject(error); return; }
        request = https.get(url, { headers: { 'User-Agent': 'EasyField/1.1 local-model-manager' }, timeout: 30000 }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirects >= 6) return fail(new TranscriptionError('Too many model download redirects.', 'MODEL_DOWNLOAD_FAILED', 502));
                let next;
                try { next = new URL(response.headers.location, url).toString(); } catch { return fail(new TranscriptionError('Invalid model download redirect.', 'MODEL_DOWNLOAD_FAILED', 502)); }
                streamDownload(next, destination, expected, signal, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                return fail(new TranscriptionError(`Model download failed (${response.statusCode}).`, 'MODEL_DOWNLOAD_FAILED', 502));
            }
            const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
            const hash = crypto.createHash('sha256');
            let bytes = 0;
            let settled = false;
            const stop = (error) => {
                if (settled) return;
                settled = true;
                output.destroy();
                response.destroy();
                try { fs.rmSync(destination, { force: true }); } catch { /* best effort */ }
                reject(error);
            };
            const abort = () => stop(new TranscriptionError('Model download cancelled.', 'CANCELLED', 499));
            if (signal) signal.addEventListener('abort', abort, { once: true });
            response.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > expected.bytes) return stop(new TranscriptionError('Model download exceeded its signed size.', 'MODEL_DOWNLOAD_FAILED', 502));
                hash.update(chunk);
            });
            response.on('error', stop);
            output.on('error', stop);
            response.pipe(output);
            output.on('finish', () => {
                if (settled) return;
                settled = true;
                if (signal) signal.removeEventListener('abort', abort);
                const digest = hash.digest('hex');
                if (bytes !== expected.bytes || digest !== expected.sha256) {
                    try { fs.rmSync(destination, { force: true }); } catch { /* best effort */ }
                    reject(new TranscriptionError('Model checksum verification failed.', 'MODEL_CHECKSUM_FAILED', 502));
                    return;
                }
                resolve({ bytes, sha256: digest });
            });
        });
        request.on('timeout', () => fail(new TranscriptionError('Model download timed out.', 'MODEL_DOWNLOAD_TIMEOUT', 504)));
        request.on('error', fail);
        if (signal) {
            const abort = () => fail(new TranscriptionError('Model download cancelled.', 'CANCELLED', 499));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
        }
    });
}

async function downloadModel(modelRoot, model, signal) {
    const definition = MODELS[model];
    fs.mkdirSync(modelRoot, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(modelRoot, 0o700); } catch { /* best effort */ }
    if (modelReady(modelRoot, model)) return { bytes: definition.bytes, alreadyReady: true };
    try {
        const stats = fs.statfsSync(modelRoot);
        const free = Number(stats.bavail) * Number(stats.bsize);
        if (Number.isFinite(free) && free < definition.bytes + 256 * 1024 * 1024) {
            throw new TranscriptionError('Not enough free disk space for this Whisper model.', 'DISK_FULL', 507);
        }
    } catch (error) {
        if (error instanceof TranscriptionError) throw error;
    }
    const paths = modelPaths(modelRoot, model);
    const partial = `${paths.file}.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.rmSync(paths.marker, { force: true });
        fs.rmSync(paths.file, { force: true });
        const verified = await streamDownload(downloadURL(model), partial, definition, signal);
        fs.renameSync(partial, paths.file);
        fs.writeFileSync(paths.marker, JSON.stringify({ schemaVersion: 1, model, bytes: verified.bytes, sha256: verified.sha256 }), { flag: 'wx', mode: 0o600 });
        return { bytes: verified.bytes, alreadyReady: false };
    } finally {
        try { fs.rmSync(partial, { force: true }); } catch { /* best effort */ }
    }
}

function milliseconds(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeTranscription(payload, options) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.transcription)) {
        throw new TranscriptionError('whisper.cpp returned an invalid result.', 'INVALID_TRANSCRIPTION_RESULT', 500);
    }
    if (payload.transcription.length > MAX_SEGMENTS) throw new TranscriptionError('Transcription result is too large.', 'RESULT_TOO_LARGE', 500);
    const segments = [];
    const words = [];
    let lastSegmentStart = -1;
    let lastWordStart = -1;
    for (let index = 0; index < payload.transcription.length; index += 1) {
        const raw = payload.transcription[index] || {};
        const startMs = milliseconds(raw.offsets && raw.offsets.from);
        const endMs = milliseconds(raw.offsets && raw.offsets.to);
        const text = safeText(raw.text, 20000);
        if (startMs == null || endMs == null || endMs < startMs || startMs < lastSegmentStart) {
            throw new TranscriptionError('whisper.cpp returned invalid segment timestamps.', 'INVALID_TRANSCRIPTION_RESULT', 500);
        }
        lastSegmentStart = startMs;
        const segmentWords = [];
        if (options.wordTimestamps && Array.isArray(raw.tokens)) {
            for (const token of raw.tokens) {
                const word = safeText(token && token.text, 500);
                const wordStart = milliseconds(token && token.offsets && token.offsets.from);
                const wordEnd = milliseconds(token && token.offsets && token.offsets.to);
                const trimmedWord = word.trim();
                if (!trimmedWord || /^\[_[A-Z0-9_]+\]$/i.test(trimmedWord) || wordStart == null || wordEnd == null || wordEnd < wordStart) continue;
                if (wordStart < lastWordStart) throw new TranscriptionError('whisper.cpp returned unordered word timestamps.', 'INVALID_TRANSCRIPTION_RESULT', 500);
                lastWordStart = wordStart;
                const normalized = {
                    id: `w-${words.length + 1}`,
                    text: word,
                    startSeconds: Math.round(wordStart) / 1000,
                    endSeconds: Math.round(wordEnd) / 1000,
                    confidence: Math.round(clamp(finite(token.p, 0), 0, 1) * 10000) / 10000,
                };
                words.push(normalized);
                segmentWords.push(normalized.id);
                if (words.length > MAX_WORDS) throw new TranscriptionError('Transcription contains too many words.', 'RESULT_TOO_LARGE', 500);
            }
        }
        if (!text.trim() && !segmentWords.length) continue;
        segments.push({
            id: `s-${index + 1}`,
            text,
            startSeconds: Math.round(startMs) / 1000,
            endSeconds: Math.round(endMs) / 1000,
            wordIds: segmentWords,
        });
    }
    const language = safeText(payload.result && payload.result.language, 16).toLowerCase() || options.language;
    const text = segments.map((segment) => segment.text).join('').trim();
    return {
        ok: true,
        engine: ENGINE,
        model: options.model,
        language,
        task: options.task,
        text: text.slice(0, 20 * 1024 * 1024),
        durationSeconds: segments.length ? segments[segments.length - 1].endSeconds : 0,
        segments,
        words,
    };
}

function readWhisperResultJson(filePath) {
    const invalid = () => new TranscriptionError(
        'Whisper result is empty, too large, or invalid.',
        'INVALID_TRANSCRIPTION_RESULT',
        500,
    );
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const closeOnExec = typeof fs.constants.O_CLOEXEC === 'number' ? fs.constants.O_CLOEXEC : 0;
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | closeOnExec);
        const before = fs.fstatSync(descriptor);
        if (!noFollow) {
            const pathStat = fs.lstatSync(filePath);
            if (pathStat.isSymbolicLink() || pathStat.dev !== before.dev || pathStat.ino !== before.ino) throw invalid();
        }
        if (!before.isFile() || before.size <= 0 || before.size > MAX_RESULT_JSON_BYTES) throw invalid();
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (!after.isFile() || bytes.length !== before.size || after.size !== before.size
            || after.dev !== before.dev || after.ino !== before.ino
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw invalid();
        }
        try {
            return JSON.parse(bytes.toString('utf8'));
        } catch {
            throw invalid();
        }
    } catch (error) {
        if (error instanceof TranscriptionError) throw error;
        throw invalid();
    } finally {
        if (descriptor != null) fs.closeSync(descriptor);
    }
}

function createTranscriptionService(options = {}) {
    const runtimeRoot = options.runtimeRoot || path.join(os.homedir(), 'Library', 'Application Support', 'EasyField', 'runtime', 'whisper');
    const modelRoot = options.modelRoot || path.join(os.homedir(), 'Library', 'Application Support', 'EasyField', 'models', 'whisper');
    const ffmpegPath = options.ffmpegPath || 'ffmpeg';
    const maxBytes = Math.max(1, finite(options.maxBytes, DEFAULT_MAX_MEDIA_BYTES));
    const timeoutMs = Math.max(30000, finite(options.timeoutMs, DEFAULT_PROCESS_TIMEOUT_MS));
    const modelDownloadTimeoutMs = Math.max(30000, finite(options.modelDownloadTimeoutMs, DEFAULT_MODEL_DOWNLOAD_TIMEOUT_MS));
    const downloading = new Map();
    let installState = 'unavailable';

    const authorize = (req, res) => !options.authorizeRequest || options.authorizeRequest(req, res);
    const operationSignal = (req, res) => {
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        req.once('aborted', abort);
        res.once('close', abort);
        return controller;
    };

    const status = async () => {
        const runtime = await probeRuntime({ runtimeRoot, cliCandidates: options.cliCandidates });
        return {
            ok: true,
            engine: ENGINE,
            runtime: {
                state: runtime.available ? 'ready' : installState,
                available: runtime.available,
                installable: false,
                engineVersion: runtime.available ? runtime.engineVersion : undefined,
                code: runtime.available ? undefined : runtime.code,
                error: runtime.available ? undefined : runtime.error,
            },
            models: publicModelState(modelRoot, downloading),
        };
    };

    const handleStatus = (res) => status().then((payload) => sendJSON(res, 200, payload)).catch((error) => {
        void error;
        sendJSON(res, 500, { ok: false, code: 'RUNTIME_CHECK_FAILED', error: 'Could not check Whisper runtime.' });
    });

    const handleInstall = (req, res) => {
        req.resume();
        installState = 'unavailable';
        sendJSON(res, 409, {
            ok: false,
            code: 'RUNTIME_PACK_UNAVAILABLE',
            error: 'A checksum-verified whisper.cpp runtime pack is not published for this EasyField build.',
            requiresAdmin: false,
        });
    };

    const handleModelDownload = async (req, res) => {
        const body = await parseJSONBody(req);
        const model = String(body && body.model || '').toLowerCase();
        if (!MODEL_IDS.includes(model)) throw new TranscriptionError('Unsupported Whisper model.', 'INVALID_MODEL', 400);
        if (downloading.has(model)) throw new TranscriptionError('This Whisper model is already downloading.', 'MODEL_DOWNLOAD_ACTIVE', 409);
        const controller = operationSignal(req, res);
        let timedOut = false;
        const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, modelDownloadTimeoutMs);
        const task = (options.downloadModel || downloadModel)(modelRoot, model, controller.signal);
        downloading.set(model, task);
        try {
            const result = await task;
            sendJSON(res, 200, { ok: true, model, state: 'ready', bytes: result.bytes, alreadyReady: !!result.alreadyReady });
        } catch (error) {
            if (timedOut) throw new TranscriptionError('Model download timed out.', 'MODEL_DOWNLOAD_TIMEOUT', 504);
            throw error;
        } finally {
            clearTimeout(deadline);
            downloading.delete(model);
        }
    };

    const handleTranscription = async (req, res) => {
        const transcriptionOptions = optionsFromHeaders(req.headers);
        if (!modelReady(modelRoot, transcriptionOptions.model) && !options.allowUnmarkedModels) {
            throw new TranscriptionError('Download and verify this Whisper model before transcription.', 'MODEL_NOT_READY', 409);
        }
        const runtime = await probeRuntime({ runtimeRoot, cliCandidates: options.cliCandidates });
        if (!runtime.available) throw new TranscriptionError(runtime.error, runtime.code, 503);
        const controller = operationSignal(req, res);
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-transcribe-'));
        const input = path.join(temporary, 'source.media');
        const audio = path.join(temporary, 'audio.wav');
        const outputBase = path.join(temporary, 'result');
        try {
            await receiveMedia(req, input, maxBytes, controller.signal);
            const decoded = await runProcess(ffmpegPath, [
                '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio,
            ], { signal: controller.signal, timeoutMs: Math.min(timeoutMs, 15 * 60 * 1000) });
            if (decoded.cancelled) throw new TranscriptionError('Transcription cancelled.', 'CANCELLED', 499);
            if (decoded.timedOut) throw new TranscriptionError('Media decoding timed out.', 'MEDIA_DECODE_TIMEOUT', 504);
            if (decoded.code !== 0 || !fs.existsSync(audio) || fs.statSync(audio).size <= 44) {
                throw new TranscriptionError('Selected media could not be decoded as audio.', 'UNSUPPORTED_MEDIA', 422);
            }
            const args = [
                '-m', modelPaths(modelRoot, transcriptionOptions.model).file,
                '-f', audio,
                '-l', transcriptionOptions.language,
                '-bs', String(transcriptionOptions.beamSize),
                '-tp', String(transcriptionOptions.temperature),
                '-tpi', '0',
                '-ojf', '-of', outputBase, '-np',
            ];
            if (transcriptionOptions.task === 'translate') args.push('-tr');
            // Keep editorially useful phrase-sized segments while asking the
            // CLI to break only at word boundaries. Token offsets in JSON are
            // still normalized into precise word timestamps below.
            if (transcriptionOptions.wordTimestamps) args.push('-ml', '84', '-sow');
            if (transcriptionOptions.initialVocabulary) args.push('--prompt', transcriptionOptions.initialVocabulary);
            if (!transcriptionOptions.conditionOnPreviousText) args.push('-mc', '0');
            const result = await runProcess(runtime.command, args, { signal: controller.signal, timeoutMs });
            if (result.cancelled) throw new TranscriptionError('Transcription cancelled.', 'CANCELLED', 499);
            if (result.timedOut) throw new TranscriptionError('Whisper transcription timed out.', 'TRANSCRIPTION_TIMEOUT', 504);
            if (result.code !== 0) throw new TranscriptionError('whisper.cpp could not transcribe this media.', 'TRANSCRIPTION_FAILED', 500);
            const jsonPath = `${outputBase}.json`;
            const payload = readWhisperResultJson(jsonPath);
            sendJSON(res, 200, normalizeTranscription(payload, transcriptionOptions));
        } finally {
            try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    };

    function handleRequest(req, res, pathname) {
        if (!pathname.startsWith('/api/transcribe')) return false;
        if (!authorize(req, res)) return true;
        const run = (operation) => Promise.resolve().then(operation).catch((error) => {
            const known = error instanceof TranscriptionError;
            sendJSON(res, known ? error.status : 500, {
                ok: false,
                code: known ? error.code : 'TRANSCRIPTION_FAILED',
                error: known ? safeText(error.message, 1000) : 'Transcription failed.',
                ...(known && error.details ? error.details : {}),
            });
        });
        if (pathname === '/api/transcribe/status' && req.method === 'GET') return void handleStatus(res), true;
        if (pathname === '/api/transcribe/runtime/install' && req.method === 'POST') return void run(() => handleInstall(req, res)), true;
        if (pathname === '/api/transcribe/model/download' && req.method === 'POST') return void run(() => handleModelDownload(req, res)), true;
        if (pathname === '/api/transcribe' && req.method === 'POST') return void run(() => handleTranscription(req, res)), true;
        sendJSON(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Unsupported transcription method.' });
        return true;
    }

    return Object.freeze({ handleRequest, status });
}

module.exports = {
    ENGINE,
    MODELS,
    MODEL_IDS,
    WHISPER_LANGUAGES,
    WHISPER_LANGUAGE_CODES,
    TranscriptionError,
    createTranscriptionService,
    normalizeTranscription,
    optionsFromHeaders,
    parseOptions,
    probeRuntime,
    readWhisperResultJson,
    runProcess,
};
