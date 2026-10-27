"""Real ByteTrack association and scored detector output contracts."""
import unittest
import importlib.util
OPTIONAL_READY = all(importlib.util.find_spec(name) for name in ("numpy", "trackers", "rtmlib"))
if OPTIONAL_READY:
    import numpy as np
    from arena import tracking


@unittest.skipUnless(OPTIONAL_READY, "install requirements-models.txt for ByteTrack tests")
class TrackingTests(unittest.TestCase):
    def test_scored_detections_keep_confidence_and_reject_invalid_boxes(self):
        raw = np.array([[[10, 20, 50, 80, .9], [11, 21, 51, 81, .7],
                         [100, 50, 140, 110, .25], [20, 30, 10, 50, .95],
                         [1, 2, 5, 8, float('nan')]]], dtype=np.float32)
        boxes, scores = tracking.decode_detections(raw, ratio=.5, input_size=(640, 640), width=400, height=300)
        self.assertEqual(boxes.shape, (2, 4))
        np.testing.assert_allclose(scores, [.9, .25], atol=1e-6)
        np.testing.assert_allclose(boxes, [[20,40,100,160], [200,100,280,220]])
        self.assertTrue(np.isfinite(boxes).all())

    def test_non_person_class_is_not_tracked(self):
        raw=np.array([[[1,2,50,80,.9],[70,2,100,80,.95]]],dtype=np.float32)
        boxes,scores=tracking.decode_detections(raw,ratio=1,input_size=(640,640),width=200,height=100,labels=[[0,1]])
        self.assertEqual(len(boxes),1)
        self.assertAlmostEqual(float(scores[0]),.9,places=5)

    def test_raw_yolox_scores_are_objectness_times_person_class(self):
        raw = np.zeros((1, 21, 6), dtype=np.float32)  # 32px grid:16+4+1 cells
        raw[0, 0] = [1, 1, 0, 0, .8, .5]
        boxes, scores = tracking.decode_detections(raw, ratio=1, input_size=(32,32), width=32, height=32)
        self.assertEqual(boxes.shape, (1,4))
        self.assertAlmostEqual(float(scores[0]), .4, places=5)

    def test_two_people_keep_ids_when_detection_order_changes(self):
        tracker = tracking.PersonTracker(10)
        a, b = [10,10,40,90], [110,10,140,90]
        for _ in range(4): ids = tracker.update([a,b], [.95,.91])
        self.assertTrue(all(isinstance(i,int) and i>0 for i in ids))
        self.assertNotEqual(ids[0],ids[1])
        swapped = tracker.update([b,a], [.92,.96])
        self.assertEqual(swapped, [ids[1],ids[0]])
        self.assertEqual(tracker.update([a,b], [.2,.91]), ids)
        self.assertEqual(tracker.update([],[]), [])

    def test_long_real_pts_gap_expires_old_id_instead_of_joining_people(self):
        tracker=tracking.PersonTracker(10)
        for t in [0,.1,.2]: previous=tracker.update([[10,10,40,90]],[.9],timestamp=t)
        after=tracker.update([[10,10,40,90]],[.9],timestamp=20)
        self.assertNotEqual(after,previous)
        after=tracker.update([[10,10,40,90]],[.9],timestamp=20.1)
        self.assertNotEqual(after,previous)
        self.assertEqual(tracker.provenance['timestamp_source'],'normalized_video_pts_seconds')

    def test_unmatched_detection_is_not_given_another_person_id(self):
        tracker = tracking.PersonTracker(10)
        for _ in range(4): previous = tracker.update([[10,10,40,90]],[.9])
        value = tracker.update([[500,10,530,90]],[.2])
        self.assertEqual(value,[None])
        self.assertEqual(previous,[1])

    def test_track_summary_keeps_gaps_and_unassigned_detections(self):
        pose={'frames':[{'t':0,'people':[{'track_id':1,'detection_confidence':.9}, {'track_id':None}]},
                        {'t':.1,'people':[]}, {'t':.2,'people':[{'track_id':1,'detection_confidence':.8}]}]}
        result=tracking.summarize(pose)
        self.assertEqual(result['track_count'],1)
        self.assertEqual(result['assigned_detections'],2)
        self.assertEqual(result['unassigned_detections'],1)
        self.assertEqual(result['tracks'][0]['observed_frames'],2)
        self.assertEqual(result['tracks'][0]['start_sec'],0)
        self.assertEqual(result['tracks'][0]['end_sec'],.2)
        self.assertFalse(result['identity_verified'])

if __name__=='__main__':unittest.main()
