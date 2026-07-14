// Secure updater for the Resolve Workflow Integration plugin.
// The renderer can only ask Main to check/install; it never supplies a path,
// URL, command, destination, or checksum. The source descriptor is installed
// root-owned with the plugin. Local development releases use a fixed directory;
// public releases use a fixed GitHub feed and an Ed25519 publisher key.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const https = require('https');

const PLUGIN_ID = 'com.easyfield.panel';
const MANIFEST_NAME = 'update-manifest.json';
const SOURCE_NAME = '.easyfield-update-source.json';
const DESTINATION_ROOT = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins';
const DESTINATION = path.join(DESTINATION_ROOT, PLUGIN_ID);
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RELEASE_FILES = 20000;
const MAX_RELEASE_NOTES = 4000;
const MAX_REMOTE_REDIRECTS = 6;
const REMOTE_REQUEST_TIMEOUT_MS = 30 * 1000;
const REMOTE_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const REMOTE_FEED_NAME = 'easyfield-update.json';
const ALLOWED_REMOTE_HOSTS = new Set([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
]);
const REQUIRED_FILES = Object.freeze([
    'animation-render.cjs',
    'audio-capture.cjs',
    'beat-detection.cjs',
    'beat-markers.cjs',
    'edit-image-capture.cjs',
    'edit-video-capture.cjs',
    'whisper-transcription.cjs',
    'main.cjs',
    'manifest.xml',
    'package.json',
    'plugin-updater.cjs',
    'preload.cjs',
    'python/beat_detect.py',
    'state-store.cjs',
    'timeline-capture.cjs',
    'timecode.cjs',
    'ui/index.html',
    'url-context.cjs',
    'workflow-integration.cjs',
]);

function readVerifiedRegularFile(filePath, options = {}) {
    const errorMessage = options.errorMessage || 'Invalid file';
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const closeOnExec = typeof fs.constants.O_CLOEXEC === 'number' ? fs.constants.O_CLOEXEC : 0;
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow | closeOnExec);
        const before = fs.fstatSync(descriptor);
        // O_NOFOLLOW is not available on every Node platform. In that case,
        // compare the opened inode with the path after opening so a symlink or
        // path swap can never make validation apply to a different file.
        if (!noFollow) {
            const pathStat = fs.lstatSync(filePath);
            if (pathStat.isSymbolicLink() || pathStat.dev !== before.dev || pathStat.ino !== before.ino) {
                throw new Error(errorMessage);
            }
        }
        const minBytes = options.minBytes == null ? 0 : options.minBytes;
        const maxBytes = options.maxBytes == null ? Number.MAX_SAFE_INTEGER : options.maxBytes;
        if (!before.isFile() || before.size < minBytes || before.size > maxBytes
            || (options.expectedBytes != null && before.size !== options.expectedBytes)) {
            throw new Error(errorMessage);
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor);
        if (!after.isFile() || bytes.length !== before.size || after.size !== before.size
            || after.dev !== before.dev || after.ino !== before.ino
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw new Error(errorMessage);
        }
        if (options.expectedSha256 != null
            && crypto.createHash('sha256').update(bytes).digest('hex') !== options.expectedSha256) {
            throw new Error(errorMessage);
        }
        return bytes;
    } catch (error) {
        if (error && error.message === errorMessage) throw error;
        throw new Error(errorMessage, { cause: error });
    } finally {
        if (descriptor != null) fs.closeSync(descriptor);
    }
}

function safeReadJson(filePath) {
    const bytes = readVerifiedRegularFile(filePath, {
        minBytes: 1,
        maxBytes: MAX_MANIFEST_BYTES,
        errorMessage: 'Invalid update metadata file',
    });
    return JSON.parse(bytes.toString('utf8'));
}

function validReleasePath(relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1024) return false;
    if (relativePath.includes('\\') || /[\x00-\x1f\x7f]/.test(relativePath) || path.posix.isAbsolute(relativePath)) return false;
    if (path.posix.normalize(relativePath) !== relativePath) return false;
    const parts = relativePath.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 240)) return false;
    if (relativePath === MANIFEST_NAME || relativePath === SOURCE_NAME) return false;
    // Resolve installs and signs this proprietary native module. EasyField
    // updates must never carry, replace, or checksum a redistributed copy.
    if (relativePath === 'WorkflowIntegration.node') return false;
    if (relativePath === '.DS_Store' || relativePath.endsWith('/.DS_Store')) return false;
    if (relativePath === 'python/.venv' || relativePath.startsWith('python/.venv/')) return false;
    return true;
}

