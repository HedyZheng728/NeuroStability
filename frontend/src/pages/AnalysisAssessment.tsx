import { useEffect, useState, type FormEvent } from 'react';
import { api, put } from '../api';
import { Field, LoadState, Panel, useData, type Notify } from '../components';
import { tx } from '../i18n';
import { dateTime, errorMessage, type AnalysisAssessment as Assessment, type AssessmentDecision, type AssessmentHistory, type Job, type SubjectRole } from '../types';

function decisionLabel(decision: AssessmentDecision) {
  return {
    accepted: tx('Reviewed · experimental', '已核查·实验性'),
    excluded: tx('Not adopted', '本次不采纳'),
    superseded: tx('Superseded', '已有后续分析'),
    pending: tx('Pending', '待核查'),
  }[decision];
}
function roleLabel(role: SubjectRole) {
  return { athlete: tx('Athlete', '运动员'), coach: tx('Coach', '教练'), unknown: tx('Unknown', '未确定') }[role];
}

export default function AnalysisAssessment({ job, reload, notify }: { job: Job; reload: () => void; notify: Notify }) {
  const eligible = ['rtmpose', 'rtmpose_tracking', 'sam2'].includes(job.backend)
    && ['completed', 'needs_review'].includes(job.status) && job.result?.synthetic === false;
  const state = useData(() => eligible ? api<{ current: Assessment | null; history: AssessmentHistory[] }>(`/jobs/${job.id}/assessment`) : Promise.resolve(null), [job.id, eligible]);
  const current = state.data ? state.data.current : job.assessment || null;
  const [decision, setDecision] = useState<AssessmentDecision>(current?.decision || 'pending');
  const [subjectRole, setSubjectRole] = useState<SubjectRole>(current?.subject_role || 'unknown');
  const [reason, setReason] = useState(current?.reason || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setDecision(current?.decision || 'pending'); setSubjectRole(current?.subject_role || 'unknown'); setReason(current?.reason || '');
  }, [current?.updated_at]);
  if (!eligible) return null;
  const history = state.data?.history || [];
  const disabled = saving || state.loading || !!state.error;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (disabled) return;
    if (decision !== 'pending' && !reason.trim()) { setError(tx('Enter a reason for this decision.', '请填写本次处理的依据。')); return; }
    if (reason.trim().length > 5000) { setError(tx('The reason must be 5,000 characters or fewer.', '处理依据不能超过 5000 字。')); return; }
    if (decision === 'accepted' && subjectRole !== 'athlete') { setError(tx('Confirm the person is an athlete before accepting measurements.', '采纳测量前请确认分析对象为运动员。')); return; }
    setSaving(true);
    try {
      const updated = await put<Assessment>(`/jobs/${job.id}/assessment`, { decision, subject_role: subjectRole, reason: reason.trim() });
      state.setData(previous => ({ current: updated, history: previous?.history || [] }));
      state.reload(); reload(); notify(tx('Measurement assessment saved.', '测量处理已保存。'), 'success');
    } catch (err) { notify(errorMessage(err), 'error'); } finally { setSaving(false); }
  }
  return <Panel title={tx('Measurement assessment', '测量处理')}>
    <LoadState loading={state.loading} error={state.error} retry={state.reload} />
    <form className="form-grid" onSubmit={save}>
      <Field label={tx('Decision', '处理结论')}><select name="decision" value={decision} disabled={disabled} onChange={event => setDecision(event.target.value as AssessmentDecision)}>{(['pending', 'accepted', 'excluded', 'superseded'] as const).map(value => <option value={value} key={value}>{decisionLabel(value)}</option>)}</select></Field>
      <Field label={tx('Person in analysis', '分析对象')}><select name="subject_role" value={subjectRole} disabled={disabled} onChange={event => setSubjectRole(event.target.value as SubjectRole)}>{(['unknown', 'athlete', 'coach'] as const).map(value => <option value={value} key={value}>{roleLabel(value)}</option>)}</select></Field>
      <div className="span-2"><Field label={tx('Reason', '处理依据')}><textarea name="reason" rows={3} maxLength={5000} required={decision !== 'pending'} value={reason} disabled={disabled} onChange={event => setReason(event.target.value)} /></Field></div>
      <div className="form-actions span-2"><button className="button" disabled={disabled}>{saving ? tx('Saving…', '保存中…') : tx('Save assessment', '保存处理')}</button>{current ? <small className="muted">{tx('Reviewer', '核查账号')}: {current.reviewer} · <time dateTime={current.updated_at}>{dateTime(current.updated_at)}</time></small> : null}</div>
      {error ? <p className="notice error span-2" role="alert">{error}</p> : null}
    </form>
    <details className="score-history"><summary>{tx('Assessment history', '处理历史')} · {history.length}</summary>{history.length ? <div className="table-wrap"><table><thead><tr><th>{tx('Recorded', '记录时间')}</th><th>{tx('Decision', '处理结论')}</th><th>{tx('Person in analysis', '分析对象')}</th><th>{tx('Reason', '处理依据')}</th><th>{tx('Reviewer', '核查账号')}</th></tr></thead><tbody>{history.map(entry => <tr key={entry.id}><td><time dateTime={entry.created_at}>{dateTime(entry.created_at)}</time></td><td>{decisionLabel(entry.snapshot.decision)}</td><td>{roleLabel(entry.snapshot.subject_role)}</td><td className="score-comment">{entry.snapshot.reason || '—'}</td><td>{entry.snapshot.reviewer}</td></tr>)}</tbody></table></div> : <p className="muted">{tx('No assessment history', '暂无处理历史')}</p>}</details>
  </Panel>;
}
