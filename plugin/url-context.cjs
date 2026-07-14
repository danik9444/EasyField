// Safe, read-only website context for the Animations workspace.
//
// This module deliberately uses only Node built-ins because the installed
// Resolve Workflow Integration plugin does not ship node_modules.  The same
// service is loaded by Vite in development, so both runtimes enforce one SSRF
// and response-sanitisation boundary.

const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 24_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REDIRECTS = 4;
const REQUEST_BODY_LIMIT = 4 * 1024;
const MAX_URL_LENGTH = 4_096;

class UrlContextError extends Error {
    constructor(message, code, status) {
        super(message);
        this.name = 'UrlContextError';
        this.code = code;
        this.status = status || 500;
    }
}

// Public pages can legitimately use either IP family.  Reject all local,
// private, documentation, multicast and reserved ranges, and pin each request
// to the exact public DNS answer that was validated.
const BLOCKED_IPS = new net.BlockList();
[
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
    ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([address, prefix]) => BLOCKED_IPS.addSubnet(address, prefix, 'ipv4'));
BLOCKED_IPS.addAddress('::', 'ipv6');
BLOCKED_IPS.addAddress('::1', 'ipv6');
BLOCKED_IPS.addSubnet('64:ff9b::', 96, 'ipv6');
BLOCKED_IPS.addSubnet('64:ff9b:1::', 48, 'ipv6');
BLOCKED_IPS.addSubnet('100::', 64, 'ipv6');
BLOCKED_IPS.addSubnet('2001:db8::', 32, 'ipv6');
BLOCKED_IPS.addSubnet('2002::', 16, 'ipv6');
BLOCKED_IPS.addSubnet('fc00::', 7, 'ipv6');
BLOCKED_IPS.addSubnet('fe80::', 10, 'ipv6');
BLOCKED_IPS.addSubnet('fec0::', 10, 'ipv6');
BLOCKED_IPS.addSubnet('ff00::', 8, 'ipv6');

const RESERVED_HOST_SUFFIXES = [
    '.localhost', '.local', '.internal', '.invalid', '.test', '.example', '.home.arpa',
];

function isReservedHostname(hostname) {
    const value = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return !value
        || value === 'localhost'
        || value === 'local'
        || value === 'internal'
        || value === 'invalid'
        || value === 'test'
        || value === 'example'
        || value === 'home.arpa'
        || RESERVED_HOST_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

function assertSafeAddress(address, family) {
    const ipFamily = Number(family) || net.isIP(address);
    const familyName = ipFamily === 6 ? 'ipv6' : ipFamily === 4 ? 'ipv4' : null;
    const mappedIpv4 = String(address).toLowerCase().startsWith('::ffff:');
    if (!familyName || mappedIpv4 || BLOCKED_IPS.check(address, familyName)) {
        throw new UrlContextError(
            'URL resolves to a private or reserved network address.',
            'UNSAFE_URL',
            400,
        );
    }
}

function parsePublicHttpsUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
        throw new UrlContextError('Enter a valid HTTPS URL.', 'BAD_REQUEST', 400);
    }
    let parsed;
    try { parsed = new URL(rawUrl); } catch {
        throw new UrlContextError('Enter a valid HTTPS URL.', 'BAD_REQUEST', 400);
    }
    if (
        parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || (parsed.port && parsed.port !== '443')
    ) {
        throw new UrlContextError(
            'Only public HTTPS URLs without credentials or custom ports are supported.',
            'UNSAFE_URL',
            400,
        );
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(hostname) || isReservedHostname(hostname)) {
        throw new UrlContextError('This URL host is not allowed.', 'UNSAFE_URL', 400);
    }
    // Fragments are never sent over HTTP and needlessly leak renderer-only
    // state into returned metadata.
    parsed.hash = '';
    return parsed;
}