function computeBuildId(manifest) {
    const canonical = JSON.stringify({
        pluginId: manifest.pluginId,
        platform: manifest.platform,
        architectures: manifest.architectures,
        minResolveVersion: manifest.minResolveVersion,
        version: manifest.version,
        files: manifest.files,
    });
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

function validateManifest(input) {
    if (!input || input.schemaVersion !== 1 || input.pluginId !== PLUGIN_ID) throw new Error('Invalid update manifest identity');
    if (input.platform !== 'darwin') throw new Error('Invalid update platform');
    if (!Array.isArray(input.architectures) || input.architectures.length !== 2 || input.architectures[0] !== 'arm64' || input.architectures[1] !== 'x64') throw new Error('Invalid update architectures');
    const minMacOSVersion = input.minMacOSVersion == null ? '0.0.0' : input.minMacOSVersion;
    if (typeof minMacOSVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(minMacOSVersion)) throw new Error('Invalid macOS compatibility');
    if (typeof input.minResolveVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(input.minResolveVersion)) throw new Error('Invalid Resolve compatibility');
    if (typeof input.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) throw new Error('Invalid update version');
    if (typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) throw new Error('Invalid update timestamp');
    if (typeof input.buildId !== 'string' || !/^[a-f0-9]{64}$/.test(input.buildId)) throw new Error('Invalid update build ID');
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > MAX_RELEASE_FILES) throw new Error('Invalid update file list');

    let previous = '';
    let totalBytes = 0;
    const seen = new Set();
    const files = input.files.map((entry) => {
        if (!entry || !validReleasePath(entry.path) || seen.has(entry.path)) throw new Error('Invalid update file path');
        if (previous && previous.localeCompare(entry.path, 'en') >= 0) throw new Error('Update file list is not canonical');
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid update file size');
        if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid update checksum');
        previous = entry.path;
        seen.add(entry.path);
        totalBytes += entry.size;
        if (totalBytes > MAX_RELEASE_BYTES) throw new Error('Update package is too large');
        return Object.freeze({ path: entry.path, size: entry.size, sha256: entry.sha256 });
    });
    for (const required of REQUIRED_FILES) {
        if (!seen.has(required)) throw new Error(`Update package is missing ${required}`);
    }
    const manifest = Object.freeze({
        schemaVersion: 1,
        pluginId: PLUGIN_ID,
        platform: input.platform,
        architectures: Object.freeze([...input.architectures]),
        minMacOSVersion,
        minResolveVersion: input.minResolveVersion,
        version: input.version,
        createdAt: input.createdAt,
        buildId: input.buildId,
        files: Object.freeze(files),
    });
    if (computeBuildId(manifest) !== manifest.buildId) throw new Error('Update manifest checksum is invalid');
    return manifest;
}

function readManifest(pluginDirectory) {
    return validateManifest(safeReadJson(path.join(pluginDirectory, MANIFEST_NAME)));
}

function readSourceDescriptor(installedPluginDir) {
    const descriptor = safeReadJson(path.join(installedPluginDir, SOURCE_NAME));
    if (descriptor && descriptor.schemaVersion === 1 && ['local-release', 'local-workspace'].includes(descriptor.kind)) {
        if (typeof descriptor.pluginRoot !== 'string' || !path.isAbsolute(descriptor.pluginRoot) || descriptor.pluginRoot.length > 2048) throw new Error('Invalid update source');
        const normalized = path.resolve(descriptor.pluginRoot);
        if (normalized !== descriptor.pluginRoot) throw new Error('Invalid update source');
        const stat = fs.lstatSync(normalized);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid update source');
        return Object.freeze({ schemaVersion: 1, kind: descriptor.kind, pluginRoot: normalized });
    }
    if (descriptor && descriptor.schemaVersion === 2 && descriptor.kind === 'github-release') {
        if (typeof descriptor.feedUrl !== 'string' || descriptor.feedUrl.length > 2048) throw new Error('Invalid update feed');
        const feed = validateGitHubFeedUrl(descriptor.feedUrl);
        const keyBytes = decodeCanonicalBase64(descriptor.publicKey, 'Invalid update publisher key');
        let publicKey;
        try {
            publicKey = crypto.createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
        } catch {
            throw new Error('Invalid update publisher key');
        }
        if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Invalid update publisher key');
        return Object.freeze({
            schemaVersion: 2,
            kind: 'github-release',
            feedUrl: feed.url,
            publicKey: keyBytes.toString('base64'),
        });
    }
    throw new Error('Unsupported update source');
}

