import type { Category, TrainingCategory } from './types';
import type { AnalysisSummary } from './analyticsTypes';

export type TrainingPlan = {
  id: string; athlete_id: string; athlete_name?: string; date: string;
  category: TrainingCategory; objective: string; planned_minutes: number;
  status: 'planned' | 'completed' | 'cancelled'; session_id: string | null; created_at: string;
};
export type PeriodFilters = { start: string; end: string; athlete_id: string };
export type Distribution = { n: number; median: number | null; q1: number | null; q3: number | null };
export type InsightsData = {
  filters: { start: string; end: string; athlete_id: string | null };
  summary: {
    session_count: number; total_minutes: number; load_au: number | null; rpe_recorded: number;
    video_count: number; reviewed_videos: number; verified_measurements: number; annotation_count: number;
  };
  planning: { due_count: number; completed_count: number; cancelled_count: number; completion_rate: number | null };
  weekly: { week_start: string; session_count: number; minutes: number; load_au: number | null; rpe_recorded: number }[];
  statistics: { duration_min: Distribution; rpe: Distribution };
  category_counts: Partial<Record<Category, number>>;
  manual_scores: Distribution & {
    mean: number | null;
    distribution: { score: number; n: number }[];
    by_category: Partial<Record<Category, { n: number; mean: number }>>;
  };
  analysis?: AnalysisSummary;
};

let workspaceTimezone = 'Asia/Shanghai';
export function setWorkspaceTimezone(timezone = 'Asia/Shanghai') {
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  workspaceTimezone = timezone;
}
export function getWorkspaceTimezone() { return workspaceTimezone; }

export function localDate(offsetDays = 0, instant = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: workspaceTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (name: string) => Number(parts.find(value => value.type === name)!.value);
  const day = new Date(Date.UTC(part('year'), part('month') - 1, part('day') + offsetDays));
  return day.toISOString().slice(0, 10);
}