async function resolvePublicTarget(rawUrl, lookup) {
    const parsed = parsePublicHttpsUrl(rawUrl);
    let addresses;
    try {
        addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    } catch {
        throw new UrlContextError('The website host could not be resolved.', 'URL_FETCH_FAILED', 502);
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new UrlContextError('The website host could not be resolved.', 'URL_FETCH_FAILED', 502);
    }
    for (const item of addresses) assertSafeAddress(item && item.address, item && item.family);
    const address = addresses[0];
    return { parsed, address: { address: address.address, family: Number(address.family) || net.isIP(address.address) } };
}

function parseContentType(header) {
    const raw = String(header || '');
    const mediaType = raw.split(';', 1)[0].trim().toLowerCase();
    const allowed = mediaType === 'text/html'
        || mediaType === 'text/plain'
        || mediaType === 'application/xhtml+xml';
    if (!allowed) {
        throw new UrlContextError(
            'The URL must return an HTML or plain-text page.',
            'UNSUPPORTED_CONTENT_TYPE',
            415,
        );
    }
    const charsetMatch = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(raw);
    return { mediaType, charset: charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8' };
}

function decodeBytes(bytes, charset) {
    const normalized = charset === 'utf8' ? 'utf-8' : charset;
    const supported = new Set(['utf-8', 'us-ascii', 'iso-8859-1', 'windows-1252']);
    try {
        return new TextDecoder(supported.has(normalized) ? normalized : 'utf-8', { fatal: false }).decode(bytes);
    } catch {
        return Buffer.from(bytes).toString('utf8');
    }
}

const NAMED_ENTITIES = Object.freeze({
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
    copy: '©', reg: '®', trade: '™', ndash: '–', mdash: '—', hellip: '…',
    laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
});

function decodeHtmlEntities(value) {
    return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (whole, entity) => {
        if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? ' ';
        const hexadecimal = entity[1] && entity[1].toLowerCase() === 'x';
        const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
            return '�';
        }
        return String.fromCodePoint(codePoint);
    });
}