function decodeCanonicalBase64(value, message) {
    if (typeof value !== 'string' || !value || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(message);
    const bytes = Buffer.from(value, 'base64');
    if (!bytes.length || bytes.toString('base64') !== value) throw new Error(message);
    return bytes;
}

function validateGitHubFeedUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid update feed'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || url.hash || url.port) {
        throw new Error('Invalid update feed');
    }
    const match = url.pathname.match(/^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/releases\/latest\/download\/easyfield-update\.json$/);
    if (!match || match[1].startsWith('.') || match[2].startsWith('.')) throw new Error('Invalid update feed');
    return Object.freeze({ url: url.toString(), owner: match[1], repository: match[2] });
}

function canonicalReleasePayload(payload) {
    return JSON.stringify({
        pluginId: payload.pluginId,
        channel: payload.channel,
        version: payload.version,
        buildId: payload.buildId,
        createdAt: payload.createdAt,
        manifest: payload.manifest,
        archive: payload.archive,
        releaseNotes: payload.releaseNotes,
    });
}

function validateRemoteRelease(input, descriptor) {
    if (!input || input.schemaVersion !== 1 || input.kind !== 'easyfield-release') throw new Error('Invalid signed update feed');
    const feed = validateGitHubFeedUrl(descriptor.feedUrl);
    const payload = input.payload;
    if (!payload || payload.pluginId !== PLUGIN_ID || payload.channel !== 'stable') throw new Error('Invalid signed update identity');
    const manifest = validateManifest(payload.manifest);
    if (payload.version !== manifest.version || payload.buildId !== manifest.buildId || payload.createdAt !== manifest.createdAt) {
        throw new Error('Signed update metadata does not match its manifest');
    }
    const archive = payload.archive;
    if (!archive || typeof archive.name !== 'string' || !/^EasyField-[0-9A-Za-z.-]+-plugin\.tar\.gz$/.test(archive.name)) throw new Error('Invalid update archive');
    if (!Number.isSafeInteger(archive.size) || archive.size <= 0 || archive.size > MAX_RELEASE_BYTES) throw new Error('Invalid update archive size');
    if (typeof archive.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(archive.sha256)) throw new Error('Invalid update archive checksum');
    let archiveUrl;
    try { archiveUrl = new URL(archive.url); } catch { throw new Error('Invalid update archive URL'); }
    const expectedPath = `/${feed.owner}/${feed.repository}/releases/download/v${manifest.version}/${archive.name}`;
    if (archiveUrl.protocol !== 'https:' || archiveUrl.hostname !== 'github.com' || archiveUrl.pathname !== expectedPath
        || archiveUrl.username || archiveUrl.password || archiveUrl.search || archiveUrl.hash || archiveUrl.port) {
        throw new Error('Invalid update archive URL');
    }
    const releaseNotes = typeof payload.releaseNotes === 'string'
        ? payload.releaseNotes.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, MAX_RELEASE_NOTES)
        : '';
    if (releaseNotes !== (payload.releaseNotes || '')) throw new Error('Invalid update release notes');
    const signature = decodeCanonicalBase64(input.signature, 'Invalid update signature');
    if (signature.length !== 64) throw new Error('Invalid update signature');
    const key = crypto.createPublicKey({ key: Buffer.from(descriptor.publicKey, 'base64'), format: 'der', type: 'spki' });
    const canonicalPayload = {
        pluginId: PLUGIN_ID,
        channel: 'stable',
        version: manifest.version,
        buildId: manifest.buildId,
        createdAt: manifest.createdAt,
        manifest,
        archive: Object.freeze({ name: archive.name, url: archiveUrl.toString(), size: archive.size, sha256: archive.sha256 }),
        releaseNotes,
    };
    if (!crypto.verify(null, Buffer.from(canonicalReleasePayload(canonicalPayload)), key, signature)) throw new Error('Update publisher signature is invalid');
    return Object.freeze({
        manifest,
        archive: canonicalPayload.archive,
        releaseNotes,
    });
}

