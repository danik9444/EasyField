const path = require('path');
const fs = require('fs');

function createStateStore(userDataPath) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const userDataInfo = fs.lstatSync(userDataPath);
    if (!userDataInfo.isDirectory() || userDataInfo.isSymbolicLink()) {
        throw new Error('EasyField state directory must be a local directory');
    }
    // Drafts, transcripts and job metadata can contain private project data.
    // Do not inherit a permissive umask from Resolve for the SQLite directory
    // or its WAL/SHM sidecars.
    fs.chmodSync(userDataPath, 0o700);
    const databasePath = path.join(userDataPath, 'easyfield.sqlite3');
    const db = new DatabaseSync(databasePath);

    function hardenDatabaseFiles() {
        for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
            try { fs.chmodSync(filePath, 0o600); } catch (error) {
                if (error && error.code !== 'ENOENT') throw error;
            }
        }
    }

    hardenDatabaseFiles();
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS app_state (
            namespace TEXT NOT NULL,
            key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (namespace, key)
        );
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, unixepoch() * 1000);
    `);
    hardenDatabaseFiles();

    const getStatement = db.prepare('SELECT value_json FROM app_state WHERE namespace = ? AND key = ?');
    const listStatement = db.prepare('SELECT key, value_json, updated_at FROM app_state WHERE namespace = ? ORDER BY updated_at DESC');
    const setStatement = db.prepare(`
        INSERT INTO app_state(namespace, key, value_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `);
    const deleteStatement = db.prepare('DELETE FROM app_state WHERE namespace = ? AND key = ?');

    function parse(row) {
        if (!row) return null;
        try { return JSON.parse(row.value_json); } catch { return null; }
    }

    return Object.freeze({
        databasePath,
        get(namespace, key) { return parse(getStatement.get(namespace, key)); },
        list(namespace) {
            return listStatement.all(namespace).map((row) => ({
                key: row.key,
                value: parse(row),
                updatedAt: Number(row.updated_at),
            }));
        },
        set(namespace, key, value) {
            const json = JSON.stringify(value);
            if (json === undefined) throw new TypeError('State value is not JSON serializable');
            setStatement.run(namespace, key, json, Date.now());
            hardenDatabaseFiles();
            return true;
        },
        delete(namespace, key) {
            deleteStatement.run(namespace, key);
            hardenDatabaseFiles();
            return true;
        },
        close() {
            hardenDatabaseFiles();
            db.close();
        },
    });
}

module.exports = { createStateStore };
