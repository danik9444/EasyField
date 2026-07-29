'use strict';

// Main-owned EasyField account client. The renderer receives only sanitized
// account snapshots; Supabase access/refresh tokens and checkout URLs never
// cross the preload boundary.

const crypto = require('crypto');

const SESSION_VERSION = 1;
const CHECKOUT_STATE_VERSION = 1;
const CHECKOUT_STORE_VERSION = 2;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const OAUTH_TTL_MS = 5 * 60 * 1000;
const PASSWORD_RECOVERY_TTL_MS = 5 * 60 * 1000;
// Email confirmation is asynchronous by nature: the customer leaves for an
// inbox that may be on another device. Five minutes — right for OAuth and
// recovery, where the user never leaves the flow — would expire before a
// realistic round trip. Thirty still bounds how long the PKCE verifier lives.
const EMAIL_CONFIRMATION_TTL_MS = 30 * 60 * 1000;
const REFRESH_SKEW_SECONDS = 90;
const CHECKOUT_STATE_TTL_MS = 30 * 60 * 1000;
const CHECKOUT_STATE_MAX_BYTES = 16 * 1024;
const MAX_ACCOUNT_CHECKOUT_STATES = 8;

const PLAN_IDS = new Set(['starter', 'creator', 'pro', 'studio']);
const BILLING_INTERVALS = new Set(['monthly', 'annual']);
const CHECKOUT_KINDS = new Set(['subscription', 'top-up', 'partner', 'billing-portal', 'upstream-top-up']);
const OAUTH_PROVIDERS = new Set(['google', 'apple']);
const PLATFORM_ROLES = new Set(['customer', 'support', 'admin']);
const DEFINITIVE_CHECKOUT_REJECTION_STATUSES = new Set([400, 404, 409, 422]);

function resultOk(value) {
    return { ok: true, value };
}

function resultError(code, message, retryable = false) {
    return { ok: false, error: { code, message, retryable } };
}

function normalizeBaseUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
        const parsed = new URL(value.trim());
        if (parsed.protocol !== 'https:') return '';
        parsed.username = '';
        parsed.password = '';
        parsed.hash = '';
        parsed.search = '';
        return parsed.toString().replace(/\/$/, '');
    } catch {
        return '';
    }
}

function normalizeCheckoutHosts(value) {
    const values = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : [];
    const hosts = new Set();
    for (const entry of values) {
        const normalized = String(entry || '').trim().toLowerCase();
        if (/^[a-z0-9.-]+$/.test(normalized) && !normalized.startsWith('.') && !normalized.endsWith('.')) {
            hosts.add(normalized);
        }
    }
    return hosts;
}

function normalizeOAuthProviders(value) {
    const values = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : [];
    const providers = new Set();
    for (const entry of values) {
        const normalized = String(entry || '').trim().toLowerCase();
        if (OAUTH_PROVIDERS.has(normalized)) providers.add(normalized);
    }
    return providers;
}

function toEpochMs(value) {
    if (value == null || value === '') return null;
    const millis = Date.parse(String(value));
    return Number.isFinite(millis) && millis >= 0 ? millis : null;
}

function safeMicros(value) {
    const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function safeRole(value) {
    return PLATFORM_ROLES.has(value) ? value : 'customer';
}

function mapSubscriptionStatus(value) {
    const normalized = String(value || '').replaceAll('_', '-');
    return new Set(['active', 'trialing', 'past-due', 'paused', 'canceled', 'expired', 'incomplete']).has(normalized)
        ? normalized
        : 'incomplete';
}

function defaultAutoReloadPolicy() {
    return { enabled: false };
}

function emptySnapshot(options = {}) {
    const configuredOAuthProviders = options.accountConfigured
        ? [...normalizeOAuthProviders(options.oauthProviders)]
        : [];
    return {
        version: 1,
        revision: Number.isSafeInteger(options.revision) ? options.revision : 0,
        measuredAtMs: Date.now(),
        session: { status: 'signed-out' },
        subscription: null,
        balances: null,
        partnerEntitlement: null,
        autoReloadPolicy: defaultAutoReloadPolicy(),
        checkoutStatus: null,
        privilegedBilling: null,
        capabilities: {
            accountConfigured: Boolean(options.accountConfigured),
            billingConfigured: Boolean(options.billingConfigured),
            oauthProviders: configuredOAuthProviders,
            generationAccess: Boolean(options.directProviderAllowed),
            directProviderAllowed: Boolean(options.directProviderAllowed),
            customerCheckoutAvailable: false,
            partnerCheckoutAvailable: false,
            billingPortalAvailable: false,
        },
    };
}

function parseStoredSession(raw) {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (
            parsed?.version !== SESSION_VERSION
            || typeof parsed.refreshToken !== 'string'
            || !parsed.refreshToken
            || parsed.refreshToken.length > 16_384
        ) return null;
        return { version: SESSION_VERSION, refreshToken: parsed.refreshToken };
    } catch {
        return null;
    }
}

function authUserFromResponse(value) {
    const user = value?.user ?? value;
    if (!user || typeof user !== 'object' || typeof user.id !== 'string' || typeof user.email !== 'string') return null;
    return user;
}

function internalSessionFromResponse(value) {
    if (
        !value
        || typeof value.access_token !== 'string'
        || !value.access_token
        || typeof value.refresh_token !== 'string'
        || !value.refresh_token
    ) return null;
    const expiresIn = Number(value.expires_in);
    const expiresAt = Number(value.expires_at);
    const expiresAtSeconds = Number.isFinite(expiresAt) && expiresAt > 0
        ? Math.floor(expiresAt)
        : Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 3600);
    return {
        accessToken: value.access_token,
        refreshToken: value.refresh_token,
        expiresAtSeconds,
        user: authUserFromResponse(value),
    };
}

function sanitizeMessage(status, payload, fallback) {
    if (status === 400 || status === 401) {
        const raw = String(payload?.msg || payload?.message || payload?.error_description || '').toLowerCase();
        if (raw.includes('invalid login') || raw.includes('invalid credential')) return 'The email or password is incorrect.';
        if (raw.includes('email not confirmed')) return 'Verify your email before signing in.';
        if (raw.includes('already registered') || raw.includes('already been registered')) return 'An account already exists for this email.';
    }
    if (status === 429) return 'Too many attempts. Wait a moment and try again.';
    return fallback;
}

function errorCodeForStatus(status) {
    if (status === 401) return 'invalid-credentials';
    if (status === 403) return 'not-entitled';
    if (status === 429) return 'rate-limited';
    if (status >= 500) return 'service-unavailable';
    return 'internal';
}

function validateEmail(value) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
}

function validatePassword(value) {
    return typeof value === 'string' && value.length >= 8 && value.length <= 1024 ? value : null;
}

function requestId() {
    return crypto.randomUUID();
}

function canonicalCheckoutInput(input) {
    if (input?.kind === 'subscription' && PLAN_IDS.has(input.planId) && BILLING_INTERVALS.has(input.billingInterval)) {
        return { kind: 'subscription', planId: input.planId, billingInterval: input.billingInterval };
    }
    if (input?.kind === 'top-up' && Number.isSafeInteger(input.amountCreditMicros) && input.amountCreditMicros > 0) {
        return { kind: 'top-up', amountCreditMicros: input.amountCreditMicros };
    }
    if (input?.kind === 'partner' || input?.kind === 'billing-portal') return { kind: input.kind };
    return null;
}

function checkoutFingerprint(input) {
    const canonical = canonicalCheckoutInput(input);
    return canonical
        ? crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
        : '';
}

function parseCheckoutStateValue(value) {
    try {
        const target = canonicalCheckoutInput(value?.target);
        if (
            value?.version !== CHECKOUT_STATE_VERSION
            || typeof value.accountId !== 'string'
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.accountId)
            || typeof value.requestId !== 'string'
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
            || !target
            || value.fingerprint !== checkoutFingerprint(target)
            || !Number.isSafeInteger(value.createdAtMs)
            || !Number.isSafeInteger(value.expiresAtMs)
            || value.expiresAtMs <= value.createdAtMs
            || !['prepared', 'opened'].includes(value.stage)
            || typeof value.baselineMarker !== 'string'
            || value.baselineMarker.length > 2048
        ) return null;
        if (value.stage === 'opened' && (
            typeof value.intentId !== 'string'
            || !/^[A-Za-z0-9_-]{8,200}$/.test(value.intentId)
            || !Number.isSafeInteger(value.openedAtMs)
        )) return null;
        return {
            version: CHECKOUT_STATE_VERSION,
            accountId: value.accountId.toLowerCase(),
            requestId: value.requestId.toLowerCase(),
            target,
            fingerprint: value.fingerprint,
            createdAtMs: value.createdAtMs,
            expiresAtMs: value.expiresAtMs,
            stage: value.stage,
            baselineMarker: value.baselineMarker,
            ...(value.stage === 'opened' ? { intentId: value.intentId, openedAtMs: value.openedAtMs } : {}),
        };
    } catch {
        return null;
    }
}

function parseStoredCheckoutStates(raw) {
    if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > CHECKOUT_STATE_MAX_BYTES) return [];
    try {
        const value = JSON.parse(raw);
        const legacy = parseCheckoutStateValue(value);
        if (legacy) return [legacy];
        if (
            value?.version !== CHECKOUT_STORE_VERSION
            || !Array.isArray(value.checkouts)
            || value.checkouts.length > MAX_ACCOUNT_CHECKOUT_STATES
        ) return [];
        const states = [];
        const accountIds = new Set();
        for (const entry of value.checkouts) {
            const state = parseCheckoutStateValue(entry);
            if (!state || accountIds.has(state.accountId)) return [];
            accountIds.add(state.accountId);
            states.push(state);
        }
        return states;
    } catch {
        return [];
    }
}

function parseStoredCheckoutState(raw) {
    const states = parseStoredCheckoutStates(raw);
    return states.length === 1 ? states[0] : null;
}

function checkoutBaselineMarker() {
    // Kept only for backward-compatible parsing of already encrypted state.
    // Payment completion is never inferred from this marker.
    return 'server-status-required';
}

