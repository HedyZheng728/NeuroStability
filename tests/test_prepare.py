import hashlib
import json
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path


class VideoPreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='arena-prepare-test-')
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def video(self, name='original.mp4', duration=2, audio=False, vfr=False, gop=15):
        target = self.root / name
        command = ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', f'testsrc2=s=320x240:r=30:d={duration}']
        if audio:
            command += ['-f', 'lavfi', '-i', f'sine=frequency=440:duration={duration}']
        if vfr:
            command += ['-vf', "select='lt(t,1)+gte(t,2)'", '-fps_mode', 'vfr']
        subprocess.run(command + ['-c:v', 'libx264', '-g', str(gop), '-preset', 'ultrafast', '-crf', '15', '-c:a', 'aac', str(target)], check=True)
        return target

    def prepare(self, source, **kwargs):
        from arena.video_prepare import prepare_video
        folder = prepare_video(source, self.root / 'outputs', **kwargs)
        return folder, json.loads((folder / 'manifest.json').read_text())

    def test_compliant_video_is_copied_unchanged_with_hash_and_unique_folder(self):
        source = self.video()
        original = source.read_bytes()
        folder, manifest = self.prepare(source)
        self.assertEqual(manifest['status'], 'complete')
        self.assertEqual(manifest['source']['sha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(manifest['clips'][0]['mode'], 'copy')
        self.assertEqual((folder / manifest['clips'][0]['filename']).read_bytes(), original)
        self.assertEqual(source.read_bytes(), original)
        other, _ = self.prepare(source)
        self.assertNotEqual(folder, other)

    def test_long_under_limit_video_splits_without_reencoding_or_changing_decoded_frames(self):
        source = self.video(duration=4.4, audio=True)
        folder, manifest = self.prepare(source, max_seconds=2, overlap=0.2)
        self.assertGreater(len(manifest['clips']), 2)
        self.assertEqual(manifest['clips'][0]['requested_start_sec'], 0)
        previous_end = 0
        for clip in manifest['clips']:
            self.assertLessEqual(clip['duration_seconds'], 2)
            self.assertLessEqual(clip['size_bytes'], 100 * 1024 * 1024)
            self.assertLessEqual(clip['requested_start_sec'], previous_end + 1e-6)
            self.assertGreater(clip['requested_end_sec'], previous_end)
            self.assertEqual(clip['codec'], 'h264')
            self.assertEqual(clip['mode'], 'stream_copy')
            self.assertTrue(clip['has_audio'])
            self.assertEqual(clip['sha256'], hashlib.sha256((folder / clip['filename']).read_bytes()).hexdigest())
            previous_end = clip['requested_end_sec']
        self.assertAlmostEqual(previous_end, manifest['source']['duration_seconds'], places=3)
        def frame_hashes(path):
            output = subprocess.check_output(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:v:0', '-fps_mode', 'passthrough', '-f', 'framemd5', '-'], text=True)
            return [line.rsplit(',', 1)[1].strip() for line in output.splitlines() if line and not line.startswith('#')]
        self.assertEqual(frame_hashes(source), [hash for clip in manifest['clips'] for hash in frame_hashes(folder / clip['filename'])])

    def test_duration_only_refuses_unusable_gop_instead_of_silently_encoding(self):
        source = self.video(duration=4, gop=250)
        with self.assertRaisesRegex(ValueError, 'lossless'):
            self.prepare(source, max_seconds=2, overlap=0)

    def test_oversize_video_uses_shorter_clips_and_all_files_fit_without_rate_conversion(self):
        source = self.video(duration=4)
        folder, manifest = self.prepare(source, max_bytes=45000, overlap=0.1)
        self.assertGreater(len(manifest['clips']), 1)
        self.assertTrue(all(clip['size_bytes'] <= 45000 for clip in manifest['clips']))
        self.assertTrue(all(clip['fps'] == 30 for clip in manifest['clips']))
        self.assertEqual(manifest['settings']['crf'], 20)
        self.assertEqual(manifest['settings']['frame_rate'], 'preserve')

    def test_variable_frame_intervals_are_not_filled_or_changed(self):
        source = self.video(duration=3, vfr=True)
        folder, manifest = self.prepare(source, max_bytes=source.stat().st_size-1, overlap=0)
        pts = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', str(folder / manifest['clips'][0]['filename'])]))
        times = [float(frame['best_effort_timestamp_time']) for frame in pts['frames']]
        self.assertGreater(max(b-a for a,b in zip(times,times[1:])), 0.9)

    def test_cancellation_never_publishes_a_partial_video_or_complete_manifest(self):
        from arena.video_prepare import PreparationCancelled
        source = self.video(duration=3)
        cancel = threading.Event()
        def progress(value):
            if value['stage'] in ('encoding', 'splitting'):
                cancel.set()
        with self.assertRaises(PreparationCancelled):
            self.prepare(source, max_seconds=2, overlap=0.2, cancel=cancel, progress=progress)
        folder = next((self.root / 'outputs').iterdir())
        self.assertEqual(json.loads((folder / 'manifest.json').read_text())['status'], 'cancelled')
        self.assertFalse(list(folder.glob('*.partial.mp4')))
        self.assertEqual(source.stat().st_size > 0, True)

    def test_invalid_source_and_invalid_limits_fail_without_touching_source(self):
        source = self.root / 'broken.mp4'
        source.write_bytes(b'not a video')
        with self.assertRaises(ValueError):
            self.prepare(source)
        source = self.video()
        for kwargs in ({'max_bytes': 0}, {'max_bytes': 101*1024*1024}, {'max_seconds': 301}, {'max_seconds': float('nan')}, {'overlap': -1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.prepare(source, **kwargs)

    def test_unachievable_size_fails_and_leaves_no_invalid_published_clip(self):
        source = self.video()
        with self.assertRaises(ValueError):
            self.prepare(source, max_bytes=1000)
        folder = next((self.root / 'outputs').iterdir())
        manifest = json.loads((folder / 'manifest.json').read_text())
        self.assertEqual(manifest['status'], 'failed')
        self.assertEqual(manifest['clips'], [])
        self.assertFalse(list(folder.glob('*.partial.mp4')))

    def test_audio_tail_does_not_produce_an_audio_only_video_segment(self):
        source = self.root / 'audio-tail.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30:d=1',
                        '-f', 'lavfi', '-i', 'sine=duration=4', '-c:v', 'libx264', '-c:a', 'aac', str(source)], check=True)
        folder, manifest = self.prepare(source, max_seconds=2, overlap=0.2)
        self.assertEqual(manifest['status'], 'complete')
        self.assertEqual(len(manifest['clips']), 1)
        self.assertAlmostEqual(manifest['source']['video_duration_seconds'], 1, places=2)
        self.assertLess(manifest['clips'][0]['duration_seconds'], 1.1)

    def test_hdr_requiring_encoding_is_rejected_instead_of_silent_color_conversion(self):
        source = self.root / 'hdr.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30:d=3',
                        '-c:v', 'libx264', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', str(source)], check=True)
        from arena.video_prepare import inspect_video
        self.assertTrue(inspect_video(source)['hdr'])
        with self.assertRaisesRegex(ValueError, 'HDR'):
            self.prepare(source, max_bytes=source.stat().st_size-1, max_seconds=2, overlap=0.2)


if __name__ == '__main__':
    unittest.main()
