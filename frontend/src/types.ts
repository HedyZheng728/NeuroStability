import { t, localeTag } from './i18n';
import { getWorkspaceTimezone } from './planningTypes';
import type { AnalysisSummary } from './analyticsTypes';
export type Id = string;
export type TrainingCategory = 'stability' | 'footwork' | 'attack' | 'defense';
export type Category = TrainingCategory | 'mixed';
export type Backend = 'preprocess' | 'rtmpose' | 'rtmpose_tracking' | 'sam2' | 'fsw' | 'sample' | 'wham' | 'action' | 'pose3d';
export type Auth = { username: string; csrf: string; timezone?: string };
export type ModelState = { joint_observed_videos?: number; ready: boolean; reason: string; processed_jobs?: number; processed_videos?: number; track_count?: number; last_processed_at?: string | null; active_jobs?: number; segmented_frames?: number };
export type Models = Record<Exclude<Backend, 'preprocess'> | 'preprocessing' | 'llm' | 'sam2' | 'tracking', ModelState>;
export type Athlete = { id: Id; name: string; level: string; created_at: string };
export type Session = { id: Id; athlete_id: Id; athlete_name?: string; date: string; objective: string; duration_min: number; rpe: number | null; plan_id?: string | null; notes: string; created_at?: string };
export type Metric = { label: string; value: number | null; unit: string; formula?: string };
export type JointName = 'left_knee' | 'right_knee' | 'left_elbow' | 'right_elbow' | 'trunk_lean';
export type JointSummary = { n: number; min: number | null; median: number | null; max: number | null };
export type JointSample = { t: number } & Partial<Record<JointName, number | null>>;
export type JointTrack = { track_id: number; n_samples: number; first_t: number; last_t: number; joints: Record<JointName, JointSummary>; series: JointSample[] };
export type JointKinematics = { method_version: 'joint-angles-2d-v1'; experimental: true; unit: 'deg'; tracks: JointTrack[] };
export type ActionCandidate = { id: string; label: string; similarity?: number };
export type ActionWindow = { start_sec: number; end_sec: number; candidate_label?: string | null; visual_description?: string; evidence_id?: string; category_id?: string; technique_id?: string; category_ids?: string[]; wrestling_hypothesis?: { id: string; label: string; validated: false } | null; candidates: ActionCandidate[]; source_frame_times_sec: number[]; frame_pts_sec?: number[] };
export type Pose3D = { kind: 'pose3d'; synthetic: false; experimental: true; layout: 'h36m17'; coordinates: 'root_relative_model_space'; unit: 'model_units'; frames: { t: number; people: { track_id: number; joints: [number, number, number][] }[] }[]; summary?: Record<string, unknown>; provenance?: Record<string, unknown> };
export type Result = {
  kind?: string; metrics?: Record<string, Metric>; quality?: Record<string, unknown> | string;
  experimental?: boolean; synthetic?: boolean; needs_review?: boolean; limitations?: string[] | string;
  specialty_score?: { value: number | null; [key: string]: unknown };
  candidate_label?: string | null; labels?: string[]; probabilities?: number[] | Record<string, number>;
  source_pose_job_id?: string | null; candidates?: ActionCandidate[]; windows?: ActionWindow[]; provenance?: Record<string, unknown>; pose3d?: { frame_count?: number; person_observation_count?: number; track_ids?: number[]; [key: string]: unknown };
  method_version?: string;
  sample_fps?: number;
  kinematics?: JointKinematics;
  segmentation?: { segmented_frames: number; total_frames: number; object_count: number; prompted_objects?: number };
  tracking?: { track_count: number; assigned_detections: number; unassigned_detections: number; tracks: { track_id: number; start_sec: number; end_sec: number; observed_frames: number }[] };
};
export const limitationList = (value?: string[] | string): string[] => typeof value === 'string' ? [value] : value || [];
export type AssessmentDecision = 'accepted' | 'excluded' | 'superseded' | 'pending';
export type SubjectRole = 'athlete' | 'coach' | 'unknown';
export type AnalysisAssessment = { id: Id; job_id: Id; decision: AssessmentDecision; subject_role: SubjectRole; reason: string; reviewer: string; updated_at: string };
export type AssessmentHistory = { id: Id; job_id: Id; snapshot: AnalysisAssessment; created_at: string };
export type Job = {
  id: Id; video_id?: Id; backend: Backend; status: string; stage: string; progress: number;
  params?: Record<string, unknown>; error?: string | null; result: Result | null; metadata?: Record<string, unknown>; created_at?: string; assessment?: AnalysisAssessment | null;
};
export type Review = { observations: string; next_action: string; confirmed: boolean; confirmed_by?: string; updated_at: string; draft_id?: Id | null };
export type ReviewDraft = { id: Id; text: string; provider: string; model?: string; synthetic?: boolean; created_at?: string; job_id?: Id; facts?: { language_output?: { method?: string; selection?: unknown } } };
export const reviewDraftVisible = (draft: ReviewDraft) => draft.provider !== 'llm' || draft.model !== 'Qwen/Qwen2.5-1.5B-Instruct' || draft.facts?.language_output?.method === 'extractive-source-v1';
export function draftDisplayText(draft: ReviewDraft) {
  return draft.model === 'Qwen/Qwen2.5-1.5B-Instruct' && draft.facts?.language_output?.method === 'extractive-source-v1'
    && /^AI (原文参考|source reference)/.test(draft.text) && draft.text.includes('\n') ? draft.text.slice(draft.text.indexOf('\n') + 1) : draft.text;
}
export type VideoEvent = { id: Id; start_sec: number; end_sec: number; label: string; actor: 'athlete' | 'opponent' | 'unknown'; outcome: string; notes: string; source_job_id?: Id | null };
export type Video = {
  id: Id; session_id: Id; category: Category; filename: string; status: string; size_bytes: number;
  created_at: string; athlete_name?: string; session_date?: string; latest_job: Job | null; review: Review | null;
  duration_sec?: number;
  score?: { score: number; confirmed: boolean } | null;
};
export type CoachScore = { id: Id; video_id: Id; score: number; comment: string; confirmed: boolean; assessor: string; rubric_version: string; updated_at: string };
export type ScoreHistory = { id: Id; video_id: Id; snapshot: CoachScore; created_at: string };
export type Report = { video: Video; jobs: Job[]; review: Review | null; drafts: ReviewDraft[]; events: VideoEvent[]; score: CoachScore | null; score_history: ScoreHistory[] };
export type Dashboard = { athlete_count: number; session_count: number; video_count: number; pending_review_count: number; category_counts: Partial<Record<Category, number>>; recorded_minutes: number; recent_jobs: Job[]; analysis?: AnalysisSummary; review_scores?: { n: number; mean: number | null } };
export type Trend = { date: string; category: Category; job_id: Id; method_version: string; metrics: Record<string, Metric> };
export type AthleteProfile = { athlete: Athlete; sessions: Session[]; video_count: number; recorded_load: number | null; recorded_minutes: number; trends: Trend[]; analysis?: AnalysisSummary };
export type Pose = { width: number; height: number; frames: { t: number; people: { keypoints: [number, number, number][]; track_id?: number | null; bbox?: number[]; detection_confidence?: number }[] }[]; synthetic: boolean; time_offset?: number };

