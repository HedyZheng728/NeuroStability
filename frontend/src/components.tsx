import { t, tx } from './i18n';
import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
import { errorMessage, type Job } from './types';

export type Notify = (message: string, kind?: 'success' | 'error') => void;
export function useData<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    loader().then(value => { if (alive) setData(value); }).catch(err => { if (alive) setError(errorMessage(err)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // Callers declare the values that change their request; loader identities are intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision]);
  return { data, setData, error, loading, reload: () => setRevision(value => value + 1) };
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><span className="empty-mark" aria-hidden="true"><Icon name="layers" /></span><h3>{title}</h3>{children ? <p>{children}</p> : null}{action}</div>;
}
export function LoadState({ loading, error, retry }: { loading: boolean; error: string; retry: () => void }) {
  if (error) return <div className="notice error" role="alert"><span>{t(error)}</span><button className="button small secondary" onClick={retry}>{t("重新加载")}</button></div>;
  return loading ? <div className="loading" role="status"><span className="spinner" />{t("正在加载真实记录…")}</div> : null;
}
const statuses: Record<string, [string, string]> = {
  queued: ['排队中', 'neutral'], running: ['分析中', 'info'], completed: ['分析完成', 'success'],
  needs_review: ['数据待核查', 'warning'], blocked: ['模型未就绪', 'warning'], failed: ['分析失败', 'danger'],
  uploaded: ['已上传', 'neutral'], ready: ['已就绪', 'success'], processing: ['处理中', 'info'],
};
export function Status({ value }: { value: string }) {
  const [label, tone] = statuses[value] || [value || t("待分析"), 'neutral'];
  return <span className={`status ${tone}`}><i />{t(label)}</span>;
}
export function JobStatus({ job, showAssessment = true }: { job: Job; showAssessment?: boolean }) {
  if (!showAssessment && job.backend === 'action' && job.result?.kind === 'recognition' && job.result.synthetic === false && job.result.windows?.length && (job.status === 'completed' || job.status === 'needs_review'))
    return <span className="status neutral"><i />{tx('Action candidates ready', '动作候选已生成')}</span>;
  if (!showAssessment && job.backend === 'rtmpose_tracking' && job.result?.kinematics?.tracks.length && (job.status === 'completed' || job.status === 'needs_review'))
    return <span className="status neutral"><i />{tx('Track data ready', '轨迹已生成')}</span>;
  if (job.status === 'completed' || job.status === 'needs_review') {
    const decision = job.assessment?.decision;
    if (decision === 'accepted') return <span className="status success"><i />{tx('Reviewed · experimental', '已核查·实验性')}</span>;
    if (decision === 'excluded') return <span className="status neutral"><i />{tx('Not adopted', '本次不采纳')}</span>;
    if (decision === 'superseded') return <span className="status neutral"><i />{tx('Superseded', '已有后续分析')}</span>;
    if (decision === 'pending') return <Status value="needs_review" />;
  }
  return <Status value={job.status} />;
}
export function Synthetic({ value }: { value?: boolean }) { return value ? <span className="synthetic">{t("合成样例 · 非真实成绩")}</span> : null; }
export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1>{description ? <p>{t(description)}</p> : null}</div>{action}</div>;
}
export function Panel({ title, description, action, children, className = '' }: { title?: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{title ? <div className="panel-heading"><div><h2>{t(title)}</h2>{description ? <p>{t(description)}</p> : null}</div>{action}</div> : null}{children}</section>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const control = isValidElement<{ 'aria-label'?: string }>(children) && typeof children.type === 'string' && ['input', 'select', 'textarea'].includes(children.type)
    ? cloneElement(children, { 'aria-label': label }) : children;
  return <label className="field"><span>{label}</span>{control}{hint ? <small>{hint}</small> : null}</label>;
}
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    users: <><path d="M15 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /><circle cx="8" cy="7" r="4" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2" /></>,
    video: <><rect x="3" y="5" width="13" height="14" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5" /></>,
    model: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5M18 9h5m-5 6h5M10 10h4v4h-4z" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    logout: <><path d="M9 21H4V3h5M14 7l5 5-5 5M8 12h13" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M3 6h18M3 12h18M3 18h18" />,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M3 17v4h18v-4" /></>,
    back: <path d="M19 12H5m6-6-6 6 6 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
    activity: <><path d="M2 12h4l3-8 5 16 3-8h5" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    footwork: <><path d="M7 3v6l3 3v4H4v-4L2 9V5l5-2ZM17 8v6l3 3v4h-6v-4l-2-3v-4l5-2Z" /></>,
    attack: <><path d="m4 20 8-8m2-2 6-6M13 4h7v7M4 4l5 5M4 11V4h7" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.layers}</svg>;
}
