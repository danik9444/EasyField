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
    directCloud: Object.freeze({
        connect: (candidate) => ipcRenderer.invoke('ef:direct-cloud:connect', candidate),
        hasExisting: () => ipcRenderer.invoke('ef:direct-cloud:has-existing'),
        hasScoped: () => ipcRenderer.invoke('ef:direct-cloud:has-scoped'),
        adoptExisting: () => ipcRenderer.invoke('ef:direct-cloud:adopt-existing'),
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
    billing: Object.freeze({
        openCreditPurchase: () => ipcRenderer.invoke('ef:billing:open-credit-purchase'),
    }),
    account: Object.freeze({
        restore: () => ipcRenderer.invoke('ef:account:restore'),
        signIn: (input) => ipcRenderer.invoke('ef:account:sign-in', input),
        signUp: (input) => ipcRenderer.invoke('ef:account:sign-up', input),
        startOAuth: (input) => ipcRenderer.invoke('ef:account:start-oauth', input),
        signOut: () => ipcRenderer.invoke('ef:account:sign-out'),
        requestPasswordReset: (input) => ipcRenderer.invoke('ef:account:request-password-reset', input),
        completePasswordRecovery: (input) => ipcRenderer.invoke('ef:account:complete-password-recovery', input),
        cancelPasswordRecovery: (input) => ipcRenderer.invoke('ef:account:cancel-password-recovery', input),
        updateProfile: (input) => ipcRenderer.invoke('ef:account:update-profile', input),
        resendVerification: (input) => ipcRenderer.invoke('ef:account:resend-verification', input),
        getSnapshot: (input) => ipcRenderer.invoke('ef:account:get-snapshot', input),
        checkout: (input) => ipcRenderer.invoke('ef:account:checkout', input),
        resumeCheckout: () => ipcRenderer.invoke('ef:account:resume-checkout'),
        saveAutoReload: (input) => ipcRenderer.invoke('ef:account:save-auto-reload', input),
        onChanged: (listener) => {
            if (typeof listener !== 'function') throw new TypeError('Account listener must be a function');
            const handler = (_event, snapshot) => listener(snapshot);
            ipcRenderer.on('ef:account:changed', handler);
            return () => ipcRenderer.removeListener('ef:account:changed', handler);
        },
        onOAuthCompleted: (listener) => {
            if (typeof listener !== 'function') throw new TypeError('OAuth listener must be a function');
            const handler = (_event, completion) => listener(completion);
            ipcRenderer.on('ef:account:oauth-completed', handler);
            return () => ipcRenderer.removeListener('ef:account:oauth-completed', handler);
        },
        onPasswordRecoveryCompleted: (listener) => {
            if (typeof listener !== 'function') throw new TypeError('Password recovery listener must be a function');
            const handler = (_event, completion) => listener(completion);
            ipcRenderer.on('ef:account:password-recovery-completed', handler);
            return () => ipcRenderer.removeListener('ef:account:password-recovery-completed', handler);
        },
    }),
    updates: Object.freeze({
        check: () => ipcRenderer.invoke('ef:updates:check'),
        install: () => ipcRenderer.invoke('ef:updates:install'),
    }),
    artifacts: Object.freeze({
        ingestUrl: (input) => ipcRenderer.invoke('ef:artifacts:ingest-url', input),
        ingestBytes: (input) => ipcRenderer.invoke('ef:artifacts:ingest-bytes', input),
    }),
}));
