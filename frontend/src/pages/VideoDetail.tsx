import { t, tx, qualityText, getLocale } from '../i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { api, navigate, post, put } from '../api';
import { Empty, Field, Icon, JobStatus, LoadState, PageHeader, Panel, Synthetic, useData, type Notify } from '../components';
import { activeJob, backendNames, categories, dateTime, errorMessage, fileSize, reviewDraftVisible, draftDisplayText, limitationList, type Backend, type CoachScore, type Job, type Models, type Report, type ReviewDraft, type Video, type VideoEvent } from '../types';
import PosePlayer from '../PosePlayer';
import Pose3DPlayer from '../Pose3DPlayer';
import ActionCandidates from './ActionCandidates';
import ReviewPanel from './ReviewPanel';
import EventsPanel from './EventsPanel';
import AnalysisAssessment from './AnalysisAssessment';
import JointObservations from './JointObservations';
import './CoachWorkspace.css';

type Capability = 'original' | 'pose' | 'tracking' | 'masks' | 'review' | 'techniques' | '3d';
const capabilities: Capability[] = ['original', 'pose', 'tracking', 'masks', 'review', 'techniques', '3d'];
const capabilityBackends: Partial<Record<Capability, Backend>> = { pose: 'rtmpose', tracking: 'rtmpose_tracking', masks: 'sam2', techniques: 'action', '3d': 'pose3d' };
function capabilityLabel(value: Capability) {
  return ({ original: tx('Original', '原片'), pose: tx('2D pose', '二维姿态'), tracking: tx('Tracking', '人物追踪'), masks: tx('Masks', '人物分割'), review: tx('AI review', 'AI 复盘'), techniques: tx('Action analysis', '动作分析'), '3d': tx('3D', '三维骨架') })[value];
}
function capabilityForBackend(backend: Job['backend']): Capability {
  if (backend === 'review_draft') return 'review';
  return capabilities.find(value => capabilityBackends[value] === backend) || 'original';
}
function latestCapabilityJob(jobs: Job[], backend: Backend) {
  return jobs.find(job => job.backend === backend && !activeJob(job) && !!job.result)
    || jobs.find(job => job.backend === backend && activeJob(job)) || jobs.find(job => job.backend === backend);
}
function scrollToReview() { document.getElementById('coach-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

export default function VideoDetail({ id, initialJobId = '', notify }: { id: string; initialJobId?: string; notify: Notify }) {
  const state = useData(async () => { const [report, models] = await Promise.all([api<Report>(`/videos/${id}/report`), api<Models>('/models')]); return { report, models }; }, [id]);
  const [selectedId, setSelectedId] = useState(initialJobId);
  const [busy, setBusy] = useState(false);
  const [categorySaving, setCategorySaving] = useState(false);
  const [scoreSaving, setScoreSaving] = useState(false);
  const [scoreError, setScoreError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [seek, setSeek] = useState<number | null>(null);
  const [capabilityChoice, setCapabilityChoice] = useState<Capability | null>(null);
  const [playbackRequest, setPlaybackRequest] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [generatedDraft, setGeneratedDraft] = useState<{ videoId: string; draft: ReviewDraft } | null>(null);
  const report = state.data?.report;
  const manualScore = report?.score;
  const scoreHistory = report?.score_history || [];
  const running = report?.jobs.filter(activeJob).map(job => job.id).join(',') || '';
  const selected = report?.jobs.find(job => job.id === selectedId) || (capabilityChoice && capabilityBackends[capabilityChoice]
    ? latestCapabilityJob(report?.jobs || [], capabilityBackends[capabilityChoice]!) : report?.jobs[0]);
  const capability = capabilityChoice || (initialJobId && selected?.id === initialJobId ? capabilityForBackend(selected.backend) : 'original');
  const runningJob = report?.jobs.find(activeJob);
  const sourcePoseJob = report?.jobs.find(job => job.backend === 'rtmpose_tracking' && !activeJob(job) && !!job.result?.tracking && !job.result.synthetic);
  const reviewJob = selected?.result && !selected.result.synthetic && !activeJob(selected) ? selected
    : report?.jobs.find(job => job.result && !job.result.synthetic && !activeJob(job));
  const visibleDrafts = report?.drafts?.filter(reviewDraftVisible) || [];
  const latestDraft = generatedDraft?.videoId === id && reviewDraftVisible(generatedDraft.draft) ? generatedDraft.draft : visibleDrafts.find(draft => draft.provider === 'llm') || visibleDrafts[0];
  const analysisMode = ['pose', 'tracking', 'masks'].includes(capability) && !!selected?.result && !!selected.metadata;
  function chooseCapability(value: Capability) {
    setCapabilityChoice(value); setSeek(null); setPlaybackRequest(previous => previous + 1);
    const backend = capabilityBackends[value];
    if (backend) setSelectedId(latestCapabilityJob(report?.jobs || [], backend)?.id || '');
  }
  async function generateAI() {
    if (!reviewJob || generating || !state.data?.models.llm?.ready) return;
    setGenerating(true);
    try {
      const draft = await post<ReviewDraft & { status?: string }>(`/videos/${id}/review-drafts`, { job_id: reviewJob.id, provider: 'llm', language: getLocale() });
      if (draft.status === 'queued') notify(tx('Queued for analysis on your computer', '已排队，等待电脑分析'), 'success');
      else { setGeneratedDraft({ videoId: id, draft }); notify(tx('AI review draft generated.', 'AI 复盘草稿已生成。'), 'success'); }
      state.reload();
    } catch (err) { notify(errorMessage(err), 'error'); } finally { setGenerating(false); }
  }
  useEffect(() => {
    if (!running) return;
    let alive = true; let timer: number;
    const poll = async () => {
      try { const updated = await api<Report>(`/videos/${id}/report`); if (alive) { state.setData(previous => previous ? { ...previous, report: updated } : previous); if (updated.jobs.some(activeJob)) timer = window.setTimeout(poll, 2000); } }
      catch { if (alive) timer = window.setTimeout(poll, 5000); }
    };
    timer = window.setTimeout(poll, 2000);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [id, running, state.setData, notify]);
  async function start(values: Record<string, unknown>) {
    if (busy || running) return;
    setBusy(true);
    try {
      const job = await post<Job>(`/videos/${id}/jobs`, values);
      setSelectedId(job.id); setCapabilityChoice(capabilityForBackend(job.backend)); setSeek(null); setPlaybackRequest(previous => previous + 1);
      state.setData(previous => previous ? { ...previous, report: { ...previous.report, jobs: [job, ...previous.report.jobs.filter(value => value.id !== job.id)] } } : previous);
      state.reload(); notify("分析任务已提交。", 'success');
    }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }
  async function cancelRunningJob() {
    if (!runningJob || busy) return;
    setBusy(true);
    try { await post(`/jobs/${runningJob.id}/cancel`, {}); state.reload(); notify(tx('Task cancelled', '任务已取消'), 'success'); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }
  async function remove() {
    setDeleting(true);
    try { await api(`/videos/${id}`, { method: 'DELETE' }); notify("视频及相关记录已删除。", 'success'); navigate('videos'); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setDeleting(false); }
  }
  async function updateCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const category = new FormData(event.currentTarget).get('category');
    setCategorySaving(true);
    try {
      const video = await api<Video>(`/videos/${id}/category`, { method: 'PATCH', body: JSON.stringify({ category }) });
      state.setData(previous => previous ? { ...previous, report: { ...previous.report, video } } : previous);
      notify(tx('Category saved.', '分类已保存。'), 'success');
    } catch (err) { notify(errorMessage(err), 'error'); } finally { setCategorySaving(false); }
  }
  async function saveScore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setScoreError('');
    const values = new FormData(event.currentTarget);
    const rawScore = String(values.get('score') ?? '').trim();
    const score = Number(rawScore);
    const comment = String(values.get('comment') || '').trim();
    const confirmed = values.get('confirmed') === 'on';
    if (!rawScore || !Number.isFinite(score) || score < 0 || score > 10) { setScoreError(tx('Enter a score from 0 to 10.', '请输入 0 到 10 的评分。')); return; }
    if (confirmed && !comment) { setScoreError(tx('A review comment is required to mark the score reviewed.', '审核评分前请填写复盘评语。')); return; }
    setScoreSaving(true);
    try {
      const updated = await put<CoachScore>(`/videos/${id}/score`, { score, comment, confirmed });
      state.setData(previous => previous ? { ...previous, report: { ...previous.report, score: updated } } : previous);
      state.reload(); notify(tx('Training score saved.', '训练评分已保存。'), 'success');
    } catch (err) { notify(errorMessage(err), 'error'); } finally { setScoreSaving(false); }
  }
  async function downloadReport() {
    try {
      const value = await api<Report>(`/videos/${id}/report`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `arena-${id}-report.json`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { notify(errorMessage(err), 'error'); }
  }
  return <>
    <a className="back-link" href="#videos"><Icon name="back" size={16} />{t("返回专项视频库")}</a>
    <LoadState loading={state.loading} error={state.error} retry={state.reload} />
    {report && state.data ? <>
      <PageHeader title={report.video.filename} description={`${report.video.athlete_name || t("运动员")} · ${report.video.session_date || t("训练日期未返回")} · ${t(categories[report.video.category]?.name)} · ${fileSize(report.video.size_bytes)}`} action={<button className="button secondary" onClick={downloadReport}><Icon name="download" size={17} />{t("下载报告 JSON")}</button>} />
      {runningJob ? <div className="notice" role="status"><span>{t(backendNames[runningJob.backend])} · {t(runningJob.stage || tx('Waiting for computer', '等待电脑处理'))} · {runningJob.progress || 0}%</span><button className="button secondary small" disabled={busy} onClick={cancelRunningJob}>{tx('Cancel task', '取消任务')}</button></div> : null}
      <nav className="capability-tabs" role="tablist" aria-label={tx('Video capabilities', '视频功能')}>
        {capabilities.map(value => <button key={value} type="button" role="tab" id={`capability-${value}`} aria-controls="capability-workspace" aria-selected={capability === value} className={capability === value ? 'active' : ''} onClick={() => chooseCapability(value)}>{capabilityLabel(value)}{capabilityBackends[value] ? <i className={latestCapabilityJob(report.jobs, capabilityBackends[value]!)?.result ? 'ready' : state.data?.models[capabilityBackends[value] as keyof Models]?.ready ? 'available' : 'unavailable'} /> : null}</button>)}
      </nav>
      <div className="coach-viewport" id="capability-workspace" role="tabpanel" aria-labelledby={`capability-${capability}`}>
        <Panel className="video-panel">{capability === '3d' && selected?.backend === 'pose3d' && selected.result?.kind === 'pose3d' ? <Pose3DPlayer key={selected.id} job={selected} seekTime={seek} onTime={setCurrentTime} /> : <PosePlayer key={`${selected?.id || id}:${capability}:${playbackRequest}`} videoId={id} job={selected} preferredMode={analysisMode ? 'analysis' : 'original'} showModeControls={false} seekTime={seek} onTime={setCurrentTime} />}</Panel>
        {capability === 'review' ? <Panel className="capability-context" title={tx('AI review', 'AI 复盘')} action={<span className={`status ${state.data.models.llm?.ready ? 'success' : 'neutral'}`}>{state.data.models.llm?.ready ? tx('Available', '可使用') : tx('Unavailable', '未就绪')}</span>}>
          <div className="capability-body"><button className="button" disabled={generating || !!running || !state.data.models.llm?.ready || !reviewJob} onClick={generateAI}>{runningJob?.backend === 'review_draft' ? tx('Waiting for computer', '等待电脑处理') : generating ? tx('Generating…', '生成中…') : tx('Generate AI review', '生成 AI 复盘')}</button>
          {!state.data.models.llm?.ready ? <p>{tx('Language model unavailable', '语言模型未就绪')} · <a className="text-link" href="#models">{tx('Model status', '模型状态')}</a></p> : !reviewJob ? <p>{tx('Analyze this video first.', '请先分析此视频。')}</p> : null}
          {latestDraft ? <div className="capability-draft"><small title={latestDraft.model}>{tx('Saved reference', '已保存参考')} · {dateTime(latestDraft.created_at)}</small><Synthetic value={latestDraft.synthetic} /><pre>{draftDisplayText(latestDraft)}</pre></div> : null}
          <button className="text-link" onClick={scrollToReview}>{tx('Edit training review', '编辑训练复盘')}<Icon name="arrow" size={15} /></button></div>
        </Panel> : capability === 'original' ? <Panel className="capability-context" title={tx('Training review', '训练复盘')} action={<span className={`status ${report.review?.confirmed ? 'success' : 'neutral'}`}>{report.review?.confirmed ? tx('Review complete', '复盘完成') : tx('Not reviewed', '未复盘')}</span>}>
          <div className="capability-body">{report.review?.observations ? <p className="coach-observation">{report.review.observations}</p> : null}{report.review?.next_action ? <p><strong>{tx('Next session', '下一次训练')}</strong><br />{report.review.next_action}</p> : null}{manualScore ? <p className="coach-score-summary"><strong>{manualScore.score}</strong> / 10 · {manualScore.confirmed ? tx('Reviewed', '已审核') : tx('Not reviewed', '未审核')}</p> : null}<button className="button" onClick={scrollToReview}>{report.review ? tx('Open review', '查看复盘') : tx('Write review', '撰写复盘')}</button><button className="text-link" onClick={() => chooseCapability('review')}>{tx('Generate AI review', '生成 AI 复盘')}<Icon name="arrow" size={15} /></button></div>
        </Panel> : <CapabilityPanel capability={capability} job={selected} models={state.data.models} busy={busy} runningJob={runningJob} onRun={start} sourcePoseJob={sourcePoseJob} videoId={id} events={report.events} reload={state.reload} notify={notify} onSeek={setSeek} />}
      </div>
      {selected && capability === 'tracking' ? <TrackFocus job={selected} busy={busy || !!running} start={start} /> : null}
      {selected && (capability === 'tracking' || capability === 'pose') ? <JointObservations key={selected.id} job={selected} onSeek={setSeek} /> : null}
      <section className="coach-review-section" id="coach-review" aria-label={tx('Coach review', '教练复盘')}>
      <ReviewPanel videoId={id} job={reviewJob} report={report} reload={state.reload} notify={notify} llmReady={state.data.models.llm?.ready} />
      <Panel title={tx('Training score', '训练评分')} action={<span className={`status ${manualScore?.confirmed ? 'success' : 'neutral'}`}><i />{manualScore ? manualScore.confirmed ? tx('Reviewed', '已审核') : tx('Not reviewed', '未审核') : tx('Not scored', '未评分')}</span>}>
        <form className="form-grid score-form" key={`${id}:${manualScore?.updated_at || ''}`} onSubmit={saveScore}>
          <Field label={tx('Score / 10', '评分 / 10')}><input name="score" type="number" min="0" max="10" step="any" required defaultValue={manualScore?.score ?? ''} disabled={scoreSaving} /></Field>
          <Field label={tx('Review comment', '复盘评语')}><textarea name="comment" rows={3} defaultValue={manualScore?.comment || ''} disabled={scoreSaving} /></Field>
          <div className="form-actions span-2"><label className="checkbox-label"><input name="confirmed" type="checkbox" defaultChecked={manualScore?.confirmed || false} disabled={scoreSaving} />{tx('Reviewed', '已审核')}</label><button className="button" disabled={scoreSaving}>{scoreSaving ? tx('Saving…', '保存中…') : tx('Save score', '保存评分')}</button>{manualScore ? <small className="muted">{tx('Reviewer', '复盘账号')}: {manualScore.assessor} · <time dateTime={manualScore.updated_at}>{dateTime(manualScore.updated_at)}</time> · {manualScore.rubric_version}</small> : null}</div>
          {scoreError ? <p className="notice error span-2" role="alert">{scoreError}</p> : null}
        </form>
        <details className="score-history"><summary>{tx('Score history', '评分历史')} · {scoreHistory.length}</summary>{scoreHistory.length ? <div className="table-wrap"><table><thead><tr><th>{tx('Recorded', '记录时间')}</th><th>{tx('Score / 10', '评分 / 10')}</th><th>{tx('Reviewer', '复盘账号')}</th><th>{tx('Review comment', '复盘评语')}</th><th>{tx('Status', '状态')}</th><th>{tx('Rubric version', '评分标准版本')}</th></tr></thead><tbody>{scoreHistory.map(entry => <tr key={entry.id}><td><time dateTime={entry.created_at}>{dateTime(entry.created_at)}</time></td><td>{entry.snapshot.score}</td><td>{entry.snapshot.assessor}</td><td className="score-comment">{entry.snapshot.comment || '—'}</td><td>{entry.snapshot.confirmed ? tx('Reviewed', '已审核') : tx('Not reviewed', '未审核')}</td><td className="mono">{entry.snapshot.rubric_version}</td></tr>)}</tbody></table></div> : <p className="muted">{tx('No score history', '暂无评分历史')}</p>}</details>
      </Panel>
      </section>
      <section id="event-timeline"><EventsPanel videoId={id} events={report.events} ready={report.jobs.some(job => !!job.metadata)} currentTime={currentTime} seek={setSeek} reload={state.reload} notify={notify} /></section>
      <details className="coach-advanced"><summary>{tx('Advanced tools', '高级工具')}</summary><div className="coach-advanced-content"><div className="coach-advanced-grid">
        <Panel title={tx('Video category', '视频分类')}><form className="analysis-form" key={`${report.video.id}:${report.video.category}`} onSubmit={updateCategory}>
          <Field label={t("专项")}><select name="category" required defaultValue={report.video.category} disabled={categorySaving}>{Object.entries(categories).map(([key, value]) => <option value={key} key={key}>{t(value.name)}</option>)}</select></Field>
          <button className="button secondary" disabled={categorySaving}>{categorySaving ? tx('Saving…', '保存中…') : tx('Save category', '保存分类')}</button>
        </form></Panel>
        <AnalysisForm models={state.data.models} busy={busy || !!running} start={start} />
        <Panel title={t("分析记录")} >
          {report.jobs.length ? <div className="job-list">{report.jobs.map(job => <button key={job.id} className={`job-row ${selected?.id === job.id ? 'selected' : ''}`} onClick={() => { setSelectedId(job.id); setCapabilityChoice(capabilityForBackend(job.backend)); setSeek(null); setPlaybackRequest(previous => previous + 1); }}><span><strong>{t(backendNames[job.backend])}</strong><small>{dateTime(job.created_at)}</small></span><JobStatus job={job} /></button>)}</div> : <Empty title={t("尚未进行分析")}></Empty>}
        </Panel>
      </div>
      {selected ? <ResultPanel job={selected} /> : null}
      {selected ? <AnalysisAssessment key={selected.id} job={selected} reload={state.reload} notify={notify} /> : null}
      <div className="danger-zone"><div><strong>{t("删除视频记录")}</strong><p>{t("将删除此视频、分析与复盘记录。请确认已经导出需要保留的信息。")}</p></div>{!deleteConfirm ? <button className="button danger-outline" disabled={!!running} onClick={() => setDeleteConfirm(true)}>{t("删除视频")}</button> : <div className="delete-confirm"><span>{t("确认永久删除此视频及相关记录？")}</span><button className="button danger" disabled={deleting} onClick={remove}>{deleting ? t("正在删除…") : t("确认永久删除")}</button><button className="button secondary" disabled={deleting} onClick={() => setDeleteConfirm(false)}>{t("取消")}</button></div>}</div>
      </div></details>
    </> : null}
  </>;
}

export function CapabilityPanel({ capability, job, models, busy, runningJob, onRun, sourcePoseJob, videoId, reload, notify, onSeek, events }: { capability: Capability; job?: Job; models: Models; busy: boolean; runningJob?: Job; sourcePoseJob?: Job; videoId?: string; events?: VideoEvent[]; reload?: () => void; notify?: Notify; onSeek?: (time: number) => void; onRun: (values: Record<string, unknown>) => void | Promise<void> }) {
  const backend = capabilityBackends[capability];
  const model = backend ? models[backend === 'preprocess' ? 'preprocessing' : backend] : undefined;
  const result = job?.result;
  const sourceTrackJobId = result?.source_pose_job_id || (typeof job?.params?.source_pose_job_id === 'string' ? job.params.source_pose_job_id : '');
  const blocked = model?.reason ? t(model.reason) : tx('Model unavailable', '模型未就绪');
  const runLabel = ({ pose: tx('Run 2D pose', '运行二维姿态'), tracking: tx('Run tracking', '运行人物追踪'), masks: tx('Generate masks', '生成人物分割'), techniques: tx('Analyze actions', '分析动作'), '3d': tx('View 3D skeleton', '生成三维骨架'), original: '', review: '' })[capability];
  const progress = runningJob ? Math.max(0, Math.min(100, runningJob.progress <= 1 ? runningJob.progress * 100 : runningJob.progress)) : 0;
  return <Panel className="capability-context" title={capabilityLabel(capability)} action={result ? <span className="status neutral">{tx('Experimental', '实验性')}</span> : job ? <JobStatus job={job} /> : <span className={`status ${model?.ready ? 'success' : 'neutral'}`}>{model?.ready ? tx('Available', '可使用') : tx('Unavailable', '未就绪')}</span>}>
    <div className="capability-body">
      {result?.tracking ? <><p className="capability-number"><strong>{result.tracking.track_count}</strong> {tx('tracks', '条轨迹')}</p><div className="capability-tracks">{result.tracking.tracks.map(track => <div key={track.track_id}><strong>T{track.track_id}</strong><span>{track.observed_frames} {tx('observed frames', '观测帧')}</span></div>)}</div></> : null}
      {result?.segmentation ? <><p className="capability-number"><strong>{result.segmentation.object_count}</strong> {tx('objects', '个目标')}</p><p>{tx('Mask frames', '分割帧')} <strong>{result.segmentation.segmented_frames} / {result.segmentation.total_frames}</strong></p></> : null}
      {result && capability === 'pose' ? <p>{tx('2D pose overlay ready', '二维姿态叠加已就绪')}</p> : null}
      {result?.kind === 'recognition' && job && videoId && reload && notify && onSeek ? <ActionCandidates videoId={videoId} job={job} events={events} reload={reload} notify={notify} onSeek={onSeek} /> : null}
      {result?.kind === 'pose3d' && videoId && sourceTrackJobId ? <a className="text-link" href={`#videos/${encodeURIComponent(videoId)}?job=${encodeURIComponent(sourceTrackJobId)}`}>{tx('View source tracks', '查看来源轨迹')}</a> : null}
      {result?.kind === 'pose3d' ? <><p>MotionBERT · {tx('Root-relative model units', '根节点相对模型单位')}</p><div className="capability-tracks">{result.pose3d?.frame_count != null ? <div><span>{tx('Frames', '帧数')}</span><strong>{result.pose3d.frame_count}</strong></div> : null}{result.pose3d?.track_ids ? <div><span>{tx('Tracks', '轨迹数')}</span><strong>{result.pose3d.track_ids.length}</strong></div> : null}{result.pose3d?.person_observation_count != null ? <div><span>{tx('Person observations', '人物观测数')}</span><strong>{result.pose3d.person_observation_count}</strong></div> : null}</div></> : null}
      {!result ? model?.ready ? <><p>{tx('No saved result yet.', '尚无分析结果。')}</p><button className="button" disabled={busy || !!runningJob} onClick={() => backend && onRun({ backend, ...(backend === 'pose3d' && sourcePoseJob ? { source_pose_job_id: sourcePoseJob.id } : {}) })}>{runLabel}</button></> : <p className="capability-unavailable">{blocked}<br /><a className="text-link" href="#models">{tx('Model status', '模型状态')}<Icon name="arrow" size={14} /></a></p> : null}
      {job?.error ? <p className="notice error">{t(job.error)}</p> : null}
      {runningJob ? <div className="capability-progress"><div><JobStatus job={runningJob} /><strong>{Math.round(progress)}%</strong></div><progress value={progress} max="100" /><small>{t(backendNames[runningJob.backend])} · {t(runningJob.stage || tx('Processing', '处理中'))}</small></div> : null}
    </div>
  </Panel>;
}

export function TrackFocus({ job, busy, start }: { job: Job; busy: boolean; start: (values: Record<string, unknown>) => Promise<void> }) {
  const tracks = job.result?.tracking?.tracks || [];
  if (!tracks.length) return null;
  return <Panel title={tx('Focus a track', '选择分析目标')}><form className="form-row" onSubmit={event => {
    event.preventDefault(); const target = Number(new FormData(event.currentTarget).get('target_track_id'));
    if (tracks.some(track => track.track_id === target)) void start({ backend: 'rtmpose_tracking', source_pose_job_id: job.id, target_track_id: target });
  }}><Field label={tx('Track', '目标轨迹')}><select name="target_track_id" required defaultValue=""><option value="" disabled>{tx('Select a track', '选择轨迹')}</option>{tracks.map(track => <option key={track.track_id} value={track.track_id}>T{track.track_id} · {track.observed_frames} {tx('frames', '帧')}</option>)}</select></Field><button className="button" disabled={busy}>{tx('Analyze this track', '分析此轨迹')}</button></form></Panel>;
}

function AnalysisForm({ models, busy, start }: { models: Models; busy: boolean; start: (values: Record<string, unknown>) => Promise<void> }) {
  const [backend, setBackend] = useState<Backend>(() => models.rtmpose_tracking?.ready ? 'rtmpose_tracking' : models.rtmpose?.ready ? 'rtmpose' : 'preprocess');
  const [acknowledged, setAcknowledged] = useState(false);
  const [roi, setRoi] = useState(false);
  const [localError, setLocalError] = useState('');
  const model = models[backend === 'preprocess' ? 'preprocessing' : backend];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLocalError(''); const values = new FormData(event.currentTarget);
    const body: Record<string, unknown> = { backend, sample_acknowledged: backend === 'sample' && acknowledged };
    const from = String(values.get('start_sec') || ''); const to = String(values.get('end_sec') || '');
    if (from !== '') body.start_sec = Number(from);
    if (to !== '') body.end_sec = Number(to);
    if (from !== '' && to !== '' && Number(to) <= Number(from)) { setLocalError("结束时间必须晚于开始时间。"); return; }
    if (roi && !['action', 'pose3d'].includes(backend)) {
      const region = ['x', 'y', 'w', 'h'].map(key => Number(values.get(`roi_${key}`)));
      if (region[0] + region[2] > 1.00001 || region[1] + region[3] > 1.00001) { setLocalError("关注区域超出画面，请确保 x + 宽、y + 高不超过 1。"); return; }
      body.roi = region;
    }
    await start(body);
  }
  return <Panel title={t("运行分析")}><form className="analysis-form" onSubmit={submit}>
    <Field label={t("分析方法")}><select value={backend} onChange={event => { setBackend(event.target.value as Backend); setAcknowledged(false); }}><option value="preprocess">{t(backendNames.preprocess)}</option><option value="rtmpose">{t(backendNames.rtmpose)}</option><option value="rtmpose_tracking">{t(backendNames.rtmpose_tracking)}</option><option value="sam2">{t(backendNames.sam2)}</option><option value="action">{t(backendNames.action)}</option><option value="pose3d">{t(backendNames.pose3d)}</option><option value="fsw">{t(backendNames.fsw)}</option><option value="wham">{t(backendNames.wham)}</option><option value="sample">{t(backendNames.sample)}</option></select></Field>
    {backend === 'preprocess' ? <p className="muted analysis-explanation">{t("只规范视频格式和检查有效性，不运行 AI 模型、不生成测量指标。完成后可人工标注与复盘。")}</p> : null}
    <div className={`model-readiness ${model?.ready ? 'ready' : ''}`}><strong>{model?.ready ? t("方法可用") : t("方法未就绪")}</strong><p>{t(model?.reason || (backend === 'preprocess' ? model?.ready ? t("FFmpeg / FFprobe 可用") : t("需要 FFmpeg / FFprobe") : t("服务端未返回可用状态")))}</p></div>
    {backend === 'sample' ? <label className="checkbox-label sample-confirm"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>{t("我理解这是合成样例，仅验证流程，不作为运动员真实成绩，不计入个人趋势。")}</span></label> : null}
    <details><summary>{t("时间范围与目标区域（可选）")}</summary><p className="muted">{t("秒数以原始视频为准。区域使用 0–1 的归一化坐标；用于聚焦目标，不保证双人接触时的身份连续性。")}</p><div className="form-grid"><Field label={t("开始 / 秒")}><input type="number" name="start_sec" min="0" max="300" step="0.01" placeholder="0" /></Field><Field label={t("结束 / 秒")}><input type="number" name="end_sec" min="0.01" max="300" step="0.01" placeholder={t("视频结尾")} /></Field></div>{!['action', 'pose3d'].includes(backend) ? <label className="checkbox-label"><input type="checkbox" checked={roi} onChange={event => setRoi(event.target.checked)} />{t("指定目标区域")}</label> : null}{roi && !['action', 'pose3d'].includes(backend) ? <div className="form-grid roi-fields">{[['x', t("左侧 x"), '0'], ['y', t("顶部 y"), '0'], ['w', t("宽度"), '1'], ['h', t("高度"), '1']].map(([key, label, value]) => <Field label={label} key={key}><input name={`roi_${key}`} type="number" min={key === 'w' || key === 'h' ? '0.01' : '0'} max="1" step="0.01" defaultValue={value} required /></Field>)}</div> : null}</details>
    {localError ? <p className="notice error" role="alert">{t(localError)}</p> : null}<button className="button full" disabled={busy || !model?.ready || (backend === 'sample' && !acknowledged)}>{busy ? t("已有任务正在处理…") : backend === 'sample' ? t("生成合成样例分析") : backend === 'preprocess' ? t("提交视频预处理") : t("提交分析任务")}<Icon name="arrow" size={17} /></button>
  </form></Panel>;
}
function ResultPanel({ job }: { job: Job }) {
  const result = job.result;
  const limitations = limitationList(result?.limitations);
  const hasSimilarities = result?.candidates?.some(candidate => typeof candidate.similarity === 'number' && Number.isFinite(candidate.similarity));
  const progress = Math.max(0, Math.min(100, job.progress <= 1 ? job.progress * 100 : job.progress));
  return <Panel title={t("分析结果")} description={t(backendNames[job.backend])} action={<div className="inline-actions"><Synthetic value={job.backend === 'sample' || result?.synthetic} /><JobStatus job={job} /></div>}>
    {activeJob(job) ? <div className="job-progress"><div><strong>{t(job.stage || '任务处理中')}</strong><span>{Math.round(progress)}%</span></div><progress max={100} value={progress} /></div> : null}
    {job.error ? <div className="notice error"><strong>{job.status === 'blocked' ? t("分析条件尚未满足") : t("任务未能完成")}</strong><p>{t(job.error)}</p></div> : null}
    {!result && job.backend === 'preprocess' && job.status === 'completed' ? <div className="notice"><strong>{t("视频预处理完成")}</strong><p>{t("可播放预处理副本并人工标注、撰写复盘。此任务未运行 AI 模型，不生成测量指标或专项评分。")}</p></div> : !result && !activeJob(job) && !job.error ? <Empty title={t("任务尚未返回分析结果")}></Empty> : null}
    {result ? <>
      {result.synthetic ? <div className="notice sample-notice"><strong>{t("合成样例结果，不代表真实训练表现")}</strong><p>{t("本次数据用于验证系统功能，不参与运动员真实趋势或专项评价。")}</p></div> : null}
      {result.kind === 'recognition' ? <div className="recognition"><div><span className="muted">{t("专项动作候选")}</span><h3>{t(result.candidate_label || "未获得可靠候选")}</h3><p>{t("候选识别须结合视频，由教练人工确认。")}</p></div>{result.candidates?.length ? <div className="table-wrap"><table><thead><tr><th>{tx('Candidate', '候选')}</th>{hasSimilarities ? <th>{tx('Cosine similarity', '余弦相似度')}</th> : null}</tr></thead><tbody>{(hasSimilarities ? result.candidates.slice(0, 3) : result.candidates).map(candidate => <tr key={candidate.id}><td>{t(candidate.label)}</td>{hasSimilarities ? <td>{typeof candidate.similarity === 'number' && Number.isFinite(candidate.similarity) ? candidate.similarity.toFixed(3) : ''}</td> : null}</tr>)}</tbody></table></div> : result.labels?.length ? <div className="table-wrap"><table><thead><tr><th>{t("类别")}</th><th>{t("模型概率")}</th></tr></thead><tbody>{result.labels.map((label, index) => {
        const probability = Array.isArray(result.probabilities) ? result.probabilities[index] : result.probabilities?.[label];
        return <tr key={label}><td>{t(label)}</td><td>{typeof probability === 'number' ? `${(probability * 100).toFixed(1)}%` : t("未返回")}</td></tr>;
      })}</tbody></table></div> : null}</div> : result.metrics ? <div className="table-wrap"><table className="metrics-table"><thead><tr><th>{t("测量指标")}</th><th>{t("结果")}</th><th>{t("计算公式 / 方法")}</th></tr></thead><tbody>{Object.entries(result.metrics).map(([key, metric]) => <tr key={key}><td><strong>{t(metric.label)}</strong></td><td>{metric.value === null ? <span className="muted">{t("无法测量")}</span> : <strong className="measurement">{Number(metric.value.toFixed(3))}<small>{t(metric.unit)}</small></strong>}</td><td className="formula">{t(metric.formula || '服务端未提供公式')}</td></tr>)}</tbody></table></div> : null}
      {result.segmentation ? <div className="insight-totals"><div><span>{tx('Segmented frames', '分割帧数')}</span><strong>{result.segmentation.segmented_frames} / {result.segmentation.total_frames}</strong></div><div><span>{tx('Objects', '目标数量')}</span><strong>{result.segmentation.object_count}</strong></div><div><span>{tx('Sampling', '采样频率')}</span><strong>2 Hz</strong></div></div> : null}
      {result.tracking ? <div className="table-wrap"><table><caption>{tx('Person tracks', '人物轨迹')} · {result.tracking.track_count}</caption><thead><tr><th>{tx('Track', '轨迹')}</th><th>{tx('Start / s', '起点 / 秒')}</th><th>{tx('End / s', '终点 / 秒')}</th><th>{tx('Observed frames', '观测帧')}</th></tr></thead><tbody>{result.tracking.tracks.map(track => <tr key={track.track_id}><td>T{track.track_id}</td><td>{track.start_sec.toFixed(2)}</td><td>{track.end_sec.toFixed(2)}</td><td>{track.observed_frames}</td></tr>)}</tbody></table></div> : null}
      {result.quality ? <details className="quality-details"><summary>{t("数据质量与方法信息")}</summary><pre>{qualityText(result.quality)}</pre></details> : null}
      {limitations.length ? <div className="limitations"><strong>{t("解释边界")}</strong><ul>{limitations.map((limitation, index) => <li key={index}>{t(limitation)}</li>)}</ul></div> : null}
    </> : null}
  </Panel>;
}
