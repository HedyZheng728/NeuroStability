import { t, tx, getLocale } from '../i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { api, post, put } from '../api';
import { Field, Icon, Panel, Synthetic, type Notify } from '../components';
import { dateTime, errorMessage, reviewDraftVisible, draftDisplayText, type Job, type Report, type ReviewDraft } from '../types';

export default function ReviewPanel({ videoId, job, report, reload, notify, llmReady = false }: { videoId: string; job: Job | undefined; report: Report; reload: () => void; notify: Notify; llmReady?: boolean }) {
  const [provider, setProvider] = useState('rules');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [observations, setObservations] = useState(report.review?.observations || '');
  const [nextAction, setNextAction] = useState(report.review?.next_action || '');
  const [confirmed, setConfirmed] = useState(report.review?.confirmed || false);
  const [draftId, setDraftId] = useState<string | undefined>(report.review?.draft_id || undefined);
  const [draftSelected, setDraftSelected] = useState<string>('');
  const [queuedJobId, setQueuedJobId] = useState('');
  const pendingDraft = (report.jobs || []).find(item => String(item.backend) === 'review_draft' && ['queued', 'running'].includes(item.status));
  const waitingJobId = queuedJobId || pendingDraft?.id || '';
  const visibleDrafts = report.drafts.filter(reviewDraftVisible);
  const draft = visibleDrafts.find(item => item.id === draftSelected) || visibleDrafts[0];
  const usedDraft = visibleDrafts.find(item => item.id === draftId);
  const completed = !!report.review?.confirmed && !!report.review.observations.trim();
  useEffect(() => {
    setObservations(report.review?.observations || ''); setNextAction(report.review?.next_action || ''); setConfirmed(report.review?.confirmed || false); setDraftId(report.review?.draft_id || undefined);
  }, [report.review?.updated_at]);
  useEffect(() => {
    if (!waitingJobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const latest = await api<Job>(`/jobs/${waitingJobId}`);
        if (!active) return;
        if (!['queued', 'running'].includes(latest.status)) {
          setQueuedJobId(''); reload();
          if (latest.status === 'completed') notify("复盘草稿已生成，请核对后编辑。", 'success');
          else notify(latest.error || tx('Review generation failed', '复盘生成失败'), 'error');
          return;
        }
      } catch { /* The task remains on the server during a temporary connection loss. */ }
      if (active) timer = setTimeout(poll, 3000);
    }
    timer = setTimeout(poll, 1000);
    return () => { active = false; clearTimeout(timer); };
  }, [waitingJobId, reload, notify]);
  async function generate() {
    if (!job) return; setGenerating(true);
    try { const value = await post<ReviewDraft & { status?: string }>(`/videos/${videoId}/review-drafts`, { job_id: job.id, provider, language: getLocale() }); setDraftSelected(value.id); if (value.status === 'queued' && value.job_id) { setQueuedJobId(value.job_id); notify(tx('Queued for analysis on your computer', '已排队，等待电脑分析'), 'success'); } else notify("复盘草稿已生成，请核对后编辑。", 'success'); reload(); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setGenerating(false); }
  }
  function useDraft() {
    if (!draft) return;
    setObservations(draftDisplayText(draft)); setDraftId(draft.id); setConfirmed(false); notify("草稿已载入观察区，请结合视频修改并填写下一步训练安排。", 'success');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true);
    try { await put(`/videos/${videoId}/review`, { draft_id: draftId, observations: observations.trim(), next_action: nextAction.trim(), confirmed }); reload(); notify(confirmed ? "训练复盘已完成并保存。" : "训练复盘已保存。", 'success'); }
    catch (err) { notify(errorMessage(err), 'error'); } finally { setSaving(false); }
  }
  const draftTools = <div className="draft-area"><h3>{t("辅助复盘草稿")}</h3><div className="draft-controls"><select aria-label={t("草稿生成方式")} value={provider} onChange={event => setProvider(event.target.value)}><option value="rules">{t("规则草稿 · 按指标整理")}</option><option value="llm" disabled={!llmReady}>{t("语言模型草稿")}{llmReady ? '' : t(" · 服务未配置")}</option></select><button className="button secondary small" disabled={generating || !!waitingJobId || !job?.result} onClick={generate}>{waitingJobId ? tx('Waiting for computer', '等待电脑处理') : generating ? t("正在生成…") : t("生成草稿")}</button></div>
    {visibleDrafts.length ? <><Field label={t("历史草稿")}><select value={draft?.id || ''} onChange={event => setDraftSelected(event.target.value)}>{visibleDrafts.map(item => <option value={item.id} key={item.id}>{item.provider === 'llm' ? t("语言模型") : t("规则")} · {dateTime(item.created_at)}{item.synthetic ? t(" · 合成样例") : ''}</option>)}</select></Field><div className="draft-text"><Synthetic value={draft?.synthetic} /><pre>{draft ? draftDisplayText(draft) : null}</pre><small>{draft?.provider === 'llm' ? tx(`Model: ${draft.model || t("未返回型号")}`, `语言模型：${draft.model || t("未返回型号")}`) : t("生成方式：规则整理")}</small></div><button className="text-link" onClick={useDraft}>{t("载入人工编辑区")}<Icon name="arrow" size={16} /></button></> : !completed ? <div className="draft-empty">{t("尚无草稿，可直接在右侧撰写复盘。")}</div> : null}
  </div>;
  const reviewForm = <form className="review-form" onSubmit={save}><h3>{tx('Review observations', '复盘观察')}</h3><Synthetic value={usedDraft?.synthetic} />{usedDraft ? <small className="muted">{tx(`Linked ${usedDraft.provider === 'llm' ? 'language model' : 'rules'} draft`, `已关联${usedDraft.provider === 'llm' ? '语言模型' : '规则'}草稿`)} · {dateTime(usedDraft.created_at)}</small> : null}<Field label={tx('Review observations', '复盘观察')}><textarea rows={7} required maxLength={10000} value={observations} onChange={event => { setObservations(event.target.value); setConfirmed(false); }} placeholder={tx('Record observations from the video, events and measurement quality', '结合视频、事件标注与测量质量记录观察')} /></Field><Field label={t("下一步训练安排")}><textarea rows={4} required maxLength={5000} value={nextAction} onChange={event => { setNextAction(event.target.value); setConfirmed(false); }} placeholder={t("填写可执行的训练重点与后续观察事项")} /></Field><label className="checkbox-label authorization"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>{tx('Review complete', '复盘完成')}</span></label><button className="button" disabled={saving}><Icon name="check" size={18} />{saving ? t("正在保存…") : tx('Save review', '保存复盘')}</button>{report.review ? <small className="muted review-saved">{t("最近保存：")}{dateTime(report.review.updated_at)}{report.review.confirmed_by ? tx(` · Reviewer ${report.review.confirmed_by}`, ` · 复盘账号 ${report.review.confirmed_by}`) : ''}</small> : null}</form>;
  return <Panel title={tx('Training review', '训练复盘')} action={report.review ? <span className={`status ${report.review.confirmed ? 'success' : 'warning'}`}><i />{report.review.confirmed ? tx('Review complete', '复盘完成') : tx('In progress', '复盘中')}</span> : undefined}>
    <div className="review-layout" style={completed ? { gridTemplateColumns: '1fr' } : undefined}>{completed ? <>{reviewForm}<details><summary>{tx('Reference drafts', '参考草稿')}</summary>{draftTools}</details></> : <>{draftTools}{reviewForm}</>}</div>
  </Panel>;
}
