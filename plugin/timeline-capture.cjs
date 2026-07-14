'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function createTimelineBoundaryCapture({
    getContext,
    withTimelineOperationLock,
    sleep,
    sendFile,
    EFError,
    timelineFrameToTimecode,
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

    const optionalNumber = async (object, method) => {
        try {
            if (!object || typeof object[method] !== 'function') return null;
            const value = Number(await object[method]());
            return Number.isFinite(value) ? Math.round(value) : null;
        } catch (e) { return null; }
    };

    const optionalId = async (object) => {
        try {
            if (object && typeof object.GetUniqueId === 'function') return String(await object.GetUniqueId());
        } catch (e) { /* optional identity */ }
        return '';
    };

    const snapshotItem = async (item) => {
        const mediaPoolItem = item && typeof item.GetMediaPoolItem === 'function'
            ? await item.GetMediaPoolItem()
            : null;
        let trackType = 'video';
        let trackIndex = 0;
        try {
            const track = await item.GetTrackTypeAndIndex();
            if (Array.isArray(track)) {
                trackType = String(track[0] || 'video');
                trackIndex = Number(track[1]) || 0;
            }
        } catch (e) { /* optional metadata */ }
        return {
            itemId: await optionalId(item),
            itemStartFrame: await optionalNumber(item, 'GetStart'),
            itemEndFrame: await optionalNumber(item, 'GetEnd'),
            sourceStartFrame: await optionalNumber(item, 'GetSourceStartFrame'),
            sourceEndFrame: await optionalNumber(item, 'GetSourceEndFrame'),
            mediaPoolItemId: await optionalId(mediaPoolItem),
            trackType,
            trackIndex,
        };
    };

    const sameItemSnapshot = (left, right) => {
        if (!left || !right || !left.itemId || left.itemId !== right.itemId) return false;
        for (const key of ['itemStartFrame', 'itemEndFrame', 'sourceStartFrame', 'sourceEndFrame']) {
            if (left[key] != null && right[key] !== left[key]) return false;
        }
        if (left.mediaPoolItemId && right.mediaPoolItemId !== left.mediaPoolItemId) return false;
        if (left.trackIndex > 0 && (right.trackType !== left.trackType || right.trackIndex !== left.trackIndex)) return false;
        return true;
    };

    const capture = async (req, res, edge) => withTimelineOperationLock(async () => {
        // A request may have timed out while waiting for another timeline
        // operation. Never let a stale queued request move the user's playhead.
        if (responseClosed(req, res)) {
            throw new EFError('Timeline capture was cancelled', 'CAPTURE_CANCELLED', 499);
        }

        const initial = await getContext();
        const { project, timeline } = initial;
        if (!timeline) throw new EFError('No current timeline', 'NO_TIMELINE', 409);

        const item = await timeline.GetCurrentVideoItem();
        if (!item) {
            const direction = edge === 'start' ? 'incoming' : 'outgoing';
            throw new EFError(`Place the playhead inside the ${direction} shot`, 'NO_ITEM', 409);
        }

        const originalTimecode = await timeline.GetCurrentTimecode();
        const projectId = String(await project.GetUniqueId());
        const timelineId = String(await timeline.GetUniqueId());
        const timelineName = await timeline.GetName();
        const itemSnapshot = await snapshotItem(item);
        const itemId = itemSnapshot.itemId;
        const itemName = await item.GetName();
        const itemStartFrame = itemSnapshot.itemStartFrame;
        const itemEndFrame = itemSnapshot.itemEndFrame;
        if (!itemId) throw new EFError('Resolve did not provide a stable shot identity', 'NO_ITEM', 409);
        if (!Number.isFinite(itemStartFrame) || !Number.isFinite(itemEndFrame) || itemEndFrame <= itemStartFrame) {
            throw new EFError('The shot has no visible timeline frames', 'NO_ITEM', 409);
        }

        const captureFrame = edge === 'start'
            ? itemStartFrame
            : Math.max(itemStartFrame, itemEndFrame - 1);
        const timelineStartFrame = Math.round(Number(await timeline.GetStartFrame()));
        const timelineStartTimecode = await timeline.GetStartTimecode();
        const frameRateSetting = String(await timeline.GetSetting('timelineFrameRate') || '24');
        const fps = parseFloat(frameRateSetting) || 24;
        const targetTimecode = timelineFrameToTimecode({
            captureFrame,
            timelineStartFrame,
            timelineStartTimecode,
            fps,
            dropFrame: /\bDF\b/i.test(frameRateSetting),
        });

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ef-shot-${edge}-`));
        const out = path.join(tmpDir, 'timeline-output.png');
        let streamed = false;
        try {
            const moved = await timeline.SetCurrentTimecode(targetTimecode);
            if (!moved) {
                throw new EFError(`Resolve could not move to the shot ${edge} frame`, 'FRAME_EXPORT_FAILED', 500);
            }
            // Give Resolve one short UI cycle to update the composited viewer,
            // then prove the user did not scrub or switch project/timeline.
            await sleep(80);
            if (responseClosed(req, res)) {
                throw new EFError('Timeline capture was cancelled', 'CAPTURE_CANCELLED', 499);
            }
            const current = await getContext();
            const currentProjectId = String(await current.project.GetUniqueId());
            const currentTimelineId = current.timeline && String(await current.timeline.GetUniqueId());
            if (!current.timeline || currentProjectId !== projectId || currentTimelineId !== timelineId) {
                throw new EFError('The active project or timeline changed before capture', 'TIMELINE_CHANGED', 409);
            }
            const currentTimecode = await current.timeline.GetCurrentTimecode();
            if (!sameTimecodeFrame(currentTimecode, targetTimecode, fps)) {
                throw new EFError('The playhead moved before the frame was captured', 'PLAYHEAD_CHANGED', 409);
            }
            const currentItem = await current.timeline.GetCurrentVideoItem();
            const currentItemSnapshot = currentItem ? await snapshotItem(currentItem) : null;
            if (!sameItemSnapshot(itemSnapshot, currentItemSnapshot)) {
                throw new EFError('The shot moved, was trimmed, relinked, or changed tracks before capture', 'TIMELINE_CHANGED', 409);
            }

            const exported = await current.project.ExportCurrentFrameAsStill(out);
            let bytes = 0;
            try { bytes = fs.statSync(out).size; } catch (e) { /* checked below */ }
            if (!exported || bytes <= 0) {
                throw new EFError('Resolve could not export the timeline output frame', 'FRAME_EXPORT_FAILED', 500);
            }

            sendFile(res, out, 'image/png', {
                'X-EF-Name': enc(itemName),
                'X-EF-Timecode': enc(targetTimecode),
                'X-EF-Original-Timecode': enc(originalTimecode),
                'X-EF-Project-Id': enc(projectId),
                'X-EF-Timeline': enc(timelineName),
                'X-EF-Timeline-Id': enc(timelineId),
                'X-EF-Item-Id': enc(itemId),
                'X-EF-Item-Start-Frame': enc(itemStartFrame),
                'X-EF-Item-End-Frame': enc(itemEndFrame),
                'X-EF-Source-Start-Frame': enc(itemSnapshot.sourceStartFrame),
                'X-EF-Source-End-Frame': enc(itemSnapshot.sourceEndFrame),
                'X-EF-Media-Pool-Item-Id': enc(itemSnapshot.mediaPoolItemId),
                'X-EF-Capture-Frame': enc(captureFrame),
                'X-EF-Capture-Edge': enc(edge),
                'X-EF-Track-Type': enc(itemSnapshot.trackType),
                'X-EF-Track-Index': enc(itemSnapshot.trackIndex),
                'X-EF-Timeline-Fps': enc(fps),
                'X-EF-Capture-Kind': enc('timeline-output'),
            });
            streamed = true;
        } finally {
            // Restore only if the same project/timeline is still active and the
            // playhead is still at EasyField's temporary capture position.
            try {
                const current = await getContext();
                const currentProjectId = String(await current.project.GetUniqueId());
                const currentTimelineId = current.timeline && String(await current.timeline.GetUniqueId());
                const currentTimecode = current.timeline && await current.timeline.GetCurrentTimecode();
                if (
                    current.timeline
                    && currentProjectId === projectId
                    && currentTimelineId === timelineId
                    && sameTimecodeFrame(currentTimecode, targetTimecode, fps)
                ) {
                    await current.timeline.SetCurrentTimecode(originalTimecode);
                }
            } catch (e) { /* best-effort restoration */ }

            const remove = () => {
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
            };
            if (streamed && cleanupDelayMs > 0) setTimeout(remove, cleanupDelayMs);
            else remove();
        }
    });

    return {
        grabShotStartFrame: (req, res) => capture(req, res, 'start'),
        grabShotEndFrame: (req, res) => capture(req, res, 'end'),
    };
}

module.exports = { createTimelineBoundaryCapture };
