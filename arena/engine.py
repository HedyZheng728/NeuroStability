"""Experimental image-plane descriptors. Never interprets them as ability or COM."""
import math
import statistics

METHOD = "wse-2d-v1"
CORE = (5, 6, 11, 12, 15, 16)
JOINTS = {"left_knee": (11, 13, 15), "right_knee": (12, 14, 16),
          "left_elbow": (5, 7, 9), "right_elbow": (6, 8, 10)}
LIMITATIONS = [
    "实验性二维代理指标，受机位、透视、镜头移动、遮挡与动作类型影响。",
    "髋中点不是人体真实重心；图像坐标不能推断力量、真实速度或竞技能力。",
    "人物编号仅帧内有效；固定 ROI 不等于身份跟踪，必须人工复核。",
    "同一运动员的连续帧不是独立受试者；趋势不代表训练的因果效果。",
]


def valid(point, width, height):
    return (len(point) == 3 and all(isinstance(v, (int, float)) and math.isfinite(v) for v in point)
            and 0 <= point[0] < width and 0 <= point[1] < height and 0.5 <= point[2] <= 1)


def candidates(frame, width, height, roi=None):
    people = frame.get("people", [])
    if roi is None:
        return people
    x, y, w, h = roi
    chosen = []
    for person in people:
        pts = person.get("keypoints", [])
        if len(pts) != 17 or not all(valid(pts[i], width, height) for i in (11, 12)):
            continue
        cx = (pts[11][0] + pts[12][0]) / (2 * width)
        cy = (pts[11][1] + pts[12][1]) / (2 * height)
        if x <= cx <= x + w and y <= cy <= y + h:
            chosen.append(person)
    return chosen


def joint_angle(points, indices, width, height):
    if not all(valid(points[i], width, height) for i in indices):
        return None
    a, b, c = (points[i] for i in indices)
    ax, ay, cx, cy = a[0] - b[0], a[1] - b[1], c[0] - b[0], c[1] - b[1]
    ab, cb = math.hypot(ax, ay), math.hypot(cx, cy)
    if min(ab, cb) < 2:
        return None
    cosine = (ax / ab) * (cx / cb) + (ay / ab) * (cy / cb)
    return math.degrees(math.acos(max(-1, min(1, cosine))))


def track_kinematics(pose, roi=None, target_track_id=None):
    """Image-plane observations per unambiguous tracker ID; gaps are not interpolated."""
    width, height = pose["width"], pose["height"]
    by_track = {}
    for frame in pose["frames"]:
        counts = {}
        for person in frame.get("people", []):
            track_id = person.get("track_id")
            if type(track_id) is int and track_id > 0:
                counts[track_id] = counts.get(track_id, 0) + 1
        for person in candidates(frame, width, height, roi):
            track_id = person.get("track_id")
            if (type(track_id) is not int or track_id <= 0 or counts[track_id] != 1
                    or target_track_id is not None and track_id != target_track_id):
                continue
            points = person.get("keypoints", [])
            if len(points) != 17:
                continue
            angles = {name: joint_angle(points, indices, width, height) for name, indices in JOINTS.items()}
            angles["trunk_lean"] = None
            if all(valid(points[i], width, height) for i in (5, 6, 11, 12)):
                sx, sy = (points[5][0] + points[6][0]) / 2, (points[5][1] + points[6][1]) / 2
                hx, hy = (points[11][0] + points[12][0]) / 2, (points[11][1] + points[12][1]) / 2
                if math.hypot(sx - hx, sy - hy) >= 2:
                    angles["trunk_lean"] = math.degrees(math.atan2(abs(sx - hx), hy - sy))
            if any(value is not None for value in angles.values()):
                by_track.setdefault(track_id, []).append({"t": frame["t"], **angles})
    tracks = []
    for track_id, series in sorted(by_track.items()):
        summaries = {}
        for name in (*JOINTS, "trunk_lean"):
            values = [row[name] for row in series if row[name] is not None and math.isfinite(row[name])]
            summaries[name] = {"n": len(values), "min": min(values) if values else None,
                               "median": statistics.median(values) if values else None,
                               "max": max(values) if values else None}
        tracks.append({"track_id": track_id, "n_samples": len(series),
                       "first_t": series[0]["t"], "last_t": series[-1]["t"],
                       "joints": summaries, "series": series})
    return {"method_version": "joint-angles-2d-v1", "experimental": True, "unit": "deg", "tracks": tracks}


