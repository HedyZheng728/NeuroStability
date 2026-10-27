"""Fail-closed FSW artifact preflight; no verified trained release is available.

Integrity checks do not establish training provenance or model compatibility.
This module deliberately never deserializes a checkpoint or emits predictions.
"""
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlparse

from arena.backends import BackendUnavailable


LABELS = (
    "Hip headlock throw", "Single leg tackle", "Gut wrench / rolling side sweep",
    "Arm spin", "Side sweep and over-under", "Ankle lace", "From head and arm",
)
PREPROCESSING = {
    "num_frames": 15, "resize": [224, 224], "color": "RGB",
    "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225],
    "segmentation": "DeepLabV3+",
}
AUDIT_DATE = "2026-10-26"
SOURCE_COMMIT = "9dad3e652507e57714c60abb3a3853d000267e4c"


class _BundleError(ValueError):
    def __init__(self, code, reason):
        self.code = code
        super().__init__(reason)


def _artifact(root, spec, label):
    if not isinstance(spec, dict):
        raise _BundleError("missing_checkpoint", f"缺少 {label} 本地权重及 SHA256")
    value, digest = spec.get("path"), spec.get("sha256")
    if not isinstance(value, str) or not value or "://" in value or Path(value).is_absolute():
        raise _BundleError("invalid_bundle", f"{label} 必须使用 bundle 目录内的本地相对路径")
    path = (root / value).resolve()
    if not path.is_relative_to(root):
        raise _BundleError("invalid_bundle", f"{label} 路径超出 bundle 目录")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise _BundleError("invalid_bundle", f"{label} 必须声明小写 SHA256")
    if not path.is_file():
        raise _BundleError("missing_checkpoint", f"缺少 {label} 本地权重文件")
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != digest:
        raise _BundleError("checkpoint_mismatch", f"{label} SHA256 与 manifest 不匹配")
    return actual


def fsw_status(settings):
    """Inspect a local JSON bundle without downloads, imports or model execution.

    Every status remains blocked until a trained release has been independently
    verified, strictly loaded and exercised on an authorized real video clip.
    A self-declared ``ready``/``verified`` manifest flag cannot bypass that gate.
    """
    status = {
        "ready": False, "status": "blocked", "synthetic": False,
        "code": "missing_bundle", "audit_date": AUDIT_DATE,
        "source_commit": SOURCE_COMMIT, "artifact_hashes_match": False,
        "strict_load_verified": False, "real_clip_verified": False,
        "reason": "未就绪：尚未找到可核实的 FSW 训练权重；需本地 JSON bundle、七类映射、预处理和分割权重",
    }
    value = getattr(settings, "fsw_bundle", "")
    if not value:
        return status
    try:
        if not isinstance(value, (str, Path)) or "://" in str(value):
            raise _BundleError("invalid_bundle", "FSW bundle 必须是本地 JSON 文件；不会自动下载")
        path = Path(value).expanduser().resolve()
        if not path.is_file():
            return {**status, "reason": "未就绪：未找到本地 FSW JSON bundle"}
        if path.stat().st_size > 65536:
            raise _BundleError("invalid_bundle", "FSW manifest 超过 64 KiB")
        bundle = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(bundle, dict) or type(bundle.get("schema_version")) is not int or bundle["schema_version"] != 1:
            raise _BundleError("invalid_bundle", "FSW manifest 必须是 schema_version=1 的 JSON 对象")
        if bundle.get("architecture") != "CNN_BiLSTM" or bundle.get("training_dataset") != "Open FSW":
            raise _BundleError("invalid_bundle", "需要 FSW 训练的 CNN_BiLSTM；通用 EfficientNet 权重不能识别摔跤技术")
        labels = bundle.get("labels")
        if not isinstance(labels, list) or len(labels) != 7 or not all(isinstance(x, str) for x in labels) or set(labels) != set(LABELS):
            raise _BundleError("invalid_bundle", "必须声明 FSW 七类的完整、有序、无重复标签映射")
        if bundle.get("preprocessing") != PREPROCESSING:
            raise _BundleError("invalid_bundle", "预处理必须声明 T=15、224×224、RGB、ImageNet 归一化及 DeepLabV3+ 前景分割")
        source = bundle.get("source_url")
        if not isinstance(source, str) or urlparse(source).scheme not in ("http", "https") or not urlparse(source).netloc:
            raise _BundleError("invalid_bundle", "缺少可追溯的权重来源 source_url")
        revision = bundle.get("source_commit")
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise _BundleError("invalid_bundle", "source_commit 必须是明确的 40 位 commit，不能使用 main")
        hashes = {
            "classifier": _artifact(path.parent, bundle.get("checkpoint"), "动作分类器"),
            "segmenter": _artifact(path.parent, bundle.get("segmentation_checkpoint"), "摔跤前景分割器"),
        }
        return {**status, "code": "verification_required", "artifact_hashes_match": True,
                "model_sha256": hashes,
                "reason": "仍阻塞：本地文件哈希匹配仅证明完整性；FSW 训练来源、标签顺序、架构严格加载及真实片段 CPU 推理尚未核实"}
    except _BundleError as exc:
        return {**status, "code": exc.code, "reason": f"未就绪：{exc}"}
    except (OSError, ValueError, TypeError, RecursionError) as exc:
        return {**status, "code": "invalid_bundle", "reason": f"无法读取 FSW bundle（{type(exc).__name__}）"}


class FSWBackend:
    def __init__(self, settings):
        self.settings = settings

    def classify(self, path, metadata, progress):
        # No fallback, random head, generic pretrained model or synthetic result.
        raise BackendUnavailable(fsw_status(self.settings)["reason"])
