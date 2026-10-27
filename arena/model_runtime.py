"""Serialize resident language models so a model switch releases the previous cache."""
from contextlib import contextmanager
import gc
import sys
import threading

_LOCK = threading.RLock()
_owner = None
_clear = None


@contextmanager
def inference_turn(owner, clear):
    # Acquire before a backend's own lock and hold through loading and inference.
    global _owner, _clear
    with _LOCK:
        if _owner != owner:
            if _clear is not None:
                _clear()
                gc.collect()
                torch = sys.modules.get("torch")
                if torch is not None and torch.backends.mps.is_available():
                    torch.mps.empty_cache()
            _owner, _clear = owner, clear
        yield
