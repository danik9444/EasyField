'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const STILL_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff',
    '.heic', '.heif', '.dpx', '.exr', '.psd', '.raw', '.cr2', '.cr3',
    '.nef', '.arw', '.raf', '.orf', '.rw2',
]);

const DIRECT_STILL_TYPES = Object.freeze({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
});

function finitePositive(value) {
    const parsed = Number(String(value == null ? '' : value).replace(/[^\d.]/g, ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function classifyEditImageSource({ filePath, type, clipType, frames }) {
    const descriptor = `${type || ''} ${clipType || ''}`.trim().toLowerCase();
    const extension = path.extname(String(filePath || '')).toLowerCase();
    const frameCount = finitePositive(frames);

    if (/compound|fusion|generator|title|adjustment|timeline/.test(descriptor)) return 'generated';
    if (/image\s*sequence|sequence|movie|video/.test(descriptor)) return 'video';
    if (/still|single\s*image|photo/.test(descriptor)) return 'still-image';

    // DPX/EXR and other image files can represent a multi-frame image sequence.
    // Resolve's explicit frame count wins over the file extension.
    if (frameCount > 1) return 'video';
    if (frameCount === 1 && extension && STILL_EXTENSIONS.has(extension)) return 'still-image';
    if (filePath) return 'video';
    return 'unknown';
}

async function getClipProperty(mediaPoolItem, key) {
    if (!mediaPoolItem || typeof mediaPoolItem.GetClipProperty !== 'function') return '';
    try {
        return await mediaPoolItem.GetClipProperty(key);
    } catch (e) {
        return '';
    }
}

function createEditImageCapture({
    getContext,
    withTimelineOperationLock,
    sleep,
    sendFile,
    runFfmpeg,
    EFError,
    timecodeToFrames,
    enc,
    cleanupDelayMs = 15000,
}) {
    const responseClosed = (req, res) => !!(
        (req && req.destroyed)
        || (res && (res.destroyed || res.headersSent || res.writableEnded))
    );

    const sameTimecodeFrame = (left, right, fps) => {
        const a = timecodeToFrames(left, fps);
        const b = timecodeToFrames(right, fps);
        return a != null && b != null && a === b;
    };

    const optionalId = async (object) => {
        try {
            if (object && typeof object.GetUniqueId === 'function') return String(await object.GetUniqueId());
        } catch (e) { /* optional metadata */ }
        return '';
    };

    const currentIdentity = async () => {
        const context = await getContext();
        return {
            context,
            projectId: await optionalId(context.project),
            timelineId: await optionalId(context.timeline),
            timecode: context.timeline && await context.timeline.GetCurrentTimecode(),
        };
    };

    const currentItemId = async (timeline) => {
        if (!timeline || typeof timeline.GetCurrentVideoItem !== 'function') return '';
        const currentItem = await timeline.GetCurrentVideoItem();
        return await optionalId(currentItem);
    };

    const capture = async (req, res) => withTimelineOperationLock(async () => {
        if (responseClosed(req, res)) {
            throw new EFError('Timeline capture was cancelled', 'CAPTURE_CANCELLED', 499);
        }

        const initial = await currentIdentity();
        const { project, timeline } = initial.context;
        if (!timeline) throw new EFError('No current timeline', 'NO_TIMELINE', 409);

        const item = await timeline.GetCurrentVideoItem();
        if (!item) throw new EFError('Place the playhead over an image or video clip', 'NO_ITEM', 409);

        const mediaPoolItem = typeof item.GetMediaPoolItem === 'function'
            ? await item.GetMediaPoolItem()
            : null;
        const filePath = mediaPoolItem && await getClipProperty(mediaPoolItem, 'File Path');
        const sourceKind = classifyEditImageSource({
            filePath,
            type: await getClipProperty(mediaPoolItem, 'Type'),
            clipType: await getClipProperty(mediaPoolItem, 'Clip Type'),
            frames: await getClipProperty(mediaPoolItem, 'Frames'),
        });
        const itemName = typeof item.GetName === 'function' ? await item.GetName() : 'Timeline media';
        const timelineName = await timeline.GetName();
        const itemId = await optionalId(item);
        const fps = parseFloat(await timeline.GetSetting('timelineFrameRate')) || 24;
        const baseHeaders = {
            'X-EF-Name': enc(sourceKind === 'still-image' && filePath ? path.basename(filePath) : itemName),
            'X-EF-Timecode': enc(initial.timecode),
            'X-EF-Timeline': enc(timelineName),
            'X-EF-Project-Id': enc(initial.projectId),
            'X-EF-Timeline-Id': enc(initial.timelineId),
            'X-EF-Item-Id': enc(itemId),
            'X-EF-Source-Kind': enc(sourceKind),
        };

        if (sourceKind === 'still-image') {
            if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                throw new EFError('The source still is offline or unreadable', 'SOURCE_OFFLINE', 409);
            }
            const extension = path.extname(filePath).toLowerCase();
            const directType = DIRECT_STILL_TYPES[extension];
            if (directType) {
                sendFile(res, filePath, directType, {
                    ...baseHeaders,
                    'X-EF-Capture-Kind': enc('source'),
                });
                return;
            }

            // Normalize browser-unsupported source stills (TIFF/EXR/RAW/etc.)
            // without applying any timeline transform, grade, Fusion or crop.
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-still-'));
            const out = path.join(tmpDir, 'source.png');
            let streamed = false;
            try {
                await runFfmpeg(['-y', '-i', filePath, '-frames:v', '1', out]);
                let bytes = 0;
                try { bytes = fs.statSync(out).size; } catch (e) { /* checked below */ }
                if (bytes <= 0) throw new EFError('The source still could not be decoded', 'FFMPEG_FAILED', 500);
                sendFile(res, out, 'image/png', {
                    ...baseHeaders,
                    'X-EF-Capture-Kind': enc('source'),
                    'X-EF-Source-Normalized': enc('true'),
                });
                streamed = true;
            } finally {
                const remove = () => {
                    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
                };
                if (streamed && cleanupDelayMs > 0) setTimeout(remove, cleanupDelayMs);
                else remove();
            }
            return;
        }

        // Video, Compound, Fusion and generated media are captured exactly as
        // displayed at the current playhead. The playhead is never moved.
        await sleep(40);
        if (responseClosed(req, res)) {
            throw new EFError('Timeline capture was cancelled', 'CAPTURE_CANCELLED', 499);
        }
        const beforeExport = await currentIdentity();
        if (
            !beforeExport.context.timeline
            || beforeExport.projectId !== initial.projectId
            || beforeExport.timelineId !== initial.timelineId
        ) {
            throw new EFError('The active project or timeline changed before capture', 'TIMELINE_CHANGED', 409);
        }
        if (!sameTimecodeFrame(beforeExport.timecode, initial.timecode, fps)) {
            throw new EFError('The playhead moved before the frame was captured', 'PLAYHEAD_CHANGED', 409);
        }
        const beforeItemId = await currentItemId(beforeExport.context.timeline);
        if (itemId && beforeItemId !== itemId) {
            throw new EFError('The media under the playhead changed before capture', 'PLAYHEAD_CHANGED', 409);
        }

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-frame-'));
        const out = path.join(tmpDir, 'timeline-output.png');
        let streamed = false;
        try {
            const exported = await beforeExport.context.project.ExportCurrentFrameAsStill(out);
            let bytes = 0;
            try { bytes = fs.statSync(out).size; } catch (e) { /* checked below */ }
            if (!exported || bytes <= 0) {
                throw new EFError('Resolve could not export the current timeline frame', 'FRAME_EXPORT_FAILED', 500);
            }

            const afterExport = await currentIdentity();
            if (
                !afterExport.context.timeline
                || afterExport.projectId !== initial.projectId
                || afterExport.timelineId !== initial.timelineId
            ) {
                throw new EFError('The active project or timeline changed during capture', 'TIMELINE_CHANGED', 409);
            }
            if (!sameTimecodeFrame(afterExport.timecode, initial.timecode, fps)) {
                throw new EFError('The playhead moved during frame capture', 'PLAYHEAD_CHANGED', 409);
            }
            const afterItemId = await currentItemId(afterExport.context.timeline);
            if (itemId && afterItemId !== itemId) {
                throw new EFError('The media under the playhead changed during capture', 'PLAYHEAD_CHANGED', 409);
            }

            sendFile(res, out, 'image/png', {
                ...baseHeaders,
                'X-EF-Capture-Kind': enc('timeline-output'),
            });
            streamed = true;
        } finally {
            const remove = () => {
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
            };
            if (streamed && cleanupDelayMs > 0) setTimeout(remove, cleanupDelayMs);
            else remove();
        }
    });

    return { grabEditImageSource: capture };
}

module.exports = {
    classifyEditImageSource,
    createEditImageCapture,
};
