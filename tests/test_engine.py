import copy
import math
import unittest

from arena.engine import analyze


def pose_frame(t, shift=0, confidence=1, people=1):
    points = [[50.0 + shift, 50.0, confidence] for _ in range(17)]
    for index, x, y in [(5, 40, 20), (6, 60, 20), (11, 40, 60),
                        (12, 60, 60), (15, 30, 100), (16, 70, 100)]:
        points[index] = [x + shift, y, confidence]
    return {"t": t, "people": [{"keypoints": copy.deepcopy(points)} for _ in range(people)]}


def sequence(frames):
    return {"schema_version": 1, "layout": "coco17", "width": 200,
            "height": 120, "sample_fps": 10, "frames": frames}


def tracked_person(track_id, straight=False):
    points = [[0, 0, 0] for _ in range(17)]
    for index, x, y in [(5, 40, 20), (6, 60, 20), (7, 30, 20), (8, 70, 20),
                        (9, 20, 20), (10, 70, 30), (11, 40, 60), (12, 60, 60),
                        (13, 40, 80), (14, 60, 80), (15, 60, 80), (16, 60, 100)]:
        points[index] = [x, y, 1]
    if straight:
        points[15] = [40, 100, 1]
    return {"track_id": track_id, "keypoints": points}


def tracking_sequence(frames):
    return {**sequence(frames), "backend": "rtmpose_tracking", "synthetic": False}


