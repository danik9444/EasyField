// Native window policy for the Resolve-hosted EasyField panel.
//
// This module deliberately has no renderer input. Main owns the two supported
// layout profiles, display selection and z-order decisions so untrusted page
// content cannot turn the panel into an arbitrary always-on-top window.

const { execFile } = require('child_process');

const WINDOW_MARGIN = 16;
const EDGE_AFFINITY = 56;
const FRONTMOST_POLL_MS = 900;
const LSAPPINFO = '/usr/bin/lsappinfo';
const RESOLVE_BUNDLE_IDS = new Set([
    'com.blackmagic-design.DaVinciResolve',
]);

const WINDOW_PROFILES = Object.freeze({
    compact: Object.freeze({
        preferredWidth: 400,
        preferredHeight: 820,
        minWidth: 340,
        minHeight: 520,
        maxWidth: 480,
        maxHeight: 920,
    }),
    expanded: Object.freeze({
        preferredWidth: 960,
        preferredHeight: 800,
        minWidth: 720,
        minHeight: 560,
        maxWidth: 1200,
        maxHeight: 960,
    }),
});

function finiteInteger(value, fallback = 0) {
    return Number.isFinite(value) ? Math.round(value) : fallback;
}

function normalizeRectangle(rectangle) {
    const rect = rectangle || {};
    return {
        x: finiteInteger(rect.x),
        y: finiteInteger(rect.y),
        width: Math.max(1, finiteInteger(rect.width, 1)),
        height: Math.max(1, finiteInteger(rect.height, 1)),
    };
}

function assertWindowMode(mode) {
    if (!Object.prototype.hasOwnProperty.call(WINDOW_PROFILES, mode)) {
        throw new Error('Invalid window mode');
    }
    return mode;
}

function clamp(value, minimum, maximum) {
    if (maximum <= minimum) return minimum;
    return Math.min(maximum, Math.max(minimum, value));
}

function availableAxis(origin, length) {
    const safeLength = Math.max(1, finiteInteger(length, 1));
    const margin = safeLength > WINDOW_MARGIN * 2 ? WINDOW_MARGIN : 0;
    return {
        start: finiteInteger(origin) + margin,
        length: Math.max(1, safeLength - margin * 2),
        margin,
    };
}

function profileLimitsForWorkArea(mode, workArea) {
    const profile = WINDOW_PROFILES[assertWindowMode(mode)];
    const area = normalizeRectangle(workArea);
    const horizontal = availableAxis(area.x, area.width);
    const vertical = availableAxis(area.y, area.height);
    const maxWidth = Math.min(profile.maxWidth, horizontal.length);
    const maxHeight = Math.min(profile.maxHeight, vertical.length);
    return {
        profile,
        area,
        horizontal,
        vertical,
        minWidth: Math.min(profile.minWidth, maxWidth),
        minHeight: Math.min(profile.minHeight, maxHeight),
        maxWidth,
        maxHeight,
    };
}

function coordinateForResize(currentStart, currentLength, nextLength, axis) {
    if (!currentLength) return axis.start + axis.length - nextLength;
    const currentEnd = currentStart + currentLength;
    const axisEnd = axis.start + axis.length;
    const startGap = Math.abs(currentStart - axis.start);
    const endGap = Math.abs(axisEnd - currentEnd);
    let proposed;
    if (endGap <= EDGE_AFFINITY && endGap <= startGap) {
        proposed = axisEnd - nextLength;
    } else if (startGap <= EDGE_AFFINITY) {
        proposed = axis.start;
    } else {
        proposed = currentStart + (currentLength - nextLength) / 2;
    }
    return clamp(Math.round(proposed), axis.start, axisEnd - nextLength);
}

/**
 * Return a fully clamped outer-window rectangle for one EasyField mode.
 * Compact is intentionally portrait; expanded is intentionally landscape.
 * An existing rectangle keeps its display and edge/centre affinity.
 */
function windowBoundsForMode(mode, workArea, currentBounds = null) {
    const limits = profileLimitsForWorkArea(mode, workArea);
    const width = clamp(limits.profile.preferredWidth, limits.minWidth, limits.maxWidth);
    const height = clamp(limits.profile.preferredHeight, limits.minHeight, limits.maxHeight);
    const current = currentBounds ? normalizeRectangle(currentBounds) : null;
    return {
        x: current
            ? coordinateForResize(current.x, current.width, width, limits.horizontal)
            : limits.horizontal.start + limits.horizontal.length - width,
        y: current
            ? coordinateForResize(current.y, current.height, height, limits.vertical)
            : limits.vertical.start,
        width,
        height,
    };
}

function displayForWindow(electronScreen, currentBounds) {
    if (!electronScreen) throw new Error('Electron screen API is unavailable');
    if (currentBounds && typeof electronScreen.getDisplayMatching === 'function') {
        const matching = electronScreen.getDisplayMatching(normalizeRectangle(currentBounds));
        if (matching?.workArea) return matching;
    }
    const primary = electronScreen.getPrimaryDisplay?.();
    if (!primary?.workArea) throw new Error('No display work area is available');
    return primary;
}

