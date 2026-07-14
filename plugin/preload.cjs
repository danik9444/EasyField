// Sandbox + contextIsolation are on. Main injects bridge authentication in the
// Electron session, so neither the real credential nor the bridge token is ever
// exposed to renderer JavaScript.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('easyfield', Object.freeze({
    plugin: true,
    credentials: Object.freeze({
        get: (name) => ipcRenderer.invoke('ef:credentials:get', name),
        set: (name, value) => ipcRenderer.invoke('ef:credentials:set', name, value),
        delete: (name) => ipcRenderer.invoke('ef:credentials:delete', name),
    }),
    state: Object.freeze({
        get: (namespace, key) => ipcRenderer.invoke('ef:state:get', namespace, key),
        list: (namespace) => ipcRenderer.invoke('ef:state:list', namespace),
        set: (namespace, key, value) => ipcRenderer.invoke('ef:state:set', namespace, key, value),
        delete: (namespace, key) => ipcRenderer.invoke('ef:state:delete', namespace, key),
    }),
    window: Object.freeze({
        setMode: (mode) => ipcRenderer.invoke('ef:window:set-mode', mode),
    }),
    updates: Object.freeze({
        check: () => ipcRenderer.invoke('ef:updates:check'),
        install: () => ipcRenderer.invoke('ef:updates:install'),
    }),
    artifacts: Object.freeze({
        ingestUrl: (input) => ipcRenderer.invoke('ef:artifacts:ingest-url', input),
    }),
}));
