"""Observed period summaries and de-identified, traceable research exports."""
import csv
import io
import json
import math
import zipfile
from collections import defaultdict
from datetime import date, timedelta

from fastapi import HTTPException
from sqlalchemy import select

from . import db
from .config import workspace_today

CATEGORIES = ("stability", "footwork", "attack", "defense", "mixed")


def date_filters(start=None, end=None, athlete_id=None, *, today=None):
    end = end or (today if today is not None else workspace_today())
    start = start or end - timedelta(days=55)
    if start > end:
        raise HTTPException(422, "开始日期不能晚于结束日期")
    return {"start": start.isoformat(), "end": end.isoformat(), "athlete_id": athlete_id}


def read_snapshot(engine, filters):
    """Read all exported tables in one repeatable snapshot, including under SQLite WAL."""
    with engine.connect() as c:
        if engine.dialect.name == "postgresql":
            c = c.execution_options(isolation_level="REPEATABLE READ")
            c.begin()
        else:
            # Python sqlite3 legacy mode does not start a transaction for SELECT.
            c.exec_driver_sql("BEGIN")
        conditions = [db.sessions.c.date >= filters["start"], db.sessions.c.date <= filters["end"]]
        plan_conditions = [db.plans.c.date >= filters["start"], db.plans.c.date <= filters["end"]]
        if filters["athlete_id"] is not None:
            conditions.append(db.sessions.c.athlete_id == filters["athlete_id"])
            plan_conditions.append(db.plans.c.athlete_id == filters["athlete_id"])

        def rows(stmt):
            return [dict(row) for row in c.execute(stmt).mappings()]

        session_rows = rows(select(db.sessions).where(*conditions).order_by(db.sessions.c.date, db.sessions.c.id))
        plan_rows = rows(select(db.plans, db.sessions.c.date.label("session_date"))
                         .outerjoin(db.sessions, db.plans.c.session_id == db.sessions.c.id)
                         .where(*plan_conditions).order_by(db.plans.c.date, db.plans.c.id))
        video_join = db.videos.join(db.sessions, db.videos.c.session_id == db.sessions.c.id)
        video_rows = rows(select(db.videos.c.id, db.videos.c.session_id, db.videos.c.category,
                                 db.videos.c.filename, db.videos.c.size_bytes,
                                 db.sessions.c.date, db.sessions.c.athlete_id)
                          .select_from(video_join).where(*conditions).order_by(db.videos.c.id))
        job_rows = rows(select(db.jobs.c.id, db.jobs.c.video_id, db.jobs.c.backend, db.jobs.c.status,
                               db.jobs.c.params, db.jobs.c.metadata, db.jobs.c.result, db.jobs.c.created_at)
                        .select_from(video_join.join(db.jobs)).where(*conditions)
                        .order_by(db.jobs.c.created_at, db.jobs.c.id))
        assessments = rows(select(db.analysis_assessments)
                           .select_from(video_join.join(db.jobs).join(db.analysis_assessments))
                           .where(*conditions).order_by(db.analysis_assessments.c.job_id))
        current_scores = rows(select(db.manual_scores.c.video_id, db.manual_scores.c.confirmed)
                              .select_from(video_join.join(db.manual_scores)).where(*conditions)
                              .order_by(db.manual_scores.c.video_id))
        reviewed = rows(select(db.reviews.c.video_id).select_from(video_join.join(db.reviews))
                        .where(*conditions, db.reviews.c.confirmed.is_(True)))
        scores = rows(select(db.manual_scores.c.id.label("score_id"), db.manual_scores.c.video_id,
                             db.videos.c.session_id, db.sessions.c.athlete_id, db.sessions.c.date,
                             db.videos.c.category, db.manual_scores.c.rubric_version, db.manual_scores.c.score,
                             db.manual_scores.c.confirmed, db.manual_scores.c.updated_at)
                      .select_from(video_join.join(db.manual_scores))
                      .where(*conditions, db.manual_scores.c.confirmed.is_(True))
                      .order_by(db.sessions.c.date, db.manual_scores.c.video_id))
        event_rows = rows(select(db.events.c.id, db.events.c.video_id, db.videos.c.session_id,
                                db.sessions.c.athlete_id, db.sessions.c.date, db.videos.c.category,
                                db.events.c.start_sec, db.events.c.end_sec, db.events.c.label,
                                db.events.c.actor, db.events.c.outcome)
                          .select_from(video_join.join(db.events)).where(*conditions)
                          .order_by(db.sessions.c.date, db.events.c.video_id, db.events.c.start_sec, db.events.c.id))
        analyses = rows(select(db.jobs.c.id.label("job_id"), db.videos.c.id.label("video_id"),
                              db.videos.c.session_id, db.sessions.c.athlete_id, db.sessions.c.date,
                              db.videos.c.category, db.jobs.c.result, db.jobs.c.params,
                              db.drafts.c.id.label("draft_id"))
                        .select_from(video_join.join(db.reviews, db.reviews.c.video_id == db.videos.c.id)
                                     .join(db.drafts, db.drafts.c.id == db.reviews.c.draft_id)
                                     .join(db.jobs, db.jobs.c.id == db.drafts.c.job_id))
                        .where(*conditions, db.reviews.c.confirmed.is_(True), db.drafts.c.synthetic.is_(False),
                               db.drafts.c.video_id == db.videos.c.id, db.jobs.c.video_id == db.videos.c.id,
                               db.jobs.c.backend == "rtmpose", db.jobs.c.status == "completed")
                        .order_by(db.sessions.c.date, db.jobs.c.id))
        excluded = {row["job_id"] for row in assessments if row["decision"] in ("excluded", "superseded")}
        measurements = [row for row in analyses if eligible_result(row["result"]) and row["job_id"] not in excluded]
        return {"sessions": session_rows, "plans": plan_rows, "videos": video_rows,
                "reviewed": reviewed, "events": event_rows, "measurements": measurements, "scores": scores,
                "jobs": job_rows, "current_scores": current_scores, "assessments": assessments}


