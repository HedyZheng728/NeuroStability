import type { Category } from './types';

export type AnalysisSummary = {
  capabilities?: { backend: 'rtmpose_tracking' | 'sam2' | 'action' | 'pose3d'; processed_videos: number; video_count: number; first_video_id: string | null; first_job_id: string | null }[];
  video_count: number;
  analyzed_videos: number;
  status_counts: Record<'completed' | 'needs_review' | 'queued' | 'running' | 'failed' | 'blocked' | 'not_analyzed', number>;
  storage_bytes: number;
  footage_seconds: number | null;
  duration_known: number;
  duration_stats: { n: number; mean: number | null; median: number | null; q1: number | null; q3: number | null; min: number | null; max: number | null };
  duration_bins: { key: '0-10' | '10-30' | '30-60' | '60+'; count: number }[];
  frames: { total: number; usable: number; ambiguous: number; missing: number; usable_ratio: number | null };
  quality_known: number;
  quality_passed: number;
  needs_review: number;
  review_counts?: { reviewed: number; pending: number; accepted: number; excluded: number; superseded: number };
  scores: { confirmed: number; draft: number; unscored: number };
  by_session: { session_id: string; date: string; athlete_id: string; duration_min: number; video_count: number; analyzed_videos: number; review_needed: number }[];
  measurement_count: number;
  measurements: {
    video_id: string; job_id: string; filename: string; date: string; category: Category;
    method_version: string | null; quality_passed: boolean; confirmed: boolean;
    assessment_decision?: 'accepted' | 'excluded' | 'superseded' | 'pending' | null;
    target_track_id?: number | null; source_pose_job_id?: string | null;
    metrics: Record<string, { value: number; label?: string; unit?: string; formula?: string }>;
  }[];
  review_queue: { video_id: string; job_id: string; filename: string; date: string; usable_ratio: number | null; total_frames: number | null; ambiguous_frames: number | null }[];
};
