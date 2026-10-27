import unittest
from arena.review import facts_for, rules_draft
from arena.local_review import selection_source, validate_selection, render_selection
import json


class ReviewResultTests(unittest.TestCase):
    def test_pose3d_evidence_uses_counts_without_2d_metrics(self):
        facts = facts_for({'id':'3d-job','result':{'kind':'pose3d','synthetic':False,'method_version':'motionbert-test',
            'pose3d':{'frame_count':17,'person_observation_count':30,'track_ids':[1,2],'segment_count':3},
            'limitations':['model units only']}})
        self.assertEqual(facts['summary']['frame_count'],17)
        self.assertNotIn('metrics',facts)
        self.assertIn('17',rules_draft(facts,'en'))
        self.assertIn('17',rules_draft(facts,'zh'))
        self.assertEqual(selection_source(facts)['coverage']['summary.person_observation_count'],30)
        selection=validate_selection(json.dumps({'coverage':selection_source(facts)['coverage']}),facts)
        for lang in ('zh','en'): self.assertIn('17',render_selection(facts,selection,lang))

    def test_action_evidence_does_not_invent_scores_or_fsw_model(self):
        facts = facts_for({'id':'visual-job','result':{'kind':'recognition','synthetic':False,'method_version':'vision-test',
            'candidate_label':'paired wrestling','windows':[{'candidates':[{'id':'wrestling','label':'paired wrestling'}],
            'source_frame_times_sec':[0,.1,.2]}], 'provenance':{'model':'real-visual-model'},'limitations':['candidate only']}})
        self.assertEqual(facts['summary']['window_count'],1)
        self.assertEqual(facts['summary']['sampled_frame_count'],3)
        for language in ('zh','en'):
            text=rules_draft(facts,language)
            self.assertIn('paired wrestling',text)
            self.assertNotIn('FSW-Net',text)
            self.assertNotIn('seven',text)
        self.assertNotIn('probabilities',facts)
        self.assertIn('summary.window_count',selection_source(facts)['coverage'])
        selection=validate_selection(json.dumps({'coverage':selection_source(facts)['coverage']}),facts)
        for lang in ('zh','en'): self.assertIn('3',render_selection(facts,selection,lang))
