import subprocess
import json
import tempfile
import unittest
from pathlib import Path

from arena.config import Settings
from arena.video import preprocess


class TimingTests(unittest.TestCase):
    def test_vfr_and_fractional_clip_keep_source_timeline(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, normalized = root / "vfr.mp4", root / "normalized.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=30:d=3",
                            "-vf", "select='lt(t,1)+gte(t,2)'", "-fps_mode", "vfr", "-c:v", "libx264", str(source)], check=True)
            metadata = preprocess(source, normalized, Settings(), start_sec=0.55, end_sec=2.6)
            info = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0",
                    "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(normalized)]))
            pts = [float(frame["best_effort_timestamp_time"]) for frame in info["frames"]]
            self.assertAlmostEqual(pts[0], 0, places=5)
            self.assertAlmostEqual(metadata["time_offset"], 17 / 30, places=5)
            mapped = [t + metadata["time_offset"] for t in pts]
            self.assertTrue(any(abs(t - 2) < 0.001 for t in mapped))
            self.assertGreater(max(b - a for a, b in zip(pts, pts[1:])), 1)


if __name__ == "__main__":
    unittest.main()
