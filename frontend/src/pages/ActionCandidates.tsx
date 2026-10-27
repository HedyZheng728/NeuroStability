import { useState, type FormEvent } from 'react';
import { t, tx } from '../i18n';
import { post } from '../api';
import { Field, type Notify } from '../components';
import { errorMessage, limitationList, type ActionWindow, type Job, type VideoEvent } from '../types';
import './ActionCandidates.css';

type Props = { videoId: string; job: Job; events?: VideoEvent[]; reload: () => void; notify: Notify; onSeek: (time: number) => void };
export function CandidateWindow({ videoId, job, window, events = [], reload, notify, onSeek }: Props & { window: ActionWindow }) {
  const hasSimilarities = window.candidates.some(candidate => typeof candidate.similarity === 'number' && Number.isFinite(candidate.similarity));
  const candidates = hasSimilarities ? window.candidates.slice(0, 3) : window.candidates;
  const sourceStart = window.source_frame_times_sec?.[0] ?? window.start_sec;
  const sourceEnd = window.source_frame_times_sec?.at(-1) ?? window.end_sec;
  const [label, setLabel] = useState(t(window.candidate_label || window.candidates[0]?.label || ''));
  const [start, setStart] = useState(String(sourceStart));
  const [end, setEnd] = useState(String(sourceEnd));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const recorded = events.find(event => event.source_job_id === job.id && Math.abs(event.start_sec - sourceStart) < 1e-6 && Math.abs(event.end_sec - sourceEnd) < 1e-6);
  const recordedLabel = recorded?.label ?? saved;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (recordedLabel !== null || busy) return;
    const from = Number(start); const to = Number(end);
    if (!label.trim() || !start.trim() || !end.trim() || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) { notify(tx('Enter a label and a valid source time range.', '请填写名称和有效的原片时间范围。'), 'error'); return; }
    setBusy(true);
    try {
      await post(`/videos/${videoId}/events`, { start_sec: from, end_sec: to, label: label.trim(), actor: 'unknown', outcome: '', notes: '', source_job_id: job.id });
      setSaved(label.trim()); reload(); notify(tx('Event recorded.', '事件已记录。'), 'success');
    } catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }
  return <section className="action-window">
    <div className="action-window-heading"><button className="text-link" onClick={() => onSeek(sourceStart)}>{sourceStart.toFixed(2)}–{sourceEnd.toFixed(2)} {tx('s', '秒')}</button><span className="status neutral">{tx('Candidate', '候选')}</span></div>
    {window.wrestling_hypothesis ? <p className="action-hypothesis"><span className="status neutral">{tx('Unconfirmed hypothesis', '待确认专项假设')}</span> {t(window.wrestling_hypothesis.label)}</p> : null}
    <ul className="action-ranking" aria-label={tx('Observed categories', '观察类别')}>{candidates.map(candidate => <li key={candidate.id}><span>{t(candidate.label)}</span>{typeof candidate.similarity === 'number' && Number.isFinite(candidate.similarity) ? <strong>{candidate.similarity.toFixed(3)}</strong> : null}</li>)}</ul>
    {hasSimilarities ? <small className="muted">{tx('Cosine similarity', '余弦相似度')}</small> : null}
    {recordedLabel !== null ? <div className="action-event-form"><span className="muted">{tx('Recorded in timeline', '已记入时间线')}</span><strong>{recordedLabel}</strong><button type="button" className="text-link" onClick={() => document.getElementById('event-timeline')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{tx('View timeline', '查看时间线')}</button></div> : <form className="action-event-form" onSubmit={save}>
      <Field label={tx('Event label', '事件名称')}><input name="label" required maxLength={100} value={label} onChange={event => { setLabel(event.target.value); setSaved(null); }} /></Field>
      <div className="action-times"><Field label={tx('Start / s', '起点 / 秒')}><input name="start_sec" type="number" min="0" step="any" required value={start} onChange={event => { setStart(event.target.value); setSaved(null); }} /></Field><Field label={tx('End / s', '终点 / 秒')}><input name="end_sec" type="number" min="0" step="any" required value={end} onChange={event => { setEnd(event.target.value); setSaved(null); }} /></Field></div>
      <button className="button small secondary" disabled={busy}>{busy ? tx('Saving…', '保存中…') : tx('Record event', '记录事件')}</button>
    </form>}
  </section>;
}
export default function ActionCandidates(props: Props) {
  const windows = props.job.result?.windows || [];
  const limitations = limitationList(props.job.result?.limitations);
  const [selected, setSelected] = useState(0);
  const current = windows[selected] || windows[0];
  return <div className="action-candidates"><p className="action-method">Qwen3-VL · {tx('Experimental', '实验性')}</p>{windows.length > 1 ? <Field label={tx('Time window', '时间片段')}><select value={selected} onChange={event => setSelected(Number(event.target.value))}>{windows.map((window, index) => <option key={index} value={index}>{(window.source_frame_times_sec?.[0] ?? window.start_sec).toFixed(2)}–{(window.source_frame_times_sec?.at(-1) ?? window.end_sec).toFixed(2)} {tx('s', '秒')} · {t(window.candidate_label || '')}</option>)}</select></Field> : null}{current ? <CandidateWindow key={`${props.job.id}:${selected}`} {...props} window={current} /> : <p className="muted">{tx('No timed candidates returned.', '未返回带时间的动作候选。')}</p>}
    {limitations.length || current?.visual_description ? <details><summary>{tx('Method and limits', '方法与边界')}</summary>{current?.visual_description ? <p><strong>{tx('Model output', '模型输出')}</strong><br />{t(current.visual_description)}</p> : null}<ul>{limitations.map((value, index) => <li key={index}>{t(value)}</li>)}</ul></details> : null}
  </div>;
}