function compareVersions(left, right) {
    const parse = (value) => {
        const [core, prerelease = ''] = value.split('-', 2);
        return {
            core: core.split('.').map((part) => Number(part)),
            prerelease: prerelease ? prerelease.split('.') : [],
        };
    };
    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < 3; index += 1) {
        if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
    }
    if (left === right) return 0;
    // SemVer: a stable release is newer than any prerelease with the same core.
    if (!a.prerelease.length) return 1;
    if (!b.prerelease.length) return -1;
    const length = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        if (a.prerelease[index] == null) return -1;
        if (b.prerelease[index] == null) return 1;
        if (a.prerelease[index] === b.prerelease[index]) continue;
        const aNumeric = /^\d+$/.test(a.prerelease[index]);
        const bNumeric = /^\d+$/.test(b.prerelease[index]);
        if (aNumeric && bNumeric) return Number(a.prerelease[index]) > Number(b.prerelease[index]) ? 1 : -1;
        if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
        return a.prerelease[index].localeCompare(b.prerelease[index], 'en') > 0 ? 1 : -1;
    }
    return 0;
}

function normalizedThreePartVersion(value) {
    const match = String(value || '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!match) return null;
    return `${Number(match[1])}.${Number(match[2] || 0)}.${Number(match[3] || 0)}`;
}

function detectMacOSVersion() {
    if (process.platform !== 'darwin') return null;
    try {
        return normalizedThreePartVersion(execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
            encoding: 'utf8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim());
    } catch {
        return null;
    }
}

function candidateIsNewer(installed, candidate) {
    const versionOrder = compareVersions(candidate.version, installed.version);
    if (versionOrder > 0) return true;
    if (versionOrder < 0 || candidate.buildId === installed.buildId) return false;
    return Date.parse(candidate.createdAt) > Date.parse(installed.createdAt);
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.once('error', reject);
        stream.once('end', () => resolve(hash.digest('hex')));
    });
}

function containedPath(root, relativePath) {
    const target = path.resolve(root, ...relativePath.split('/'));
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Update path escaped its package');
    return target;
}

async function stageVerifiedRelease(sourceRoot, manifest, descriptor) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-update-'));
    const stagedPlugin = path.join(temporaryRoot, PLUGIN_ID);
    fs.mkdirSync(stagedPlugin, { recursive: true, mode: 0o755 });
    try {
        for (const entry of manifest.files) {
            const sourcePath = containedPath(sourceRoot, entry.path);
            const sourceStat = fs.lstatSync(sourcePath);
            if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== entry.size) throw new Error('An update file changed during verification');
            const destinationPath = containedPath(stagedPlugin, entry.path);
            fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o755 });
            fs.copyFileSync(sourcePath, destinationPath);
            const stagedStat = fs.lstatSync(destinationPath);
            if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || stagedStat.size !== entry.size) throw new Error('An update file could not be staged safely');
            if (await sha256File(destinationPath) !== entry.sha256) throw new Error('An update file failed checksum verification');
            fs.chmodSync(destinationPath, 0o644);
        }
        // Write the already-validated snapshot instead of re-copying metadata
        // that could change while files are being staged.
        fs.writeFileSync(
            path.join(stagedPlugin, MANIFEST_NAME),
            `${JSON.stringify(manifest, null, 2)}\n`,
            { mode: 0o644 },
        );
        readManifest(stagedPlugin);
        fs.writeFileSync(
            path.join(stagedPlugin, SOURCE_NAME),
            `${JSON.stringify(descriptor, null, 2)}\n`,
            { mode: 0o644 },
        );
        return Object.freeze({ temporaryRoot, stagedPlugin });
    } catch (error) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        throw error;
    }
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appleScriptString(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function descriptorBytes(descriptor) {
    return Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
}

async function verifyReleaseDirectory(directory, expectedManifest, expectedDescriptor) {
    const manifest = readManifest(directory);
    if (manifest.buildId !== expectedManifest.buildId) throw new Error('The deployed update manifest does not match.');
    const descriptor = safeReadJson(path.join(directory, SOURCE_NAME));
    if (JSON.stringify(descriptor) !== JSON.stringify(expectedDescriptor)) throw new Error('The deployed update source does not match.');
    const expected = new Set([...expectedManifest.files.map((entry) => entry.path), MANIFEST_NAME, SOURCE_NAME]);
    const actual = [];
    const walk = (current, prefix = '') => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            const absolutePath = path.join(current, entry.name);
            if (entry.isSymbolicLink()) throw new Error('The deployed update contains a symbolic link.');
            if (entry.isDirectory()) walk(absolutePath, relativePath);
            else if (entry.isFile()) actual.push(relativePath);
            else throw new Error('The deployed update contains an unsupported file type.');
        }
    };
    walk(directory);
    if (actual.length !== expected.size || actual.some((relativePath) => !expected.has(relativePath))) {
        throw new Error('The deployed update contains an unexpected file.');
    }
    for (const entry of expectedManifest.files) {
        const filePath = containedPath(directory, entry.path);
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || await sha256File(filePath) !== entry.sha256) {
            throw new Error('A deployed update file failed verification.');
        }
    }
}

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const append = (chunk) => { if (output.length < 65536) output += chunk.toString(); };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(code === 1 && /canceled|cancelled|-128/i.test(output)
                ? 'The administrator approval was cancelled.'
                : 'macOS could not install the EasyField update.'));
        });
    });
}

function allowedRemoteUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid remote update URL'); }
    if (url.protocol !== 'https:' || !ALLOWED_REMOTE_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
        throw new Error('Invalid remote update URL');
    }
    return url;
}

function requestRemoteBuffer(value, maxBytes, options = {}) {
    const redirects = options.redirects || 0;
    const deadline = options.deadline || Date.now() + REMOTE_REQUEST_TIMEOUT_MS;
    if (redirects > MAX_REMOTE_REDIRECTS || Date.now() >= deadline) return Promise.reject(new Error('Update server request timed out'));
    const url = allowedRemoteUrl(value);
    return new Promise((resolve, reject) => {
        let settled = false;
        let request;
        let timer;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(result);
        };
        request = https.get(url, {
            headers: { 'User-Agent': 'EasyField-Resolve-Updater/1', Accept: 'application/json, application/octet-stream' },
        }, (response) => {
            const status = response.statusCode || 0;
            if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                response.resume();
                let next;
                try { next = new URL(response.headers.location, url).toString(); } catch { return finish(new Error('Update server returned an invalid redirect')); }
                requestRemoteBuffer(next, maxBytes, { redirects: redirects + 1, deadline }).then((bytes) => finish(null, bytes), finish);
                return;
            }
            if (status !== 200) {
                response.resume();
                finish(new Error(`Update server returned ${status || 'an invalid response'}`));
                return;
            }
            const declared = Number(response.headers['content-length']);
            if (Number.isFinite(declared) && (declared <= 0 || declared > maxBytes)) {
                response.destroy();
                finish(new Error('Update metadata is too large'));
                return;
            }
            let total = 0;
            const chunks = [];
            response.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxBytes) {
                    response.destroy();
                    finish(new Error('Update metadata is too large'));
                } else chunks.push(chunk);
            });
            response.once('error', finish);
            response.once('end', () => finish(null, Buffer.concat(chunks)));
        });
        request.once('error', finish);
        request.setTimeout(Math.min(15000, Math.max(1, deadline - Date.now())), () => {
            request.destroy();
            finish(new Error('Update server request timed out'));
        });
        timer = setTimeout(() => {
            request.destroy();
            finish(new Error('Update server request timed out'));
        }, Math.max(1, deadline - Date.now()));
    });
}

function downloadRemoteFile(value, destination, expected) {
    const deadline = Date.now() + REMOTE_DOWNLOAD_TIMEOUT_MS;
    const visit = (current, redirects) => {
        if (redirects > MAX_REMOTE_REDIRECTS || Date.now() >= deadline) return Promise.reject(new Error('Update download timed out'));
        const url = allowedRemoteUrl(current);
        return new Promise((resolve, reject) => {
            let request;
            let timer;
            let settled = false;
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(result);
            };
            request = https.get(url, { headers: { 'User-Agent': 'EasyField-Resolve-Updater/1', Accept: 'application/octet-stream' } }, (response) => {
                const status = response.statusCode || 0;
                if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                    response.resume();
                    let next;
                    try { next = new URL(response.headers.location, url).toString(); } catch { return finish(new Error('Update download returned an invalid redirect')); }
                    visit(next, redirects + 1).then((result) => finish(null, result), finish);
                    return;
                }
                if (status !== 200) {
                    response.resume();
                    finish(new Error(`Update download returned ${status || 'an invalid response'}`));
                    return;
                }
                const declared = Number(response.headers['content-length']);
                if (Number.isFinite(declared) && declared !== expected.size) {
                    response.destroy();
                    finish(new Error('Update archive size does not match its signed metadata'));
                    return;
                }
                const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
                const hash = crypto.createHash('sha256');
                let total = 0;
                const fail = (error) => {
                    response.destroy();
                    output.destroy();
                    try { fs.rmSync(destination, { force: true }); } catch {}
                    finish(error);
                };
                response.on('data', (chunk) => {
                    total += chunk.length;
                    if (total > expected.size) return fail(new Error('Update archive exceeded its signed size'));
                    hash.update(chunk);
                    if (!output.write(chunk)) response.pause(), output.once('drain', () => response.resume());
                });
                response.once('error', fail);
                output.once('error', fail);
                response.once('end', () => output.end());
                output.once('finish', () => {
                    if (total !== expected.size || hash.digest('hex') !== expected.sha256) {
                        try { fs.rmSync(destination, { force: true }); } catch {}
                        finish(new Error('Update archive failed publisher verification'));
                    } else finish(null, true);
                });
            });
            request.once('error', finish);
            request.setTimeout(30000, () => {
                request.destroy();
                finish(new Error('Update download timed out'));
            });
            timer = setTimeout(() => {
                request.destroy();
                finish(new Error('Update download timed out'));
            }, Math.max(1, deadline - Date.now()));
        });
    };
    return visit(value, 0);
}

