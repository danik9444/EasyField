'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function finiteFrame(value) {
    const frame = Number(value);
    return Number.isFinite(frame) ? Math.round(frame) : null;
}

function createEditVideoCapture({
    getContext,
    withTimelineOperationLock,
    sendFile,
    runFfmpeg,
    probeDuration,
    clipFps,
    EFError,
    enc,
    cleanupDelayMs = 15000,
}) {
    const responseClosed = (req, res) => !!(
        (req && req.destroyed)
        || (res && (res.destroyed || res.headersSent || res.writableEnded))
    );

    const optionalId = async (object) => {
        try {
            if (object && typeof object.GetUniqueId === 'function') return String(await object.GetUniqueId());
        } catch (e) { /* optional metadata */ }
        return '';
    };

    const capture = async (req, res) => withTimelineOperationLock(async () => {
        if (responseClosed(req, res)) {
            throw new EFError('Timeline clip capture was cancelled', 'CAPTURE_CANCELLED', 499);
        }

        const { project, timeline } = await getContext();
        if (!timeline) throw new EFError('No current timeline', 'NO_TIMELINE', 409);

        const item = await timeline.GetCurrentVideoItem();
        if (!item) throw new EFError('Place the playhead over the video clip to edit', 'NO_ITEM', 409);

        const mediaPoolItem = typeof item.GetMediaPoolItem === 'function'
            ? await item.GetMediaPoolItem()
            : null;
        const filePath = mediaPoolItem && await mediaPoolItem.GetClipProperty('File Path');
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            throw new EFError('The timeline clip source is offline or is not a file-backed video', 'SOURCE_OFFLINE', 409);
        }

        const fps = await clipFps(mediaPoolItem, timeline);
        const sourceStartFrame = finiteFrame(await item.GetSourceStartFrame());
        const sourceEndFrame = finiteFrame(await item.GetSourceEndFrame());
        if (
            sourceStartFrame == null
            || sourceEndFrame == null
            || sourceStartFrame < 0
            || sourceEndFrame < sourceStartFrame
        ) {
            throw new EFError('Resolve returned an invalid trimmed clip range', 'INVALID_RANGE', 409);
        }

        const sourceFrameCount = sourceEndFrame - sourceStartFrame + 1;
        const sourceStartSeconds = sourceStartFrame / fps;
        const durationSeconds = sourceFrameCount / fps;
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
            throw new EFError('The trimmed timeline clip has no usable duration', 'INVALID_RANGE', 409);
        }

        const timelineStartFrame = finiteFrame(await item.GetStart());
        const timelineEndFrame = finiteFrame(await item.GetEnd());
        const timelineFps = parseFloat(await timeline.GetSetting('timelineFrameRate')) || fps;
        if (
            timelineStartFrame == null
            || timelineEndFrame == null
            || timelineEndFrame <= timelineStartFrame
        ) {
            throw new EFError('Resolve returned an invalid timeline clip range', 'INVALID_RANGE', 409);
        }
        const timelineDurationSeconds = (timelineEndFrame - timelineStartFrame) / timelineFps;
        const retimeTolerance = Math.max(2 / fps, 2 / timelineFps, 0.08);
        if (Math.abs(timelineDurationSeconds - durationSeconds) > retimeTolerance) {
            throw new EFError(
                'This clip is retimed. Render or flatten it before using Grab in Edit Video.',
                'UNSUPPORTED_TIMELINE_EDIT',
                409,
            );
        }
        const itemName = typeof item.GetName === 'function' ? await item.GetName() : path.basename(filePath);
        const timecode = await timeline.GetCurrentTimecode();
        const timelineName = await timeline.GetName();
        const projectId = await optionalId(project);
        const timelineId = await optionalId(timeline);
        const itemId = await optionalId(item);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-edit-video-'));
        const out = path.join(tmpDir, 'trimmed-source.mp4');
        let streamed = false;
        try {
            // Re-encode deliberately: stream-copy can begin at the previous
            // keyframe and return frames outside Resolve's Source In/Out.
            // Optional audio mapping keeps source audio when the clip has it.
            await runFfmpeg([
                '-y',
                '-ss', String(sourceStartSeconds),
                '-i', filePath,
                '-t', String(durationSeconds),
                '-map', '0:v:0',
                '-map', '0:a:0?',
                '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '18',
                '-c:a', 'aac',
                '-avoid_negative_ts', 'make_zero',
                '-movflags', '+faststart',
                out,
            ], res);
            let bytes = 0;
            try { bytes = fs.statSync(out).size; } catch (e) { /* checked below */ }
            if (bytes <= 0) {
                throw new EFError('The trimmed timeline clip could not be exported', 'FFMPEG_FAILED', 500);
            }
            const actualDuration = await probeDuration(out);
            const durationTolerance = Math.max(3 / fps, 0.2);
            if (!actualDuration || Math.abs(actualDuration - durationSeconds) > durationTolerance) {
                throw new EFError('The trimmed clip duration could not be verified', 'FFMPEG_FAILED', 500);
            }
            if (responseClosed(req, res)) {
                throw new EFError('Timeline clip capture was cancelled', 'CAPTURE_CANCELLED', 499);
            }

            const current = await getContext();
            const currentProjectId = await optionalId(current.project);
            const currentTimelineId = await optionalId(current.timeline);
            if (!current.timeline || currentProjectId !== projectId || currentTimelineId !== timelineId) {
                throw new EFError('The active project or timeline changed during clip capture', 'TIMELINE_CHANGED', 409);
            }
            const currentSourceStart = finiteFrame(await item.GetSourceStartFrame());
            const currentSourceEnd = finiteFrame(await item.GetSourceEndFrame());
            const currentTimelineStart = finiteFrame(await item.GetStart());
            const currentTimelineEnd = finiteFrame(await item.GetEnd());
            if (
                currentSourceStart !== sourceStartFrame
                || currentSourceEnd !== sourceEndFrame
                || currentTimelineStart !== timelineStartFrame
                || currentTimelineEnd !== timelineEndFrame
            ) {
                throw new EFError('The timeline clip was trimmed or changed during capture', 'TIMELINE_CHANGED', 409);
            }

            sendFile(res, out, 'video/mp4', {
                'X-EF-Name': enc(itemName),
                'X-EF-Timecode': enc(timecode),
                'X-EF-Timeline': enc(timelineName),
                'X-EF-Project-Id': enc(projectId),
                'X-EF-Timeline-Id': enc(timelineId),
                'X-EF-Item-Id': enc(itemId),
                'X-EF-Item-Start-Frame': enc(timelineStartFrame == null ? '' : timelineStartFrame),
                'X-EF-Item-End-Frame': enc(timelineEndFrame == null ? '' : timelineEndFrame),
                'X-EF-Timeline-Fps': enc(timelineFps),
                'X-EF-Source-Start-Frame': enc(sourceStartFrame),
                'X-EF-Source-End-Frame': enc(sourceEndFrame),
                'X-EF-Duration-Seconds': enc(durationSeconds),
                'X-EF-Timeline-Duration-Seconds': enc(timelineDurationSeconds),
                'X-EF-Capture-Kind': enc('source'),
                'X-EF-Source-Kind': enc('video'),
                'X-EF-Trimmed': enc('true'),
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

    return { grabEditVideoSource: capture };
}

module.exports = { createEditVideoCapture };
