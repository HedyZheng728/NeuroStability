"""Local, quality-first preparation. No model inference or network access."""
import hashlib
import json
import math
import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .video import probe

UPLOAD_BYTES = 100 * 1024 * 1024
UPLOAD_SECONDS = 300
EXTENSIONS = {'.mp4', '.mov', '.mkv', '.webm', '.m4v'}


class PreparationCancelled(Exception):
    pass


def _check_cancel(cancel):
    if cancel is not None and cancel.is_set():
        raise PreparationCancelled('Processing cancelled')


def inspect_video(path):
    try:
        info, stream, fps = probe(path)
        duration = float(info['format']['duration'])
        video_duration = duration
        try:
            video_duration = float(stream['duration'])
        except (KeyError, ValueError):
            parts = stream.get('tags', {}).get('DURATION', '').split(':')
            if len(parts) == 3:
                try:
                    video_duration = float(parts[0])*3600 + float(parts[1])*60 + float(parts[2])
                except ValueError:
                    pass
        if not math.isfinite(video_duration) or video_duration <= 0:
            video_duration = duration
        width, height = int(stream['width']), int(stream['height'])
        if not (math.isfinite(duration) and duration > 0 and 0 < fps <= 240 and 2 <= min(width, height) and max(width, height) <= 8192):
            raise ValueError('Video must have a valid duration, resolution <=8192 and frame rate <=240 fps')
        return {'filename': path.name, 'size_bytes': path.stat().st_size, 'duration_seconds': duration,
                'video_duration_seconds': min(duration, video_duration),
                'width': width, 'height': height, 'fps': fps, 'codec': stream.get('codec_name'),
                'color_transfer': stream.get('color_transfer'),
                'hdr': stream.get('color_transfer') in ('smpte2084', 'arib-std-b67') or any('DOVI' in s.get('side_data_type', '') for s in stream.get('side_data_list', [])),
                'has_audio': any(s.get('codec_type') == 'audio' for s in info['streams'])}
    except (subprocess.SubprocessError, OSError, KeyError, StopIteration, ZeroDivisionError, json.JSONDecodeError) as exc:
        raise ValueError('Cannot decode video. Check the file and FFmpeg/ffprobe installation.') from exc


def _hash(path, cancel):
    digest = hashlib.sha256()
    with path.open('rb') as data:
        while chunk := data.read(1024 * 1024):
            _check_cancel(cancel)
            digest.update(chunk)
    return digest.hexdigest()


def _save_manifest(folder, manifest):
    pending = folder / 'manifest.json.tmp'
    pending.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    os.chmod(pending, 0o600)
    pending.replace(folder / 'manifest.json')


def _encode(source, target, start, duration, cancel, progress):
    command = ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
               '-ss', f'{start:.8f}', '-i', str(source), '-t', f'{duration:.8f}',
               '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
               '-vf', "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
               '-fps_mode', 'vfr', '-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-pix_fmt', 'yuv420p',
               '-threads', '2', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
               '-progress', 'pipe:1', '-stats_period', '0.3', str(target)]
    _run_ffmpeg(command, duration, cancel, progress)


def _run_ffmpeg(command, duration, cancel, progress):
    _check_cancel(cancel)
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors, text=True)
        messages = queue.Queue()
        def read_progress():
            try:
                for line in process.stdout:
                    messages.put(line.strip())
            finally:
                messages.put(None)
        reader = threading.Thread(target=read_progress, daemon=True)
        reader.start()
        deadline = time.monotonic() + max(300, duration * 30)
        try:
            while True:
                _check_cancel(cancel)
                if time.monotonic() > deadline:
                    raise ValueError('Encoding timed out; try a shorter source clip')
                try:
                    line = messages.get(timeout=0.2)
                except queue.Empty:
                    continue
                if line is None:
                    break
                key, _, value = line.partition('=')
                if key == 'out_time_us':
                    try:
                        elapsed = max(0, min(duration, int(value) / 1_000_000))
                    except ValueError:
                        continue
                    progress(elapsed)
            process.wait(timeout=10)
            _check_cancel(cancel)
            if process.returncode:
                errors.seek(0)
                detail = errors.read()[-2000:].decode('utf-8', errors='replace')
                raise ValueError(f'FFmpeg could not encode the video: {detail.strip()}')
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            reader.join(timeout=1)
            process.stdout.close()