async function fetchRemoteRelease(descriptor) {
    const bytes = await requestRemoteBuffer(descriptor.feedUrl, MAX_MANIFEST_BYTES);
    let input;
    try { input = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Update server returned invalid metadata'); }
    return validateRemoteRelease(input, descriptor);
}

async function stageRemoteRelease(descriptor, release) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfield-remote-update-'));
    const archivePath = path.join(temporaryRoot, release.archive.name);
    const extractionRoot = path.join(temporaryRoot, 'extracted');
    fs.mkdirSync(extractionRoot, { recursive: true, mode: 0o700 });
    try {
        await downloadRemoteFile(release.archive.url, archivePath, release.archive);
        // bsdtar's default extraction policy rejects absolute/`..` paths and
        // refuses to traverse an archive-created directory symlink. Strip all
        // publisher-supplied ownership, ACL, xattr, flags and mode metadata as
        // an additional boundary; the exact regular-file tree is verified next.
        await runCommand('/usr/bin/tar', [
            '-xzf', archivePath,
            '-C', extractionRoot,
            '--no-same-owner',
            '--no-same-permissions',
            '--no-acls',
            '--no-fflags',
            '--no-mac-metadata',
            '--no-xattrs',
        ]);
        const stagedPlugin = path.join(extractionRoot, PLUGIN_ID);
        const stat = fs.lstatSync(stagedPlugin);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Update archive has an invalid root');
        await verifyReleaseDirectory(stagedPlugin, release.manifest, descriptor);
        return Object.freeze({ temporaryRoot, stagedPlugin });
    } catch (error) {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        throw error;
    }
}

