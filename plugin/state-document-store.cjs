const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOCUMENT_REFERENCE_TYPE = 'easyfield-state-document-v1';
const DOCUMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isDocumentReference(value) {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && value.type === DOCUMENT_REFERENCE_TYPE
        && typeof value.id === 'string'
        && DOCUMENT_ID.test(value.id)
        && Number.isSafeInteger(value.bytes)
        && value.bytes >= 0
        && typeof value.checksum === 'string'
        && /^[0-9a-f]{64}$/.test(value.checksum),
    );
}

function createStateDocumentStore(userDataPath) {
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const userDataInfo = fs.lstatSync(userDataPath);
    if (!userDataInfo.isDirectory() || userDataInfo.isSymbolicLink()) {
        throw new Error('EasyField document state boundary must be a local directory');
    }
    fs.chmodSync(userDataPath, 0o700);
    const rootPath = path.join(userDataPath, 'state-documents');
    fs.mkdirSync(rootPath, { recursive: true, mode: 0o700 });
    const rootInfo = fs.lstatSync(rootPath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error('EasyField document state directory must be a local directory');
    }
    fs.chmodSync(rootPath, 0o700);

    function filePathFor(reference) {
        if (!isDocumentReference(reference)) throw new Error('Invalid document state reference');
        return path.join(rootPath, `${reference.id}.json`);
    }

    function write(valueJson) {
        if (typeof valueJson !== 'string') throw new TypeError('Document state must be serialized JSON');
        const bytes = Buffer.from(valueJson);
        const id = crypto.randomUUID();
        const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
        const filePath = path.join(rootPath, `${id}.json`);
        const temporaryPath = path.join(rootPath, `${id}.${crypto.randomBytes(8).toString('hex')}.tmp`);
        try {
            fs.writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
            fs.renameSync(temporaryPath, filePath);
            fs.chmodSync(filePath, 0o600);
        } catch (error) {
            try { fs.rmSync(temporaryPath, { force: true }); } catch (cleanupError) { /* best effort */ }
            try { fs.rmSync(filePath, { force: true }); } catch (cleanupError) { /* best effort */ }
            throw error;
        }
        return Object.freeze({
            type: DOCUMENT_REFERENCE_TYPE,
            id,
            bytes: bytes.length,
            checksum,
        });
    }

    function read(reference) {
        const filePath = filePathFor(reference);
        let info;
        try {
            info = fs.lstatSync(filePath);
        } catch {
            throw new Error('Saved document state is unavailable');
        }
        if (!info.isFile() || info.isSymbolicLink() || info.size !== reference.bytes) {
            throw new Error('Saved document state is invalid');
        }
        const bytes = fs.readFileSync(filePath);
        const checksum = crypto.createHash('sha256').update(bytes).digest();
        const expectedChecksum = Buffer.from(reference.checksum, 'hex');
        if (!crypto.timingSafeEqual(checksum, expectedChecksum)) {
            throw new Error('Saved document state is corrupt');
        }
        try {
            return JSON.parse(bytes.toString('utf8'));
        } catch {
            throw new Error('Saved document state is invalid JSON');
        }
    }

    function deleteReference(reference) {
        if (!isDocumentReference(reference)) return false;
        try {
            fs.rmSync(filePathFor(reference), { force: true });
            return true;
        } catch {
            return false;
        }
    }

    return Object.freeze({
        rootPath,
        write,
        read,
        deleteReference,
    });
}

module.exports = {
    createStateDocumentStore,
    isDocumentReference,
};
