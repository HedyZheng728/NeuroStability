"""Real PTS sampling and sequential RGB decoding shared by action backends."""
from bisect import bisect_left
import math

NUM_FRAMES = 8
WINDOW_SECONDS = 8


def sample_windows(times, num_frames=NUM_FRAMES):
    """Nearest real presentation timestamps per nonoverlapping 8-second window."""
    if (not times or len(times) > 73000 or any(not math.isfinite(t) for t in times)
            or any(b <= a for a,b in zip(times,times[1:])) or times[-1]-times[0] > 300):
        raise ValueError('视频帧时间戳无效或超出300秒上限')
    if type(num_frames) is not int or not 2 <= num_frames <= 32:
        raise ValueError("视频采样数须为2–32帧")
    windows = []
    start = 0
    while start < len(times):
        stop = bisect_left(times, times[start]+WINDOW_SECONDS, lo=start+1)
        end = stop-1
        selected = []
        for i in range(num_frames):
            target = times[start] + (times[end]-times[start])*i/(num_frames-1)
            right = min(end, bisect_left(times, target, lo=start, hi=stop))
            left = max(start,right-1)
            selected.append(min((left,right), key=lambda j: abs(times[j]-target)))
        windows.append(selected)
        start = stop
    return windows


def decoded_windows(path, windows, expected_frames):
    """Sequential decoding retains only selected source frames and validates full decode."""
    import cv2
    cap = cv2.VideoCapture(str(path))
    index, window, frames = 0, 0, {}
    try:
        while True:
            ok, bgr = cap.read()
            if not ok:
                break
            if index >= expected_frames:
                raise ValueError('视频解码帧数与时间戳不匹配')
            if window < len(windows) and index in windows[window]:
                frames[index] = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            if window < len(windows) and index == windows[window][-1]:
                yield [frames[j] for j in windows[window]]
                window += 1
                frames = {}
            index += 1
    finally:
        cap.release()
    if index != expected_frames or window != len(windows):
        raise ValueError('视频解码不完整或没有可用帧')

