"""Observed real RTMPose attempts; descriptors remain experimental, never ability scores."""
import csv
import io
import json
import math

from .planning import csv_value, statistics

METRICS = ("hip_sway_ratio", "trunk_lean_deg", "ankle_span_ratio")
STATUSES = ("completed", "needs_review", "queued", "running", "failed", "blocked", "not_analyzed")
TERMINAL_ANALYSES = ("completed", "needs_review")
POSE_BACKENDS = ("rtmpose", "rtmpose_tracking")
FRAME_FIELDS = ("total_frames", "usable_frames", "ambiguous_frames", "missing_frames")


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def count(value):
    return finite(value) and value >= 0 and value == int(value)


def mapping(value):
    return value if isinstance(value, dict) else {}


def job_order(job):
    return (job["created_at"], job["id"])


def select_jobs(data, *, terminal_only=False):
    """Deduplicate attempts and full-source metadata independently, deterministically."""
    videos = {row["id"] for row in data["videos"]}
    latest, durations = {}, {}
    for job in sorted(data.get("jobs", []), key=job_order):
        video_id = job["video_id"]
        if video_id not in videos or job["backend"] == "sample" or mapping(job.get("result")).get("synthetic") is True:
            continue
        duration = mapping(job.get("metadata")).get("source_duration")
        if finite(duration) and duration > 0:
            durations[video_id] = duration
        if job["backend"] in POSE_BACKENDS and (not terminal_only or analyzed_result(job)):
            latest[video_id] = job
    return latest, durations


def analyzed_result(job):
    result = mapping(job.get("result"))
    return result if job["status"] in TERMINAL_ANALYSES and result.get("synthetic") is False else {}


def quality(result):
    """Only a complete nonnegative integer partition can define frame coverage."""
    stored = mapping(result.get("quality"))
    values = [stored.get(name) for name in FRAME_FIELDS]
    if not all(count(value) for value in values) or values[0] != sum(values[1:]):
        return None, False
    total, usable, ambiguous, missing = (int(value) for value in values)
    ratio = usable / total if total else None
    minimum = stored.get("minimum_usable_frames", 10)
    coverage = stored.get("minimum_coverage", 0.6)
    passed = (count(minimum) and finite(coverage) and 0 <= coverage <= 1 and ratio is not None
              and usable >= minimum and ratio >= coverage and ambiguous == 0
              and result.get("needs_review") is not True)
    return dict(zip(FRAME_FIELDS, (total, usable, ambiguous, missing)), usable_ratio=ratio), bool(passed)


def metric_values(result):
    metrics = mapping(result.get("metrics"))
    return {name: {key: value for key, value in metrics[name].items() if key in ("value", "unit", "label", "formula")}
            for name in METRICS if isinstance(metrics.get(name), dict) and finite(metrics[name].get("value"))}


def acceptance_error(job, subject_role):
    """Technical acceptance keeps experimental descriptors separate from scientific validation."""
    result = mapping(job.get("result"))
    if subject_role != "athlete":
        return "接受分析须明确确认目标为运动员"
    if job["backend"] in POSE_BACKENDS:
        counters, _ = quality(result)
        if (not metric_values(result) or counters is None or counters["usable_frames"] < 10
                or counters["usable_ratio"] is None or counters["usable_ratio"] < 0.6
                or counters["ambiguous_frames"] != 0):
            return "姿态分析须有有限实测指标、至少10个可用帧、覆盖率至少60%，且无歧义帧"
    elif job["backend"] == "sam2":
        summary = mapping(result.get("segmentation"))
        total, segmented, objects = (summary.get(key) for key in ("total_frames", "segmented_frames", "object_count"))
        prompted = summary.get("prompted_objects")
        if (result.get("kind") != "segmentation" or not all(count(value) for value in (total, segmented, objects))
                or not 0 < segmented <= total or objects <= 0
                or prompted is not None and (not count(prompted) or objects > prompted)):
            return "人物分割须有非零且一致的分割帧数和目标数"
    return None


def provenance(job, result):
    params = mapping(job.get("params"))
    target = result.get("selected_track_id", result.get("target_track_id", params.get("target_track_id")))
    source = result.get("source_pose_job_id", params.get("source_pose_job_id"))
    return {"target_track_id": int(target) if count(target) and 1 <= target <= 100000 else None,
            "source_pose_job_id": source if isinstance(source, str) and 0 < len(source) <= 36 else None}