def analyze(pose, roi=None, target_track_id=None):
    if pose.get("layout") != "coco17":
        raise ValueError("需要 COCO17 关键点格式")
    width, height = pose["width"], pose["height"]
    if not width > 0 or not height > 0:
        raise ValueError("无效图像尺寸")
    if roi is not None and (len(roi) != 4 or not all(math.isfinite(v) for v in roi)
                            or min(roi) < 0 or min(roi[2:]) <= 0
                            or roi[0] + roi[2] > 1 or roi[1] + roi[3] > 1):
        raise ValueError("ROI 必须是图像内归一化的 [x,y,w,h]")
    previous, ambiguous, missing, good_points = -1, 0, 0, 0
    hips, scales, angles, spans, series = [], [], [], [], []
    frames = pose["frames"]
    for frame in frames:
        t = frame["t"]
        if not math.isfinite(t) or t < 0 or t <= previous:
            raise ValueError("时间戳须有限、非负且严格递增")
        previous = t
        people = candidates(frame, width, height, roi)
        if target_track_id is not None:
            people = [person for person in people if person.get("track_id") == target_track_id]
        if len(people) > 1:
            ambiguous += 1
            continue
        if not people:
            missing += 1
            continue
        pts = people[0].get("keypoints", [])
        if len(pts) != 17:
            missing += 1
            continue
        good_points += sum(valid(p, width, height) for p in pts)
        if not all(valid(pts[i], width, height) for i in CORE):
            missing += 1
            continue
        sx, sy = (pts[5][0] + pts[6][0]) / 2, (pts[5][1] + pts[6][1]) / 2
        hx, hy = (pts[11][0] + pts[12][0]) / 2, (pts[11][1] + pts[12][1]) / 2
        scale = math.hypot(sx - hx, sy - hy)
        if scale < 2:
            missing += 1
            continue
        angle = math.degrees(math.atan2(abs(sx - hx), hy - sy))
        span = math.dist(pts[15][:2], pts[16][:2])
        hips.append(hx)
        scales.append(scale)
        angles.append(angle)
        spans.append(span)
        series.append({"t": t, "trunk_lean_deg": angle, "hip_x_px": hx, "ankle_span_px": span})
    n, usable = len(frames), len(hips)
    sufficient = usable >= 10 and usable / max(n, 1) >= 0.6
    scale = statistics.median(scales) if scales else None
    metrics = {
        "hip_sway_ratio": {
            "label": "髋中点横向离散度", "unit": "躯干长度", "formula": "总体标准差(髋中点 x) / 中位躯干长度",
            "value": statistics.pstdev(hips) / scale if sufficient else None},
        "trunk_lean_deg": {
            "label": "平均躯干倾角", "unit": "°", "formula": "均值 atan2(|肩中点x−髋中点x|, 髋中点y−肩中点y)",
            "value": statistics.mean(angles) if sufficient else None},
        "ankle_span_ratio": {
            "label": "平均二维踝间距", "unit": "躯干长度", "formula": "均值(二维踝间距) / 中位躯干长度",
            "value": statistics.mean(spans) / scale if sufficient else None},
    }
    result = {
        "method_version": "wse-2d-track-v1" if target_track_id is not None else METHOD,
        "selected_track_id": target_track_id,
        "experimental": True, "needs_review": target_track_id is not None or ambiguous > 0 or not sufficient,
        "quality": {"total_frames": n, "usable_frames": usable, "ambiguous_frames": ambiguous,
                    "missing_frames": missing, "usable_ratio": usable / max(n, 1),
                    "keypoint_valid_ratio": good_points / max(n * 17, 1),
                    "confidence_threshold": 0.5, "minimum_usable_frames": 10, "minimum_coverage": 0.6},
        "metrics": metrics, "series": series,
        "specialty_score": {"value": None, "status": "unvalidated", "reason": "尚无实测标定、效度与重测可靠性证据，暂不评分"},
        "limitations": LIMITATIONS if target_track_id is None else [*LIMITATIONS[:2],
            "ByteTrack轨迹编号可能在遮挡处切换；目标选择须结合视频核对。", LIMITATIONS[3]],
    }
    if pose.get("backend") == "rtmpose_tracking" and pose.get("synthetic") is False:
        result["kinematics"] = track_kinematics(pose, roi, target_track_id)
    return result
