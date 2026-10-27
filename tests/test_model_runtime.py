import threading
import unittest
from arena.model_runtime import inference_turn


class ModelRuntimeTests(unittest.TestCase):
    def test_switch_clears_previous_cache_only_on_owner_change(self):
        cleared = []
        with inference_turn('runtime-test-a', lambda: cleared.append('a')):
            pass
        with inference_turn('runtime-test-a', lambda: cleared.append('a')):
            self.assertEqual(cleared, [])
        with inference_turn('runtime-test-b', lambda: cleared.append('b')):
            self.assertEqual(cleared, ['a'])

    def test_different_model_inference_is_serialized(self):
        entered = threading.Event()
        started = threading.Event()
        def other():
            started.set()
            with inference_turn('runtime-test-d', lambda: None):
                entered.set()
        with inference_turn('runtime-test-c', lambda: None):
            thread = threading.Thread(target=other)
            thread.start()
            self.assertTrue(started.wait(1))
            self.assertFalse(entered.wait(.05))
        thread.join(2)
        self.assertTrue(entered.is_set())
        self.assertFalse(thread.is_alive())

    def test_model_package_disables_racy_async_weight_loading_by_default(self):
        import os
        import subprocess
        import sys
        env={key:value for key,value in os.environ.items() if key!='HF_DEACTIVATE_ASYNC_LOAD'}
        result=subprocess.run([sys.executable,'-c','import arena, os; print(os.environ.get("HF_DEACTIVATE_ASYNC_LOAD"))'],env=env,text=True,capture_output=True,check=True)
        self.assertEqual(result.stdout.strip(),'1')