function applyWindowMode(browserWindow, electronScreen, mode, options = {}) {
    assertWindowMode(mode);
    if (!browserWindow || browserWindow.isDestroyed?.()) return null;
    const currentBounds = typeof browserWindow.getBounds === 'function' ? browserWindow.getBounds() : null;
    const display = displayForWindow(electronScreen, currentBounds);
    const limits = profileLimitsForWorkArea(mode, display.workArea);
    const bounds = windowBoundsForMode(mode, display.workArea, options.initial ? null : currentBounds);

    // Release the previous profile before applying the next one. Otherwise an
    // expanded minimum can prevent compact bounds (or a compact maximum can
    // prevent expanded bounds) from being applied atomically.
    browserWindow.setMinimumSize?.(1, 1);
    browserWindow.setMaximumSize?.(Math.max(limits.area.width, limits.maxWidth), Math.max(limits.area.height, limits.maxHeight));
    browserWindow.setBounds(bounds, options.animate === true);
    browserWindow.setMinimumSize?.(limits.minWidth, limits.minHeight);
    browserWindow.setMaximumSize?.(limits.maxWidth, limits.maxHeight);
    return { bounds, displayId: display.id, limits: {
        minWidth: limits.minWidth,
        minHeight: limits.minHeight,
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
    } };
}

function clampWindowToWorkArea(browserWindow, electronScreen, mode) {
    assertWindowMode(mode);
    if (!browserWindow || browserWindow.isDestroyed?.()) return null;
    const current = normalizeRectangle(browserWindow.getBounds?.());
    const display = displayForWindow(electronScreen, current);
    const limits = profileLimitsForWorkArea(mode, display.workArea);
    const width = clamp(current.width, limits.minWidth, limits.maxWidth);
    const height = clamp(current.height, limits.minHeight, limits.maxHeight);
    const bounds = {
        x: clamp(current.x, limits.horizontal.start, limits.horizontal.start + limits.horizontal.length - width),
        y: clamp(current.y, limits.vertical.start, limits.vertical.start + limits.vertical.length - height),
        width,
        height,
    };
    const unchanged = bounds.x === current.x && bounds.y === current.y
        && bounds.width === current.width && bounds.height === current.height;

    browserWindow.setMinimumSize?.(1, 1);
    browserWindow.setMaximumSize?.(Math.max(limits.area.width, limits.maxWidth), Math.max(limits.area.height, limits.maxHeight));
    if (!unchanged) browserWindow.setBounds(bounds, false);
    browserWindow.setMinimumSize?.(limits.minWidth, limits.minHeight);
    browserWindow.setMaximumSize?.(limits.maxWidth, limits.maxHeight);
    return { bounds, displayId: display.id, changed: !unchanged };
}

function frontmostBundleIdFromInfo(output) {
    const match = String(output || '').match(/"CFBundleIdentifier"\s*=\s*"([^"]+)"/);
    return match ? match[1] : '';
}

function execFileText(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { encoding: 'utf8', timeout: 1200, maxBuffer: 64 * 1024 }, (error, stdout) => {
            if (error) reject(error);
            else resolve(String(stdout || ''));
        });
    });
}

async function readFrontmostBundleId() {
    if (process.platform !== 'darwin') return '';
    const applicationSerialNumber = (await execFileText(LSAPPINFO, ['front'])).trim();
    if (!/^ASN:0x[0-9a-f]+-0x[0-9a-f]+:$/i.test(applicationSerialNumber)) return '';
    const info = await execFileText(LSAPPINFO, ['info', '-only', 'bundleid', applicationSerialNumber]);
    return frontmostBundleIdFromInfo(info);
}

function isResolveBundleId(bundleId) {
    return RESOLVE_BUNDLE_IDS.has(String(bundleId || ''));
}

/**
 * Float only while EasyField itself or DaVinci Resolve is frontmost. This gives
 * the editor a companion panel without leaving EasyField above unrelated apps.
 */
function createResolveAwareFloatingController(browserWindow, options = {}) {
    const getFrontmostBundleId = options.getFrontmostBundleId || readFrontmostBundleId;
    const setIntervalFn = options.setIntervalFn || setInterval;
    const clearIntervalFn = options.clearIntervalFn || clearInterval;
    const pollMs = Number.isFinite(options.pollMs) ? Math.max(100, options.pollMs) : FRONTMOST_POLL_MS;
    let disposed = false;
    let floating = null;
    let refreshGeneration = 0;

    browserWindow.setVisibleOnAllWorkspaces?.(false, { visibleOnFullScreen: false });

    const applyFloating = (next) => {
        if (disposed || browserWindow.isDestroyed?.() || floating === next) return;
        floating = next;
        if (next) browserWindow.setAlwaysOnTop?.(true, 'floating');
        else browserWindow.setAlwaysOnTop?.(false);
    };

    const refresh = async () => {
        const generation = ++refreshGeneration;
        let bundleId = '';
        try { bundleId = await getFrontmostBundleId(); } catch { /* focused-only fallback */ }
        if (disposed || generation !== refreshGeneration) return;
        const focused = typeof browserWindow.isFocused === 'function' && browserWindow.isFocused();
        applyFloating(focused || isResolveBundleId(bundleId));
    };

    const onFocus = () => {
        refreshGeneration += 1;
        applyFloating(true);
    };
    const onBlur = () => { void refresh(); };
    browserWindow.on?.('focus', onFocus);
    browserWindow.on?.('blur', onBlur);
    const timer = setIntervalFn(() => { void refresh(); }, pollMs);
    timer?.unref?.();
    void refresh();

    return Object.freeze({
        refresh,
        dispose() {
            if (disposed) return;
            disposed = true;
            refreshGeneration += 1;
            clearIntervalFn(timer);
            browserWindow.removeListener?.('focus', onFocus);
            browserWindow.removeListener?.('blur', onBlur);
            if (!browserWindow.isDestroyed?.()) browserWindow.setAlwaysOnTop?.(false);
        },
    });
}

module.exports = {
    WINDOW_PROFILES,
    applyWindowMode,
    clampWindowToWorkArea,
    createResolveAwareFloatingController,
    frontmostBundleIdFromInfo,
    isResolveBundleId,
    profileLimitsForWorkArea,
    readFrontmostBundleId,
    windowBoundsForMode,
};
