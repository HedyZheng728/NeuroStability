"""Local official SAM2.1 video inference; prompts and object IDs are not identities."""
import hashlib
import importlib.util
import json
import math
from functools import lru_cache
from pathlib import Path

from .video import frame_timestamps, sample_indices

MODEL_ID = "facebook/sam2.1-hiera-tiny"
MODEL_REVISION = "de431c4043854a71d8101e17995dfe596bf101a5"
METHOD_VERSION = "sam2.1-hiera-tiny-streaming-2hz-v1"
SAMPLE_FPS = 2
MAX_OBJECTS = 4
# Published registry metadata at the pinned revision. Config files use Git blob hashes.
MODEL_FILES = {
    "model.safetensors": (155908064, "48c14467e5cf9e51870511feb72c89688e82dd74523142c0538b663e193ac2a7"),
    "config.json": (5695, "e8fa1e6d6d31299bba32d2f5759c2d156c8a6bd1"),
    "preprocessor_config.json": (683, "8499e53cb79bf1786a890021550e6994b9808f39"),
    "processor_config.json": (95, "7556f607c3581a19f545de09d8b3fc98502b9f36"),
    "video_preprocessor_config.json": (705, "aceb9b5b612e726cea11ae4db21c0964629aac3a"),
}


def official_file_hash(path, filename):
    """Verify safetensors SHA256 or the config's official Git blob SHA1."""
    size, expected = MODEL_FILES[filename]
    if path.stat().st_size != size:
        return False
    digest = hashlib.sha256() if filename.endswith(".safetensors") else hashlib.sha1()
    if not filename.endswith(".safetensors"):
        digest.update(f"blob {size}\0".encode())
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest() == expected


@lru_cache(maxsize=4)
def _verified_manifest(folder, signature):
    root = Path(folder)
    manifest = json.loads((root / "manifest.json").read_text())
    if not isinstance(manifest, dict) or manifest.get("model_id") != MODEL_ID or manifest.get("revision") != MODEL_REVISION:
        raise ValueError("SAM2 模型来源或版本不匹配")
    if not isinstance(manifest.get("files"), dict):
        raise ValueError("SAM2 模型来源记录不完整")
    for filename in MODEL_FILES:
        path = root / filename
        record = manifest.get("files", {}).get(filename, {})
        if not isinstance(record, dict) or record.get("source_url") != f"https://huggingface.co/{MODEL_ID}/resolve/{MODEL_REVISION}/{filename}":
            raise ValueError("SAM2 模型来源记录不完整")
        if not official_file_hash(path, filename):
            raise ValueError("SAM2 模型文件不完整或校验失败")
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != record.get("sha256"):
                raise ValueError("SAM2 模型清单校验失败")
    return manifest


def verified_manifest(folder):
    root = Path(folder).resolve()
    names = ("manifest.json", *MODEL_FILES)
    signature = tuple((name, (root / name).stat().st_size, (root / name).stat().st_mtime_ns,
                       (root / name).stat().st_ctime_ns) for name in names)
    return _verified_manifest(str(root), signature)


@lru_cache(maxsize=1)
def _dependencies_usable():
    try:
        from transformers import Sam2VideoModel, Sam2VideoProcessor
        import torch
        return bool(Sam2VideoModel and Sam2VideoProcessor and torch)
    except (ImportError, OSError, RuntimeError):
        return False


def segmentation_status(settings):
    folder = getattr(settings, "sam2_path", "")
    packages = all(importlib.util.find_spec(name) for name in ("torch", "transformers", "safetensors", "cv2"))
    if not folder:
        return {"ready": False, "reason": "需要配置本地 SAM2 模型目录", "dependencies_installed": bool(packages)}
    try:
        verified_manifest(folder)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        reason = str(exc) if isinstance(exc, ValueError) else "SAM2 模型文件或来源清单不完整"
        return {"ready": False, "reason": reason, "dependencies_installed": bool(packages), "weights_installed": False}
    ready = bool(packages and _dependencies_usable())
    automatic = bool(importlib.util.find_spec("rtmlib") and getattr(settings, "detector_path", "")
                     and Path(settings.detector_path).is_file())
    return {"ready": ready, "dependencies_installed": ready, "weights_installed": True, "automatic_prompt_ready": automatic,
            "reason": ("官方 SAM2.1 tiny 本地文件已校验；2 Hz 视频分割将在任务中运行" if automatic else "SAM2 可使用；自动人物检测未配置，请指定目标区域") if ready else "需要 SAM2 Video 的 PyTorch / Transformers 依赖",
            "method_version": METHOD_VERSION, "sample_fps": SAMPLE_FPS, "max_objects": MAX_OBJECTS}