async function runPrivilegedAtomicSwap(stagedPlugin, destination = DESTINATION, expectedManifest, expectedDescriptor) {
    // Production callers use the fixed Resolve directory. A custom destination
    // is accepted only for injected tests and never comes from IPC/renderer.
    if (destination !== DESTINATION) throw new Error('Invalid plugin destination');
    const manifest = validateManifest(expectedManifest || safeReadJson(path.join(stagedPlugin, MANIFEST_NAME)));
    const descriptor = expectedDescriptor || safeReadJson(path.join(stagedPlugin, SOURCE_NAME));
    const descriptorBuffer = descriptorBytes(descriptor);
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const checksumEntries = [
        ...manifest.files.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
        { path: MANIFEST_NAME, sha256: crypto.createHash('sha256').update(manifestBuffer).digest('hex') },
        { path: SOURCE_NAME, sha256: crypto.createHash('sha256').update(descriptorBuffer).digest('hex') },
    ].sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const checksums = Buffer.from(checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(''));
    const checksumPath = path.join(path.dirname(stagedPlugin), 'release-checksums.sha256');
    fs.writeFileSync(checksumPath, checksums, { mode: 0o600 });
    const expectedChecksumHash = crypto.createHash('sha256').update(checksums).digest('hex');
    const destinationRoot = path.dirname(destination);
    const recoveryRoot = '/Library/Application Support/EasyField/Recovery';
    const nonce = crypto.randomBytes(12).toString('hex');
    // This command is passed inline to osascript. Root never executes a
    // user-writable script. It first copies and authenticates the checksum
    // ledger, then verifies the root-owned NEXT tree before the swap.
    const command = `set -euo pipefail
STAGE=${shellQuote(stagedPlugin)}
CHECKSUMS=${shellQuote(checksumPath)}
DEST=${shellQuote(destination)}
ROOT=${shellQuote(destinationRoot)}
RECOVERY_ROOT=${shellQuote(recoveryRoot)}
ROOT_CHECKSUMS=${shellQuote(`/private/tmp/.easyfield-checksums-${nonce}`)}
EXPECTED_CHECKSUM_HASH=${shellQuote(expectedChecksumHash)}
EXPECTED_FILE_COUNT=${checksumEntries.length}
NEXT="${destination}.next.$$"
BACKUP="$RECOVERY_ROOT/${PLUGIN_ID}.previous"
/bin/rm -f "$ROOT_CHECKSUMS"
/bin/cp "$CHECKSUMS" "$ROOT_CHECKSUMS"
/usr/sbin/chown root:wheel "$ROOT_CHECKSUMS"
/bin/chmod 600 "$ROOT_CHECKSUMS"
ACTUAL_CHECKSUM_HASH=$(/usr/bin/shasum -a 256 "$ROOT_CHECKSUMS" | /usr/bin/awk '{print $1}')
[ "$ACTUAL_CHECKSUM_HASH" = "$EXPECTED_CHECKSUM_HASH" ]
/bin/mkdir -p "$ROOT"
/bin/mkdir -p "$RECOVERY_ROOT"
/bin/rm -rf "$NEXT"
/bin/cp -R "$STAGE" "$NEXT"
/usr/sbin/chown -R root:wheel "$NEXT"
/bin/chmod -R a+rX "$NEXT"
test -z "$(/usr/bin/find "$NEXT" -type l -print -quit)"
test -z "$(/usr/bin/find "$NEXT" ! -type f ! -type d -print -quit)"
FILE_COUNT=$(/usr/bin/find "$NEXT" -type f -print | /usr/bin/wc -l | /usr/bin/tr -d '[:space:]')
[ "$FILE_COUNT" -eq "$EXPECTED_FILE_COUNT" ]
(cd "$NEXT" && /usr/bin/shasum -a 256 -c "$ROOT_CHECKSUMS")
HAD_CURRENT=0
if [ -e "$DEST" ]; then
  /bin/rm -rf "$BACKUP"
  /bin/mv "$DEST" "$BACKUP"
  HAD_CURRENT=1
fi
if /bin/mv "$NEXT" "$DEST"; then
  /bin/rm -f "$ROOT_CHECKSUMS"
  exit 0
fi
/bin/rm -rf "$NEXT" || true
if [ "$HAD_CURRENT" -eq 1 ] && [ -e "$BACKUP" ]; then /bin/mv "$BACKUP" "$DEST"; fi
/bin/rm -f "$ROOT_CHECKSUMS" || true
exit 1
`;
    await runCommand('/usr/bin/osascript', ['-e', `do shell script ${appleScriptString(`/bin/bash -c ${shellQuote(command)}`)} with administrator privileges`]);
}