def eligible_result(result):
    if not isinstance(result, dict) or result.get("synthetic") is not False:
        return False
    return any(isinstance(metric, dict) and isinstance(metric.get("value"), (int, float))
               and not isinstance(metric["value"], bool) and math.isfinite(metric["value"])
               for metric in result.get("metrics", {}).values())


def statistics(values):
    values = sorted(values)
    if not values:
        return {"n": 0, "median": None, "q1": None, "q3": None}

    def quantile(p):
        index = (len(values) - 1) * p
        lower = math.floor(index)
        upper = math.ceil(index)
        return values[lower] + (values[upper] - values[lower]) * (index - lower)

    return {"n": len(values), "median": quantile(0.5), "q1": quantile(0.25), "q3": quantile(0.75)}


def load(rows):
    known = [row for row in rows if row["rpe"] is not None]
    return sum(row["duration_min"] * row["rpe"] for row in known) if known else None


def summarize(data, filters, *, today=None):
    sessions = data["sessions"]
    scores = [row["score"] for row in data["scores"]]
    score_counts = defaultdict(int)
    category_scores = defaultdict(list)
    for row in data["scores"]:
        score_counts[row["score"]] += 1
        category_scores[row["category"]].append(row["score"])
    today = today if today is not None else workspace_today()
    cutoff = min(filters["end"], today.isoformat())
    due = [plan for plan in data["plans"] if plan["date"] <= cutoff and plan["status"] != "cancelled"]
    completed = sum(plan["session_id"] is not None and plan["session_date"] is not None
                    and plan["session_date"] <= cutoff for plan in due)
    weeks = defaultdict(list)
    for row in sessions:
        day = date.fromisoformat(row["date"])
        weeks[(day - timedelta(days=day.weekday())).isoformat()].append(row)
    return {
        "filters": filters,
        "summary": {"session_count": len(sessions), "total_minutes": sum(row["duration_min"] for row in sessions),
                    "load_au": load(sessions), "rpe_recorded": sum(row["rpe"] is not None for row in sessions),
                    "video_count": len(data["videos"]), "reviewed_videos": len(data["reviewed"]),
                    "verified_measurements": len(data["measurements"]), "annotation_count": len(data["events"])},
        "planning": {"due_count": len(due), "completed_count": completed,
                     "cancelled_count": sum(plan["status"] == "cancelled" for plan in data["plans"]),
                     "completion_rate": completed / len(due) if due else None},
        "weekly": [{"week_start": week, "session_count": len(rows),
                    "minutes": sum(row["duration_min"] for row in rows), "load_au": load(rows),
                    "rpe_recorded": sum(row["rpe"] is not None for row in rows)} for week, rows in sorted(weeks.items())],
        "statistics": {"duration_min": statistics([row["duration_min"] for row in sessions]),
                       "rpe": statistics([row["rpe"] for row in sessions if row["rpe"] is not None])},
        "manual_scores": {**statistics(scores), "mean": sum(scores) / len(scores) if scores else None,
                          "distribution": [{"score": score, "n": count} for score, count in sorted(score_counts.items())],
                          "by_category": {category: {"n": len(values), "mean": sum(values) / len(values)}
                                          for category, values in sorted(category_scores.items())}},
        "category_counts": {category: sum(row["category"] == category for row in data["videos"]) for category in CATEGORIES},
    }


