import { useState, type FormEvent } from 'react';
import { api, post } from '../api';
import { Empty, Field, Icon, LoadState, PageHeader, Panel, useData, type Notify } from '../components';
import { t, tx } from '../i18n';
import { localDate, type TrainingPlan } from '../planningTypes';
import { trainingCategories, errorMessage, type Athlete } from '../types';

export default function Planning({ notify }: { notify: Notify }) {
  const { data, loading, error, reload } = useData(async () => {
    const [plans, athletes] = await Promise.all([api<TrainingPlan[]>('/plans'), api<Athlete[]>('/athletes')]);
    return { plans, athletes };
  });
  const [showForm, setShowForm] = useState(false);
  const [athlete, setAthlete] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const visible = (data?.plans || []).filter(plan => (!athlete || plan.athlete_id === athlete) && (!status || plan.status === status));

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const value = new FormData(form); setBusy(true);
    try {
      await post('/plans', {
        athlete_id: value.get('athlete_id'), date: value.get('date'), category: value.get('category'),
        objective: String(value.get('objective') || '').trim(), planned_minutes: Number(value.get('planned_minutes')),
      });
      form.reset(); setShowForm(false); reload(); notify(tx('Plan created.', '计划已创建。'));
    } catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }
  async function changeStatus(plan: TrainingPlan, next: 'planned' | 'cancelled') {
    setBusy(true);
    try {
      await api(`/plans/${plan.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      reload(); notify(tx('Plan updated.', '计划已更新。'));
    } catch (err) { notify(errorMessage(err), 'error'); } finally { setBusy(false); }
  }

  return <>
    <PageHeader title={tx('Training plans', '训练计划')} description="" action={<button className="button" onClick={() => setShowForm(!showForm)}><Icon name="plus" size={18} />{tx('Schedule training', '安排训练')}</button>} />
    <LoadState loading={loading} error={error} retry={reload} />
    {showForm && data ? <Panel title={tx('New plan', '新建计划')}>
      {data.athletes.length ? <form className="form-grid" onSubmit={create}>
        <Field label={tx('Athlete', '运动员')}><select name="athlete_id" required defaultValue={athlete}><option value="" disabled>{tx('Select athlete', '选择运动员')}</option>{data.athletes.map(person => <option value={person.id} key={person.id}>{person.name}</option>)}</select></Field>
        <Field label={tx('Date', '日期')}><input name="date" type="date" required defaultValue={localDate()} /></Field>
        <Field label={tx('Focus', '专项')}><select name="category" required>{Object.entries(trainingCategories).map(([key, value]) => <option value={key} key={key}>{t(value.name)}</option>)}</select></Field>
        <Field label={tx('Planned minutes', '计划时长 / 分钟')}><input name="planned_minutes" type="number" min="1" max="1440" step="1" required /></Field>
        <div className="span-2"><Field label={tx('Objective', '目标')}><input name="objective" required maxLength={500} /></Field></div>
        <div className="form-actions span-2"><button className="button" disabled={busy}>{busy ? tx('Saving…', '保存中…') : tx('Save plan', '保存计划')}</button><button className="button secondary" type="button" onClick={() => setShowForm(false)}>{tx('Cancel', '取消')}</button></div>
      </form> : <Empty title={tx('Add an athlete first', '先添加运动员')} action={<a className="button" href="#athletes">{tx('Add athlete', '添加运动员')}</a>} />}
    </Panel> : null}
    {data ? <>
      <div className="record-toolbar">
        <select aria-label={tx('Filter athlete', '筛选运动员')} value={athlete} onChange={event => setAthlete(event.target.value)}><option value="">{tx('All athletes', '全部运动员')}</option>{data.athletes.map(person => <option value={person.id} key={person.id}>{person.name}</option>)}</select>
        <select aria-label={tx('Filter status', '筛选状态')} value={status} onChange={event => setStatus(event.target.value)}><option value="">{tx('All plans', '全部计划')}</option><option value="planned">{tx('Scheduled', '待执行')}</option><option value="completed">{tx('Completed', '已完成')}</option><option value="cancelled">{tx('Cancelled', '已取消')}</option></select>
        <span className="record-count">{visible.length} {tx('plans', '项计划')}</span>
      </div>
      <Panel title={tx('Schedule', '训练日程')}>
        {visible.length ? <div className="table-wrap"><table><thead><tr><th>{tx('Date', '日期')}</th><th>{tx('Athlete', '运动员')}</th><th>{tx('Focus / objective', '专项 / 目标')}</th><th>{tx('Minutes', '分钟')}</th><th>{tx('Status', '状态')}</th><th /></tr></thead><tbody>{visible.map(plan => <tr key={plan.id}>
          <td className="nowrap">{plan.date}</td><td>{plan.athlete_name || data.athletes.find(person => person.id === plan.athlete_id)?.name || '—'}</td>
          <td><strong>{t(trainingCategories[plan.category]?.name || plan.category)}</strong><span className="cell-sub plan-objective">{plan.objective}</span></td><td>{plan.planned_minutes}</td>
          <td><span className={`status ${plan.status === 'completed' ? 'success' : 'neutral'}`}><i />{plan.status === 'completed' ? tx('Completed', '已完成') : plan.status === 'cancelled' ? tx('Cancelled', '已取消') : tx('Scheduled', '待执行')}</span></td>
          <td><div className="inline-actions">{plan.status === 'planned' ? <><a className="text-link nowrap" href={`#sessions?plan=${plan.id}`}>{tx('Log session', '记录训练')}<Icon name="arrow" size={14} /></a><button className="text-link" disabled={busy} onClick={() => changeStatus(plan, 'cancelled')}>{tx('Cancel plan', '取消计划')}</button></> : plan.status === 'cancelled' ? <button className="text-link" disabled={busy} onClick={() => changeStatus(plan, 'planned')}>{tx('Restore', '恢复')}</button> : null}</div></td>
        </tr>)}</tbody></table></div> : <Empty title={tx('No training plans', '暂无训练计划')} action={<button className="button secondary" onClick={() => setShowForm(true)}>{tx('Schedule training', '安排训练')}</button>} />}
      </Panel>
    </> : null}
  </>;
}
