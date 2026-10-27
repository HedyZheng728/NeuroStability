"""NeuroStability Arena."""
import os

# Concurrent safetensors materialization can deadlock its lazy dtype cache
# when different models load in API/worker threads. Use Transformers' supported
# serial weight loader; GPU inference remains unchanged.
os.environ.setdefault("HF_DEACTIVATE_ASYNC_LOAD", "1")