def summarize(data):
    latest, durations = select_jobs(data)
    review_latest, _ = select_jobs(data, terminal_only=True)
    assessments = {row["job_id"]: row for row in data.get("assessments", [])}
    review_counts = dict.fromkeys(("reviewed", "pending", "accepted", "excluded", "superseded"), 0)
    status_counts = dict.fromkeys(STATUSES, 0)
    frames = dict.fromkeys(("total", "usable", "ambiguous", "missing"), 0)
    by_session = {row["id"]: {"session_id": row["id"], "date": row["date"], "athlete_id": row["athlete_id"],
                  "duration_min": row["duration_min"], "video_count": 0, "analyzed_videos": 0, "review_needed": 0}
                  for row in data["sessions"]}
    # Confirmation belongs to this exact eligible job, never a newer attempt on the same video.
    confirmed = {row["job_id"] for row in data["measurements"]}
    scores = {row["video_id"]: row["confirmed"] for row in data.get("current_scores", [])}
    score_counts = dict.fromkeys(("confirmed", "draft", "unscored"), 0)
    measurements, review_queue = [], []
    analyzed = known = passed = 0
    for video in data["videos"]:
        session = by_session[video["session_id"]]
        session["video_count"] += 1
        score_counts["confirmed" if scores.get(video["id"]) is True else
                     "draft" if video["id"] in scores else "unscored"] += 1
        review_job = review_latest.get(video["id"])
        if review_job:
            decision = assessments.get(review_job["id"], {}).get("decision", "pending")
            if decision in ("accepted", "excluded", "superseded"):
                review_counts["reviewed"] += 1
                review_counts[decision] += 1
            else:
                review_counts["pending"] += 1
                session["review_needed"] += 1
                counters, _ = quality(analyzed_result(review_job))
                review_queue.append({"video_id": video["id"], "job_id": review_job["id"], "filename": video["filename"],
                                     "date": video["date"], "usable_ratio": counters["usable_ratio"] if counters else None,
                                     "total_frames": counters["total_frames"] if counters else None,
                                     "ambiguous_frames": counters["ambiguous_frames"] if counters else None})
        job = latest.get(video["id"])
        status = job["status"] if job else "not_analyzed"
        status_counts[status if status in status_counts else "not_analyzed"] += 1
        if not job:
            continue
        result = analyzed_result(job)
        if not result:
            continue
        analyzed += 1
        session["analyzed_videos"] += 1
        counters, quality_passed = quality(result)
        if counters is not None:
            known += 1
            passed += quality_passed
            for key, field in zip(frames, FRAME_FIELDS):
                frames[key] += counters[field]
        source = {"video_id": video["id"], "job_id": job["id"], "filename": video["filename"], "date": video["date"]}
        metrics = metric_values(result)
        decision = assessments.get(job["id"], {}).get("decision")
        if metrics and decision not in ("excluded", "superseded"):
            measurements.append({**source, "category": video["category"], "method_version": result.get("method_version"),
                                 "quality_passed": quality_passed, "confirmed": job["id"] in confirmed, "metrics": metrics,
                                 "assessment_decision": decision, **provenance(job, result)})
    frames["usable_ratio"] = frames["usable"] / frames["total"] if frames["total"] else None
    times = list(durations.values())
    duration_stats = {**statistics(times), "mean": sum(times) / len(times) if times else None,
                      "min": min(times) if times else None, "max": max(times) if times else None}
    bins = [{"key": key, "count": 0} for key in ("0-10", "10-30", "30-60", "60+")]
    for seconds in times:
        bins[0 if seconds <= 10 else 1 if seconds <= 30 else 2 if seconds <= 60 else 3]["count"] += 1
    measurements.sort(key=lambda row: (not row["quality_passed"], row["date"], row["video_id"], row["job_id"]))
    review_queue.sort(key=lambda row: (row["date"], row["video_id"], row["job_id"]))
    capabilities = []
    video_ids = {video["id"] for video in data["videos"]}
    ordered_jobs = sorted(data.get("jobs", []), key=job_order)
    for backend, kind, summary_key, field in (
            ("rtmpose_tracking", "pose", "tracking", "track_count"),
            ("sam2", "segmentation", "segmentation", "segmented_frames"),
            ("action", "recognition", None, None),
            ("pose3d", "pose3d", "pose3d", "frame_count")):
        produced = {}
        for job in ordered_jobs:
            if job["backend"] != backend or job["video_id"] not in video_ids:
                continue
            result = analyzed_result(job)
            if result.get("kind") != kind:
                continue
            if backend == "action":
                windows = result.get("windows")
                available = isinstance(windows, list) and bool(windows)
            else:
                value = mapping(result.get(summary_key)).get(field)
                available = count(value) and value > 0
            if available:
                produced[job["video_id"]] = job["id"]
        first = min(produced, default=None)
        capabilities.append({"backend": backend, "processed_videos": len(produced), "video_count": len(video_ids),
                             "first_video_id": first, "first_job_id": produced.get(first)})
    return {"video_count": len(data["videos"]), "analyzed_videos": analyzed, "status_counts": status_counts,
            "storage_bytes": sum(row["size_bytes"] for row in data["videos"]),
            "footage_seconds": sum(times) if times else None, "duration_known": len(times), "duration_stats": duration_stats,
            "duration_bins": bins, "frames": frames, "quality_known": known, "quality_passed": passed,
            "needs_review": review_counts["pending"], "review_counts": review_counts, "scores": score_counts,
            "by_session": sorted(by_session.values(), key=lambda row: (row["date"], row["session_id"])),
            "measurement_count": len(measurements), "measurements": measurements[:12], "review_queue": review_queue[:6],
            "capabilities": capabilities}


