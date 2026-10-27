import { t, tx } from '../i18n';
import { useState, type FormEvent } from 'react';
import { api, post } from '../api';
import { Empty, Field, Icon, Panel, type Notify } from '../components';
import { errorMessage, type VideoEvent } from '../types';

const actors = { athlete: '运动员', opponent: '对手', unknown: '尚未确认' };
export default function EventsPanel({ videoId, events, ready, currentTime, seek, reload, notify }: { videoId: string; events: VideoEvent[]; ready: boolean; currentTime: number; seek: (time: number) => void; reload: () => void; notify: Notify }) {
  const [showForm, setShowForm] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteId, setDeleteId] = useState('');
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    if (Number(end) < Number(start)) { notify("结束时间不能早于开始时间。", 'error'); return; }
    setBusy(true);
    try { await post(`/videos/${videoId}/events`, { start_sec: Number(start), end_sec: Number(end), label: String(values.get('label')).trim(), actor: values.get('actor'), outcome: String(values.get('outcome') || '').trim(), notes: String(values.get('notes') || '').trim() }); form.reset(); setStart(''); setEnd(''); setShowForm(false); reload(); notify("人工事件标注已保存。", 'success'); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true);
    try { await api(`/events/${id}`, { method: 'DELETE' }); setDeleteId(''); reload(); notify("事件标注已删除。", 'success'); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }
  return <Panel title={t("关键事件时间线")} action={<button className="button small secondary" disabled={!ready} onClick={() => setShowForm(!showForm)}><Icon name="plus" size={16} />{t("标注事件")}</button>}>
    {!ready ? <div className="notice">{t("请先提交并完成视频预处理，确认原始时长后即可标注关键事件。")}</div> : null}
    {showForm ? <form className="event-form form-grid" onSubmit={create}>
      <Field label={t("开始时间 / 秒")}><div className="input-action"><input name="start_sec" aria-label={t("开始时间 / 秒")} type="number" min="0" max="300" step="0.01" value={start} onChange={event => setStart(event.target.value)} required /><button type="button" title={t("使用当前播放时间")} onClick={() => setStart(currentTime.toFixed(2))}>{t("取当前")}</button></div></Field>
      <Field label={t("结束时间 / 秒")}><div className="input-action"><input name="end_sec" aria-label={t("结束时间 / 秒")} type="number" min="0" max="300" step="0.01" value={end} onChange={event => setEnd(event.target.value)} required /><button type="button" title={t("使用当前播放时间")} onClick={() => setEnd(currentTime.toFixed(2))}>{t("取当前")}</button></div></Field>
      <Field label={t("事件 / 技术名称")}><input name="label" required maxLength={100} placeholder={t("人工识别的关键事件")} /></Field>
      <Field label={t("动作主体")}><select name="actor" defaultValue="unknown"><option value="unknown">{t("尚未确认")}</option><option value="athlete">{t("运动员")}</option><option value="opponent">{t("对手")}</option></select></Field>
      <div className="span-2"><Field label={t("观察到的结果")}><input name="outcome" maxLength={500} placeholder={t("如实记录，不由系统自动判分")} /></Field></div>
      <div className="span-2"><Field label={t("备注")}><textarea name="notes" rows={2} maxLength={2000} /></Field></div>
      <div className="form-actions span-2"><button className="button small" disabled={busy}>{busy ? t("正在保存…") : t("保存人工标注")}</button><button className="button small secondary" type="button" onClick={() => setShowForm(false)}>{t("取消")}</button></div>
    </form> : null}
    {events.length ? <div className="event-list">{[...events].sort((a, b) => a.start_sec - b.start_sec).map(event => <div className="event-row" key={event.id}><button className="event-time" onClick={() => seek(event.start_sec)} title={t("跳转原始视频中的事件时间")}>{event.start_sec.toFixed(2)}<small>{t("至")} {event.end_sec.toFixed(2)} {t("秒")}</small></button><div className="event-copy"><strong>{event.label}</strong>{event.actor !== 'unknown' ? <span className="actor-label">{t(actors[event.actor])}</span> : null}{event.outcome ? <p>{event.outcome}</p> : null}{event.notes ? <small>{event.notes}</small> : null}{event.source_job_id ? <a className="text-link" href={`#videos/${encodeURIComponent(videoId)}?job=${encodeURIComponent(event.source_job_id)}`}>{tx('View analysis source', '查看分析来源')}<Icon name="arrow" size={13} /></a> : null}</div>{deleteId === event.id ? <div className="event-delete"><button className="text-link danger-text" disabled={busy} onClick={() => remove(event.id)}>{t("确认删除")}</button><button className="text-link" onClick={() => setDeleteId('')}>{t("取消")}</button></div> : <button className="icon-button" aria-label={tx(`Delete event ${event.label}`, `删除事件 ${event.label}`)} onClick={() => setDeleteId(event.id)}><Icon name="close" size={15} /></button>}</div>)}</div> : <Empty title={t("尚未标注关键事件")}></Empty>}
  </Panel>;
}
