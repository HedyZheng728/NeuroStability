import json
import math
import subprocess
from fractions import Fraction


def probe(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format",
                        "-of", "json", str(path)], capture_output=True, timeout=20, check=True)
    info = json.loads(p.stdout)
    stream = next(s for s in info["streams"] if s.get("codec_type") == "video")
    if not any(kind in info["format"]["format_name"].split(",") for kind in ("mov", "mp4", "matroska", "webm")):
        raise ValueError("视频容器不受支持，请使用 MP4/MOV/WebM/MKV")
    rate = stream.get("avg_frame_rate", "0/0")
    if rate in ("0/0", "0/1"):
        rate = stream.get("r_frame_rate", "0/0")
    return info, stream, float(Fraction(rate))


def frame_timestamps(path, normalize=False):
    """Authoritative decoded presentation timestamps, including gaps in VFR video."""
    data = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
                           "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(path)],
                          capture_output=True, timeout=60, check=True)
    frames = json.loads(data.stdout)["frames"]
    times = [float(f["best_effort_timestamp_time"]) for f in frames]
    if not times or len(times) > 73000 or any(not math.isfinite(t) for t in times) or any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("视频帧时间戳无效或超出上限")
    return [t - times[0] for t in times] if normalize else times


def sample_indices(times, sample_fps):
    selected, next_t = set(), 0.0
    for i, t in enumerate(times):
        if t + 1e-7 >= next_t:
            selected.add(i)
            next_t = t + 1 / sample_fps
    return selected


def preprocess(source, output, settings, start_sec=0, end_sec=None):
    """Preserve frame cadence, remove audio and normalize orientation for analysis."""
    try:
        info, stream, fps = probe(source)
        duration = float(info["format"].get("duration", 0))
        width, height = int(stream["width"]), int(stream["height"])
        if not (math.isfinite(duration) and 0 < duration <= settings.max_video_seconds
                and 1 <= min(width, height) and max(width, height) <= 8192 and 0 < fps <= 240):
            raise ValueError("视频须不超过300秒、8192像素和240fps")
        end = duration if end_sec is None else end_sec
        if not 0 <= start_sec < end <= duration + 0.05:
            raise ValueError("分析片段超出视频时长")
        source_times = frame_timestamps(source, normalize=True)
        selected = [t for t in source_times if start_sec - 1e-7 <= t < end - 1e-7]
        if not selected:
            raise ValueError("所选片段没有可用视频帧")
        filters = (f"setpts=PTS-STARTPTS,trim=start={start_sec}:end={end},setpts=PTS-STARTPTS,"
                   "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1")
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "1", "-protocol_whitelist", "file,pipe",
                        "-i", str(source),
                        "-map", "0:v:0", "-an", "-vf", filters, "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "fast",
                        "-threads", "1", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)],
                       capture_output=True, timeout=600, check=True)
        normalized_info, normalized, normalized_fps = probe(output)
        return {"duration": float(normalized_info["format"]["duration"]), "source_duration": duration,
                "time_offset": selected[0], "requested_start_sec": start_sec,
                "width": normalized["width"], "height": normalized["height"],
                "original_width": width, "original_height": height, "source_fps": fps, "fps": normalized_fps,
                "sample_fps": settings.sample_fps, "audio_removed": True, "rotation_normalized": True,
                "timing_note": "原始视频保留；分析采样不作为快速动作的逐帧时间测量"}
    except (subprocess.SubprocessError, KeyError, StopIteration, json.JSONDecodeError, OSError, ZeroDivisionError) as exc:
        raise ValueError("视频无法解码或预处理失败，请上传有效 MP4/MOV/WebM；并检查 FFmpeg") from exc
