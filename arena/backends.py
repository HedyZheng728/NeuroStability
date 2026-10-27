"""Replaceable 2D backends. Model files must be installed explicitly."""
import hashlib
import importlib.util
import math
import shutil
from pathlib import Path
from typing import Protocol
from .video import frame_timestamps, sample_indices


class BackendUnavailable(RuntimeError):
    pass


class PoseBackend(Protocol):
    def extract(self, path, metadata, progress): ...


def model_status(settings):
    from .fsw import fsw_status
    from .segmentation import segmentation_status
    from .local_review import status as local_review_status
    from .vision_action import action_status
    from .pose3d import pose3d_status
    packages = all(importlib.util.find_spec(m) for m in ("rtmlib", "cv2", "onnxruntime"))
    weights = all(p and Path(p).is_file() and Path(p).suffix == ".onnx"
                  for p in (settings.detector_path, settings.pose_path))
    tracking_ready = bool(packages and weights and importlib.util.find_spec("trackers") and importlib.util.find_spec("supervision"))
    return {
        "action": action_status(settings),
        "pose3d": pose3d_status(settings),
        "rtmpose_tracking": {"ready": tracking_ready, "reason": "YOLOX / RTMPose + ByteTrack 人物轨迹" if tracking_ready else "需要RTMPose权重及trackers依赖"},
        "fsw": fsw_status(settings),
        "rtmpose": {"ready": bool(packages and weights), "dependencies_installed": bool(packages),
                    "weights_installed": bool(weights),
                    "reason": "本地 ONNX 权重已配置，加载和推理将在任务中验证" if packages and weights else
                              "未就绪：需要 rtmlib、OpenCV、ONNX Runtime 和本地 YOLOX / COCO17 RTMPose ONNX 权重"},
        "wham": {"ready": False, "reason": "WHAM 未接入：需独立环境、权重与已授权 SMPL；当前三维骨架使用 MotionBERT"},
        "sample": {"ready": settings.sample_enabled, "synthetic": True,
                   "reason": "合成关键点，仅用于验证流程，与上传视频中的动作无关"},
        "llm": local_review_status(settings) if settings.review_model_path else {"ready": bool(settings.llm_base_url and settings.llm_model and settings.llm_key),
                "model": settings.llm_model, "reason": "配置后可请求 AI 复盘草稿；仅发送去标识的测量摘要"},
        "preprocessing": {"ready": bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))},
        "sam2": segmentation_status(settings),
        "tracking": {"ready": tracking_ready, "reason": "已接入人物轨迹；轨迹编号不等同于运动员身份" if tracking_ready else "需要RTMPose权重及trackers依赖"},
    }


class SampleBackend:
    def extract(self, path, metadata, progress):
        width, height, fps = metadata["width"], metadata["height"], metadata["sample_fps"]
        frames = []
        base = [(0.5, .17), (.47, .15), (.53, .15), (.44, .17), (.56, .17),
                (.4, .3), (.6, .3), (.34, .42), (.66, .42), (.3, .52), (.7, .52),
                (.43, .58), (.57, .58), (.39, .73), (.61, .73), (.35, .9), (.65, .9)]
        for i in range(int(metadata["duration"] * fps)):
            t = i / fps
            shift = .025 * math.sin(2 * math.pi * t)
            frames.append({"t": t, "people": [{"keypoints": [[(x + shift) * width, y * height, 1] for x, y in base]}]})
        progress(85, "计算合成样例指标")
        return {"schema_version": 1, "layout": "coco17", "width": width, "height": height,
                "sample_fps": fps, "synthetic": True, "backend": "sample", "identity": "synthetic",
                "notice": "合成样例：关键点由数学函数生成，不是对视频内容的测量", "frames": frames}