export type Segmentation = { width: number; height: number; sample_fps: number; frames: { t: number; masks: { object_id: number; polygons: number[][][] }[] }[] };

export const trainingCategories: Record<TrainingCategory, { name: string; description: string; number: string }> = {
  stability: { name: '稳定性', description: '支撑控制与重心稳定', number: '01' },
  footwork: { name: '步法', description: '移动、变向与步法衔接', number: '02' },
  attack: { name: '进攻', description: '进入、抱摔与技术组合', number: '03' },
  defense: { name: '防守', description: '防守反应与攻防转换', number: '04' },
};
export const categories: Record<Category, { name: string; description: string; number: string }> = {
  ...trainingCategories,
  mixed: { name: '混合训练', description: '多种训练内容', number: '05' },
};
export const backendNames: Record<Backend, string> = { preprocess: '视频预处理 · 人工复盘', rtmpose: 'RTMPose · 2D 测量', rtmpose_tracking: 'RTMPose + ByteTrack · 人物轨迹', sam2: 'SAM2 · 人物分割', fsw: 'FSW-Net · 专项识别', sample: '合成样例 · 功能验证', wham: 'WHAM · 实验性 3D', action: 'Qwen3-VL · 动作分析', pose3d: 'MotionBERT · 三维骨架' };
export const modelNames: Record<Exclude<keyof Models, 'rtmpose_tracking'>, string> = { action: backendNames.action, pose3d: backendNames.pose3d, preprocessing: '视频预处理', rtmpose: backendNames.rtmpose, fsw: backendNames.fsw, sample: backendNames.sample, wham: backendNames.wham, llm: '复盘语言模型', sam2: 'SAM2 · 人物分割', tracking: 'ByteTrack · 人物轨迹' };
export const activeJob = (job: Job) => job.status === 'queued' || job.status === 'running';
export function dateTime(value?: string) { return value ? new Date(value).toLocaleString(localeTag(), { hour12: false, timeZone: getWorkspaceTimezone() }) : '—'; }
export function fileSize(size: number) { return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`; }
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : "请求失败，请重试。"; }
