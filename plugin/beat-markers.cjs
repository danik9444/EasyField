'use strict';

const fs = require('fs');
const path = require('path');

const COLORS = new Set(['Blue', 'Cyan', 'Green', 'Yellow', 'Red', 'Pink', 'Purple', 'Fuchsia', 'Rose', 'Lavender', 'Sky', 'Mint', 'Lemon', 'Sand', 'Cocoa', 'Cream']);
const MAX_MARKERS = 10000;

function values(collection) {
    if (Array.isArray(collection)) return collection;
    if (collection && typeof collection === 'object') return Object.values(collection);
    return [];
}

function createBeatMarkerService({ getContext, withTimelineOperationLock, mediaRoot, EFError }) {
    const canonicalPath = (candidate) => {
        try { return fs.realpathSync(String(candidate)); } catch (e) { return path.resolve(String(candidate)); }
    };

    const containedMediaPath = (candidate) => {
        if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
            throw new EFError('Invalid EasyField media path', 'BAD_REQUEST', 400);
        }
        let root;
        let target;
        try {
            root = fs.realpathSync(mediaRoot);
            target = fs.realpathSync(candidate);
        } catch (e) {
            throw new EFError('The imported EasyField media file is unavailable', 'SOURCE_OFFLINE', 409);
        }
        if (target !== root && !target.startsWith(root + path.sep)) {
            throw new EFError('Markers can only be attached to EasyField-imported media', 'UNSAFE_PATH', 400);
        }
        return target;
    };

    const normalizePayload = (payload) => {
        if (!payload || typeof payload !== 'object') throw new EFError('Invalid marker request', 'BAD_REQUEST', 400);
        const target = payload.target === 'timeline' ? 'timeline' : payload.target === 'media-pool' ? 'media-pool' : null;
        if (!target) throw new EFError('Choose a marker destination', 'BAD_REQUEST', 400);
        const filePath = containedMediaPath(payload.path);
        const analysisId = typeof payload.analysisId === 'string' && /^[a-z0-9_-]{6,120}$/i.test(payload.analysisId)
            ? payload.analysisId
            : null;
        if (!analysisId) throw new EFError('Invalid beat analysis identity', 'BAD_REQUEST', 400);
        const color = COLORS.has(payload.color) ? payload.color : 'Cyan';
        if (!Array.isArray(payload.markers) || payload.markers.length < 1 || payload.markers.length > MAX_MARKERS) {
            throw new EFError(`Choose between 1 and ${MAX_MARKERS} reviewed markers`, 'BAD_REQUEST', 400);
        }
        let previous = -1;
        const markers = payload.markers.map((marker, index) => {
            const time = Number(marker && marker.time);
            const confidence = Number(marker && marker.confidence);
            if (!Number.isFinite(time) || time < 0 || time > 24 * 60 * 60 || time < previous) {
                throw new EFError('Beat markers must be finite, ordered and inside the source', 'BAD_REQUEST', 400);
            }
            previous = time;
            return {
                time,
                confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
                name: typeof marker.name === 'string' && marker.name.trim()
                    ? marker.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64)
                    : `Beat ${String(index + 1).padStart(3, '0')}`,
            };
        });
        return { target, filePath, analysisId, color, markers };
    };

    const findMediaPoolItem = async (project, filePath) => {
        const mediaPool = await project.GetMediaPool();
        const root = mediaPool && await mediaPool.GetRootFolder();
        if (!root) return null;
        const pending = [root];
        const visited = new Set();
        while (pending.length) {
            const folder = pending.shift();
            if (!folder || visited.has(folder)) continue;
            visited.add(folder);
            let clips = [];
            let folders = [];
            try { clips = values(await folder.GetClipList()); } catch (e) { /* keep walking */ }
            for (const clip of clips) {
                try {
                    const candidate = await clip.GetClipProperty('File Path');
                    if (candidate && canonicalPath(candidate) === filePath) return clip;
                } catch (e) { /* inspect next clip */ }
            }
            try { folders = values(await folder.GetSubFolderList()); } catch (e) { /* leaf */ }
            pending.push(...folders);
        }
        return null;
    };

    const findTimelineItem = async (timeline, filePath) => {
        if (!timeline) return null;
        const count = Number(await timeline.GetTrackCount('audio')) || 0;
        for (let trackIndex = 1; trackIndex <= count; trackIndex += 1) {
            let items = [];
            try { items = values(await timeline.GetItemListInTrack('audio', trackIndex)); } catch (e) { continue; }
            for (const item of items) {
                try {
                    const mediaPoolItem = await item.GetMediaPoolItem();
                    const candidate = mediaPoolItem && await mediaPoolItem.GetClipProperty('File Path');
                    if (candidate && canonicalPath(candidate) === filePath) return item;
                } catch (e) { /* inspect next item */ }
            }
        }
        return null;
    };

    const markerTarget = async (context, target, filePath) => {
        if (!context.project) throw new EFError('No current Resolve project', 'RESOLVE_CLOSED', 409);
        if (target === 'media-pool') {
            const mediaPoolItem = await findMediaPoolItem(context.project, filePath);
            if (!mediaPoolItem) throw new EFError('The imported Media Pool audio could not be found', 'NO_ITEM', 409);
            return mediaPoolItem;
        }
        if (!context.timeline) throw new EFError('No current timeline', 'NO_TIMELINE', 409);
        const timelineItem = await findTimelineItem(context.timeline, filePath);
        if (!timelineItem) throw new EFError('The newly placed timeline audio could not be found', 'NO_ITEM', 409);
        return timelineItem;
    };

    const projectFps = async (context) => {
        let value = 0;
        try { if (context.timeline) value = parseFloat(await context.timeline.GetSetting('timelineFrameRate')); } catch (e) { /* project fallback */ }
        try { if (!value && context.project) value = parseFloat(await context.project.GetSetting('timelineFrameRate')); } catch (e) { /* default below */ }
        return value || 24;
    };

    const applyMarkers = (rawPayload) => withTimelineOperationLock(async () => {
        const payload = normalizePayload(rawPayload);
        const context = await getContext();
        const target = await markerTarget(context, payload.target, payload.filePath);
        const fps = await projectFps(context);
        const operationId = `easyfield-beat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
        const applied = [];
        const occupiedFrames = new Set();
        try {
            for (let index = 0; index < payload.markers.length; index += 1) {
                const marker = payload.markers[index];
                const frame = Math.max(0, Math.round(marker.time * fps));
                if (occupiedFrames.has(frame)) continue;
                occupiedFrames.add(frame);
                const customData = `${operationId}:${payload.analysisId}:${index}`;
                const note = `EasyField Beat Detection · ${Math.round(marker.confidence * 100)}% confidence · ${marker.time.toFixed(3)}s`;
                const ok = await target.AddMarker(frame, payload.color, marker.name, note, 1, customData);
                if (!ok) throw new EFError(`Resolve could not add marker ${index + 1}`, 'MARKER_APPLY_FAILED', 500);
                applied.push({ frame, customData });
            }
            if (!applied.length) throw new EFError('No unique marker frames remained after timeline rounding', 'MARKER_APPLY_FAILED', 409);
        } catch (error) {
            for (const marker of applied.reverse()) {
                try { await target.DeleteMarkerByCustomData(marker.customData); } catch (e) { /* rollback best effort */ }
            }
            throw error;
        }
        return {
            ok: true,
            target: payload.target,
            applied: applied.length,
            fps,
            operationId,
            undoToken: { path: payload.filePath, target: payload.target, customData: applied.map((marker) => marker.customData) },
        };
    });

    const undoMarkers = (rawPayload) => withTimelineOperationLock(async () => {
        const filePath = containedMediaPath(rawPayload && rawPayload.path);
        const targetKind = rawPayload && rawPayload.target === 'timeline' ? 'timeline' : rawPayload && rawPayload.target === 'media-pool' ? 'media-pool' : null;
        const customData = Array.isArray(rawPayload && rawPayload.customData)
            ? rawPayload.customData.filter((value) => typeof value === 'string' && value.startsWith('easyfield-beat-')).slice(0, MAX_MARKERS)
            : [];
        if (!targetKind || !customData.length) throw new EFError('Invalid marker undo token', 'BAD_REQUEST', 400);
        const context = await getContext();
        const target = await markerTarget(context, targetKind, filePath);
        let removed = 0;
        for (const value of customData) {
            try { if (await target.DeleteMarkerByCustomData(value)) removed += 1; } catch (e) { /* keep removing owned markers */ }
        }
        return { ok: true, removed };
    });

    return { applyMarkers, undoMarkers };
}

module.exports = { createBeatMarkerService };
