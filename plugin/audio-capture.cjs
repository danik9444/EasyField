'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function finiteFrame(value) {
    const frame = Number(value);
    return Number.isFinite(frame) ? Math.round(frame) : null;
}

function createAudioCapture({
    getContext,
    withTimelineOperationLock,
    sendFile,
    runFfmpeg,
    probeDuration,
    clipFps,
    timecodeToFrames,
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

    const itemAtPlayhead = async (timeline, frame) => {
        let trackCount = 0;
        try { trackCount = Number(await timeline.GetTrackCount('audio')) || 0; } catch (e) { /* fallback below */ }
        for (let trackIndex = 1; trackIndex <= trackCount; trackIndex += 1) {
            let items = [];
            try { items = await timeline.GetItemListInTrack('audio', trackIndex) || []; } catch (e) { continue; }
            for (const item of items) {
                try {
                    const start = finiteFrame(await item.GetStart());
                    const end = finiteFrame(await item.GetEnd());
                    if (start != null && end != null && start <= frame && frame < end) {
                        return { item, trackType: 'audio', trackIndex };
                    }
                } catch (e) { /* keep scanning */ }
            }
        }
        const videoItem = typeof timeline.GetCurrentVideoItem === 'function'
            ? await timeline.GetCurrentVideoItem()
            : null;
        return videoItem ? { item: videoItem, trackType: 'video', trackIndex: 0 } : null;
    };

    const capture = async (req, res) => withTimelineOperationLock(async () => {
        if (responseClosed(req, res)) throw new EFError('Timeline audio capture was cancelled', 'CAPTURE_CANCELLED', 499);

        const { project, timeline } = await getContext();
        if (!timeline) throw new EFError('No current timeline', 'NO_TIMELINE', 409);

        const timecode = await timeline.GetCurrentTimecode();
        const timelineFps = parseFloat(await timeline.GetSetting('timelineFrameRate')) || 24;
        const playheadFrame = timecodeToFrames(timecode, timelineFps);
        if (!Number.isSafeInteger(playheadFrame)) throw new EFError('Resolve returned an invalid playhead position', 'INVALID_RANGE', 409);

        const selected = await itemAtPlayhead(timeline, playheadFrame);
        if (!selected) throw new EFError('Place the playhead over an audio clip', 'NO_ITEM', 409);
        const { item, trackType, trackIndex } = selected;

        const mediaPoolItem = typeof item.GetMediaPoolItem === 'function' ? await item.GetMediaPoolItem() : null;
        const filePath = mediaPoolItem && await mediaPoolItem.GetClipProperty('File Path');
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            throw new EFError('The audio source under the playhead is offline or is not file-backed', 'SOURCE_OFFLINE', 409);
        }

        const sourceFps = await clipFps(mediaPoolItem, timeline);
        const sourceStartFrame = finiteFrame(await item.GetSourceStartFrame());
        const sourceEndFrame = finiteFrame(await item.GetSourceEndFrame());
        const itemStartFrame = finiteFrame(await item.GetStart());
        const itemEndFrame = finiteFrame(await item.GetEnd());
        if (
            sourceStartFrame == null || sourceEndFrame == null || sourceStartFrame < 0 || sourceEndFrame < sourceStartFrame
            || itemStartFrame == null || itemEndFrame == null || itemEndFrame <= itemStartFrame
        ) {
            throw new EFError('Resolve returned an invalid trimmed audio range', 'INVALID_RANGE', 409);
        }

        const sourceDurationSeconds = (sourceEndFrame - sourceStartFrame + 1) / sourceFps;
        const timelineDurationSeconds = (itemEndFrame - itemStartFrame) / timelineFps;
        const tolerance = Math.max(2 / sourceFps, 2 / timelineFps, 0.08);
        if (Math.abs(timelineDurationSeconds - sourceDurationSeconds) > tolerance) {
            throw new EFError(
                'This audio clip is retimed. Render or flatten it before using Grab.',
                'UNSUPPORTED_TIMELINE_EDIT',
                409,
            );
        }

        const sourceStartSeconds = sourceStartFrame / sourceFps;
        const itemName = typeof item.GetName === 'function' ? await item.GetName() : path.basename(filePath);
        const timelineName = await timeline.GetName();
        const projectId = await optionalId(project);
        const timelineId = await optionalId(timeline);
        const itemId = await optionalId(item);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-audio-'));
        const outputPath = path.join(tmpDir, 'timeline-audio.wav');
        let streamed = false;
        try {
            await runFfmpeg([
                '-y',
                '-ss', String(sourceStartSeconds),
                '-i', filePath,
                '-t', String(sourceDurationSeconds),
                '-map', '0:a:0',
                '-vn',
                '-ar', '48000',
                '-c:a', 'pcm_s16le',
                outputPath,
            ], res);
            const byteSize = fs.statSync(outputPath).size;
            if (byteSize <= 0) throw new EFError('Timeline audio capture was empty', 'FFMPEG_FAILED', 500);

            const actualDuration = await probeDuration(outputPath);
            if (!actualDuration || Math.abs(actualDuration - sourceDurationSeconds) > Math.max(3 / sourceFps, 0.2)) {
                throw new EFError('The captured audio duration could not be verified', 'FFMPEG_FAILED', 500);
            }
            if (responseClosed(req, res)) throw new EFError('Timeline audio capture was cancelled', 'CAPTURE_CANCELLED', 499);

            const current = await getContext();
            if (
                !current.timeline
                || await optionalId(current.project) !== projectId
                || await optionalId(current.timeline) !== timelineId
                || finiteFrame(await item.GetSourceStartFrame()) !== sourceStartFrame
                || finiteFrame(await item.GetSourceEndFrame()) !== sourceEndFrame
                || finiteFrame(await item.GetStart()) !== itemStartFrame
                || finiteFrame(await item.GetEnd()) !== itemEndFrame
            ) {
                throw new EFError('The active timeline or audio clip changed during capture', 'TIMELINE_CHANGED', 409);
            }

            sendFile(res, outputPath, 'audio/wav', {
                'X-EF-Name': enc(itemName),
                'X-EF-Timecode': enc(timecode),
                'X-EF-Timeline': enc(timelineName),
                'X-EF-Project-Id': enc(projectId),
                'X-EF-Timeline-Id': enc(timelineId),
                'X-EF-Item-Id': enc(itemId),
                'X-EF-Item-Start-Frame': enc(itemStartFrame),
                'X-EF-Item-End-Frame': enc(itemEndFrame),
                'X-EF-Timeline-Fps': enc(timelineFps),
                'X-EF-Source-Start-Frame': enc(sourceStartFrame),
                'X-EF-Source-End-Frame': enc(sourceEndFrame),
                'X-EF-Duration-Seconds': enc(actualDuration),
                'X-EF-Track-Type': enc(trackType),
                'X-EF-Track-Index': enc(trackIndex),
                'X-EF-Capture-Kind': enc('source'),
                'X-EF-Source-Kind': enc('audio'),
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

    return { grabAudio: capture };
}

module.exports = { createAudioCapture };