function createAccountService(options) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const supabaseUrl = normalizeBaseUrl(options.supabaseUrl);
    const anonKey = typeof options.anonKey === 'string' ? options.anonKey.trim() : '';
    const accountApiUrl = normalizeBaseUrl(options.accountApiUrl);
    const checkoutHosts = normalizeCheckoutHosts(options.checkoutHosts);
    const oauthProviders = normalizeOAuthProviders(options.oauthProviders);
    const configuredOAuthProviders = Object.freeze(
        [...OAUTH_PROVIDERS].filter((provider) => oauthProviders.has(provider)),
    );
    const callbackUrl = typeof options.callbackUrl === 'string' ? options.callbackUrl : '';
    const recoveryCallbackUrl = typeof options.recoveryCallbackUrl === 'string' ? options.recoveryCallbackUrl : '';
    const confirmCallbackUrl = typeof options.confirmCallbackUrl === 'string' ? options.confirmCallbackUrl : '';
    const accountConfigured = Boolean(fetchImpl && supabaseUrl && anonKey);
    const allowLegacyDirectProvider = options.allowLegacyDirectProvider === true;
    const hasDurableCheckoutState = typeof options.readCheckoutState === 'function'
        && typeof options.writeCheckoutState === 'function'
        && typeof options.clearCheckoutState === 'function';
    const billingConfigured = Boolean(accountConfigured && accountApiUrl && checkoutHosts.size && hasDurableCheckoutState);

    let internalSession = null;
    let revision = 0;
    let cachedSnapshot = emptySnapshot({
        revision,
        accountConfigured,
        billingConfigured,
        oauthProviders: configuredOAuthProviders,
        directProviderAllowed: transitionalDirectProviderAllowed(),
    });
    let pendingOAuth = null;
    let oauthExpiryTimer = null;
    let pendingPasswordRecovery = null;
    let passwordRecoveryExpiryTimer = null;
    let pendingEmailConfirmation = null;
    let emailConfirmationExpiryTimer = null;
    let lastCheckoutStatus = null;
    let authQueue = Promise.resolve();

    function clearOAuthExpiryTimer() {
        if (oauthExpiryTimer) clearTimeout(oauthExpiryTimer);
        oauthExpiryTimer = null;
    }

    function emitOAuthCompletion(attempt, state, message) {
        if (!attempt?.attemptId) return;
        try {
            options.onOAuthCompleted?.({ attemptId: attempt.attemptId, state, message });
        } catch { /* renderer notification is best effort */ }
    }

    function finishOAuthAttempt(attempt, state, message) {
        if (pendingOAuth === attempt) pendingOAuth = null;
        clearOAuthExpiryTimer();
        emitOAuthCompletion(attempt, state, message);
    }

    function scheduleOAuthExpiry(attempt) {
        clearOAuthExpiryTimer();
        const delay = Math.max(0, attempt.expiresAtMs - Date.now());
        oauthExpiryTimer = setTimeout(() => {
            if (pendingOAuth !== attempt || attempt.used) return;
            finishOAuthAttempt(attempt, 'expired', 'Social sign-in expired. Try again.');
        }, delay);
        oauthExpiryTimer.unref?.();
    }

    function oauthAttemptInProgress() {
        if (pendingOAuth && !pendingOAuth.used && pendingOAuth.expiresAtMs <= Date.now()) {
            finishOAuthAttempt(pendingOAuth, 'expired', 'Social sign-in expired. Try again.');
        }
        return pendingOAuth != null;
    }

    function clearPasswordRecoveryExpiryTimer() {
        if (passwordRecoveryExpiryTimer) clearTimeout(passwordRecoveryExpiryTimer);
        passwordRecoveryExpiryTimer = null;
    }

    function emitPasswordRecoveryCompletion(attempt, state, message) {
        if (!attempt?.attemptId) return;
        try {
            options.onPasswordRecoveryCompleted?.({ attemptId: attempt.attemptId, state, message });
        } catch { /* renderer notification is best effort */ }
    }

    function finishPasswordRecoveryAttempt(attempt, state, message) {
        if (pendingPasswordRecovery === attempt) pendingPasswordRecovery = null;
        clearPasswordRecoveryExpiryTimer();
        emitPasswordRecoveryCompletion(attempt, state, message);
    }

    function schedulePasswordRecoveryExpiry(attempt) {
        clearPasswordRecoveryExpiryTimer();
        const delay = Math.max(0, attempt.expiresAtMs - Date.now());
        passwordRecoveryExpiryTimer = setTimeout(() => {
            if (pendingPasswordRecovery !== attempt) return;
            finishPasswordRecoveryAttempt(attempt, 'expired', 'Password recovery expired. Request a new email.');
        }, delay);
        passwordRecoveryExpiryTimer.unref?.();
    }

    function clearEmailConfirmationExpiryTimer() {
        if (emailConfirmationExpiryTimer) clearTimeout(emailConfirmationExpiryTimer);
        emailConfirmationExpiryTimer = null;
    }

    function emitEmailConfirmationCompletion(attempt, state, message) {
        if (!attempt?.attemptId) return;
        try {
            options.onEmailConfirmed?.({ attemptId: attempt.attemptId, state, message });
        } catch { /* renderer notification is best effort */ }
    }

    function finishEmailConfirmationAttempt(attempt, state, message) {
        if (pendingEmailConfirmation === attempt) pendingEmailConfirmation = null;
        clearEmailConfirmationExpiryTimer();
        emitEmailConfirmationCompletion(attempt, state, message);
    }

    function scheduleEmailConfirmationExpiry(attempt) {
        clearEmailConfirmationExpiryTimer();
        const delay = Math.max(0, attempt.expiresAtMs - Date.now());
        emailConfirmationExpiryTimer = setTimeout(() => {
            if (pendingEmailConfirmation !== attempt || attempt.used) return;
            // Deliberately quiet: the confirmation link itself is still valid for
            // much longer on the server. Only the automatic sign-in has lapsed.
            finishEmailConfirmationAttempt(attempt, 'expired', 'Confirm from the email, then sign in.');
        }, delay);
        emailConfirmationExpiryTimer.unref?.();
    }

    /**
     * Opens a confirmation attempt and returns what the Auth request needs to
     * bind the emailed link back to this process. Returns null when the build
     * has no loopback callback configured, in which case the caller sends no
     * redirect_to and Supabase falls back to the Site URL exactly as before.
     */
    function beginEmailConfirmation(email) {
        if (!confirmCallbackUrl) return null;
        if (pendingEmailConfirmation) {
            finishEmailConfirmationAttempt(
                pendingEmailConfirmation,
                'cancelled',
                'The previous verification request was replaced.',
            );
        }
        const verifier = crypto.randomBytes(48).toString('base64url');
        const state = crypto.randomBytes(32).toString('base64url');
        const redirect = new URL(confirmCallbackUrl);
        redirect.searchParams.set('attempt', state);
        const attempt = {
            attemptId: requestId(),
            email,
            verifier,
            state,
            redirectUrl: redirect.toString(),
            expiresAtMs: Date.now() + EMAIL_CONFIRMATION_TTL_MS,
            used: false,
        };
        pendingEmailConfirmation = attempt;
        scheduleEmailConfirmationExpiry(attempt);
        return attempt;
    }

    function passwordRecoveryReady() {
        const attempt = pendingPasswordRecovery;
        if (attempt && attempt.expiresAtMs <= Date.now()) {
            finishPasswordRecoveryAttempt(attempt, 'expired', 'Password recovery expired. Request a new email.');
            return false;
        }
        return Boolean(attempt?.recoverySession);
    }

    function currentAccountId() {
        const accountId = internalSession?.user?.id;
        return typeof accountId === 'string' ? accountId.toLowerCase() : '';
    }

    function readCheckoutStates() {
        try { return parseStoredCheckoutStates(options.readCheckoutState?.()); } catch { return []; }
    }

    function readCheckoutState(accountId = currentAccountId()) {
        const normalized = typeof accountId === 'string' ? accountId.toLowerCase() : '';
        if (!normalized) return null;
        return readCheckoutStates().find((state) => state.accountId === normalized) || null;
    }

    function writeCheckoutState(value) {
        const state = parseCheckoutStateValue(value);
        if (!state) throw new Error('invalid-checkout-state');
        const states = readCheckoutStates();
        const existingIndex = states.findIndex((entry) => entry.accountId === state.accountId);
        if (existingIndex >= 0) {
            states[existingIndex] = state;
        } else {
            // Never evict another account's unresolved payment recovery state.
            // If the bounded encrypted store is full, starting another checkout
            // fails safely instead of destroying an existing recovery linkage.
            if (states.length >= MAX_ACCOUNT_CHECKOUT_STATES) throw new Error('checkout-store-full');
            states.push(state);
        }
        const raw = JSON.stringify({ version: CHECKOUT_STORE_VERSION, checkouts: states });
        if (Buffer.byteLength(raw) > CHECKOUT_STATE_MAX_BYTES) throw new Error('checkout-state-too-large');
        options.writeCheckoutState(raw);
    }

    function clearCheckoutState(accountId = currentAccountId()) {
        const normalized = typeof accountId === 'string' ? accountId.toLowerCase() : '';
        if (!normalized) return;
        const remaining = readCheckoutStates().filter((state) => state.accountId !== normalized);
        if (remaining.length === 0) {
            options.clearCheckoutState?.();
            return;
        }
        const raw = JSON.stringify({ version: CHECKOUT_STORE_VERSION, checkouts: remaining });
        if (Buffer.byteLength(raw) > CHECKOUT_STATE_MAX_BYTES) throw new Error('checkout-state-too-large');
        options.writeCheckoutState(raw);
    }

    function reconcileCheckoutState(snapshot, authoritativeStatus) {
        const state = readCheckoutState();
        if (!state) return lastCheckoutStatus;
        const accountId = snapshot?.session?.status === 'signed-in' ? snapshot.session.accountId : null;
        if (!accountId || state.accountId !== String(accountId).toLowerCase()) {
            clearCheckoutState();
            lastCheckoutStatus = null;
            return null;
        }
        const purchaseKind = ['subscription', 'top-up', 'partner'].includes(state.target.kind)
            ? state.target.kind
            : null;
        if (!purchaseKind) {
            clearCheckoutState();
            lastCheckoutStatus = null;
            return null;
        }

        if (authoritativeStatus?.found === true && authoritativeStatus.state === 'completed') {
            clearCheckoutState();
            lastCheckoutStatus = { state: 'completed', kind: purchaseKind, updatedAtMs: authoritativeStatus.updatedAtMs };
            return lastCheckoutStatus;
        }
        if (authoritativeStatus?.found === true && authoritativeStatus.state === 'closed-unpaid') {
            clearCheckoutState();
            lastCheckoutStatus = { state: 'closed-unpaid', kind: purchaseKind, updatedAtMs: authoritativeStatus.updatedAtMs };
            return lastCheckoutStatus;
        }
        if (authoritativeStatus?.found === true && authoritativeStatus.state === 'awaiting-reconciliation') {
            lastCheckoutStatus = {
                state: 'awaiting-reconciliation',
                kind: purchaseKind,
                updatedAtMs: authoritativeStatus.updatedAtMs,
            };
            return lastCheckoutStatus;
        }
        if (authoritativeStatus?.found === true && authoritativeStatus.state === 'open') {
            const opened = {
                ...state,
                stage: 'opened',
                intentId: authoritativeStatus.intentId,
                openedAtMs: state.stage === 'opened' ? state.openedAtMs : authoritativeStatus.updatedAtMs,
                expiresAtMs: authoritativeStatus.expiresAtMs,
            };
            if (state.stage !== 'opened' || state.intentId !== opened.intentId || state.expiresAtMs !== opened.expiresAtMs) {
                try { writeCheckoutState(opened); } catch { /* retain the previous safe state */ }
            }
            lastCheckoutStatus = {
                state: 'pending',
                kind: purchaseKind,
                startedAtMs: opened.openedAtMs,
                expiresAtMs: opened.expiresAtMs,
            };
            return lastCheckoutStatus;
        }

        // A prepared operation is safe to retry with the same request ID. An
        // opened operation with a temporarily unavailable status endpoint stays
        // pending; neither local time nor mutable balances can close it.
        lastCheckoutStatus = state.stage === 'opened'
            ? {
                state: authoritativeStatus?.found === false ? 'awaiting-reconciliation' : 'pending',
                kind: purchaseKind,
                ...(authoritativeStatus?.found === false
                    ? { updatedAtMs: Date.now() }
                    : { startedAtMs: state.openedAtMs, expiresAtMs: state.expiresAtMs }),
            }
            : {
                state: 'ready-to-resume',
                kind: purchaseKind,
                startedAtMs: state.createdAtMs,
                expiresAtMs: state.expiresAtMs,
            };
        return lastCheckoutStatus;
    }

    function transitionalDirectProviderAllowed() {
        return !accountConfigured && allowLegacyDirectProvider;
    }

    function enqueue(operation) {
        const current = authQueue.then(operation, operation);
        authQueue = current.then(() => undefined, () => undefined);
        return current;
    }

    async function requestJson(url, requestOptions = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestOptions.timeoutMs || REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(url, {
                method: requestOptions.method || 'GET',
                headers: requestOptions.headers,
                body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
                signal: controller.signal,
                redirect: 'error',
            });
            const length = Number(response.headers?.get?.('content-length'));
            if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new Error('response-too-large');
            const text = await response.text();
            if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error('response-too-large');
            let payload = null;
            if (text) {
                try { payload = JSON.parse(text); } catch { payload = null; }
            }
            return { response, payload };
        } finally {
            clearTimeout(timeout);
        }
    }

    function baseHeaders(accessToken) {
        const headers = {
            apikey: anonKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Client-Info': 'easyfield-desktop/1',
        };
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        return headers;
    }

    function persistRefreshToken(refreshToken) {
        options.writeSession(JSON.stringify({ version: SESSION_VERSION, refreshToken }));
    }

    function clearSession() {
        internalSession = null;
        lastCheckoutStatus = null;
        try { options.clearSession(); } catch { /* best effort */ }
        // A hosted payment can complete after sign-out. Keep its encrypted,
        // account-bound idempotency state so the same account can recover it.
    }

    async function acceptSession(value) {
        const next = internalSessionFromResponse(value);
        if (!next) return false;
        const previousAccountId = currentAccountId();
        internalSession = next;
        if (previousAccountId && previousAccountId !== currentAccountId()) lastCheckoutStatus = null;
        persistRefreshToken(next.refreshToken);
        return true;
    }

    async function refreshSession(force = false) {
        if (!accountConfigured) return null;
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (!force && internalSession?.accessToken && internalSession.expiresAtSeconds > nowSeconds + REFRESH_SKEW_SECONDS) {
            return internalSession;
        }
        let refreshToken = internalSession?.refreshToken || '';
        if (!refreshToken) {
            const stored = parseStoredSession(options.readSession());
            refreshToken = stored?.refreshToken || '';
        }
        if (!refreshToken) return null;
        try {
            const { response, payload } = await requestJson(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
                method: 'POST',
                headers: baseHeaders(),
                body: { refresh_token: refreshToken },
            });
            if (!response.ok || !await acceptSession(payload)) {
                if (response.status === 400 || response.status === 401) clearSession();
                return null;
            }
            return internalSession;
        } catch {
            return internalSession?.accessToken ? internalSession : null;
        }
    }

    async function fetchAuthUser(accessToken) {
        const { response, payload } = await requestJson(`${supabaseUrl}/auth/v1/user`, {
            headers: baseHeaders(accessToken),
        });
        if (!response.ok) return null;
        return authUserFromResponse(payload);
    }

    async function sessionMatchesAccount(session, expectedAccountId) {
        const expected = typeof expectedAccountId === 'string' ? expectedAccountId.toLowerCase() : '';
        if (!session?.accessToken || !expected) return false;
        const sessionUserId = typeof session.user?.id === 'string' ? session.user.id.toLowerCase() : '';
        if (sessionUserId && sessionUserId !== expected) return false;
        try {
            // Re-read the owner of this exact bearer token immediately before a
            // billing mutation. The user embedded in a cached/refreshed session
            // is useful as an early mismatch check, but it is not the authority
            // for persisting or submitting a paid operation.
            const user = await fetchAuthUser(session.accessToken);
            return typeof user?.id === 'string' && user.id.toLowerCase() === expected;
        } catch {
            return false;
        }
    }

    async function fetchBillingSnapshot(accessToken) {
        const { response, payload } = await requestJson(`${supabaseUrl}/rest/v1/rpc/my_billing_snapshot`, {
            method: 'POST',
            headers: baseHeaders(accessToken),
            body: {},
        });
        return response.ok && payload && typeof payload === 'object' ? payload : null;
    }

    async function fetchPartnerEntitlement(accessToken) {
        const select = [
            'status', 'included_microcredits', 'lifetime_access', 'all_model_access',
            'raw_provider_pricing_access', 'direct_provider_billing', 'starts_at', 'ends_at',
        ].join(',');
        const url = `${supabaseUrl}/rest/v1/partner_entitlements?select=${encodeURIComponent(select)}&order=created_at.desc&limit=1`;
        const { response, payload } = await requestJson(url, { headers: baseHeaders(accessToken) });
        if (!response.ok || !Array.isArray(payload) || !payload[0]) return null;
        const row = payload[0];
        return {
            productId: 'partner_lifetime',
            status: row.status === 'active' ? 'active' : 'revoked',
            lifetime: row.lifetime_access === true,
            allModelsIncluded: row.all_model_access === true,
            assertedByServer: true,
            activatedAtMs: toEpochMs(row.starts_at),
        };
    }

    async function fetchPrivilegedBilling(accessToken, directAllowed) {
        if (!accountApiUrl || !directAllowed) return null;
        try {
            const { response, payload } = await requestJson(`${accountApiUrl}/privileged-snapshot`, {
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            });
            if (!response.ok || !payload || typeof payload !== 'object') return null;
            return {
                upstreamBalanceCreditMicros: payload.upstreamBalanceCreditMicros == null ? null : safeMicros(payload.upstreamBalanceCreditMicros),
                latestRawCostMoneyMicros: payload.latestRawCostMoneyMicros == null ? null : safeMicros(payload.latestRawCostMoneyMicros),
                latestRawCostCurrencyCode: /^[A-Z]{3}$/.test(payload.latestRawCostCurrencyCode || '') ? payload.latestRawCostCurrencyCode : null,
                measuredAtMs: Number.isSafeInteger(payload.measuredAtMs) ? payload.measuredAtMs : Date.now(),
            };
        } catch {
            return null;
        }
    }

    async function fetchDirectAccess(accessToken, expectedAccountId) {
        if (!accountApiUrl || !expectedAccountId) return false;
        try {
            const { response, payload } = await requestJson(`${accountApiUrl}/direct-access`, {
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            });
            if (
                !response.ok
                || !payload
                || typeof payload !== 'object'
                || Array.isArray(payload)
                || Object.keys(payload).some((key) => !['accountId', 'allowed'].includes(key))
                || payload.accountId !== expectedAccountId
                || typeof payload.allowed !== 'boolean'
            ) return false;
            return payload.allowed;
        } catch {
            return false;
        }
    }

    async function fetchServiceCapabilities(accessToken, expectedAccountId) {
        const unavailable = {
            customerGenerationReady: false,
            customerCheckoutAvailable: false,
            partnerCheckoutAvailable: false,
            billingPortalAvailable: false,
        };
        if (!accountApiUrl || !expectedAccountId) return unavailable;
        try {
            const { response, payload } = await requestJson(`${accountApiUrl}/service-capabilities`, {
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            });
            if (
                !response.ok
                || !payload
                || typeof payload !== 'object'
                || Array.isArray(payload)
                || Object.keys(payload).length !== 5
                || Object.keys(payload).some((key) => ![
                    'accountId', 'customerGenerationReady', 'customerCheckoutAvailable',
                    'partnerCheckoutAvailable', 'billingPortalAvailable',
                ].includes(key))
                || payload.accountId !== expectedAccountId
                || typeof payload.customerGenerationReady !== 'boolean'
                || typeof payload.customerCheckoutAvailable !== 'boolean'
                || typeof payload.partnerCheckoutAvailable !== 'boolean'
                || typeof payload.billingPortalAvailable !== 'boolean'
                || (payload.customerCheckoutAvailable && !payload.customerGenerationReady)
            ) return unavailable;
            return {
                customerGenerationReady: payload.customerGenerationReady,
                customerCheckoutAvailable: payload.customerCheckoutAvailable,
                partnerCheckoutAvailable: payload.partnerCheckoutAvailable,
                billingPortalAvailable: payload.billingPortalAvailable,
            };
        } catch {
            return unavailable;
        }
    }

    async function fetchCheckoutStatus(accessToken, expectedAccountId, state) {
        if (!accountApiUrl || !state || !expectedAccountId) return null;
        const purchaseKind = ['subscription', 'top-up', 'partner'].includes(state.target.kind)
            ? state.target.kind
            : null;
        if (!purchaseKind) return null;
        try {
            const { response, payload } = await requestJson(`${accountApiUrl}/checkout-status`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: { kind: purchaseKind, requestId: state.requestId },
            });
            if (response.status === 404) return { found: false };
            const allowedKeys = new Set([
                'version', 'kind', 'requestId', 'intentId', 'state', 'terminal',
                'mayStartNewCheckout', 'checkoutUrl', 'providerExpiresAt', 'updatedAt',
            ]);
            const remoteStates = new Set([
                'prepared', 'open', 'awaiting-reconciliation', 'completed', 'closed-unpaid',
            ]);
            if (
                !response.ok
                || !payload
                || typeof payload !== 'object'
                || Array.isArray(payload)
                || Object.keys(payload).length !== allowedKeys.size
                || Object.keys(payload).some((key) => !allowedKeys.has(key))
                || payload.version !== 1
                || payload.kind !== purchaseKind
                || payload.requestId !== state.requestId
                || typeof payload.intentId !== 'string'
                || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.intentId)
                || typeof payload.state !== 'string'
                || !remoteStates.has(payload.state)
                || typeof payload.terminal !== 'boolean'
                || typeof payload.mayStartNewCheckout !== 'boolean'
                || typeof payload.updatedAt !== 'string'
                || !Number.isFinite(Date.parse(payload.updatedAt))
                || (payload.providerExpiresAt !== null
                    && (typeof payload.providerExpiresAt !== 'string' || !Number.isFinite(Date.parse(payload.providerExpiresAt))))
            ) return null;
            const terminal = payload.state === 'completed' || payload.state === 'closed-unpaid';
            const mayStartNewCheckout = payload.state === 'closed-unpaid'
                || (payload.state === 'completed' && payload.kind === 'top-up');
            if (payload.terminal !== terminal || payload.mayStartNewCheckout !== mayStartNewCheckout) return null;
            const checkoutUrl = payload.state === 'open' ? validateCheckoutUrl(payload.checkoutUrl) : null;
            if ((payload.state === 'open' && !checkoutUrl) || (payload.state !== 'open' && payload.checkoutUrl !== null)) return null;
            return {
                found: true,
                state: payload.state,
                intentId: payload.intentId,
                checkoutUrl,
                expiresAtMs: payload.providerExpiresAt === null ? state.expiresAtMs : Date.parse(payload.providerExpiresAt),
                updatedAtMs: Date.parse(payload.updatedAt),
            };
        } catch {
            return null;
        }
    }

    async function retireMissingPreparedCheckoutAfterDefinitiveRejection(session, accountId, state) {
        if (
            state?.stage !== 'prepared'
            || !['subscription', 'top-up', 'partner'].includes(state.target?.kind)
            || !await sessionMatchesAccount(session, accountId)
        ) return false;
        const authoritativeStatus = await fetchCheckoutStatus(session.accessToken, accountId, state);
        if (authoritativeStatus?.found !== false) return false;
        const current = readCheckoutState(accountId);
        if (!current || current.requestId !== state.requestId || current.stage !== 'prepared') return false;
        clearCheckoutState(accountId);
        lastCheckoutStatus = {
            state: 'closed-unpaid',
            kind: state.target.kind,
            updatedAtMs: Date.now(),
        };
        // Publish the terminal renderer state immediately so checkout controls
        // unlock without asking the user to restart. With no server operation
        // after a completed, definitive rejection, there is nothing payable to
        // recover or abandon.
        try { await getSnapshot(true); } catch { /* the durable local state is already safely retired */ }
        return true;
    }

    function toAccountSnapshot(
        user,
        billing,
        partnerEntitlement,
        privilegedBilling,
        authoritativeDirectAllowed,
        serviceCapabilities,
        authoritativeCheckoutStatus,
    ) {
        revision += 1;
        const profile = billing?.profile || {};
        const account = billing?.account;
        const subscription = billing?.subscription;
        const nextExpiring = billing?.next_expiring_lot;
        const role = safeRole(profile.platform_role);
        const emailVerified = Boolean(user.email_confirmed_at || user.confirmed_at);
        const directProviderAllowed = emailVerified && authoritativeDirectAllowed === true;
        const availableMicros = safeMicros(account?.available_microcredits);
        const serverMeasuredAtMs = toEpochMs(billing?.as_of) || Date.now();
        const entitlementEndsAtMs = toEpochMs(subscription?.entitlement_ends_at);
        const activeSubscription = subscription
            && ['active', 'trialing'].includes(String(subscription.status))
            && entitlementEndsAtMs != null
            && entitlementEndsAtMs > serverMeasuredAtMs;
        const generationAccess = emailVerified && (
            directProviderAllowed
            || (serviceCapabilities.customerGenerationReady && activeSubscription && availableMicros > 0)
        );

        const autoReload = billing?.auto_reload;
        cachedSnapshot = {
            version: 1,
            revision,
            measuredAtMs: serverMeasuredAtMs,
            session: {
                status: 'signed-in',
                accountId: user.id,
                email: user.email,
                displayName: typeof user.user_metadata?.full_name === 'string'
                    ? user.user_metadata.full_name.slice(0, 160)
                    : typeof user.user_metadata?.name === 'string'
                        ? user.user_metadata.name.slice(0, 160)
                        : undefined,
                emailVerified,
                platformRole: role,
            },
            subscription: subscription && PLAN_IDS.has(subscription.plan_key) && BILLING_INTERVALS.has(subscription.billing_interval)
                ? {
                    planId: subscription.plan_key,
                    billingInterval: subscription.billing_interval,
                    status: mapSubscriptionStatus(subscription.status),
                    currentPeriodEndMs: toEpochMs(subscription.current_period_end),
                    entitlementEndsAtMs,
                    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
                }
                : null,
            balances: account
                ? {
                    subscriptionCreditMicros: safeMicros(account.subscription_microcredits),
                    subscriptionExpiresAtMs: toEpochMs(nextExpiring?.expires_at),
                    purchasedCreditMicros: safeMicros(account.purchased_microcredits),
                    otherCreditMicros: safeMicros(account.other_microcredits),
                    measuredAtMs: serverMeasuredAtMs,
                }
                : null,
            partnerEntitlement,
            autoReloadPolicy: autoReload?.enabled === true
                ? {
                    enabled: true,
                    triggerBalanceCreditMicros: safeMicros(autoReload.trigger_below_microcredits),
                    topUpAmountCreditMicros: safeMicros(autoReload.reload_microcredits),
                }
                : defaultAutoReloadPolicy(),
            checkoutStatus: null,
            privilegedBilling: directProviderAllowed ? privilegedBilling : null,
            capabilities: {
                accountConfigured,
                billingConfigured,
                oauthProviders: [...configuredOAuthProviders],
                generationAccess,
                directProviderAllowed,
                customerCheckoutAvailable: serviceCapabilities.customerCheckoutAvailable === true,
                partnerCheckoutAvailable: serviceCapabilities.partnerCheckoutAvailable === true,
                billingPortalAvailable: serviceCapabilities.billingPortalAvailable === true,
            },
        };
        cachedSnapshot.checkoutStatus = reconcileCheckoutState(cachedSnapshot, authoritativeCheckoutStatus);
        options.onChanged?.(cachedSnapshot);
        return cachedSnapshot;
    }

    function setSignedOutSnapshot() {
        revision += 1;
        cachedSnapshot = emptySnapshot({
            revision,
            accountConfigured,
            billingConfigured,
            oauthProviders: configuredOAuthProviders,
            directProviderAllowed: transitionalDirectProviderAllowed(),
        });
        options.onChanged?.(cachedSnapshot);
        return cachedSnapshot;
    }

    async function getSnapshot(force = false) {
        if (!accountConfigured) return setSignedOutSnapshot();
        const session = await refreshSession(force);
        if (!session?.accessToken) return setSignedOutSnapshot();
        const user = await fetchAuthUser(session.accessToken);
        if (!user) {
            if (force) clearSession();
            return setSignedOutSnapshot();
        }
        const localCheckoutState = readCheckoutState();
        const [billing, partner, authoritativeDirectAllowed, serviceCapabilities, authoritativeCheckoutStatus] = await Promise.all([
            fetchBillingSnapshot(session.accessToken),
            fetchPartnerEntitlement(session.accessToken),
            fetchDirectAccess(session.accessToken, user.id),
            fetchServiceCapabilities(session.accessToken, user.id),
            fetchCheckoutStatus(session.accessToken, user.id, localCheckoutState),
        ]);
        const directAllowed = Boolean(user.email_confirmed_at || user.confirmed_at)
            && authoritativeDirectAllowed === true;
        const privileged = await fetchPrivilegedBilling(session.accessToken, directAllowed);
        return toAccountSnapshot(
            user,
            billing,
            partner,
            privileged,
            directAllowed,
            serviceCapabilities,
            authoritativeCheckoutStatus,
        );
    }

    async function restore() {
        try {
            return resultOk(await enqueue(() => getSnapshot(true)));
        } catch {
            return resultError('network', 'EasyField could not reach the account service.', true);
        }
    }

    async function signIn(input) {
        const email = validateEmail(input?.email);
        const password = validatePassword(input?.password);
        if (!email || !password) return resultError('invalid-input', 'Enter a valid email and a password of at least 8 characters.');
        if (!accountConfigured) return resultError('service-unavailable', 'EasyField account service is not configured in this build.');
        if (oauthAttemptInProgress()) {
            return resultError('oauth-in-progress', 'Finish or cancel the open social sign-in before using email and password.');
        }
        if (passwordRecoveryReady()) {
            return resultError('recovery-in-progress', 'Finish or cancel the open password recovery before signing in.');
        }
        return enqueue(async () => {
            if (oauthAttemptInProgress()) {
                return resultError('oauth-in-progress', 'Finish or cancel the open social sign-in before using email and password.');
            }
            if (passwordRecoveryReady()) {
                return resultError('recovery-in-progress', 'Finish or cancel the open password recovery before signing in.');
            }
            try {
                const { response, payload } = await requestJson(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
                    method: 'POST', headers: baseHeaders(), body: { email, password },
                });
                if (!response.ok || !await acceptSession(payload)) {
                    return resultError(
                        errorCodeForStatus(response.status),
                        sanitizeMessage(response.status, payload, 'EasyField could not sign you in.'),
                        response.status === 429 || response.status >= 500,
                    );
                }
                return resultOk({ state: 'authenticated', snapshot: await getSnapshot(true) });
            } catch {
                return resultError('network', 'EasyField could not reach the account service.', true);
            }
        });
    }

    async function signUp(input) {
        const email = validateEmail(input?.email);
        const password = validatePassword(input?.password);
        if (!email || !password) return resultError('invalid-input', 'Enter a valid email and a password of at least 8 characters.');
        if (!accountConfigured) return resultError('service-unavailable', 'EasyField account service is not configured in this build.');
        if (oauthAttemptInProgress()) {
            return resultError('oauth-in-progress', 'Finish or cancel the open social sign-in before creating an account.');
        }
        if (passwordRecoveryReady()) {
            return resultError('recovery-in-progress', 'Finish or cancel the open password recovery before creating an account.');
        }
        return enqueue(async () => {
            if (oauthAttemptInProgress()) {
                return resultError('oauth-in-progress', 'Finish or cancel the open social sign-in before creating an account.');
            }
            if (passwordRecoveryReady()) {
                return resultError('recovery-in-progress', 'Finish or cancel the open password recovery before creating an account.');
            }
            try {
                // The confirmation link is bound to this process so clicking it
                // returns the customer to EasyField signed in, rather than to a web
                // page that leaves them to sign in again by hand.
                const confirmation = beginEmailConfirmation(email);
                const signupUrl = new URL(`${supabaseUrl}/auth/v1/signup`);
                if (confirmation) signupUrl.searchParams.set('redirect_to', confirmation.redirectUrl);
                const { response, payload } = await requestJson(signupUrl.toString(), {
                    method: 'POST',
                    headers: baseHeaders(),
                    body: confirmation
                        ? {
                            email,
                            password,
                            code_challenge: oauthChallenge(confirmation.verifier),
                            code_challenge_method: 's256',
                        }
                        : { email, password },
                });
                if (!response.ok) {
                    if (confirmation) {
                        finishEmailConfirmationAttempt(confirmation, 'cancelled', 'The account was not created.');
                    }
                    return resultError(
                        errorCodeForStatus(response.status),
                        sanitizeMessage(response.status, payload, 'EasyField could not create the account.'),
                        response.status === 429 || response.status >= 500,
                    );
                }
                if (await acceptSession(payload)) {
                    // Confirmation is disabled on this project, so the attempt has
                    // nothing left to wait for.
                    if (confirmation) {
                        finishEmailConfirmationAttempt(confirmation, 'not-required', 'Your account is ready.');
                    }
                    return resultOk({ state: 'authenticated', snapshot: await getSnapshot(true) });
                }
                return resultOk({
                    state: 'verification-required',
                    email,
                    attemptId: confirmation?.attemptId ?? null,
                    expiresAtMs: confirmation?.expiresAtMs ?? null,
                });
            } catch {
                return resultError('network', 'EasyField could not reach the account service.', true);
            }
        });
    }

    async function signOut() {
        return enqueue(async () => {
            if (pendingOAuth) {
                finishOAuthAttempt(pendingOAuth, 'cancelled', 'Social sign-in was cancelled.');
            }
            const accessToken = internalSession?.accessToken;
            clearSession();
            if (accessToken && accountConfigured) {
                try {
                    await requestJson(`${supabaseUrl}/auth/v1/logout`, {
                        method: 'POST', headers: baseHeaders(accessToken), body: {},
                    });
                } catch { /* local sign-out remains authoritative */ }
            }
            return resultOk({ snapshot: setSignedOutSnapshot() });
        });
    }

    async function requestPasswordReset(input) {
        const email = validateEmail(input?.email);
        if (!email) return resultError('invalid-input', 'Enter a valid email address.');
        if (!accountConfigured) return resultError('service-unavailable', 'EasyField account service is not configured in this build.');
        if (!recoveryCallbackUrl) return resultError('service-unavailable', 'Password recovery is not configured in this build.');
        if (oauthAttemptInProgress()) {
            return resultError('oauth-in-progress', 'Finish or cancel the open social sign-in before resetting a password.');
        }
        if (pendingPasswordRecovery) {
            finishPasswordRecoveryAttempt(
                pendingPasswordRecovery,
                'cancelled',
                'The previous password recovery request was replaced.',
            );
        }
        const verifier = crypto.randomBytes(48).toString('base64url');
        const state = crypto.randomBytes(32).toString('base64url');
        const attempt = {
            attemptId: requestId(),
            email,
            verifier,
            state,
            expiresAtMs: Date.now() + PASSWORD_RECOVERY_TTL_MS,
            used: false,
            recoverySession: null,
        };
        pendingPasswordRecovery = attempt;
        schedulePasswordRecoveryExpiry(attempt);
        const redirect = new URL(recoveryCallbackUrl);
        redirect.searchParams.set('attempt', state);
        try {
            const recover = new URL(`${supabaseUrl}/auth/v1/recover`);
            recover.searchParams.set('redirect_to', redirect.toString());
            const { response } = await requestJson(recover.toString(), {
                method: 'POST',
                headers: baseHeaders(),
                body: {
                    email,
                    code_challenge: oauthChallenge(verifier),
                    code_challenge_method: 's256',
                },
            });
            if (response.status === 429) {
                finishPasswordRecoveryAttempt(attempt, 'failed', 'Too many attempts. Wait a moment and try again.');
                return resultError('rate-limited', 'Too many attempts. Wait a moment and try again.', true);
            }
            if (response.status >= 500) {
                finishPasswordRecoveryAttempt(attempt, 'failed', 'EasyField could not send password reset instructions.');
                return resultError('service-unavailable', 'EasyField could not send password reset instructions.', true);
            }
            // Deliberately return the same accepted response for all other
            // statuses so the desktop client cannot be used to enumerate
            // registered email addresses.
            return resultOk({ accepted: true, attemptId: attempt.attemptId, expiresAtMs: attempt.expiresAtMs });
        } catch {
            finishPasswordRecoveryAttempt(attempt, 'failed', 'EasyField could not reach the account service.');
            // Keep account discovery impossible while still reporting transport failure.
            return resultError('network', 'EasyField could not reach the account service.', true);
        }
    }

    async function handlePasswordRecoveryCallback(req, res) {
        let parsed;
        try { parsed = new URL(req.url, recoveryCallbackUrl); } catch { return false; }
        if (!recoveryCallbackUrl || parsed.pathname !== new URL(recoveryCallbackUrl).pathname) return false;
        const attempt = pendingPasswordRecovery;
        const state = parsed.searchParams.get('attempt') || '';
        const code = parsed.searchParams.get('code') || '';
        const recoveryError = parsed.searchParams.get('error');
        const writePage = (title, message) => {
            const body = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:16px system-ui;background:#101015;color:#f7f4fb;padding:48px"><h1>${title}</h1><p>${message}</p><p>You can close this window and return to EasyField.</p></body></html>`);
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': body.length,
                'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
            });
            res.end(body);
        };
        if (!attempt || attempt.expiresAtMs <= Date.now()) {
            if (attempt) finishPasswordRecoveryAttempt(attempt, 'expired', 'Password recovery expired. Request a new email.');
            writePage('Password recovery was not completed', 'This recovery request is invalid or expired.');
            return true;
        }
        if (!state || state !== attempt.state || attempt.used) {
            writePage('Password recovery was not completed', 'This recovery response does not match the open request.');
            return true;
        }
        if (recoveryError || !code) {
            finishPasswordRecoveryAttempt(attempt, 'failed', 'Password recovery could not be completed. Request a new email.');
            writePage('Password recovery was not completed', 'The recovery response was cancelled or invalid.');
            return true;
        }

        attempt.used = true;
        clearPasswordRecoveryExpiryTimer();
        const outcome = await enqueue(async () => {
            if (pendingPasswordRecovery !== attempt) return false;
            try {
                const { response, payload } = await requestJson(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
                    method: 'POST',
                    headers: baseHeaders(),
                    body: { auth_code: code, code_verifier: attempt.verifier },
                });
                const recoverySession = response.ok ? internalSessionFromResponse(payload) : null;
                if (!recoverySession?.accessToken) return false;
                const user = await fetchAuthUser(recoverySession.accessToken);
                if (
                    !user
                    || typeof user.id !== 'string'
                    || typeof user.email !== 'string'
                    || user.email.trim().toLowerCase() !== attempt.email
                ) return false;
                recoverySession.user = user;
                attempt.recoverySession = recoverySession;
                attempt.expiresAtMs = Math.min(attempt.expiresAtMs, recoverySession.expiresAtSeconds * 1000);
                schedulePasswordRecoveryExpiry(attempt);
                return true;
            } catch {
                return false;
            }
        });
        if (!outcome) {
            finishPasswordRecoveryAttempt(attempt, 'failed', 'Password recovery could not be completed. Request a new email.');
            writePage('Password recovery was not completed', 'EasyField could not verify the recovery response.');
            return true;
        }
        emitPasswordRecoveryCompletion(attempt, 'ready', 'Choose a new password in EasyField.');
        writePage('Return to EasyField', 'Your email was verified. Choose a new password inside EasyField.');
        return true;
    }

    /**
     * Consumes the loopback redirect from a confirmation email.
     *
     * Supabase verifies the token and marks the address confirmed BEFORE it
     * redirects here. So arriving without a matching pending attempt is not a
     * failure — the account is confirmed either way, and the only thing lost is
     * the automatic sign-in. That case is reported as success with an
     * instruction, because telling someone their confirmation was invalid when
     * it actually worked is the worse error.
     */
    async function handleEmailConfirmationCallback(req, res) {
        if (!confirmCallbackUrl) return false;
        let parsed;
        try { parsed = new URL(req.url, confirmCallbackUrl); } catch { return false; }
        if (parsed.pathname !== new URL(confirmCallbackUrl).pathname) return false;

        const writePage = (title, message) => {
            const body = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:16px system-ui;background:#101015;color:#f7f4fb;padding:48px"><h1>${title}</h1><p>${message}</p><p>You can close this window and return to EasyField.</p></body></html>`);
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': body.length,
                'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
            });
            res.end(body);
        };

        const state = parsed.searchParams.get('attempt') || '';
        const code = parsed.searchParams.get('code') || '';
        const confirmError = parsed.searchParams.get('error');
        const attempt = pendingEmailConfirmation;

        if (confirmError) {
            if (attempt && state && state === attempt.state) {
                finishEmailConfirmationAttempt(attempt, 'failed', 'The link could not be used. Request a new email.');
            }
            writePage('Email was not confirmed', 'That link could not be used. Request a new verification email from EasyField.');
            return true;
        }

        // No usable attempt: the app restarted, the window lapsed, or the link
        // was opened twice. The address is confirmed regardless.
        if (!attempt || attempt.used || !state || state !== attempt.state || attempt.expiresAtMs <= Date.now() || !code) {
            if (attempt && state && state === attempt.state) {
                finishEmailConfirmationAttempt(attempt, 'confirmed', 'Your email is confirmed. Sign in to continue.');
            }
            writePage('Your email is confirmed', 'Sign in from EasyField to continue.');
            return true;
        }

        attempt.used = true;
        clearEmailConfirmationExpiryTimer();
        const signedIn = await enqueue(async () => {
            if (pendingEmailConfirmation !== attempt) return false;
            try {
                const { response, payload } = await requestJson(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
                    method: 'POST',
                    headers: baseHeaders(),
                    body: { auth_code: code, code_verifier: attempt.verifier },
                });
                if (!response.ok) return false;
                const candidate = internalSessionFromResponse(payload);
                if (!candidate?.accessToken) return false;
                // The session must belong to the address this attempt was opened
                // for. Without this a link for one account could establish a
                // session for another.
                const user = await fetchAuthUser(candidate.accessToken);
                if (
                    !user
                    || typeof user.email !== 'string'
                    || user.email.trim().toLowerCase() !== attempt.email
                ) return false;
                if (!await acceptSession(payload)) return false;
                // Without this the session is real but every screen still shows
                // signed-out until something else happens to refresh.
                await getSnapshot(true);
                return true;
            } catch {
                return false;
            }
        });

        if (!signedIn) {
            finishEmailConfirmationAttempt(attempt, 'confirmed', 'Your email is confirmed. Sign in to continue.');
            writePage('Your email is confirmed', 'Sign in from EasyField to continue.');
            return true;
        }
        finishEmailConfirmationAttempt(attempt, 'signed-in', 'Your email is confirmed and you are signed in.');
        writePage('Return to EasyField', 'Your email is confirmed and you are signed in.');
        return true;
    }

    function completePasswordRecovery(input) {
        const attemptId = typeof input?.attemptId === 'string' ? input.attemptId : '';
        const password = validatePassword(input?.password);
        if (!password || !/^[0-9a-f-]{36}$/i.test(attemptId)) {
            return Promise.resolve(resultError('invalid-input', 'Use a password of at least 8 characters.'));
        }
        return enqueue(async () => {
            const attempt = pendingPasswordRecovery;
            if (
                !attempt
                || attempt.attemptId !== attemptId
                || !attempt.recoverySession?.accessToken
                || attempt.expiresAtMs <= Date.now()
            ) {
                if (attempt?.expiresAtMs <= Date.now()) {
                    finishPasswordRecoveryAttempt(attempt, 'expired', 'Password recovery expired. Request a new email.');
                }
                return resultError('recovery-in-progress', 'Password recovery is no longer ready. Request a new email.');
            }
            try {
                const { response, payload } = await requestJson(`${supabaseUrl}/auth/v1/user`, {
                    method: 'PUT',
                    headers: baseHeaders(attempt.recoverySession.accessToken),
                    body: { password },
                });
                const updatedUser = response.ok ? authUserFromResponse(payload) : null;
                if (!updatedUser || updatedUser.id !== attempt.recoverySession.user?.id) {
                    if (response.status === 400 || response.status === 401) {
                        finishPasswordRecoveryAttempt(attempt, 'expired', 'Password recovery expired. Request a new email.');
                    }
                    return resultError(
                        response.status === 429 ? 'rate-limited' : 'internal',
                        response.status === 429
                            ? 'Too many attempts. Wait a moment and try again.'
                            : 'EasyField could not update the password.',
                        response.status === 429 || response.status >= 500,
                    );
                }
                finishPasswordRecoveryAttempt(attempt, 'completed', 'Password updated. Sign in with your new password.');
                clearSession();
                return resultOk({ snapshot: setSignedOutSnapshot() });
            } catch {
                return resultError('network', 'EasyField could not reach the account service.', true);
            }
        });
    }

    function cancelPasswordRecovery(input) {
        const attemptId = typeof input?.attemptId === 'string' ? input.attemptId : '';
        const attempt = pendingPasswordRecovery;
        if (!attempt || attempt.attemptId !== attemptId) {
            return Promise.resolve(resultError('invalid-input', 'Password recovery is no longer open.'));
        }
        finishPasswordRecoveryAttempt(attempt, 'cancelled', 'Password recovery was cancelled.');
        return Promise.resolve(resultOk({ accepted: true }));
    }

    function updateProfile(input) {
        const displayName = typeof input?.displayName === 'string' ? input.displayName.trim() : '';
        if (!displayName || displayName.length > 160) {
            return Promise.resolve(resultError('invalid-input', 'Display name must be between 1 and 160 characters.'));
        }
        const expectedAccountId = cachedSnapshot.session.status === 'signed-in'
            ? cachedSnapshot.session.accountId.toLowerCase()
            : '';
        return enqueue(async () => {
            const session = await refreshSession();
            if (!session?.accessToken || !expectedAccountId || !await sessionMatchesAccount(session, expectedAccountId)) {
                return resultError('not-authenticated', 'Sign in before updating your profile.');
            }
            try {
                const { response, payload } = await requestJson(`${supabaseUrl}/auth/v1/user`, {
                    method: 'PUT',
                    headers: baseHeaders(session.accessToken),
                    body: { data: { full_name: displayName } },
                });
                const user = response.ok ? authUserFromResponse(payload) : null;
                if (!user || user.id.toLowerCase() !== expectedAccountId) {
                    return resultError(
                        response.status === 429 ? 'rate-limited' : errorCodeForStatus(response.status),
                        response.status === 429 ? 'Too many attempts. Wait a moment and try again.' : 'EasyField could not update the profile.',
                        response.status === 429 || response.status >= 500,
                    );
                }
                internalSession.user = user;
                return resultOk(await getSnapshot(true));
            } catch {
                return resultError('network', 'EasyField could not reach the account service.', true);
            }
        });
    }

    async function resendVerification(input) {
        const email = validateEmail(input?.email);
        if (!email) return resultError('invalid-input', 'Enter a valid email address.');
        if (!accountConfigured) return resultError('service-unavailable', 'EasyField account service is not configured in this build.');
        try {
            // A resent link supersedes the first, so it opens a fresh attempt.
            const confirmation = beginEmailConfirmation(email);
            const resendUrl = new URL(`${supabaseUrl}/auth/v1/resend`);
            if (confirmation) resendUrl.searchParams.set('redirect_to', confirmation.redirectUrl);
            const { response } = await requestJson(resendUrl.toString(), {
                method: 'POST',
                headers: baseHeaders(),
                body: confirmation
                    ? {
                        type: 'signup',
                        email,
                        code_challenge: oauthChallenge(confirmation.verifier),
                        code_challenge_method: 's256',
                    }
                    : { type: 'signup', email },
            });
            if (response.status === 429) {
                if (confirmation) finishEmailConfirmationAttempt(confirmation, 'cancelled', 'The email was not sent.');
                return resultError('rate-limited', 'Too many attempts. Wait a moment and try again.', true);
            }
            if (response.status >= 500) {
                if (confirmation) finishEmailConfirmationAttempt(confirmation, 'cancelled', 'The email was not sent.');
                return resultError('service-unavailable', 'EasyField could not send verification instructions.', true);
            }
            return resultOk({
                accepted: true,
                attemptId: confirmation?.attemptId ?? null,
                expiresAtMs: confirmation?.expiresAtMs ?? null,
            });
        } catch {
            return resultError('network', 'EasyField could not reach the account service.', true);
        }
    }

    function oauthChallenge(verifier) {
        return crypto.createHash('sha256').update(verifier).digest('base64url');
    }

    async function startOAuth(input) {
        const provider = input?.provider;
        if (!OAUTH_PROVIDERS.has(provider)) return resultError('invalid-input', 'Unsupported sign-in provider.');
        if (!oauthProviders.has(provider)) return resultError('service-unavailable', 'This sign-in provider is not configured in this build.');
        if (!accountConfigured || !callbackUrl) return resultError('service-unavailable', 'Social sign-in is not configured in this build.');
        return enqueue(async () => {
            if (oauthAttemptInProgress()) return resultError('oauth-in-progress', 'Another sign-in attempt is already open.');
            if (passwordRecoveryReady()) return resultError('recovery-in-progress', 'Finish or cancel the open password recovery before signing in.');
            if (internalSession?.accessToken || cachedSnapshot.session.status === 'signed-in') {
                return resultError('oauth-in-progress', 'Sign out before connecting a different social account.');
            }
            const verifier = crypto.randomBytes(48).toString('base64url');
            const state = crypto.randomBytes(32).toString('base64url');
            const attemptId = requestId();
            const attempt = { provider, verifier, state, attemptId, expiresAtMs: Date.now() + OAUTH_TTL_MS, used: false };
            pendingOAuth = attempt;
            scheduleOAuthExpiry(attempt);
            const authorize = new URL(`${supabaseUrl}/auth/v1/authorize`);
            authorize.searchParams.set('provider', provider);
            // Supabase owns the OAuth provider's `state` parameter. Bind the
            // loopback response to this Main-process attempt by placing our nonce
            // inside the allowlisted redirect URL instead of relying on Supabase to
            // echo an unrelated top-level query parameter.
            const redirect = new URL(callbackUrl);
            redirect.searchParams.set('attempt', state);
            authorize.searchParams.set('redirect_to', redirect.toString());
            authorize.searchParams.set('code_challenge', oauthChallenge(verifier));
            authorize.searchParams.set('code_challenge_method', 's256');
            try {
                await options.openExternal(authorize.toString());
                if (pendingOAuth !== attempt) {
                    return resultError('oauth-in-progress', 'The social sign-in attempt expired or was cancelled.');
                }
                return resultOk({ state: 'browser-opened', attemptId, expiresAtMs: attempt.expiresAtMs });
            } catch {
                finishOAuthAttempt(attempt, 'failed', 'EasyField could not open the system browser.');
                return resultError('service-unavailable', 'EasyField could not open the system browser.', true);
            }
        });
    }

    async function handleOAuthCallback(req, res) {
        let parsed;
        try { parsed = new URL(req.url, callbackUrl); } catch { return false; }
        if (parsed.pathname !== new URL(callbackUrl).pathname) return false;
        const current = pendingOAuth;
        const state = parsed.searchParams.get('attempt') || '';
        const code = parsed.searchParams.get('code') || '';
        const oauthError = parsed.searchParams.get('error');
        const valid = current && !current.used && current.expiresAtMs > Date.now() && state && state === current.state;
        const writePage = (title, message) => {
            const body = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:16px system-ui;background:#101015;color:#f7f4fb;padding:48px"><h1>${title}</h1><p>${message}</p><p>You can close this window and return to EasyField.</p></body></html>`);
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Content-Length': body.length,
                'Cache-Control': 'no-store',
                'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
            });
            res.end(body);
        };
        if (!current) {
            writePage('Sign-in was not completed', 'The authorization response was invalid, expired, or cancelled.');
            return true;
        }
        if (current.expiresAtMs <= Date.now()) {
            finishOAuthAttempt(current, 'expired', 'Social sign-in expired. Try again.');
            writePage('Sign-in was not completed', 'The authorization response expired.');
            return true;
        }
        if (!valid) {
            // An unrelated loopback request must not consume a legitimate
            // pending attempt. The bounded expiry timer remains its fallback.
            writePage('Sign-in was not completed', 'The authorization response was invalid.');
            return true;
        }
        if (oauthError || !code) {
            const cancelled = oauthError === 'access_denied' || !code;
            finishOAuthAttempt(
                current,
                cancelled ? 'cancelled' : 'failed',
                cancelled ? 'Social sign-in was cancelled.' : 'Social sign-in could not be completed.',
            );
            writePage('Sign-in was not completed', 'The authorization response was cancelled or could not be verified.');
            return true;
        }
        current.used = true;
        clearOAuthExpiryTimer();
        const outcome = await enqueue(async () => {
            // A sign-out already queued before this callback is authoritative and
            // consumes the pending attempt rather than allowing a late account
            // switch after the user asked to leave.
            if (pendingOAuth !== current) return 'cancelled';
            try {
                const { response, payload } = await requestJson(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
                    method: 'POST', headers: baseHeaders(), body: { auth_code: code, code_verifier: current.verifier },
                });
                if (!response.ok || !await acceptSession(payload)) throw new Error('exchange-failed');
                await getSnapshot(true);
                if (pendingOAuth === current) pendingOAuth = null;
                return 'authenticated';
            } catch {
                if (pendingOAuth === current) pendingOAuth = null;
                // Do not retain a hidden OAuth session after reporting failure.
                clearSession();
                setSignedOutSnapshot();
                return 'failed';
            }
        });
        if (outcome === 'authenticated') {
            emitOAuthCompletion(current, 'authenticated', 'Signed in securely.');
            writePage('You are signed in', 'EasyField has securely connected your account.');
        } else if (outcome === 'failed') {
            emitOAuthCompletion(current, 'failed', 'EasyField could not complete social sign-in. Try again.');
            writePage('Sign-in was not completed', 'EasyField could not verify the authorization response.');
        } else {
            writePage('Sign-in was not completed', 'The authorization response was cancelled.');
        }
        return true;
    }

    function validateCheckout(input, snapshot) {
        if (!input || !CHECKOUT_KINDS.has(input.kind)) return resultError('invalid-input', 'Unsupported checkout request.');
        if (snapshot.session.status !== 'signed-in') return resultError('not-authenticated', 'Sign in before opening checkout.');
        if (!snapshot.session.emailVerified) return resultError('email-unverified', 'Verify your email before opening checkout.');
        if (input.kind === 'subscription' && (!PLAN_IDS.has(input.planId) || !BILLING_INTERVALS.has(input.billingInterval))) {
            return resultError('invalid-input', 'Choose a valid plan and billing interval.');
        }
        if (input.kind === 'top-up' && (!Number.isSafeInteger(input.amountCreditMicros) || input.amountCreditMicros <= 0)) {
            return resultError('invalid-input', 'Choose a valid credit amount.');
        }
        if ((input.kind === 'subscription' || input.kind === 'top-up') && !snapshot.capabilities.customerCheckoutAvailable) {
            return resultError('checkout-unavailable', 'Customer checkout is not available in this build yet.');
        }
        if (input.kind === 'partner' && !snapshot.capabilities.partnerCheckoutAvailable) {
            return resultError('checkout-unavailable', 'Partner checkout is not available in this build yet.');
        }
        if (input.kind === 'billing-portal' && !snapshot.capabilities.billingPortalAvailable) {
            return resultError('checkout-unavailable', 'The billing portal is not available in this build yet.');
        }
        if (input.kind === 'upstream-top-up' && !snapshot.capabilities.directProviderAllowed) {
            return resultError('not-entitled', 'Direct credit purchase is unavailable for this account.');
        }
        return null;
    }

    function validateCheckoutUrl(rawUrl) {
        try {
            const parsed = new URL(rawUrl);
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !checkoutHosts.has(parsed.hostname.toLowerCase())) return null;
            return parsed.toString();
        } catch {
            return null;
        }
    }

    async function checkoutOnce(input, expectedRequestId = null, verifiedContext = null) {
        const snapshot = verifiedContext?.snapshot || await getSnapshot(true);
        const validation = validateCheckout(input, snapshot);
        if (validation) return validation;
        if (input.kind === 'upstream-top-up') {
            try {
                await options.openDirectCreditPurchase();
                return resultOk({ state: 'opened', intentId: `direct-${requestId()}` });
            } catch {
                return resultError('checkout-unavailable', 'Direct credit purchase is unavailable.', true);
            }
        }
        if (!billingConfigured) return resultError('checkout-unavailable', 'Checkout is not configured in this build.');
        const session = verifiedContext?.session || await refreshSession();
        if (!session?.accessToken) return resultError('not-authenticated', 'Sign in before opening checkout.');
        const accountId = snapshot.session.status === 'signed-in' ? snapshot.session.accountId : '';
        const target = canonicalCheckoutInput(input);
        const fingerprint = checkoutFingerprint(target);
        if (!accountId || !target || !fingerprint) return resultError('invalid-input', 'Unsupported checkout request.');
        if (!await sessionMatchesAccount(session, accountId)) {
            return resultError('not-authenticated', 'The signed-in account changed before checkout. Refresh and try again.');
        }

        let pending = readCheckoutState();
        if (
            pending
            && (
                pending.accountId !== accountId.toLowerCase()
            )
        ) {
            clearCheckoutState();
            pending = null;
        }
        if (expectedRequestId && pending?.requestId !== expectedRequestId) {
            return resultError('checkout-unavailable', 'The checkout is no longer awaiting your action. Refresh the account.');
        }
        if (pending && pending.fingerprint !== fingerprint) {
            return resultError(
                'checkout-unavailable',
                'Another checkout is still unresolved. Reopen or finish it before starting a different purchase.',
            );
        }
        if (pending && !expectedRequestId) {
            return resultError(
                'checkout-unavailable',
                'This checkout is still unresolved. Refresh its status before reopening it.',
            );
        }
        if (!pending) {
            const now = Date.now();
            pending = {
                version: CHECKOUT_STATE_VERSION,
                accountId: accountId.toLowerCase(),
                requestId: requestId(),
                target,
                fingerprint,
                createdAtMs: now,
                expiresAtMs: now + CHECKOUT_STATE_TTL_MS,
                stage: 'prepared',
                baselineMarker: checkoutBaselineMarker(snapshot, target),
            };
            try {
                // Persist before the network call. A crash or timeout after the
                // server accepts the request will therefore retry the same
                // idempotency key instead of creating a second purchase.
                writeCheckoutState(pending);
            } catch {
                return resultError('checkout-unavailable', 'EasyField could not safely prepare checkout.', true);
            }
        }
        const payload = { ...target, requestId: pending.requestId };
        try {
            const { response, payload: answer } = await requestJson(`${accountApiUrl}/checkout`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: payload,
            });
            if (!response.ok) {
                const retired = DEFINITIVE_CHECKOUT_REJECTION_STATUSES.has(response.status)
                    && await retireMissingPreparedCheckoutAfterDefinitiveRejection(session, accountId, pending);
                if (retired) {
                    return resultError('checkout-unavailable', 'Checkout was rejected before a payment session was created. You can start a new purchase.');
                }
                return resultError(errorCodeForStatus(response.status), 'EasyField could not open checkout.', response.status >= 500);
            }
            const checkoutUrl = validateCheckoutUrl(answer?.checkoutUrl);
            const intentId = typeof answer?.intentId === 'string' && /^[a-zA-Z0-9_-]{8,200}$/.test(answer.intentId) ? answer.intentId : null;
            const responseMatchesRequest = answer?.requestId === pending.requestId && answer?.checkoutKind === target.kind;
            if (!checkoutUrl || !intentId || !responseMatchesRequest) {
                return resultError('checkout-unavailable', 'The checkout response could not be verified.');
            }
            const providerExpiry = typeof answer.checkoutExpiresAt === 'string' && Number.isFinite(Date.parse(answer.checkoutExpiresAt))
                ? Date.parse(answer.checkoutExpiresAt)
                : pending.expiresAtMs;
            const opened = {
                ...pending,
                stage: 'opened',
                intentId,
                openedAtMs: Date.now(),
                expiresAtMs: Math.min(pending.expiresAtMs, providerExpiry),
            };
            try {
                // Store the server intent before launching the browser. If the
                // browser launch fails, the next click reopens this exact
                // operation rather than allocating another intent.
                writeCheckoutState(opened);
            } catch {
                return resultError('checkout-unavailable', 'EasyField could not safely retain checkout.', true);
            }
            await options.openExternal(checkoutUrl);
            if (target.kind === 'billing-portal') {
                try { clearCheckoutState(); } catch { /* best effort */ }
                lastCheckoutStatus = null;
            }
            return resultOk({ state: 'opened', intentId });
        } catch {
            return resultError('network', 'EasyField could not reach checkout.', true);
        }
    }

    function checkout(input) {
        return enqueue(() => checkoutOnce(input));
    }

    function resumeCheckout() {
        return enqueue(async () => {
            const candidate = readCheckoutState();
            if (!candidate || !['subscription', 'top-up', 'partner'].includes(candidate.target.kind)) {
                return resultError('checkout-unavailable', 'There is no checkout waiting to be resumed.');
            }
            let snapshot;
            try {
                // Refresh identity, entitlements and the renderer-facing status
                // first. This may retire a checkout that the server has already
                // marked terminal.
                snapshot = await getSnapshot(true);
            } catch {
                return resultError('checkout-unavailable', 'EasyField could not verify this checkout. Refresh and try again.', true);
            }
            const pending = readCheckoutState();
            if (
                !pending
                || pending.requestId !== candidate.requestId
                || snapshot.session.status !== 'signed-in'
                || snapshot.session.accountId.toLowerCase() !== pending.accountId
            ) {
                return resultError('checkout-unavailable', 'The checkout is no longer awaiting your action. Refresh the account.');
            }
            const validation = validateCheckout(pending.target, snapshot);
            if (validation) return validation;
            const session = await refreshSession();
            if (!session?.accessToken) return resultError('not-authenticated', 'Sign in before opening checkout.');
            if (!await sessionMatchesAccount(session, snapshot.session.accountId)) {
                return resultError('not-authenticated', 'The signed-in account changed before checkout. Refresh and try again.');
            }

            // A local prepared/opened marker is only an idempotency aid. It is
            // never sufficient authority to reopen or recreate a paid flow.
            // Require a fresh, strictly validated server response immediately
            // before taking either action.
            const authoritativeStatus = await fetchCheckoutStatus(
                session.accessToken,
                snapshot.session.accountId,
                pending,
            );
            if (authoritativeStatus?.found === false && pending.stage === 'prepared') {
                // The initial POST may never have reached the service. Reusing
                // the exact durable request ID is safe: both the database and
                // hosted adapter treat it as the idempotency key.
                return checkoutOnce(pending.target, pending.requestId, { snapshot, session });
            }
            if (authoritativeStatus?.found !== true || !['prepared', 'open'].includes(authoritativeStatus.state)) {
                return resultError(
                    'checkout-unavailable',
                    'EasyField could not safely verify that this checkout can be resumed. Refresh its status before trying again.',
                    authoritativeStatus === null,
                );
            }

            if (authoritativeStatus.state === 'open') {
                const opened = {
                    ...pending,
                    stage: 'opened',
                    intentId: authoritativeStatus.intentId,
                    openedAtMs: pending.stage === 'opened' ? pending.openedAtMs : authoritativeStatus.updatedAtMs,
                    expiresAtMs: authoritativeStatus.expiresAtMs,
                };
                try {
                    writeCheckoutState(opened);
                    await options.openExternal(authoritativeStatus.checkoutUrl);
                } catch {
                    return resultError('checkout-unavailable', 'EasyField could not safely reopen checkout.', true);
                }
                lastCheckoutStatus = {
                    state: 'pending',
                    kind: pending.target.kind,
                    startedAtMs: opened.openedAtMs,
                    expiresAtMs: opened.expiresAtMs,
                };
                return resultOk({ state: 'opened', intentId: authoritativeStatus.intentId });
            }

            return checkoutOnce(pending.target, pending.requestId, { snapshot, session });
        });
    }

    async function saveAutoReloadOnce(input, expectedAccountId) {
        const policy = input?.policy;
        if (!policy || typeof policy.enabled !== 'boolean') return resultError('invalid-input', 'Invalid auto-reload policy.');
        if (policy.enabled && (
            !Number.isSafeInteger(policy.triggerBalanceCreditMicros)
            || policy.triggerBalanceCreditMicros < 0
            || !Number.isSafeInteger(policy.topUpAmountCreditMicros)
            || policy.topUpAmountCreditMicros <= 0
        )) return resultError('invalid-input', 'Invalid auto-reload amounts.');
        if (!billingConfigured) return resultError('checkout-unavailable', 'Billing is not configured in this build.');
        let snapshot;
        try {
            snapshot = await getSnapshot(true);
        } catch {
            return resultError('network', 'EasyField could not verify the signed-in account.', true);
        }
        if (
            snapshot.session.status !== 'signed-in'
            || !expectedAccountId
            || snapshot.session.accountId.toLowerCase() !== expectedAccountId
        ) {
            return resultError('not-authenticated', 'Sign in before changing auto-reload.');
        }
        if (policy.enabled && !snapshot.capabilities.customerCheckoutAvailable) {
            return resultError('checkout-unavailable', 'Auto-reload is unavailable until customer billing and generation are live.');
        }
        const session = await refreshSession();
        if (!session?.accessToken) return resultError('not-authenticated', 'Sign in before changing auto-reload.');
        if (!await sessionMatchesAccount(session, snapshot.session.accountId)) {
            return resultError('not-authenticated', 'The signed-in account changed before auto-reload was saved. Refresh and try again.');
        }
        try {
            const { response } = await requestJson(`${accountApiUrl}/auto-reload`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: { policy, requestId: requestId() },
            });
            if (!response.ok) return resultError(errorCodeForStatus(response.status), 'EasyField could not save auto-reload.', response.status >= 500);
            return resultOk(await getSnapshot(true));
        } catch {
            return resultError('network', 'EasyField could not reach billing.', true);
        }
    }

    function saveAutoReload(input) {
        // Bind the UI action to the account that was visible when it was
        // requested. If an earlier queued sign-in changes the account before
        // this mutation executes, fail instead of silently saving B's policy
        // from controls that belonged to A.
        const expectedAccountId = cachedSnapshot.session.status === 'signed-in'
            ? cachedSnapshot.session.accountId.toLowerCase()
            : '';
        return enqueue(() => saveAutoReloadOnce(input, expectedAccountId));
    }

    async function getGatewayAccessToken() {
        if (cachedSnapshot.session.status !== 'signed-in' || !cachedSnapshot.capabilities.generationAccess) return '';
        const session = await refreshSession();
        return session?.accessToken || '';
    }

    // Main calls this immediately before any direct-provider operation. This
    // never trusts the last renderer-facing snapshot: getSnapshot() always
    // re-reads the authenticated user, billing role and partner entitlement
    // from the server. A network or parsing failure therefore denies the
    // operation instead of extending stale privileged access.
    async function getFreshDirectProviderContext() {
        if (!accountConfigured) {
            return {
                accountConfigured: false,
                authenticated: false,
                accountId: null,
                directProviderAllowed: transitionalDirectProviderAllowed(),
            };
        }
        try {
            const snapshot = await enqueue(() => getSnapshot(false));
            const authenticated = snapshot.session.status === 'signed-in'
                && typeof snapshot.session.accountId === 'string'
                && Boolean(snapshot.session.accountId);
            return {
                accountConfigured: true,
                authenticated,
                accountId: authenticated ? snapshot.session.accountId : null,
                directProviderAllowed: authenticated
                    && snapshot.capabilities.directProviderAllowed === true,
            };
        } catch {
            return {
                accountConfigured: true,
                authenticated: false,
                accountId: null,
                directProviderAllowed: false,
            };
        }
    }

    return Object.freeze({
        restore,
        signIn,
        signUp,
        signOut,
        requestPasswordReset,
        completePasswordRecovery,
        cancelPasswordRecovery,
        updateProfile,
        resendVerification,
        startOAuth,
        handleOAuthCallback,
        handlePasswordRecoveryCallback,
        handleEmailConfirmationCallback,
        checkout,
        resumeCheckout,
        saveAutoReload,
        getSnapshot: async (input) => {
            try { return resultOk(await enqueue(() => getSnapshot(input?.force === true))); }
            catch { return resultError('network', 'EasyField could not reach the account service.', true); }
        },
        getCachedSnapshot: () => cachedSnapshot,
        getGatewayAccessToken,
        getFreshDirectProviderContext,
        getGatewayBaseUrl: () => accountApiUrl,
        isConfigured: () => accountConfigured,
    });
}

module.exports = {
    createAccountService,
    emptySnapshot,
    normalizeBaseUrl,
    normalizeCheckoutHosts,
    parseStoredCheckoutState,
    parseStoredSession,
};