# Explicit allowlists keep names, notes, source paths, identities and auth outside exports.
COLUMNS = {
    "sessions": {
        "session_id": "Recorded session UUID", "athlete_id": "Athlete UUID; pseudonymous, linkable identifier",
        "date": "Training date, YYYY-MM-DD", "duration_min": "Self-recorded duration, minutes",
        "rpe": "Self-recorded perceived exertion, 0..10; blank if missing",
        "load_au": "duration_min * rpe, arbitrary units; blank when RPE is missing",
    },
    "plans": {
        "plan_id": "Training plan UUID", "athlete_id": "Athlete UUID", "date": "Planned date, YYYY-MM-DD",
        "category": "stability | footwork | attack | defense", "planned_minutes": "Planned duration, minutes",
        "status": "planned | cancelled | completed; completed requires a linked recorded session",
        "session_id": "Linked recorded session UUID, blank if unlinked", "session_date": "Linked session training date",
    },
    "metrics": {
        "athlete_id": "Athlete UUID", "session_id": "Recorded session UUID", "date": "Session training date",
        "video_id": "Source video UUID; source media excluded", "category": "Video training category",
        "job_id": "Confirmed completed real RTMPose analysis UUID", "draft_id": "Confirmed review draft UUID",
        "method_version": "Version of measurement method", "sample_fps": "Analysis sampling rate, frames/second",
        "roi_json": "Normalized region of interest [x,y,width,height], or null",
        "start_sec": "Analysis clip start on original video timeline, seconds",
        "end_sec": "Analysis clip end on original video timeline, seconds; blank when not specified",
        "metric": "Measurement identifier", "value": "Observed numeric value; blank if missing",
        "unit": "Measurement unit from analysis", "formula": "Measurement formula from method",
        "quality_json": "Analysis quality counters, confidence threshold and eligibility thresholds",
        "model_sha256_json": "Model artifact SHA-256 provenance",
    },
    "events": {
        "event_id": "Manual annotation UUID", "video_id": "Source video UUID", "session_id": "Recorded session UUID",
        "athlete_id": "Athlete UUID", "date": "Session training date", "category": "Video training category",
        "start_sec": "Start on original video timeline, seconds", "end_sec": "End on original video timeline, seconds",
        "label": "User-recorded event label", "actor": "athlete | opponent | unknown",
        "outcome": "User-recorded outcome; no automated classification implied",
    },
    "scores": {
        "score_id": "Current training review score UUID", "video_id": "Source video UUID",
        "session_id": "Recorded session UUID", "athlete_id": "Athlete UUID", "date": "Session training date",
        "category": "Video training category", "rubric_version": "Stored scoring method version; historical versions retained",
        "score": "Subjective training video review score, 0..10 points; not a validated ability measure or competition score",
        "confirmed": "Review approved current score; only approved scores with a comment are exported",
        "updated_at": "Current score save timestamp, ISO 8601 UTC",
    },
}


def csv_value(value):
    if value is None:
        return ""
    if isinstance(value, str) and (value.startswith(("\t", "\r", "\n")) or value.lstrip().startswith(("=", "+", "-", "@"))):
        return "'" + value
    return value