function normalizePlainText(value) {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .replace(/[\t\f\v ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function htmlToPlainText(html) {
    // Decode before stripping tags so markup deliberately hidden as entities
    // cannot cross this boundary as HTML-looking output. Repeat once for the
    // common double-encoded case, then strip again after the final decode.
    const decodedHtml = decodeHtmlEntities(decodeHtmlEntities(String(html || '')));
    const withoutHiddenContent = decodedHtml
        .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
        .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, ' ')
        .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
        .replace(/<(br|hr)\b[^>]*\/?\s*>/gi, '\n')
        .replace(/<\/?(address|article|aside|blockquote|div|dl|dt|dd|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi, '\n')
        .replace(/<[^>]*>/g, ' ');
    return normalizePlainText(decodeHtmlEntities(withoutHiddenContent).replace(/<[^>]*>/g, ' '));
}

function extractTitle(html) {
    const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html || ''));
    return match ? htmlToPlainText(match[1]).slice(0, 240) : '';
}

function sanitizeResponse(bytes, contentType, maxTextChars) {
    const parsedType = parseContentType(contentType);
    const decoded = decodeBytes(bytes, parsedType.charset);
    const isHtml = parsedType.mediaType === 'text/html' || parsedType.mediaType === 'application/xhtml+xml';
    const unboundedText = isHtml ? htmlToPlainText(decoded) : normalizePlainText(decoded);
    const truncated = unboundedText.length > maxTextChars;
    return {
        title: isHtml ? extractTitle(decoded) : '',
        text: truncated ? unboundedText.slice(0, maxTextChars).trimEnd() : unboundedText,
        contentType: parsedType.mediaType,
        truncated,
    };
}

function createUrlContextFetcher(options) {
    options = options || {};
    const lookup = options.lookup || dns.lookup.bind(dns);
    const requestImpl = options.request || https.request.bind(https);
    const maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    const maxTextChars = positiveInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const maxRedirects = nonnegativeInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS);

    function fetchUrlContext(sourceUrl) {
        const state = { deadline: Date.now() + timeoutMs, cancelled: false, activeRequest: null };
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                state.cancelled = true;
                const error = new UrlContextError('The website request timed out.', 'URL_TIMEOUT', 504);
                if (state.activeRequest && typeof state.activeRequest.destroy === 'function') {
                    state.activeRequest.destroy(error);
                }
                reject(error);
            }, timeoutMs);
        });
        // The outer deadline includes DNS resolution. If a resolver returns
        // after the deadline, `requestPage` observes cancelled and never opens a
        // socket, avoiding a delayed background request after the UI timed out.
        return Promise.race([
            requestPage(sourceUrl, sourceUrl, maxRedirects, state),
            timeout,
        ]).finally(() => clearTimeout(timer));
    }

    async function requestPage(sourceUrl, currentUrl, redirectsLeft, state) {
        const target = await resolvePublicTarget(currentUrl, lookup);
        const remainingMs = state.deadline - Date.now();
        if (state.cancelled || remainingMs <= 0) throw new UrlContextError('The website request timed out.', 'URL_TIMEOUT', 504);

        const response = await new Promise((resolve, reject) => {
            let settled = false;
            let totalTimer;
            let request;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(totalTimer);
                if (state.activeRequest === request) state.activeRequest = null;
                if (error) reject(error);
                else resolve(value);
            };
            request = requestImpl({
                protocol: 'https:',
                hostname: target.parsed.hostname,
                port: 443,
                path: target.parsed.pathname + target.parsed.search,
                servername: target.parsed.hostname,
                family: target.address.family,
                lookup: (_hostname, _options, callback) => callback(null, target.address.address, target.address.family),
                rejectUnauthorized: true,
                method: 'GET',
                headers: {
                    Accept: 'text/html, application/xhtml+xml, text/plain;q=0.9',
                    'Accept-Encoding': 'identity',
                    'User-Agent': 'EasyField/1.0 URL Context',
                },
            }, (incoming) => {
                const statusCode = Number(incoming.statusCode || 0);
                const location = incoming.headers && incoming.headers.location;
                if ([301, 302, 303, 307, 308].includes(statusCode)) {
                    incoming.resume();
                    if (!location) {
                        finish(new UrlContextError('The website returned an invalid redirect.', 'URL_FETCH_FAILED', 502));
                        return;
                    }
                    if (redirectsLeft <= 0) {
                        finish(new UrlContextError('The website redirected too many times.', 'TOO_MANY_REDIRECTS', 502));
                        return;
                    }
                    let next;
                    try { next = new URL(location, target.parsed).toString(); } catch {
                        finish(new UrlContextError('The website returned an invalid redirect.', 'URL_FETCH_FAILED', 502));
                        return;
                    }
                    finish(null, { redirect: next });
                    return;
                }
                if (statusCode < 200 || statusCode >= 300) {
                    incoming.resume();
                    finish(new UrlContextError(`The website returned HTTP ${statusCode || 'error'}.`, 'URL_FETCH_FAILED', 502));
                    return;
                }
                try {
                    parseContentType(incoming.headers && incoming.headers['content-type']);
                    const encoding = String(incoming.headers && incoming.headers['content-encoding'] || '').trim().toLowerCase();
                    if (encoding && encoding !== 'identity') {
                        throw new UrlContextError('Compressed website responses are not accepted.', 'UNSUPPORTED_CONTENT_ENCODING', 415);
                    }
                    const declared = Number(incoming.headers && incoming.headers['content-length']);
                    if (Number.isFinite(declared) && declared > maxResponseBytes) {
                        throw new UrlContextError('The website response is too large.', 'RESPONSE_TOO_LARGE', 413);
                    }
                } catch (error) {
                    incoming.resume();
                    finish(error);
                    return;
                }
                const chunks = [];
                let bytes = 0;
                incoming.on('data', (chunk) => {
                    if (settled) return;
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bytes += buffer.length;
                    if (bytes > maxResponseBytes) {
                        incoming.destroy();
                        finish(new UrlContextError('The website response is too large.', 'RESPONSE_TOO_LARGE', 413));
                        return;
                    }
                    chunks.push(buffer);
                });
                incoming.on('end', () => finish(null, {
                    bytes: Buffer.concat(chunks, bytes),
                    contentType: incoming.headers['content-type'],
                    finalUrl: target.parsed.toString(),
                }));
                incoming.on('error', () => finish(new UrlContextError('The website response could not be read.', 'URL_FETCH_FAILED', 502)));
            });
            if (!settled) state.activeRequest = request;
            request.on('error', (error) => finish(
                error instanceof UrlContextError
                    ? error
                    : new UrlContextError('The website could not be fetched.', 'URL_FETCH_FAILED', 502),
            ));
            if (typeof request.setTimeout === 'function') {
                request.setTimeout(Math.min(remainingMs, timeoutMs), () => request.destroy(
                    new UrlContextError('The website request timed out.', 'URL_TIMEOUT', 504),
                ));
            }
            totalTimer = setTimeout(() => request.destroy(
                new UrlContextError('The website request timed out.', 'URL_TIMEOUT', 504),
            ), remainingMs);
            if (typeof request.end === 'function') request.end();
        });

        if (response.redirect) return requestPage(sourceUrl, response.redirect, redirectsLeft - 1, state);
        const sanitized = sanitizeResponse(response.bytes, response.contentType, maxTextChars);
        return {
            sourceUrl: parsePublicHttpsUrl(sourceUrl).toString(),
            finalUrl: response.finalUrl,
            title: sanitized.title,
            text: sanitized.text,
            contentType: sanitized.contentType,
            truncated: sanitized.truncated,
        };
    }

    return Object.freeze({ fetch: fetchUrlContext });
}