class EngineTests(unittest.TestCase):
    def test_tracking_joint_angles_have_known_geometry_and_independent_summaries(self):
        frames = [{"t": 0, "people": [tracked_person(1)]},
                  {"t": 0.5, "people": [tracked_person(1, straight=True)]}]
        kinematics = analyze(tracking_sequence(frames))["kinematics"]
        self.assertEqual(kinematics["method_version"], "joint-angles-2d-v1")
        self.assertEqual(kinematics["unit"], "deg")
        self.assertTrue(kinematics["experimental"])
        track = kinematics["tracks"][0]
        self.assertEqual((track["track_id"], track["n_samples"], track["first_t"], track["last_t"]),
                         (1, 2, 0, 0.5))
        self.assertEqual(track["series"][0], {"t": 0, "left_knee": 90, "right_knee": 180,
                                               "left_elbow": 180, "right_elbow": 90, "trunk_lean": 0})
        self.assertEqual(track["joints"]["left_knee"], {"n": 2, "min": 90, "median": 135, "max": 180})

    def test_tracking_trunk_does_not_need_ankles_and_sparse_frames_keep_their_times(self):
        first, last = tracked_person(1), tracked_person(1)
        for person in (first, last):
            person["keypoints"][15:17] = [[0, 0, 0], [0, 0, 0]]
        last["keypoints"][5:11] = [[0, 0, 0] for _ in range(6)]
        track = analyze(tracking_sequence([
            {"t": 0, "people": [first]}, {"t": 0.5, "people": []},
            {"t": 1, "people": [last]}, {"t": 2, "people": [tracked_person(1, straight=True)]},
        ]))["kinematics"]["tracks"][0]
        self.assertEqual([row["t"] for row in track["series"]], [0, 2])
        self.assertEqual(track["n_samples"], 2)
        self.assertIsNone(track["series"][0]["left_knee"])
        self.assertEqual(track["series"][0]["trunk_lean"], 0)
        self.assertEqual(track["joints"]["left_knee"], {"n": 1, "min": 180, "median": 180, "max": 180})

    def test_tracking_people_are_independent_and_target_selection_filters_tracks(self):
        pose = tracking_sequence([{"t": 0, "people": [tracked_person(2, straight=True), tracked_person(1)]}])
        result = analyze(pose)
        tracks = {track["track_id"]: track for track in result["kinematics"]["tracks"]}
        self.assertEqual(set(tracks), {1, 2})
        self.assertEqual(tracks[1]["series"][0]["left_knee"], 90)
        self.assertEqual(tracks[2]["series"][0]["left_knee"], 180)
        self.assertEqual(result["quality"]["ambiguous_frames"], 1)
        selected = analyze(pose, target_track_id=2)["kinematics"]["tracks"]
        self.assertEqual([track["track_id"] for track in selected], [2])
        self.assertEqual(analyze(pose, target_track_id=9)["kinematics"]["tracks"], [])

    def test_tracking_rejects_duplicate_and_invalid_ids_without_borrowing_people(self):
        people = [tracked_person(track_id) for track_id in (1, 1, None, True, 0, -1, "2", 2.0, 3)]
        tracks = analyze(tracking_sequence([{"t": 0, "people": people}]))["kinematics"]["tracks"]
        self.assertEqual([track["track_id"] for track in tracks], [3])

    def test_tracking_invalid_points_and_short_segments_produce_null_angles(self):
        for bad_point in ([math.nan, 80, 1], [40, math.inf, 1], [200, 80, 1],
                          [-1, 80, 1], [40, 80, 0.49], [40, 80], [40, 60.5, 1]):
            with self.subTest(point=bad_point):
                person = tracked_person(1)
                person["keypoints"][13] = bad_point
                track = analyze(tracking_sequence([{"t": 0, "people": [person]}]))["kinematics"]["tracks"][0]
                self.assertIsNone(track["series"][0]["left_knee"])
                self.assertEqual(track["joints"]["left_knee"], {"n": 0, "min": None, "median": None, "max": None})
                self.assertEqual(track["series"][0]["right_knee"], 180)

    def test_tracking_kinematics_requires_real_tracking_metadata_and_preserves_existing_analysis(self):
        pose = tracking_sequence([{"t": i / 10, "people": [tracked_person(1)]} for i in range(20)])
        original = copy.deepcopy(pose)
        untracked = {**pose, "backend": "rtmpose"}
        previous = analyze(untracked, target_track_id=1)
        current = analyze(pose, target_track_id=1)
        self.assertIn("kinematics", current)
        self.assertEqual({key: value for key, value in current.items() if key != "kinematics"}, previous)
        self.assertEqual(pose, original)
        for metadata in ({"backend": "rtmpose"}, {"synthetic": True}, {"synthetic": None}):
            with self.subTest(metadata=metadata):
                self.assertNotIn("kinematics", analyze({**pose, **metadata}))

    def test_known_geometry_and_no_invented_score(self):
        result = analyze(sequence([pose_frame(i / 10, i % 2 * 4) for i in range(20)]))
        self.assertAlmostEqual(result["metrics"]["hip_sway_ratio"]["value"], 0.05)
        self.assertAlmostEqual(result["metrics"]["trunk_lean_deg"]["value"], 0)
        self.assertAlmostEqual(result["metrics"]["ankle_span_ratio"]["value"], 1)
        self.assertIsNone(result["specialty_score"]["value"])
        self.assertEqual(result["specialty_score"]["status"], "unvalidated")

    def test_multi_person_frames_are_excluded_and_require_review(self):
        frames = [pose_frame(i / 10, people=2 if i % 2 else 1) for i in range(20)]
        result = analyze(sequence(frames))
        self.assertTrue(result["needs_review"])
        self.assertEqual(result["quality"]["ambiguous_frames"], 10)
        self.assertEqual(result["quality"]["usable_frames"], 10)

    def test_explicit_track_selection_excludes_other_people_and_keeps_gaps(self):
        frames=[pose_frame(i/10,people=2) for i in range(20)]
        for frame in frames:
            frame['people'][0]['track_id']=1;frame['people'][1]['track_id']=2
        frames[4]['people']=frames[4]['people'][1:]
        result=analyze(sequence(frames),target_track_id=1)
        self.assertEqual(result['quality']['usable_frames'],19)
        self.assertEqual(result['quality']['missing_frames'],1)
        self.assertEqual(result['selected_track_id'],1)
        self.assertIsNotNone(result['metrics']['ankle_span_ratio']['value'])
        self.assertTrue(result['needs_review'])
        self.assertEqual(result['method_version'],'wse-2d-track-v1')

    def test_unknown_or_duplicate_target_tracks_never_borrow_a_different_person(self):
        frames=[pose_frame(i/10,people=2) for i in range(20)]
        for frame in frames:
            for person in frame['people']:person['track_id']=2
        result=analyze(sequence(frames),target_track_id=1)
        self.assertEqual(result['quality']['usable_frames'],0)
        result=analyze(sequence(frames),target_track_id=2)
        self.assertEqual(result['quality']['ambiguous_frames'],20)

    def test_low_confidence_and_no_detections_never_make_valid_metrics(self):
        for frames in [[pose_frame(i / 10, confidence=0.1) for i in range(20)],
                       [{"t": i / 10, "people": []} for i in range(20)]]:
            result = analyze(sequence(frames))
            self.assertTrue(result["needs_review"])
            self.assertIsNone(result["metrics"]["hip_sway_ratio"]["value"])

    def test_nan_and_out_of_bounds_points_are_missing(self):
        frames = [pose_frame(i / 10) for i in range(20)]
        for frame in frames:
            frame["people"][0]["keypoints"][11] = [math.nan, 60, 1]
            frame["people"][0]["keypoints"][12] = [9000, 60, 1]
        result = analyze(sequence(frames))
        self.assertEqual(result["quality"]["usable_frames"], 0)

    def test_roi_can_exclude_other_person_but_does_not_claim_tracking(self):
        frames = [pose_frame(i / 10) for i in range(20)]
        for frame in frames:
            frame["people"].append(pose_frame(0, shift=100)["people"][0])
        result = analyze(sequence(frames), roi=[0, 0, 0.5, 1])
        self.assertFalse(result["needs_review"])
        self.assertEqual(result["quality"]["ambiguous_frames"], 0)

    def test_invalid_time_order_rejected(self):
        with self.assertRaises(ValueError):
            analyze(sequence([pose_frame(1), pose_frame(0)]))

    def test_zero_scale_does_not_divide_by_zero(self):
        frames = [pose_frame(i / 10) for i in range(20)]
        for f in frames:
            f["people"][0]["keypoints"][5:7] = copy.deepcopy(f["people"][0]["keypoints"][11:13])
        self.assertIsNone(analyze(sequence(frames))["metrics"]["hip_sway_ratio"]["value"])


if __name__ == "__main__":
    unittest.main()
