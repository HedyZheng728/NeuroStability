"""Authoritative PTS sampling and actual sequential RGB decoding."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from arena import action


class ActionSamplingTests(unittest.TestCase):
    def test_sampling_uses_pts_and_covers_end_of_each_window(self):
        times = [4., 4.1, 4.2, 4.3, 6., 9., 11., 14., 16., 21.]
        windows = action.sample_windows(times)
        self.assertEqual(windows[0][0], 0)
        self.assertEqual(windows[-1][-1], len(times)-1)
        self.assertEqual(windows[0][-1], 6)
        self.assertEqual(windows[1][0], 7)
        for indices in windows:
            self.assertEqual(len(indices), action.NUM_FRAMES)
            self.assertEqual(indices, sorted(indices))
        self.assertEqual(len(action.sample_windows([9.] )[0]), action.NUM_FRAMES)
        for times in ([], [float('nan')], [1., 1.], [2., 1.]):
            with self.assertRaises(ValueError):
                action.sample_windows(times)

    def test_decoder_preserves_nonzero_pts_and_rgb(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'clip.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48:r=10:d=1',
                            '-vf', 'setpts=PTS+2/TB', '-c:v', 'libx264', '-threads', '1', str(path)], capture_output=True, check=True)
            from arena.video import frame_timestamps
            times = frame_timestamps(path)
            windows = action.sample_windows(times)
            decoded = list(action.decoded_windows(path, windows, len(times)))
            self.assertEqual(len(decoded), 1)
            self.assertEqual(len(decoded[0]), action.NUM_FRAMES)
            self.assertGreater(int(decoded[0][0][0,0,0]), 200)
            self.assertLess(int(decoded[0][0][0,0,2]), 20)
            with self.assertRaises(ValueError):
                list(action.decoded_windows(path, windows, len(times)+1))
            invalid=Path(folder)/'invalid.mp4'
            invalid.write_bytes(b'not a video')
            with self.assertRaises(ValueError):
                list(action.decoded_windows(invalid, [[0]*8], 1))