CSV_COLUMNS = ("athlete_id", "session_id", "date", "video_id", "category", "job_id", "backend", "status", "created_at",
               "experimental", "confirmed", "assessment_decision", "target_track_id", "source_pose_job_id",
               "method_version", "sample_fps", "roi_json", "start_sec", "end_sec",
               "source_duration", "quality_known", "quality_passed", *FRAME_FIELDS, "usable_ratio", "confidence_threshold",
               "minimum_usable_frames", "minimum_coverage", "model_sha256_json", *METRICS)


def export_csv(data):
    """Allowlisted pseudonymous attempts, including unknown/failed results as blank cells."""
    latest, durations = select_jobs(data)
    confirmed = {row["job_id"] for row in data["measurements"]}
    assessments = {row["job_id"]: row for row in data.get("assessments", [])}
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=CSV_COLUMNS)
    writer.writeheader()
    for video in sorted(data["videos"], key=lambda row: (row["date"], row["id"])):
        job = latest.get(video["id"])
        if not job:
            continue
        result = analyzed_result(job)
        params = mapping(job.get("params"))
        counters, passed = quality(result)
        stored_quality = mapping(result.get("quality"))
        metrics = metric_values(result)
        row = {**{key: video[key] for key in ("athlete_id", "session_id", "date", "category")},
               "video_id": video["id"], "job_id": job["id"], **{key: job[key] for key in ("backend", "status", "created_at")},
               "experimental": True, "confirmed": job["id"] in confirmed, "method_version": result.get("method_version"),
               "assessment_decision": assessments.get(job["id"], {}).get("decision"), **provenance(job, result),
               "source_duration": durations.get(video["id"]), "quality_known": counters is not None,
               "quality_passed": passed if counters is not None else None, **(counters or {}),
               **{name: metrics.get(name, {}).get("value") for name in METRICS}}
        for field in ("sample_fps",):
            value = result.get(field)
            row[field] = value if finite(value) and value >= 0 else None
        for field in ("start_sec", "end_sec"):
            value = params.get(field)
            row[field] = value if finite(value) and value >= 0 else None
        for field in ("confidence_threshold", "minimum_usable_frames", "minimum_coverage"):
            value = stored_quality.get(field)
            row[field] = value if finite(value) and value >= 0 else None
        roi = result.get("roi", params.get("roi"))
        if isinstance(roi, list) and len(roi) == 4 and all(finite(value) for value in roi):
            row["roi_json"] = json.dumps(roi)
        hashes = {key: value for key, value in mapping(result.get("model_sha256")).items()
                  if key in ("detector", "pose") and isinstance(value, str) and len(value) == 64
                  and all(char in "0123456789abcdefABCDEF" for char in value)}
        if hashes:
            row["model_sha256_json"] = json.dumps(hashes, sort_keys=True)
        writer.writerow({key: csv_value(row.get(key)) for key in CSV_COLUMNS})
    return stream.getvalue().encode("utf-8")