function positiveInteger(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonnegativeInteger(value, fallback) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function sendJson(response, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
}

function readJsonBody(request) {
    const contentType = String(request.headers && request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
        return Promise.reject(new UrlContextError('Send an application/json request.', 'BAD_REQUEST', 400));
    }
    const declared = Number(request.headers && request.headers['content-length']);
    if (Number.isFinite(declared) && declared > REQUEST_BODY_LIMIT) {
        return Promise.reject(new UrlContextError('Request body is too large.', 'BAD_REQUEST', 413));
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let failed = false;
        request.on('data', (chunk) => {
            if (failed) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > REQUEST_BODY_LIMIT) {
                failed = true;
                chunks.length = 0;
                reject(new UrlContextError('Request body is too large.', 'BAD_REQUEST', 413));
                return;
            }
            chunks.push(buffer);
        });
        request.on('end', () => {
            if (failed) return;
            try { resolve(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))); }
            catch { reject(new UrlContextError('Request body must be valid JSON.', 'BAD_REQUEST', 400)); }
        });
        request.on('error', () => reject(new UrlContextError('Request body could not be read.', 'BAD_REQUEST', 400)));
    });
}

function createUrlContextService(options) {
    options = options || {};
    const fetcher = options.fetcher || createUrlContextFetcher(options);
    const authorizeRequest = options.authorizeRequest;
    return Object.freeze({
        handleRequest(request, response, pathname) {
            if (pathname !== '/api/url-context') return false;
            if (authorizeRequest && !authorizeRequest(request, response)) return true;
            if (request.method !== 'POST') {
                sendJson(response, 405, { ok: false, error: 'POST only', code: 'METHOD_NOT_ALLOWED' });
                return true;
            }
            void readJsonBody(request).then(async (body) => {
                if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.url !== 'string') {
                    throw new UrlContextError('Request must contain a URL.', 'BAD_REQUEST', 400);
                }
                const context = await fetcher.fetch(body.url);
                sendJson(response, 200, { ok: true, context });
            }).catch((error) => {
                if (response.headersSent) {
                    response.destroy();
                    return;
                }
                const safeError = error instanceof UrlContextError
                    ? error
                    : new UrlContextError('The website could not be fetched.', 'URL_FETCH_FAILED', 502);
                sendJson(response, safeError.status, { ok: false, error: safeError.message, code: safeError.code });
            });
            return true;
        },
    });
}

module.exports = {
    UrlContextError,
    createUrlContextFetcher,
    createUrlContextService,
    htmlToPlainText,
    parsePublicHttpsUrl,
    resolvePublicTarget,
    sanitizeResponse,
};