def _split_losslessly(source, work, metadata, max_seconds, cancel, progress):
    """Cut compressed streams on their existing keyframes, without encoding."""
    _check_cancel(cancel)
    try:
        encoded = subprocess.check_output(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries',
            'frame=best_effort_timestamp_time', '-of', 'json', str(source)], timeout=60)
        points = [float(frame['best_effort_timestamp_time']) for frame in json.loads(encoded)['frames']
                  if 'best_effort_timestamp_time' in frame]
    except (subprocess.SubprocessError, KeyError, ValueError) as exc:
        raise ValueError('Cannot locate keyframes for lossless splitting') from exc
    if not points or any(not math.isfinite(value) for value in points):
        raise ValueError('Cannot locate keyframes for lossless splitting')
    points = sorted(set(round(value - points[0], 8) for value in points))
    total, start, cuts = metadata['video_duration_seconds'], 0.0, []
    while total - start > max_seconds * 0.95:
        target = start + min(240, max_seconds * 0.8)
        candidates = [p for p in points if start + 1e-6 < p <= start + max_seconds * 0.9]
        if not candidates:
            raise ValueError('Cannot make lossless clips within the duration limit: keyframes are too far apart. Original unchanged.')
        before = [p for p in candidates if p <= target + 1e-6]
        start = max(before) if before else min(candidates)
        cuts.append(start)
    work.mkdir(mode=0o700)
    suffix = source.suffix.lower()
    container = {'.mp4': 'mp4', '.m4v': 'mp4', '.mov': 'mov', '.mkv': 'matroska', '.webm': 'webm'}[suffix]
    command = ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
        '-i', str(source), '-t', f'{total:.8f}', '-map', '0:v:0', '-map', '0:a:0?',
        '-c', 'copy', '-map_chapters', '-1', '-f', 'segment', '-segment_format', container,
        '-reset_timestamps', '1']
    if cuts:
        command += ['-segment_times', ','.join(f'{cut:.8f}' for cut in cuts)]
    else:
        command += ['-segment_time', str(total + 1)]
    command += ['-progress', 'pipe:1', '-stats_period', '0.3', str(work / f'part-%05d{suffix}')]
    _run_ffmpeg(command, total, cancel, progress)
    files = sorted(work.glob(f'part-*{suffix}'))
    boundaries = [0.0, *cuts, total]
    if len(files) != len(boundaries) - 1:
        raise ValueError('Cannot verify lossless segment boundaries. Original unchanged.')
    return [(file, boundaries[i], boundaries[i+1]) for i, file in enumerate(files)]


def validate_limits(max_bytes=UPLOAD_BYTES, max_seconds=UPLOAD_SECONDS, overlap=2):
    if not isinstance(max_bytes, int) or not 0 < max_bytes <= UPLOAD_BYTES:
        raise ValueError('Size limit must be a positive integer <=100 MiB')
    if not math.isfinite(max_seconds) or not 0 < max_seconds <= UPLOAD_SECONDS:
        raise ValueError('Duration limit must be >0 and <=300 seconds')
    if not math.isfinite(overlap) or not 0 <= overlap < max_seconds:
        raise ValueError('Overlap must be >=0 and shorter than the duration limit')