def roi_box(roi, width, height):
    if (not isinstance(roi, (list, tuple)) or len(roi) != 4 or
            not all(isinstance(v, (int, float)) and math.isfinite(v) for v in roi) or
            min(roi) < 0 or min(roi[2:]) <= 0 or roi[0] + roi[2] > 1 or roi[1] + roi[3] > 1):
        raise ValueError("目标区域须为有效的归一化 [x,y,宽,高]")
    x, y, w, h = roi
    return [float(x * width), float(y * height), float((x + w) * width), float((y + h) * height)]


def mask_polygons(mask):
    """External contours, simplified by 1.5 pixels; holes are omitted explicitly."""
    import cv2
    import numpy as np
    mask = np.asarray(mask)
    if mask.ndim != 2:
        raise ValueError("分割遮罩须为二维")
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polygons = []
    for contour in contours:
        if cv2.contourArea(contour) < 16:
            continue
        points = cv2.approxPolyDP(contour, 1.5, True).reshape(-1, 2)
        if len(points) >= 3:
            polygons.append([[float(x), float(y)] for x, y in points])
    return polygons


def sampled_frames(path):
    """Decode the entire local clip; return normalized presentation timestamps at 2 Hz."""
    import cv2
    times = frame_timestamps(path, normalize=True)
    selected = sample_indices(times, SAMPLE_FPS)
    cap = cv2.VideoCapture(str(path))
    index = 0
    try:
        while True:
            ok, image = cap.read()
            if not ok:
                break
            if index >= len(times):
                raise ValueError("视频解码帧数与时间戳不匹配")
            if index in selected:
                yield times[index], image
            index += 1
    finally:
        cap.release()
    if index != len(times):
        raise ValueError("视频解码帧数与时间戳不匹配")