class RTMPoseBackend:
    def __init__(self, settings, tracking=False):
        self.settings = settings
        self.tracking = tracking

    def extract(self, path, metadata, progress):
        import cv2
        from rtmlib import RTMPose, YOLOX
        settings = self.settings
        model_paths = (("detector", settings.detector_path), ("pose", settings.pose_path))
        fingerprints = {}
        for label, model_path in model_paths:
            with open(model_path, "rb") as f:
                fingerprints[label] = hashlib.file_digest(f, "sha256").hexdigest()
        detector = YOLOX(settings.detector_path, model_input_size=(640, 640), backend="onnxruntime", device="cpu")
        estimator = RTMPose(settings.pose_path, model_input_size=(192, 256), backend="onnxruntime", device="cpu")
        tracker = None
        if self.tracking:
            from .tracking import PersonTracker, detect
            tracker = PersonTracker(metadata["sample_fps"])
        cap = cv2.VideoCapture(str(path))
        frames, index = [], 0
        times = frame_timestamps(path)
        selected = sample_indices(times, metadata["sample_fps"])
        try:
            while True:
                ok, image = cap.read()
                if not ok:
                    break
                if index >= len(times):
                    raise ValueError("视频解码帧数与时间戳不匹配")
                if index in selected:
                    if tracker is not None:
                        boxes, detection_scores = detect(detector, image)
                        track_ids = tracker.update(boxes, detection_scores, timestamp=times[index])
                    else:
                        boxes = detector(image)
                    people = []
                    if len(boxes):
                        points, scores = estimator(image, bboxes=boxes)
                        if points.shape[1] != 17:
                            raise ValueError("RTMPose 模型必须输出 COCO17，当前权重布局不匹配")
                        for person_index, (person, confidence) in enumerate(zip(points, scores)):
                            kpts = []
                            for xy, score in zip(person, confidence):
                                p = [float(xy[0]), float(xy[1]), float(score)]
                                kpts.append(p if all(math.isfinite(v) for v in p) else [0, 0, 0])
                            record = {"keypoints": kpts}
                            if tracker is not None:
                                record.update(bbox=[float(v) for v in boxes[person_index]],
                                              detection_confidence=float(detection_scores[person_index]),
                                              track_id=track_ids[person_index])
                            people.append(record)
                    frames.append({"t": times[index], "people": people})
                    if len(frames) % 10 == 0:
                        progress(min(85, 35 + int(times[index] / max(metadata["duration"], 1) * 50)), "RTMPose 二维关键点提取")
                index += 1
        finally:
            cap.release()
        if index != len(times):
            raise ValueError("视频解码帧数与时间戳不匹配")
        if not frames:
            raise ValueError("预处理视频无可读取帧")
        for label, model_path in model_paths:
            with open(model_path, "rb") as f:
                if hashlib.file_digest(f, "sha256").hexdigest() != fingerprints[label]:
                    raise ValueError("模型权重在推理期间发生变化，停止发布结果；请等待安装完成后重试")
        return {"schema_version": 1, "layout": "coco17", "width": metadata["width"], "height": metadata["height"],
                "sample_fps": metadata["sample_fps"], "synthetic": False, "backend": "rtmpose_tracking" if self.tracking else "rtmpose",
                "identity": "tracklets_not_verified" if self.tracking else "frame_local_no_tracking",
                "tracking": tracker.provenance if tracker is not None else None,
                "model_sha256": fingerprints, "frames": frames}


def get_backend(name, settings):
    status = model_status(settings).get(name, {})
    if not status.get("ready"):
        raise BackendUnavailable(status.get("reason", "未知后端"))
    if name == "sample":
        return SampleBackend()
    if name in ("rtmpose", "rtmpose_tracking"):
        return RTMPoseBackend(settings, tracking=name == "rtmpose_tracking")
    if name == "sam2":
        from .segmentation import SAM2Backend
        return SAM2Backend(settings)
    if name == "action":
        from .vision_action import VisionActionBackend
        return VisionActionBackend(settings)
    if name == "pose3d":
        from .pose3d import Pose3DBackend
        return Pose3DBackend(settings)
    if name == "fsw":
        from .fsw import FSWBackend
        return FSWBackend(settings)
    raise BackendUnavailable("此后端尚未实现")