def export_zip(data, filters, *, today=None, timezone_name="Asia/Shanghai"):
    today = today if today is not None else workspace_today(timezone_name)
    exported = {name: [] for name in COLUMNS}
    for row in data["sessions"]:
        exported["sessions"].append({"session_id": row["id"], "athlete_id": row["athlete_id"], "date": row["date"],
                    "duration_min": row["duration_min"], "rpe": row["rpe"],
                    "load_au": row["duration_min"] * row["rpe"] if row["rpe"] is not None else None})
    for row in data["plans"]:
        exported["plans"].append({"plan_id": row["id"], **{key: row[key] for key in
                    ("athlete_id", "date", "category", "planned_minutes", "session_id", "session_date")},
                    "status": "completed" if row["session_id"] is not None else row["status"]})
    for row in data["events"]:
        exported["events"].append({"event_id": row["id"], **{key: row[key] for key in COLUMNS["events"] if key != "event_id"}})
    exported["scores"] = [{key: row[key] for key in COLUMNS["scores"]} for row in data["scores"]]
    for row in data["measurements"]:
        result = row["result"]
        for name, metric in result["metrics"].items():
            exported["metrics"].append({**{key: row[key] for key in
                        ("athlete_id", "session_id", "date", "video_id", "category", "job_id", "draft_id")},
                        "method_version": result.get("method_version"), "sample_fps": result.get("sample_fps"),
                        "roi_json": json.dumps(result.get("roi")), "start_sec": row["params"].get("start_sec", 0),
                        "end_sec": row["params"].get("end_sec"), "metric": name, "value": metric.get("value"),
                        "unit": metric.get("unit"), "formula": metric.get("formula"),
                        "quality_json": json.dumps(result.get("quality", {}), ensure_ascii=False, sort_keys=True),
                        "model_sha256_json": json.dumps(result.get("model_sha256", {}), sort_keys=True)})
    manifest = {
        "schema_version": 2, "exported_at": db.now(), "filters": filters,
        "timezone": timezone_name, "as_of_date": today.isoformat(),
        "completion_cutoff_date": min(filters["end"], today.isoformat()),
        "counts": {name: len(rows) for name, rows in exported.items()},
        "summary": summarize(data, filters, today=today),
        "selection": "Sessions, videos, metrics, events and scores use session training date; plans use planned date. Bounds are inclusive.",
        "missing_values": "CSV blank fields represent missing values, never zero. JSON null represents missing values.",
        "measurement_eligibility": "Confirmed review linked to a non-synthetic draft and completed RTMPose job, real result, at least one finite numeric metric. All metrics of that eligible result are retained, including nulls.",
        "manual_scoring": {"rubric_version": db.MANUAL_SCORE_RUBRIC, "source": "training video review",
                           "range": [0, 10], "unit": "points",
                           "eligibility": "Current approved scores only; comment required. Scores are subjective training clip reviews, not a validated ability measure or competition score.",
                           "statistics": "Each eligible video contributes its current score once; arithmetic mean and Type 7 quantiles."},
        "formulas": {
            "load_au": "sum(duration_min * rpe) over sessions with recorded RPE; null when none are recorded",
            "rpe_recorded": "count of sessions with non-null RPE, including zero",
            "completion_rate": "completed_count / due_count; null when due_count is zero",
            "due_count": "non-cancelled plans in the requested date range due on/before min(end,as_of_date), using workspace timezone",
            "completed_count": "due plans linked to an actual session dated on/before completion_cutoff_date",
            "quantiles": "Type 7: h=(n-1)*p, interpolate sorted observations at floor(h) and ceil(h); n=0 null, n=1 observation",
            "weeks": "Monday start; observed sessions only, no fabricated empty weeks",
            "hip_sway_ratio": "population standard deviation of hip midpoint x / median torso length",
            "trunk_lean_deg": "mean atan2(abs(shoulder midpoint x - hip midpoint x), hip midpoint y - shoulder midpoint y), degrees",
            "ankle_span_ratio": "mean two-dimensional ankle distance / median torso length",
        },
        "privacy": "Athlete names, objectives, notes, reviewer identities, score comments, assessors, media, storage paths and authentication data excluded. UUIDs remain linkable; this is pseudonymous data.",
        "csv_safety": "Apostrophe prefix escapes formula-like strings. Numeric values remain numeric.",
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, rows in exported.items():
            stream = io.StringIO(newline="")
            writer = csv.DictWriter(stream, fieldnames=COLUMNS[name])
            writer.writeheader()
            writer.writerows({key: csv_value(row.get(key)) for key in COLUMNS[name]} for row in rows)
            archive.writestr(name + ".csv", stream.getvalue())
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False))
        archive.writestr("data_dictionary.json", json.dumps({"columns": {name + ".csv": columns for name, columns in COLUMNS.items()},
                          "encoding": "UTF-8", "delimiter": ",", "date_format": "YYYY-MM-DD",
                          "measurement_units": "Each metric carries its stored unit; ratios use image-plane torso length, not physical distance.",
                          "limits": "Self-recorded load and experimental image-plane metrics do not establish ability, health or causal improvement."},
                          ensure_ascii=False, indent=2))
    return output.getvalue()