class SAM2Backend:
    def __init__(self, settings):
        self.settings = settings

    def segment(self, path, metadata, progress, roi=None):
        import cv2
        import numpy as np
        import torch
        from transformers import Sam2VideoModel, Sam2VideoProcessor

        status = segmentation_status(self.settings)
        if not status["ready"]:
            raise RuntimeError(status["reason"])
        folder = Path(self.settings.sam2_path)
        manifest = verified_manifest(folder)
        width, height = int(metadata["width"]), int(metadata["height"])
        offset = float(metadata.get("time_offset", 0))
        if not math.isfinite(offset):
            raise ValueError("视频时间偏移无效")
        # Inference has no network fallback and never accepts pickle checkpoints or custom code.
        progress(30, "加载已校验的本地 SAM2.1 tiny")
        model = Sam2VideoModel.from_pretrained(str(folder), local_files_only=True, trust_remote_code=False,
                                               use_safetensors=True).to("cpu").eval()
        processor = Sam2VideoProcessor.from_pretrained(str(folder), local_files_only=True, trust_remote_code=False)
        session = processor.init_video_session(inference_device="cpu", max_vision_features_cache_size=1)
        frames, boxes, ids, detector_sha256 = [], [], [], None
        prompt_source = "normalized_roi" if roi is not None else "first_frame_yolox_person_boxes"
        for t, image in sampled_frames(path):
            if image.shape[:2] != (height, width):
                raise ValueError("分割视频尺寸与预处理元数据不符")
            if not frames:
                if roi is not None:
                    boxes = [roi_box(roi, width, height)]
                else:
                    from rtmlib import YOLOX
                    from .tracking import detect
                    detector_path = self.settings.detector_path
                    if not detector_path or not Path(detector_path).is_file():
                        raise ValueError("自动分割需要本地 YOLOX 人物检测权重；也可指定目标区域")
                    with open(detector_path, "rb") as source:
                        detector_sha256 = hashlib.file_digest(source, "sha256").hexdigest()
                    detector = YOLOX(detector_path, model_input_size=(640, 640), backend="onnxruntime", device="cpu")
                    detected, confidence = detect(detector, image)
                    order = np.argsort(-confidence)
                    boxes = [detected[i].astype(float).tolist() for i in order if confidence[i] >= .5][:MAX_OBJECTS]
                    del detector
                ids = list(range(1, len(boxes) + 1))
            record = {"t": float(t), "masks": []}
            if ids:
                inputs = processor(images=cv2.cvtColor(image, cv2.COLOR_BGR2RGB), return_tensors="pt")
                if not frames:
                    # Transformers consumes its obj_ids list while clearing newly applied prompts.
                    processor.add_inputs_to_inference_session(session, frame_idx=0, obj_ids=list(ids),
                                                              input_boxes=[boxes], original_size=(height, width))
                frame_idx = len(frames)
                with torch.inference_mode():
                    outputs = model(inference_session=session, frame_idx=frame_idx, frame=inputs.pixel_values[0])
                    masks = processor.post_process_masks([outputs.pred_masks], original_sizes=inputs.original_sizes)[0]
                for object_id, mask in zip(outputs.object_ids, masks):
                    polygons = mask_polygons(mask[0].cpu().numpy())
                    if polygons:
                        record["masks"].append({"object_id": int(object_id), "polygons": polygons})
                # Keep the original conditioning frame and all memory/pointer frames needed by SAM2.
                # Explicit frame_idx keeps streaming chronology independent of discarded decoded images.
                session.processed_frames.clear()
                keep = max(model.config.max_object_pointers_in_encoder, model.num_maskmem)
                for object_outputs in session.output_dict_per_obj.values():
                    history = object_outputs["non_cond_frame_outputs"]
                    for old in list(history):
                        if old < frame_idx - keep:
                            del history[old]
            frames.append(record)
            progress(min(85, 35 + int(t / max(float(metadata["duration"]), 1) * 50)),
                     f"SAM2.1 本地视频分割：{len(frames)} 个采样帧")
        if not frames:
            raise ValueError("预处理视频无可读取帧")
        if verified_manifest(folder) != manifest:
            raise ValueError("SAM2 模型在推理期间发生变化")
        observed = {mask["object_id"] for frame in frames for mask in frame["masks"]}
        provenance = {"model_id": MODEL_ID, "revision": MODEL_REVISION,
                      "model_sha256": manifest["files"]["model.safetensors"]["sha256"],
                      "implementation": "transformers.Sam2VideoModel", "transformers_version": __import__("transformers").__version__,
                      "device": "cpu", "prompt_source": prompt_source, "initial_boxes": boxes,
                      "detector_sha256": detector_sha256, "minimum_detection_confidence": .5,
                      "max_objects": MAX_OBJECTS, "sampling": "2 Hz across the entire clip, decoded PTS",
                      "polygon_representation": "external contours; holes omitted; 1.5 px simplification; area >=16 px²",
                      "identity_verified": False, "local_inference": True}
        summary = {"segmented_frames": sum(bool(frame["masks"]) for frame in frames),
                   "total_frames": len(frames), "object_count": len(observed), "prompted_objects": len(ids)}
        if not ids:
            summary["notice"] = "首帧未检测到置信度至少 0.5 的人物；请指定目标区域后重试"
        return {"schema_version": 1, "kind": "segmentation", "synthetic": False, "backend": "sam2",
                "method_version": METHOD_VERSION, "width": width, "height": height, "sample_fps": SAMPLE_FPS,
                "time_offset": offset, "roi": roi, "summary": summary, "provenance": provenance,
                "model_sha256": {"sam2": provenance["model_sha256"]}, "frames": frames}
