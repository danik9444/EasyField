'use strict';

function nominalRate(fps) {
    const rate = Math.round(Number(fps));
    return Number.isFinite(rate) && rate > 0 ? rate : 24;
}

function supportsDropFrame(fps) {
    const rate = nominalRate(fps);
    return rate === 30 || rate === 60;
}

function timecodeToFrames(timecode, fps) {
    const match = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(String(timecode || '').trim());
    if (!match) return null;
    const [, hh, mm, ss, ff] = match.map(Number);
    const rate = nominalRate(fps);
    if (mm > 59 || ss > 59 || ff >= rate) return null;
    const dropFrame = String(timecode).includes(';') && supportsDropFrame(fps);
    const dropFrames = dropFrame ? Math.round(rate * 0.0666666667) : 0;
    // SMPTE drop-frame omits the first 2 (29.97) or 4 (59.94) frame labels at
    // every minute except each tenth minute. Accepting those nonexistent labels
    // would map two timecodes to the same physical frame.
    if (dropFrame && mm % 10 !== 0 && ss === 0 && ff < dropFrames) return null;
    const totalMinutes = hh * 60 + mm;
    const dropped = dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
    return ((hh * 3600 + mm * 60 + ss) * rate + ff) - dropped;
}

function framesToTimecode(frameCount, fps, dropFrame) {
    const rate = nominalRate(fps);
    let frames = Math.max(0, Math.round(Number(frameCount) || 0));
    const useDropFrame = !!dropFrame && supportsDropFrame(fps);
    const separator = useDropFrame ? ';' : ':';

    if (useDropFrame) {
        const dropFrames = Math.round(rate * 0.0666666667);
        const framesPerHour = Math.round(Number(fps) * 3600);
        const framesPer24Hours = framesPerHour * 24;
        const framesPer10Minutes = Math.round(Number(fps) * 600);
        const framesPerMinute = rate * 60 - dropFrames;
        frames %= framesPer24Hours;
        const tenMinuteBlocks = Math.floor(frames / framesPer10Minutes);
        const blockRemainder = frames % framesPer10Minutes;
        frames += dropFrames * 9 * tenMinuteBlocks;
        if (blockRemainder > dropFrames) {
            frames += dropFrames * Math.floor((blockRemainder - dropFrames) / framesPerMinute);
        }
    } else {
        frames %= rate * 60 * 60 * 24;
    }

    const ff = frames % rate;
    const totalSeconds = Math.floor(frames / rate);
    const ss = totalSeconds % 60;
    const mm = Math.floor(totalSeconds / 60) % 60;
    const hh = Math.floor(totalSeconds / 3600) % 24;
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}${separator}${pad(ff)}`;
}

function timelineFrameToTimecode({ captureFrame, timelineStartFrame, timelineStartTimecode, fps, dropFrame }) {
    const startTimecodeFrames = timecodeToFrames(timelineStartTimecode, fps);
    if (startTimecodeFrames == null) throw new Error('Timeline start timecode is invalid');
    const offset = Math.round(captureFrame) - Math.round(timelineStartFrame);
    return framesToTimecode(startTimecodeFrames + offset, fps, dropFrame || String(timelineStartTimecode).includes(';'));
}

function timelinePlayheadToSourceFrame({ playheadFrame, itemStartFrame, sourceStartFrame, timelineFps, sourceFps }) {
    const values = [playheadFrame, itemStartFrame, sourceStartFrame, timelineFps, sourceFps].map(Number);
    if (values.some((value) => !Number.isFinite(value)) || values[3] <= 0 || values[4] <= 0) return null;
    const timelineOffsetSeconds = Math.max(0, values[0] - values[1]) / values[3];
    return Math.round(values[2] + timelineOffsetSeconds * values[4]);
}

module.exports = {
    framesToTimecode,
    nominalRate,
    supportsDropFrame,
    timecodeToFrames,
    timelineFrameToTimecode,
    timelinePlayheadToSourceFrame,
};