def prepare_video(source, output_root, *, max_bytes=UPLOAD_BYTES, max_seconds=UPLOAD_SECONDS,
                  overlap=2, progress=None, cancel=None):
    """Return a unique result folder. Only validated files are published in its manifest."""
    validate_limits(max_bytes, max_seconds, overlap)
    source, output_root = Path(source).resolve(), Path(output_root).resolve()
    if not source.is_file() or source.suffix.lower() not in EXTENSIONS:
        raise ValueError('Choose an MP4, MOV, M4V, MKV or WebM video')
    _check_cancel(cancel)
    metadata = inspect_video(source)
    original_stat = source.stat()
    stem = re.sub(r'[^\w-]+', '_', source.stem, flags=re.UNICODE).strip('_')[:70] or 'video'
    folder = output_root / f'{stem}_{datetime.now().strftime("%Y%m%d-%H%M%S")}_{uuid4().hex[:6]}'
    folder.mkdir(parents=True, mode=0o700)
    manifest = {'version': 1, 'created_at': datetime.now(timezone.utc).isoformat(), 'status': 'running',
                'source': metadata, 'settings': {'max_bytes': max_bytes, 'max_seconds': max_seconds,
                'target_bytes': int(max_bytes * 0.9), 'crf': 20, 'max_edge': 1920,
                'frame_rate': 'preserve', 'audio': 'preserve; AAC 128k when encoding', 'overlap_seconds': overlap},
                'timing': 'Requested intervals use seconds from the source start. Frame boundaries may differ by one frame. Overlap repeats source content; do not count it twice.',
                'audio': 'Original audio is unchanged for copies. Encoded clips retain audio within the video interval; audio after the last video frame is excluded.',
                'clips': []}
    emit = progress or (lambda value: None)
    partial = None
    lossless_work = folder / '.lossless'
    _save_manifest(folder, manifest)
    try:
        emit({'stage': 'checking', 'fraction': 0, 'clip': 0, 'folder': str(folder)})
        metadata['sha256'] = _hash(source, cancel)
        _save_manifest(folder, manifest)
        copy = metadata['size_bytes'] <= max_bytes and metadata['duration_seconds'] <= max_seconds
        compress = metadata['size_bytes'] > max_bytes
        if metadata['hdr'] and compress:
            raise ValueError('HDR compression needs an SDR export first. The original file is unchanged.')
        start, number = 0.0, 1
        total = metadata['video_duration_seconds']
        lossless = None
        if not copy and not compress:
            emit({'stage': 'splitting', 'fraction': 0, 'clip': 0})
            lossless = _split_losslessly(source, lossless_work, metadata, max_seconds, cancel,
                lambda elapsed: emit({'stage': 'splitting', 'fraction': elapsed / total, 'clip': 0}))
            manifest['settings']['effective_overlap_seconds'] = 0
            manifest['timing'] = 'Stream-copy cuts use existing keyframes without reencoding or overlap. Intervals describe requested source keyframe times; container timestamps can be shifted by the muxer.'
        while start < total - 1e-6:
            _check_cancel(cancel)
            if source.stat().st_size != original_stat.st_size or source.stat().st_mtime_ns != original_stat.st_mtime_ns:
                raise ValueError('Source file changed during processing. Choose it again.')
            duration = total if copy else min(240, max_seconds * 0.95, total - start)
            suffix = source.suffix.lower() if copy or lossless else '.mp4'
            partial = folder / f'{number:03d}.partial{suffix}'
            if lossless:
                partial, start, end = lossless[number-1]
                duration = end - start
                result = inspect_video(partial)
            elif copy:
                emit({'stage': 'copying', 'fraction': 0, 'clip': number})
                with source.open('rb') as data, partial.open('xb') as output:
                    while chunk := data.read(1024 * 1024):
                        _check_cancel(cancel)
                        output.write(chunk)
                result = inspect_video(partial)
            else:
                for attempt in range(10):
                    emit({'stage': 'encoding', 'fraction': start / total, 'clip': number, 'duration': duration, 'elapsed': 0})
                    _encode(source, partial, start, duration, cancel,
                            lambda elapsed: emit({'stage': 'encoding', 'fraction': min(0.99, (start + elapsed) / total),
                                                  'clip': number, 'elapsed': elapsed, 'duration': duration}))
                    result = inspect_video(partial)
                    if result['size_bytes'] <= int(max_bytes * 0.9):
                        break
                    next_duration = duration * int(max_bytes * 0.9) / result['size_bytes'] * 0.9
                    if next_duration < max(0.1, 2 / metadata['fps']):
                        raise ValueError('The requested file size is too small to retain video detail')
                    duration = next_duration
                    emit({'stage': 'shortening', 'fraction': start / total, 'clip': number})
                else:
                    raise ValueError('Could not meet the size limit without reducing quality')
            _check_cancel(cancel)
            if result['size_bytes'] > max_bytes or result['duration_seconds'] > max_seconds:
                raise ValueError('Output did not pass size/duration checks; it has not been published')
            end = min(total, start + duration)
            filename = f'{number:03d}_{stem}_{start:09.2f}-{end:09.2f}s{suffix}'
            result.update(filename=filename, sha256=_hash(partial, cancel), mode='copy' if copy else 'stream_copy' if lossless else 'encode',
                          requested_start_sec=round(start, 8), requested_end_sec=round(end, 8))
            os.chmod(partial, 0o600)
            partial.replace(folder / filename)
            partial = None
            manifest['clips'].append(result)
            _save_manifest(folder, manifest)
            if end >= total - 1e-6:
                break
            start = end if lossless else end - min(overlap, duration * 0.1)
            number += 1
        _check_cancel(cancel)
        if source.stat().st_size != original_stat.st_size or source.stat().st_mtime_ns != original_stat.st_mtime_ns:
            raise ValueError('Source file changed during processing. Choose it again.')
        manifest['status'] = 'complete'
        _save_manifest(folder, manifest)
        emit({'stage': 'complete', 'fraction': 1, 'clip': len(manifest['clips'])})
        return folder
    except Exception as exc:
        manifest.update(status='cancelled' if isinstance(exc, PreparationCancelled) else 'failed', error=str(exc))
        _save_manifest(folder, manifest)
        raise
    finally:
        if partial is not None:
            partial.unlink(missing_ok=True)
        if lossless_work.exists():
            shutil.rmtree(lossless_work)
