import { t, tx } from '../i18n';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Empty, Icon, JobStatus, LoadState, PageHeader, Panel, Status, Synthetic, useData } from '../components';
import { activeJob, categories, dateTime, fileSize, type Athlete, type Category, type Video } from '../types';

export default function VideoLibrary({ initialCategory = '' }: { initialCategory?: string }) {
  const [category, setCategory] = useState(initialCategory in categories ? initialCategory : '');
  const [athleteId, setAthleteId] = useState('');
  const athletes = useData(() => api<Athlete[]>('/athletes'));
  const { data, loading, error, reload } = useData(() => {
    const query = new URLSearchParams();
    if (category) query.set('category', category);
    if (athleteId) query.set('athlete_id', athleteId);
    return api<Video[]>(`/videos?${query}`);
  }, [category, athleteId]);
  useEffect(() => {
    if (loading || error || !data?.some(video => video.latest_job && activeJob(video.latest_job))) return;
    const timer = window.setTimeout(reload, 5000);
    return () => window.clearTimeout(timer);
  }, [data, loading, error, reload]);
  return <>
    <PageHeader title={t("专项视频库")} action={<a className="button" href="#upload"><Icon name="upload" size={18} />{t("上传视频")}</a>} />
    <div className="library-toolbar"><div className="tabs" role="group" aria-label={t("按专项筛选")}><button className={!category ? 'active' : ''} onClick={() => setCategory('')}>{t("全部视频")}</button>{Object.entries(categories).map(([key, value]) => <button key={key} className={category === key ? 'active' : ''} onClick={() => setCategory(key)}>{t(value.name)}</button>)}</div><label className="filter-field"><span>{t("运动员")}</span><select value={athleteId} onChange={event => setAthleteId(event.target.value)}><option value="">{t("全部运动员")}</option>{athletes.data?.map(athlete => <option value={athlete.id} key={athlete.id}>{athlete.name}</option>)}</select></label></div>
    {athletes.error ? <LoadState loading={false} error={athletes.error} retry={athletes.reload} /> : null}
    <LoadState loading={loading && !data} error={error} retry={reload} />
    {data ? <Panel title={category ? tx(`${t(categories[category as Category].name)} videos`, `${t(categories[category as Category].name)}训练视频`) : t("全部训练视频")}>
      {data.length ? <div className="table-wrap"><table><thead><tr><th>{t("视频")}</th><th>{t("运动员 / 训练日期")}</th><th>{t("专项")}</th><th>{tx("Training score", "训练评分")}</th><th>{tx("Analysis", "数据状态")}</th><th>{t("复盘")}</th><th /></tr></thead><tbody>{data.map(video => <tr key={video.id}><td><a className="video-name" href={`#videos/${video.id}`}><span className="file-symbol"><Icon name="video" /></span><span><strong>{video.filename}</strong><small className="cell-sub">{fileSize(video.size_bytes)} · {dateTime(video.created_at)}</small>{video.latest_job?.backend === 'sample' || video.latest_job?.result?.synthetic ? <Synthetic value /> : null}</span></a></td><td>{video.athlete_name || '—'}<small className="cell-sub">{video.session_date || '—'}</small></td><td className="nowrap">{t(categories[video.category]?.name)}</td><td>{video.score ? <strong className={video.score.confirmed ? "confirmed-text" : "muted"} title={video.score.confirmed ? tx("Reviewed", "已审核") : tx("Not reviewed", "未审核")}>{video.score.score.toFixed(1)}</strong> : <span className="muted">—</span>}</td><td>{video.latest_job ? <JobStatus job={video.latest_job} showAssessment={false} /> : <Status value={video.status} />}</td><td className="nowrap"><span className={video.review?.confirmed ? 'confirmed-text' : 'muted'}>{video.review?.confirmed ? tx("Review complete", "复盘完成") : tx("Not reviewed", "未复盘")}</span></td><td><a className="text-link nowrap" href={`#videos/${video.id}`}>{t("打开")}<Icon name="arrow" size={16} /></a></td></tr>)}</tbody></table></div> : <Empty title={category || athleteId ? t("没有符合条件的视频") : t("视频库尚为空")} action={<a className="button secondary" href="#upload">{t("上传训练视频")}</a>}></Empty>}
    </Panel> : null}
  </>;
}
