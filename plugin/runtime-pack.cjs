'use strict';

// Release runtimes are part of the signed plugin tree. The build gate validates
// every payload byte; this launch-time resolver independently pins the exact
// executable files before Main is allowed to select them. An incomplete source
// catalog keeps local/Homebrew development working, but once a catalog is
// marked release-ready, a missing or changed packaged binary fails closed and
// is never replaced by PATH or a global installation.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COMPONENTS = Object.freeze({
    ffmpeg: Object.freeze(['ffmpeg', 'ffprobe']),
    'librosa-python': Object.freeze(['python3']),
    whispercpp: Object.freeze(['whisper-cli']),
});
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64']);
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

function safeRelative(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 1024
        && !value.includes('\\')
        && !value.startsWith('/')
        && !value.endsWith('/')
        && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        while (true) {
            const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (!bytes) break;
            hash.update(buffer.subarray(0, bytes));
        }
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest('hex');
}

function readCatalog(catalogPath) {
    let handle;
    try {
        handle = fs.openSync(catalogPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
        if (error?.code === 'ELOOP') throw new Error('The packaged runtime catalog is invalid.');
        throw error;
    }
    // Inspect and read the one descriptor we opened, so the path cannot be
    // swapped for another file between the checks and the read.
    let contents;
    try {
        const stat = fs.fstatSync(handle);
        if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CATALOG_BYTES) {
            throw new Error('The packaged runtime catalog is invalid.');
        }
        contents = fs.readFileSync(handle, 'utf8');
    } finally {
        fs.closeSync(handle);
    }
    const catalog = JSON.parse(contents);
    if (!catalog || catalog.schemaVersion !== 1 || catalog.platform !== 'darwin'
        || !Array.isArray(catalog.architectures) || !Array.isArray(catalog.components)
        || typeof catalog.releaseReady !== 'boolean') {
        throw new Error('The packaged runtime catalog is invalid.');
    }
    return catalog;
}

function resolveTargetExecutables(pluginRoot, componentId, target, requiredExecutables, architecture, expectedPaths) {
    const expectedRoot = `runtime-packs/${componentId}/${architecture}`;
    if (!target || target.root !== expectedRoot || !target.executables || !Array.isArray(target.files)) {
        throw new Error(`The ${componentId} runtime target is incomplete.`);
    }
    const targetRoot = path.join(pluginRoot, ...expectedRoot.split('/'));
    const rootStat = fs.lstatSync(targetRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error(`The ${componentId} runtime target is unavailable.`);
    }
    const inventory = new Map();
    for (const entry of target.files) {
        if (!entry || !safeRelative(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 1
            || !/^[0-9a-f]{64}$/.test(entry.sha256 || '') || inventory.has(entry.path)) {
            throw new Error(`The ${componentId} runtime inventory is invalid.`);
        }
        inventory.set(entry.path, entry);
    }
    const resolved = {};
    for (const executableName of requiredExecutables) {
        const relativePath = target.executables[executableName];
        const entry = inventory.get(relativePath);
        if (!safeRelative(relativePath) || !entry || entry.kind !== 'mach-o' || entry.executable !== true) {
            throw new Error(`The ${componentId} executable contract is invalid.`);
        }
        const executablePath = path.join(targetRoot, ...relativePath.split('/'));
        if (expectedPaths && path.resolve(expectedPaths[executableName]) !== executablePath) {
            throw new Error(`The ${componentId} executable path is not authenticated.`);
        }
        const stat = fs.lstatSync(executablePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size
            || (stat.mode & 0o111) === 0 || sha256File(executablePath) !== entry.sha256) {
            throw new Error(`The ${componentId} packaged executable failed verification.`);
        }
        resolved[executableName] = executablePath;
    }
    return resolved;
}

function verifyRuntimeExecutable(options = {}) {
    const componentId = options.componentId;
    const executableName = options.executableName;
    const candidate = options.candidate;
    const requiredExecutables = COMPONENTS[componentId];
    if (!requiredExecutables || !requiredExecutables.includes(executableName)
        || typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
        return false;
    }
    const pluginRoot = path.resolve(options.pluginRoot || __dirname);
    const architecture = options.architecture || process.arch;
    if (!SUPPORTED_ARCHITECTURES.has(architecture)) return false;
    try {
        const catalog = readCatalog(options.catalogPath || path.join(pluginRoot, 'runtime-packs.json'));
        if (!catalog.releaseReady) return false;
        const component = catalog.components.find((entry) => entry && entry.id === componentId);
        if (!component || !component.targets) return false;
        resolveTargetExecutables(
            pluginRoot,
            componentId,
            component.targets[architecture],
            [executableName],
            architecture,
            { [executableName]: candidate },
        );
        return true;
    } catch {
        return false;
    }
}

function resolveRuntimePack(options = {}) {
    const pluginRoot = path.resolve(options.pluginRoot || __dirname);
    const architecture = options.architecture || process.arch;
    if (!SUPPORTED_ARCHITECTURES.has(architecture)) {
        return Object.freeze({
            strict: true,
            available: false,
            executables: Object.freeze({}),
            error: 'This Mac architecture has no EasyField runtime target.',
        });
    }
    let catalog;
    try {
        catalog = readCatalog(options.catalogPath || path.join(pluginRoot, 'runtime-packs.json'));
    } catch {
        return Object.freeze({
            strict: true,
            available: false,
            executables: Object.freeze({}),
            error: 'The packaged runtime catalog could not be verified.',
        });
    }
    if (!catalog.releaseReady) {
        return Object.freeze({
            strict: false,
            available: false,
            executables: Object.freeze({}),
            error: 'Portable runtime packs are not included in this development build.',
        });
    }
    try {
        const executables = {};
        for (const [componentId, requiredExecutables] of Object.entries(COMPONENTS)) {
            const component = catalog.components.find((candidate) => candidate && candidate.id === componentId);
            if (!component || !component.targets) throw new Error('Runtime component missing.');
            Object.assign(
                executables,
                resolveTargetExecutables(
                    pluginRoot,
                    componentId,
                    component.targets[architecture],
                    requiredExecutables,
                    architecture,
                ),
            );
        }
        return Object.freeze({ strict: true, available: true, executables: Object.freeze(executables) });
    } catch {
        return Object.freeze({
            strict: true,
            available: false,
            executables: Object.freeze({}),
            error: 'A packaged local runtime failed integrity verification.',
        });
    }
}

module.exports = {
    COMPONENTS,
    resolveRuntimePack,
    verifyRuntimeExecutable,
};
