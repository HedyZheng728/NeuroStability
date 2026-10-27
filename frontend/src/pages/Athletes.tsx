import { t } from '../i18n';
import { useState, type FormEvent } from 'react';
import { api, post } from '../api';
import { Empty, Field, Icon, LoadState, PageHeader, Panel, useData, type Notify } from '../components';
import { categories, dateTime, errorMessage, type Athlete, type AthleteProfile } from '../types';
import AnalysisOverview from '../AnalysisOverview';

export default function Athletes({ notify }: { notify: Notify }) {
  const { data, loading, error, reload } = useData(() => api<Athlete[]>('/athletes'));
  const [selected, setSelected] = useState<string>('');
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const activeId = selected || data?.[0]?.id || '';
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true);
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      const athlete = await post<Athlete>('/athletes', { name: String(values.get('name')).trim(), level: String(values.get('level')).trim() });
      form.reset(); setShowForm(false); setSelected(athlete.id); reload(); notify("运动员档案已创建。", 'success');
    } catch (err) { notify(errorMessage(err), 'error'); } finally { setSaving(false); }
  }
  return <>
    <PageHeader title={t("运动员与数字画像")} action={<button className="button" onClick={() => setShowForm(!showForm)}><Icon name="plus" size={18} />{t("新建运动员")}</button>} />
    {showForm ? <Panel title={t("创建运动员档案")}><form className="form-row" onSubmit={create}><Field label={t("运动员姓名")}><input name="name" autoFocus required maxLength={80} placeholder={t("输入真实姓名")} /></Field><Field label={t("运动等级")}><input name="level" required maxLength={80} /></Field><button className="button" disabled={saving}>{saving ? t("正在保存…") : t("保存档案")}</button><button type="button" className="button secondary" onClick={() => setShowForm(false)}>{t("取消")}</button></form></Panel> : null}
    <LoadState loading={loading} error={error} retry={reload} />
    {data ? <div className="athlete-layout"><Panel title={t("运动员档案")}>
      {data.length ? <div className="athlete-list">{data.map(athlete => <button key={athlete.id} className={`athlete-row ${activeId === athlete.id ? 'selected' : ''}`} onClick={() => setSelected(athlete.id)}><span className="avatar">{athlete.name.slice(0, 1)}</span><span><strong>{athlete.name}</strong><small>{athlete.level}</small></span><Icon name="arrow" size={18} /></button>)}</div> : <Empty title={t("尚未创建运动员")} action={<button className="button secondary" onClick={() => setShowForm(true)}>{t("创建第一份档案")}</button>}></Empty>}
    </Panel>{activeId ? <Profile id={activeId} /> : <Panel><Empty title={t("选择一位运动员")} ></Empty></Panel>}</div> : null}
  </>;
}
function Profile({ id }: { id: string }) {
  const { data, loading, error, reload } = useData(() => api<AthleteProfile>(`/athletes/${id}/profile`), [id]);
  return <div className="profile-area"><LoadState loading={loading} error={error} retry={reload} />{data ? <>
    <Panel className="profile-header"><span className="avatar large">{data.athlete.name.slice(0, 1)}</span><div><h2>{data.athlete.name}</h2><p>{data.athlete.level} {t("· 自由式摔跤")}</p><small className="muted">{t("建档于")} {dateTime(data.athlete.created_at)}</small></div></Panel>
    <div className="profile-stats"><div><strong>{data.sessions.length}</strong><span>{t("训练场次")}</span></div><div><strong>{data.video_count}</strong><span>{t("视频记录")}</span></div><div><strong>{data.recorded_minutes}</strong><span>{t("累计分钟")}</span></div><div><strong>{data.recorded_load == null || !data.sessions.some(session => session.rpe != null) ? '—' : data.recorded_load}</strong><span>{t("记录负荷 / AU")}</span></div></div>
    {data.analysis ? <AnalysisOverview data={data.analysis} /> : null}
    {data.trends.length ? <Panel title={t("真实测量记录")}>
      <div className="table-wrap"><table><thead><tr><th>{t("日期 / 专项")}</th><th>{t("测量指标")}</th><th>{t("方法版本")}</th><th>{t("来源")}</th></tr></thead><tbody>{data.trends.map((trend, index) => <tr key={`${trend.job_id}-${index}`}><td>{trend.date}<small className="cell-sub">{t(categories[trend.category]?.name)}</small></td><td>{Object.entries(trend.metrics).map(([key, metric]) => <div className="metric-line" key={key}>{t(metric.label)}: <strong>{metric.value === null ? t("无法测量") : `${Number(metric.value.toFixed(3))} ${t(metric.unit)}`}</strong></div>)}</td><td className="mono">{trend.method_version}</td><td className="mono">{trend.job_id.slice(0, 8)}</td></tr>)}</tbody></table></div>
    </Panel> : null}
    <Panel title={t("最近训练场次")}><SessionList sessions={data.sessions} /></Panel>
  </> : null}</div>;
}
function SessionList({ sessions }: { sessions: AthleteProfile['sessions'] }) {
  if (!sessions.length) return <Empty title={t("尚无训练记录")} action={<a className="button secondary" href="#sessions">{t("记录训练")}</a>} />;
  return <div className="table-wrap"><table><thead><tr><th>{t("日期")}</th><th>{t("训练目标")}</th><th>{t("时长")}</th><th>RPE</th></tr></thead><tbody>{sessions.map(session => <tr key={session.id}><td>{session.date}</td><td>{session.objective}</td><td>{session.duration_min} {t("分钟")}</td><td>{session.rpe ?? t("未记录")}</td></tr>)}</tbody></table></div>;
}
