"""Pinned visual evidence, strict JSON grammar, timestamps and opt-in real model."""
import json
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from arena import vision_action


class VisionActionTests(unittest.TestCase):
    def test_missing_or_untrusted_bundle_never_ready(self):
        status=vision_action.action_status(SimpleNamespace(action_model_path=''))
        self.assertFalse(status['ready'])
        self.assertIsInstance(status['limitations'],list)
        self.assertTrue(status['limitations'])
        self.assertTrue(all(isinstance(item,str)and item for item in status['limitations']))
        with tempfile.TemporaryDirectory() as folder:
            for invalid in ([], {'ready':True}, {'model_id':vision_action.MODEL_ID,'revision':vision_action.MODEL_REVISION,'files':{}}):
                (Path(folder)/'manifest.json').write_text(json.dumps(invalid))
                self.assertFalse(vision_action.action_status(SimpleNamespace(action_model_path=folder))['ready'])
            p=Path(folder)/'config.json';p.write_bytes(b'0'*vision_action.MODEL_FILES['config.json'][0])
            with self.assertRaises(ValueError):vision_action.file_hash(p,'config.json')

    def test_json_schema_rejects_free_prose_scores_actors_and_invalid_techniques(self):
        valid={'categories':['wrestling_pair'],'technique':'unknown','evidence':'people_in_contact'}
        self.assertEqual(vision_action.parse_prediction(json.dumps(valid)),valid)
        for text in ('a wrestling match', '{}', '[]', json.dumps({**valid,'score':.99}),
                     json.dumps({**valid,'actor':'athlete'}), json.dumps({'categories':['other'],'technique':'single_leg_tackle','evidence':'unclear'}),
                     json.dumps({'categories':['fake'],'technique':'unknown','evidence':'unclear'}), json.dumps({'categories':['dumbbell'],'technique':1,'evidence':'weights_visible'}),
                     json.dumps({**valid,'categories':['dumbbell','dumbbell']}),json.dumps({**valid,'categories':['other','dumbbell']})):
            with self.subTest(text=text),self.assertRaises(ValueError):vision_action.parse_prediction(text)
        for text in vision_action.allowed_json():vision_action.parse_prediction(text)

    def test_token_grammar_allows_only_complete_legal_sequences(self):
        grammar=vision_action.TokenGrammar([[1,2,9],[1,3,9]],prompt_length=2)
        self.assertEqual(grammar.allowed([55,66]),[1])
        self.assertEqual(grammar.allowed([55,66,1]),[2,3])
        self.assertEqual(grammar.allowed([55,66,1,2]),[9])
        self.assertEqual(grammar.allowed([55,66,1,2,9]),[])
        with self.assertRaises(ValueError):grammar.allowed([55,66,8])

    @unittest.skipUnless(importlib.util.find_spec('torch'),'optional torch numerical guard test')
    def test_nonfinite_model_logits_are_rejected_before_any_label_is_emitted(self):
        import torch
        grammar=vision_action.TokenGrammar([[1,2,9],[1,3,9]],prompt_length=0)
        scores=torch.zeros((1,10))
        masked=grammar(torch.tensor([[1]]),scores)
        self.assertTrue(torch.isfinite(masked[0,[2,3]]).all())
        self.assertTrue(torch.isneginf(masked[0,[0,1,4,5,6,7,8,9]]).all())
        scores[0,2]=float('nan')
        with self.assertRaises(RuntimeError):grammar(torch.tensor([[1]]),scores)

    def test_sampling_has_exact_source_pts_and_prompt_has_no_review_or_file_context(self):
        from arena.action import sample_windows
        times=[4.,4.1,4.2,6.,9.,11.,14.,16.,21.]
        windows=sample_windows(times,num_frames=vision_action.NUM_FRAMES)
        self.assertEqual(len(windows[0]),8)
        self.assertEqual(windows[0][0],0)
        self.assertEqual(windows[-1][-1],len(times)-1)
        messages=vision_action.frame_messages([times[i] for i in windows[0]])
        text=json.dumps(messages)
        self.assertIn('11.000000',text)
        self.assertEqual(sum(item['type']=='image' for item in messages[0]['content']),8)
        self.assertNotIn('filename',text)
        self.assertNotIn('review',text)
        self.assertNotIn('IMG_',text)

    def test_capacity_budget_accounts_for_fp32_weight_expansion(self):
        bf16=vision_action.required_memory_bytes('bfloat16')
        fp32=vision_action.required_memory_bytes('float32')
        self.assertGreater(bf16,vision_action.MODEL_FILES['model.safetensors'][0])
        self.assertEqual(fp32-bf16,vision_action.MODEL_FILES['model.safetensors'][0])

    def test_aggregation_keeps_uncertainty_and_never_invents_numeric_scores(self):
        windows=[{'category_id':'dumbbell','aggregation_weight_sec':8.,'technique_id':'unknown'},
                 {'category_id':'rest','aggregation_weight_sec':.2,'technique_id':'unknown'}]
        result=vision_action.summarize_windows(windows)
        self.assertEqual(result['candidate_id'],'dumbbell')
        self.assertTrue(result['mixed'])
        self.assertTrue(result['requires_confirmation'])
        self.assertTrue(all(set(c)=={'id','label'}for c in result['candidates']))

    @unittest.skipUnless(os.getenv('ARENA_TEST_VISION_ACTION_VIDEO'),'explicit authorized real video and exclusive model-memory acknowledgment required')
    def test_real_local_visual_model(self):
        self.assertEqual(os.getenv('ARENA_TEST_VISION_EXCLUSIVE'),'1','root must acknowledge large-model exclusivity')
        root=Path(__file__).resolve().parents[1]
        model=os.getenv('ARENA_VISION_ACTION_MODEL_DIR',str(root/'models/vision-action'))
        result=vision_action.VisionActionBackend(SimpleNamespace(action_model_path=model)).classify(
            Path(os.environ['ARENA_TEST_VISION_ACTION_VIDEO']),{'time_offset':3.5,'review':'DO NOT USE HUMAN NOTES'},lambda *a:None)
        self.assertIsInstance(result['limitations'],list)
        self.assertTrue(all(isinstance(item,str) for item in result['limitations']))
        self.assertFalse(result['synthetic'])
        self.assertTrue(result['requires_confirmation'])
        self.assertEqual(result['provenance']['model_id'],vision_action.MODEL_ID)
        self.assertEqual(result['provenance']['device'],os.getenv('ARENA_TEST_VISION_EXPECTED_DEVICE','mps'))
        self.assertFalse(result['provenance']['human_notes_used'])
        self.assertEqual(len(result['windows'][0]['frame_pts_sec']),8)
        self.assertGreaterEqual(result['windows'][0]['source_frame_times_sec'][0],3.5)
        expected=os.getenv('ARENA_TEST_VISION_EXPECTED_CATEGORY')
        if expected:self.assertEqual(result['candidate_id'],expected)
        json.dumps(result,allow_nan=False)
