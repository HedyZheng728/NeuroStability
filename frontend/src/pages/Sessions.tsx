import { t, tx } from '../i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { api, post } from '../api';
import { Empty, Field, Icon, LoadState, PageHeader, Panel, useData, type Notify } from '../components';
import { errorMessage, type Athlete, type Session } from '../types';

import { localDate, type TrainingPlan } from '../planningTypes';
export default function Sessions({ notify, planId = '' }: { notify: Notify; planId?: string }) {
  const { data, loading, error, reload } = useData(async () => { const [sessions, athletes, plans] = await Promise.all([api<Session[]>('/sessions'), api<Athlete[]>('/athletes'), planId ? api<TrainingPlan[]>('/plans') : Promise.resolve([])]); const plan = plans.find(item => item.id === planId); if (planId && (!plan || plan.status !== 'planned')) throw new Error(tx('This plan is unavailable or already completed.', '此计划不可用或已完成。')); return { sessions, athletes, plan, planId }; }, [planId]);
  const [showForm, setShowForm] = useState(!!planId);
  useEffect(() => { if (planId) setShowForm(true); }, [planId]);
  const [saving, setSaving] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true);
    const form = event.currentTarget; const value = new FormData(form); const rpe = String(value.get('rpe') || '');
    try {
      await post('/sessions', { ...(data?.plan ? { plan_id: data.plan.id } : {}), athlete_id: value.get('athlete_id'), date: value.get('date'), objective: String(value.get('objective')).trim(), duration_min: Number(value.get('duration_min')), rpe: rpe === '' ? null : Number(rpe), notes: String(value.get('notes') || '').trim() });
      form.reset(); setShowForm(false); if (data?.plan) window.location.hash = 'sessions'; else reload(); notify("训练场次已保存，可关联上传视频。", 'success');
    } catch (err) { notify(errorMessage(err), 'error'); } finally { setSaving(false); }
  }
  return <>
    <PageHeader title={t("训练场次")} action={<button className="button" onClick={() => setShowForm(!showForm)}><Icon name="plus" size={18} />{t("记录训练")}</button>} />
    <LoadState loading={loading} error={error} retry={reload} />
    {showForm && data && data.planId === planId ? <Panel title={t("新增训练记录")}>
      {data.athletes.length ? <form key={planId} onSubmit={create} className="form-grid">
        <Field label={t("运动员")}><select name="athlete_id" required defaultValue={data.plan?.athlete_id || ""}><option value="" disabled>{t("选择运动员")}</option>{data.athletes.map(athlete => <option value={athlete.id} key={athlete.id}>{athlete.name} · {athlete.level}</option>)}</select></Field>
        <Field label={t("训练日期")}><input name="date" type="date" required defaultValue={data.plan?.date || localDate()} /></Field>
        <Field label={t("训练时长 / 分钟")}><input name="duration_min" type="number" required min="1" max="1440" step="1" placeholder={data.plan ? tx(`Planned: ${data.plan.planned_minutes} min`, `计划：${data.plan.planned_minutes} 分钟`) : t("实际训练时长")} /></Field>
        <Field label={t("主观用力程度 / RPE")}><input name="rpe" type="number" min="0" max="10" step="1" placeholder={t("选填，0–10")} /></Field>
        <div className="span-2"><Field label={t("本次训练目标")}><input name="objective" required maxLength={500} defaultValue={data.plan?.objective || ""} placeholder={t("例如：记录本次训练的实际目标")} /></Field></div>
        <div className="span-2"><Field label={t("训练备注")}><textarea name="notes" rows={3} maxLength={5000} placeholder={t("可记录训练内容、疲劳与恢复感受，以及需要复盘的问题")} /></Field></div>
        <div className="form-actions span-2"><button className="button" disabled={saving}>{saving ? t("正在保存…") : t("保存训练记录")}</button><button className="button secondary" type="button" onClick={() => setShowForm(false)}>{t("取消")}</button></div>
      </form> : <Empty title={t("先创建运动员档案")} action={<a className="button" href="#athletes">{t("前往建档")}</a>}></Empty>}
    </Panel> : null}
    {data ? <Panel title={t("训练记录")}>
      {data.sessions.length ? <div className="table-wrap"><table><thead><tr><th>{t("日期")}</th><th>{t("运动员")}</th><th>{t("训练目标")}</th><th>{t("时长 / RPE")}</th><th>{t("记录负荷")}</th><th /></tr></thead><tbody>{data.sessions.map(session => <tr key={session.id}><td className="nowrap">{session.date}</td><td>{session.athlete_name || data.athletes.find(athlete => athlete.id === session.athlete_id)?.name || '—'}</td><td>{session.objective}{session.notes ? <small className="cell-sub">{session.notes}</small> : null}</td><td className="nowrap">{session.duration_min} {t("分钟")}<small className="cell-sub">RPE {session.rpe ?? t("未记录")}</small></td><td>{session.rpe === null ? <span className="muted">{t("未记录")}</span> : `${session.duration_min * session.rpe} AU`}</td><td><a className="text-link nowrap" href={`#upload?session=${session.id}`}>{t("上传视频")}</a></td></tr>)}</tbody></table></div> : <Empty title={t("还没有训练场次")} action={<button className="button secondary" onClick={() => setShowForm(true)}>{t("记录第一场训练")}</button>}></Empty>}
    </Panel> : null}
  </>;
}