function createPluginUpdater(options = {}) {
    const installedPluginDir = path.resolve(options.installedPluginDir || __dirname);
    const destination = options.destinationDir ? path.resolve(options.destinationDir) : DESTINATION;
    const privilegedInstall = options.privilegedInstall
        || ((stagedPlugin, _destination, manifest, descriptor) => runPrivilegedAtomicSwap(stagedPlugin, destination, manifest, descriptor));
    const remoteReleaseLoader = options.remoteReleaseLoader || fetchRemoteRelease;
    const remoteReleaseStager = options.remoteReleaseStager || stageRemoteRelease;
    const currentMacOSVersion = normalizedThreePartVersion(options.currentMacOSVersion) || detectMacOSVersion();
    const resolveVersionProvider = typeof options.resolveVersionProvider === 'function'
        ? options.resolveVersionProvider
        : null;
    let installPromise = null;

    async function loadCandidate(descriptor) {
        if (descriptor.kind === 'github-release') return remoteReleaseLoader(descriptor);
        return Object.freeze({ manifest: readManifest(descriptor.pluginRoot), releaseNotes: '' });
    }

    function isNewerForSource(descriptor, installed, candidate) {
        // Local development may publish a corrected build of the same version.
        // Public GitHub releases are immutable and always require a version bump.
        return descriptor.kind === 'github-release'
            ? compareVersions(candidate.version, installed.version) > 0
            : candidateIsNewer(installed, candidate);
    }

    async function compatibilityReason(candidate) {
        if (!currentMacOSVersion) return 'The installed macOS version could not be verified.';
        if (compareVersions(currentMacOSVersion, candidate.minMacOSVersion) < 0) {
            return `EasyField ${candidate.version} requires macOS ${candidate.minMacOSVersion} or newer.`;
        }
        if (!resolveVersionProvider) return null;
        let resolveVersion = null;
        try {
            resolveVersion = normalizedThreePartVersion(await resolveVersionProvider());
        } catch {
            resolveVersion = null;
        }
        if (!resolveVersion) return 'The installed DaVinci Resolve version could not be verified.';
        if (compareVersions(resolveVersion, candidate.minResolveVersion) < 0) {
            return `EasyField ${candidate.version} requires DaVinci Resolve ${candidate.minResolveVersion} or newer.`;
        }
        return null;
    }

    async function check() {
        const checkedAt = Date.now();
        let installed;
        try {
            installed = readManifest(installedPluginDir);
        } catch {
            return {
                supported: false,
                available: false,
                currentVersion: 'unknown',
                candidateVersion: null,
                currentBuildId: null,
                candidateBuildId: null,
                checkedAt,
                reason: 'This EasyField installation does not include verified update metadata.',
            };
        }
        try {
            const descriptor = readSourceDescriptor(installedPluginDir);
            const release = await loadCandidate(descriptor);
            const candidate = release.manifest;
            if (candidate.platform !== process.platform || !candidate.architectures.includes(process.arch)) {
                return {
                    supported: false,
                    available: false,
                    currentVersion: installed.version,
                    candidateVersion: null,
                    currentBuildId: installed.buildId,
                    candidateBuildId: null,
                    checkedAt,
                    sourceKind: descriptor.kind,
                    reason: `This update does not support ${process.platform}/${process.arch}.`,
                };
            }
            const incompatible = await compatibilityReason(candidate);
            if (incompatible) {
                return {
                    supported: false,
                    available: false,
                    currentVersion: installed.version,
                    candidateVersion: candidate.version,
                    currentBuildId: installed.buildId,
                    candidateBuildId: candidate.buildId,
                    checkedAt,
                    sourceKind: descriptor.kind,
                    reason: incompatible,
                };
            }
            const available = isNewerForSource(descriptor, installed, candidate);
            return {
                supported: true,
                available,
                currentVersion: installed.version,
                candidateVersion: available ? candidate.version : null,
                currentBuildId: installed.buildId,
                candidateBuildId: available ? candidate.buildId : null,
                checkedAt,
                sourceKind: descriptor.kind,
                releaseNotes: available ? release.releaseNotes || undefined : undefined,
                reason: available ? undefined : 'EasyField is up to date.',
            };
        } catch (error) {
            return {
                supported: false,
                available: false,
                currentVersion: installed.version,
                candidateVersion: null,
                currentBuildId: installed.buildId,
                candidateBuildId: null,
                checkedAt,
                reason: error && /publisher signature|signed update|archive URL|publisher key/i.test(error.message || '')
                    ? 'The update channel failed publisher verification.'
                    : 'The verified update source is unavailable.',
            };
        }
    }

    async function performInstall() {
        const status = await check();
        if (!status.supported) throw new Error(status.reason || 'Updates are unavailable.');
        if (!status.available) throw new Error('EasyField is already up to date.');
        const descriptor = readSourceDescriptor(installedPluginDir);
        const release = await loadCandidate(descriptor);
        const candidate = release.manifest;
        if (candidate.buildId !== status.candidateBuildId || !isNewerForSource(descriptor, readManifest(installedPluginDir), candidate)) {
            throw new Error('The update changed while it was being prepared. Check again.');
        }
        const stage = descriptor.kind === 'github-release'
            ? await remoteReleaseStager(descriptor, release)
            : await stageVerifiedRelease(descriptor.pluginRoot, candidate, descriptor);
        try {
            await privilegedInstall(stage.stagedPlugin, destination, candidate, descriptor);
            await verifyReleaseDirectory(destination, candidate, descriptor);
            return {
                installed: true,
                restartRequired: true,
                version: candidate.version,
                buildId: candidate.buildId,
            };
        } finally {
            fs.rmSync(stage.temporaryRoot, { recursive: true, force: true });
        }
    }

    function install() {
        if (!installPromise) installPromise = performInstall().finally(() => { installPromise = null; });
        return installPromise;
    }

    return Object.freeze({ check, install });
}

module.exports = {
    PLUGIN_ID,
    MANIFEST_NAME,
    SOURCE_NAME,
    REQUIRED_FILES,
    readVerifiedRegularFile,
    computeBuildId,
    validateManifest,
    validateRemoteRelease,
    canonicalReleasePayload,
    candidateIsNewer,
    readSourceDescriptor,
    stageVerifiedRelease,
    fetchRemoteRelease,
    stageRemoteRelease,
    verifyReleaseDirectory,
    runPrivilegedAtomicSwap,
    createPluginUpdater,
};
