import { t, tx, localeTag } from '../i18n';
import { useEffect } from 'react';
import { api } from '../api';
import { Empty, Icon, JobStatus, LoadState, useData } from '../components';
import { activeJob, backendNames, categories, trainingCategories, dateTime, type Dashboard as DashboardData, type Models } from '../types';
import AnalysisOverview from '../AnalysisOverview';

const channelIcons = { stability: 'target', footwork: 'footwork', attack: 'attack', defense: 'shield' };
const methods = [
  { key: 'rtmpose', name: '姿态分析', model: 'RTMPose' },
  { key: 'tracking', name: '人物轨迹', model: 'ByteTrack' },
  { key: 'sam2', name: '人物分割', model: 'SAM2' },
  { key: 'action', name: 'Qwen3-VL · 动作分析', model: 'Qwen3-VL-2B-Instruct' },
  { key: 'pose3d', name: 'MotionBERT · 三维骨架', model: 'MotionBERT Lite' },
  { key: 'llm', name: '复盘语言模型', model: 'Review language model' },
] as const;


export default function Dashboard() {
  const { data, loading, error, reload } = useData(() => api<DashboardData>('/dashboard'));
  const modelState = useData(() => api<Models>('/models'));
  const seenJobs = new Set<string>();
  const latestJobs = data?.recent_jobs.filter(job => {
    const key = job.video_id ? JSON.stringify([job.video_id, job.backend]) : job.id;
    if (seenJobs.has(key)) return false;
    seenJobs.add(key); return true;
  }) || [];
  const reviewMean = data?.review_scores && data.review_scores.n > 0 && data.review_scores.mean != null && Number.isFinite(data.review_scores.mean) ? data.review_scores.mean : null;
  useEffect(() => {
    if (loading || error || !data?.recent_jobs.some(activeJob)) return;
    const timer = window.setTimeout(reload, 5000);
    return () => window.clearTimeout(timer);
  }, [data, loading, error, reload]);

  return <div className={`studio-dashboard${data?.analysis?.video_count ? ' has-analysis' : ''}`}>
    <LoadState loading={loading && !data} error={error} retry={reload} />
    {data ? <>
      <section className="studio-hero" aria-label={t("女子摔跤数字训练")}>
        <div className="hero-text-area">
          <h1 className="hero-title">{t("训练有据。")}<br />{t("进步有迹。")}</h1>
          <a className="hero-cta" href={data.analysis?.video_count ? '#insights' : '#upload'}>{data.analysis?.video_count ? tx('View training analysis', '查看训练分析') : t("上传训练视频")}<Icon name="arrow" size={20} /></a>
        </div>
        <div className="hero-art-area">
          <span className="mat-circle mat-outer" aria-hidden="true" />
          <span className="mat-circle mat-inner" aria-hidden="true" />
          <img className="hero-svg" src="/images/womens-wrestling.svg" alt={t("女子自由式摔跤低姿对抗插画")} width="900" height="540" fetchPriority="high" />
        </div>
      </section>
      <div className="typographic-stats" aria-label={t("真实训练记录统计")}>
        <Stat label={data.analysis ? tx('Training minutes', '训练分钟') : t("在册运动员")} value={data.analysis ? data.recorded_minutes : data.athlete_count} unit={data.analysis ? tx('min', '分钟') : t("人")} href={data.analysis ? '#sessions' : '#athletes'} />
        <Stat label={data.analysis ? tx('Analyzed videos', '已分析视频') : t("训练场次")} value={data.analysis ? data.analysis.analyzed_videos : data.session_count} unit={data.analysis ? t("段") : t("次")} href={data.analysis ? '#insights' : '#sessions'} />
        <Stat label={reviewMean != null ? tx('Training score', '训练评分') : data.analysis ? tx('Pose checks', '关键点核查') : t("训练视频")} value={reviewMean ?? (data.analysis ? data.analysis.needs_review : data.video_count)} unit={reviewMean != null ? '/10' : t("段")} precision={reviewMean != null ? 1 : undefined} href={reviewMean != null || data.analysis ? '#insights' : '#videos'} />
        <Stat label={data.analysis ? tx('Sampled frames', '采样帧数') : t("待人工复盘")} value={data.analysis ? data.analysis.frames.total : data.pending_review_count} unit={data.analysis ? tx('frames', '帧') : t("项")} href={data.analysis ? '#insights' : '#videos'} accent />
      </div>
      {data.analysis ? <div className="dashboard-analysis"><AnalysisOverview data={data.analysis} compact /></div> : null}
      <div className="studio-grid">
        <section className="studio-column training-column" aria-labelledby="training-title">
          <div className="studio-section-head"><span className="section-num">01</span><h2 id="training-title">{t("专项训练")}</h2><a className="text-link" href="#videos" aria-label={t("打开专项视频库")}><Icon name="arrow" size={20} /></a></div>
          <div className="category-list">{Object.entries(trainingCategories).map(([key, category]) =>
            <a href={`#videos?category=${key}`} className={`category-row ${key}`} key={key}>
              <span className="category-emblem"><Icon name={channelIcons[key as keyof typeof channelIcons]} size={25} /></span>
              <span className="category-copy"><strong>{t(category.name)}</strong></span>
              <span className="category-count">{data.category_counts[key as keyof typeof trainingCategories] || 0}<small>{t("段")}</small></span>
              <Icon name="arrow" size={18} />
            </a>
          )}</div>
          {data.category_counts.mixed ? <a className="text-link mixed-category-link" href="#videos?category=mixed">{t(categories.mixed.name)} · {data.category_counts.mixed} {t("段")}<Icon name="arrow" size={16} /></a> : null}
        </section>
        <section className="studio-column analysis-column" aria-labelledby="analysis-title">
          <div className="studio-section-head"><span className="section-num">02</span><h2 id="analysis-title">{t("AI 分析")}</h2><a className="text-link" href="#models" aria-label={t("查看全部模型状态")}><Icon name="arrow" size={20} /></a></div>
          {modelState.error ? <div className="model-inline-error"><p>{t("暂时无法获取方法状态")}</p><button className="text-link" onClick={modelState.reload}>{t("重新获取")}</button></div> :
            <div className="studio-methods">{methods.map(method => {
              const ready = modelState.data?.[method.key]?.ready;
              return <a className="studio-method" href="#models" key={method.key} title={method.model}>
                <span className="method-copy"><strong>{t(method.name)}</strong></span>
                <span className={`method-availability ${ready ? 'ready' : ''}`}><i />{modelState.loading ? t("检测中") : ready ? t("可使用") : t("未就绪")}</span>
              </a>;
            })}</div>
          }
        </section>
      </div>
      <section className="studio-wellbeing" aria-labelledby="wellbeing-title">
        <div className="studio-section-head"><span className="section-num">03</span><h2 id="wellbeing-title">{t("训练负荷")}</h2></div>
        <div className="wellbeing-bar">
          <div className="wellbeing-total"><Icon name="activity" size={35} /><strong>{data.recorded_minutes.toLocaleString(localeTag())}</strong><span>{t("训练时长 / 分钟")}</span></div>
          <a href="#sessions">{t("记录训练")}<Icon name="arrow" size={18} /></a>
        </div>
      </section>
      <section className="studio-tasks" aria-labelledby="recent-title">
        <div className="studio-section-head"><span className="section-num">04</span><h2 id="recent-title">{tx('Latest video analyses', '最新视频分析')}</h2></div>
        {latestJobs.length ? <div className="table-wrap"><table><thead><tr><th>{t("任务")}</th><th>{t("分析方法")}</th><th>{t("状态")}</th><th>{t("创建时间")}</th><th /></tr></thead><tbody>{latestJobs.map(job => <tr key={job.id}><td className="mono">{job.id.slice(0, 8)}</td><td>{t(backendNames[job.backend])}</td><td><JobStatus job={job} showAssessment={false} /></td><td>{dateTime(job.created_at)}</td><td>{job.video_id ? <a className="text-link" href={`#videos/${encodeURIComponent(job.video_id)}?job=${encodeURIComponent(job.id)}`}>{t("查看报告")}<Icon name="arrow" size={14} /></a> : <span className="muted">—</span>}</td></tr>)}</tbody></table></div> :
          <Empty title={t("暂无分析任务")} action={<div className="empty-actions"><a className="button secondary" href="#athletes">{t("建立运动员档案")}</a><a className="button coral" href="#upload">{t("上传训练视频")}<Icon name="arrow" size={16} /></a></div>} />
        }
      </section>

    </> : null}
  </div>;
}

function Stat({ label, value, unit, href, accent = false, precision }: { label: string; value: number; unit: string; href: string; accent?: boolean; precision?: number }) {
  return <a href={href} className={`stat-item ${accent ? 'stat-review' : ''}`}><span className="stat-label">{label}<Icon name="arrow" size={15} /></span><span className="stat-value">{value.toLocaleString(localeTag(), precision == null ? undefined : { minimumFractionDigits: precision, maximumFractionDigits: precision })}<small>{unit}</small></span></a>;
}
