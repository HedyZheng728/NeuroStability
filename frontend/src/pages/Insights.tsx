import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Empty, Field, Icon, LoadState, PageHeader, Panel, useData } from '../components';
import { t, tx, localeTag } from '../i18n';
import { localDate, type Distribution, type InsightsData, type PeriodFilters } from '../planningTypes';
import { categories, type Athlete } from '../types';
import AnalysisOverview from '../AnalysisOverview';

function number(value: number | null | undefined) { return value == null ? '—' : new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 1 }).format(value); }

export default function Insights() {
  const [applied, setApplied] = useState<PeriodFilters>(() => ({ start: '', end: '', athlete_id: '' }));
  const [validation, setValidation] = useState('');
  const [measure, setMeasure] = useState<'minutes' | 'load_au'>('minutes');
  const [filterRevision, setFilterRevision] = useState(0);
  const query = new URLSearchParams({ ...(applied.start ? { start: applied.start } : {}), ...(applied.end ? { end: applied.end } : {}), ...(applied.athlete_id ? { athlete_id: applied.athlete_id } : {}) }).toString();
  const { data, loading, error, reload } = useData(() => api<InsightsData>(`/insights${query ? `?${query}` : ''}`), [query]);
  const athletes = useData(() => api<Athlete[]>('/athletes'));
  const ready = data && !loading && !error && (!applied.start || data.filters.start === applied.start) && (!applied.end || data.filters.end === applied.end) && (data.filters.athlete_id || '') === applied.athlete_id;
  const exportQuery = data ? new URLSearchParams({ start: data.filters.start, end: data.filters.end, ...(data.filters.athlete_id ? { athlete_id: data.filters.athlete_id } : {}) }).toString() : '';
  const maximum = Math.max(1, ...(data?.weekly || []).map(week => week[measure] ?? 0));
  const athleteName = athletes.data?.find(person => person.id === applied.athlete_id)?.name || tx('All athletes', '全部运动员');

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const filters = { start: String(values.get('start')), end: String(values.get('end')), athlete_id: String(values.get('athlete_id') || '') };
    if (filters.start > filters.end) { setValidation(tx('Start date must precede end date.', '开始日期不能晚于结束日期。')); return; }
    setValidation('');
    if (filters.start === applied.start && filters.end === applied.end && filters.athlete_id === applied.athlete_id) reload();
    else setApplied({ ...filters });
  }
  return <>
    <PageHeader title={tx('Insights', '数据分析')} description="" action={<div className="insight-actions"><a className={`button ${!ready ? 'disabled' : ''}`} href={ready ? `/api/insights/analyses.csv?${exportQuery}` : undefined} aria-disabled={!ready}><Icon name="download" size={17} />{tx('Analysis CSV', '分析 CSV')}</a><a className={`button secondary ${!ready ? 'disabled' : ''}`} href={ready ? `/api/insights/export?${exportQuery}` : undefined} aria-disabled={!ready}>{tx('Research ZIP', '研究 ZIP')}</a><button className="button secondary" disabled={!ready} onClick={() => window.print()}>{tx('Print report', '打印报告')}</button></div>} />
    {data ? <><div className="period-shortcuts"><button className={!applied.start ? 'active' : ''} onClick={() => { setApplied({ start: '', end: '', athlete_id: applied.athlete_id }); setFilterRevision(value => value + 1); reload(); }}>{tx('All training', '全部训练')}</button><button onClick={() => { setApplied({ start: localDate(-55), end: localDate(), athlete_id: applied.athlete_id }); setFilterRevision(value => value + 1); reload(); }}>{tx('Last 8 weeks', '最近 8 周')}</button></div>
    <form className="insight-filters" key={`${data.filters.start}:${data.filters.end}:${data.filters.athlete_id}:${filterRevision}`} onSubmit={apply}>
      <Field label={tx('Athlete', '运动员')}><select name="athlete_id" defaultValue={data.filters.athlete_id || ''}><option value="">{tx('All athletes', '全部运动员')}</option>{athletes.data?.map(person => <option value={person.id} key={person.id}>{person.name}</option>)}</select></Field>
      <Field label={tx('From', '开始日期')}><input name="start" type="date" required defaultValue={data.filters.start} /></Field>
      <Field label={tx('To', '结束日期')}><input name="end" type="date" required defaultValue={data.filters.end} /></Field>
      <button className="button" type="submit">{tx('Apply', '应用')}</button>
    </form></> : null}
    {validation ? <div className="notice error" role="alert">{validation}</div> : null}
    <LoadState loading={loading} error={error} retry={reload} />
    {ready ? <div className="insight-report">
      <div className="print-heading"><h1>NeuroStability Arena</h1><p>{athleteName} · {data.filters.start} – {data.filters.end}</p></div>
      <TrainingReviewOverview summary={data.summary} scores={data.manual_scores} />
      {data.analysis ? <AnalysisOverview data={data.analysis} /> : null}
      <div className="insight-totals">
        <div><span>{tx('Sessions', '训练场次')}</span><strong>{number(data.summary.session_count)}</strong></div>
        <div><span>{tx('Minutes', '训练分钟')}</span><strong>{number(data.summary.total_minutes)}</strong></div>
        <div><span>{tx('sRPE load / AU', 'sRPE 负荷 / AU')}</span><strong>{number(data.summary.load_au)}</strong></div>
        <div><span>{tx('Plan completion', '计划完成率')}</span><strong>{data.planning.completion_rate == null ? '—' : `${number(data.planning.completion_rate * 100)}%`}</strong><span className="count-fraction">{data.planning.completed_count} / {data.planning.due_count}</span></div>
      </div>
      <div className="insight-columns">
        <Panel title={tx('Weekly training', '每周训练')} action={<select className="compact-select" aria-label={tx('Chart measure', '图表指标')} value={measure} onChange={event => setMeasure(event.target.value as 'minutes' | 'load_au')}><option value="minutes">{tx('Minutes', '分钟')}</option><option value="load_au">{tx('sRPE load / AU', 'sRPE 负荷 / AU')}</option></select>}>
          {data.summary.session_count ? <div className="weekly-chart" role="img" aria-label={measure === 'minutes' ? tx('Training minutes by week', '每周训练分钟') : tx('Recorded sRPE load by week', '每周记录的 sRPE 负荷')}>
            {data.weekly.map(week => <div className="week-row" key={week.week_start} title={`${week.week_start} · ${week.session_count} ${tx('sessions', '场训练')} · ${week.rpe_recorded} RPE`}><time dateTime={week.week_start}>{week.week_start.slice(5)}</time><div className="week-track"><span style={{ width: `${(week[measure] ?? 0) / maximum * 100}%` }} /></div><strong>{number(week[measure])}</strong></div>)}
          </div> : <Empty title={tx('No sessions in this period', '此时段暂无训练')} />}
        </Panel>
        <Panel title={tx('Coverage', '数据覆盖')}><dl className="coverage-list">
          <div><dt>{tx('RPE recorded', 'RPE 记录')}</dt><dd>{data.summary.rpe_recorded} / {data.summary.session_count}</dd></div>
          <div><dt>{tx('Videos reviewed', '视频已复核')}</dt><dd>{data.summary.reviewed_videos} / {data.summary.video_count}</dd></div>
          <div><dt>{tx('Verified analyses', '已确认测量')}</dt><dd>{data.summary.verified_measurements}</dd></div>
          <div><dt>{tx('Manual annotations', '人工标注')}</dt><dd>{data.summary.annotation_count}</dd></div>
        </dl></Panel>
      </div>
      <Panel title={tx('Descriptive statistics', '描述统计')}><div className="table-wrap"><table><thead><tr><th>{tx('Measure', '指标')}</th><th>n</th><th>{tx('Median', '中位数')}</th><th>Q1</th><th>Q3</th></tr></thead><tbody><StatisticsRow label={tx('Duration / min', '时长 / 分钟')} value={data.statistics.duration_min} /><StatisticsRow label="RPE" value={data.statistics.rpe} /></tbody></table></div></Panel>
      <Panel title={tx('Training library', '专项视频')}><div className="insight-categories">{Object.entries(categories).map(([key, category]) => <a href={`#videos?category=${key}`} key={key}><span>{t(category.name)}</span><strong>{data.category_counts[key as keyof typeof categories] || 0}</strong></a>)}</div></Panel>
    </div> : null}
  </>;
}

function TrainingReviewOverview({ summary, scores }: { summary: InsightsData['summary']; scores: InsightsData['manual_scores'] }) {
  const distribution = scores?.distribution || [];
  const byCategory = Object.entries(scores?.by_category || {});
  const maximum = Math.max(1, ...distribution.map(row => row.n));
  const label = `${tx('Reviewed score distribution', '已审核评分分布')}: ${distribution.map(row => `${row.score}: ${row.n}`).join(', ')}`;
  return <section className="analytics-overview training-overview" aria-label={tx('Training review', '训练复盘')}>
    <div className="analytics-kpis">
      <div><span>{tx('Reviews complete', '复盘完成')}</span><strong>{number(summary.reviewed_videos)}<small> / {number(summary.video_count)}</small></strong></div>
      <div><span>{tx('Mean training score', '平均训练评分')}</span><strong>{number(scores?.mean)}<small> / 10</small></strong></div>
      <div><span>{tx('Scored videos', '已评分视频')}</span><strong>{number(scores?.n)}</strong></div>
      <div><span>{tx('Training / min', '训练 / 分钟')}</span><strong>{number(summary.total_minutes)}</strong></div>
    </div>
    <div className="training-score-panels">
      <Panel className="analytics-chart-panel" title={tx('Reviewed training scores / 10', '已审核训练评分 / 10')}>
        {distribution.length ? <div className="training-score-distribution" role="img" aria-label={label}>
          {distribution.map(row => <div className="training-score-row" key={row.score} aria-hidden="true"><span>{row.score}</span><div className="training-score-track"><span className="training-score-bar" style={{ width: `${row.n / maximum * 100}%` }} /></div><strong>{number(row.n)}</strong></div>)}
        </div> : <p className="analytics-empty">{tx('No reviewed scores', '暂无已审核评分')}</p>}
        {scores ? <div className="table-wrap"><table aria-label={tx('Reviewed score statistics', '已审核评分统计')}><thead><tr><th scope="col">n</th><th scope="col">{tx('Mean', '均值')}</th><th scope="col">{tx('Median', '中位数')}</th><th scope="col">Q1</th><th scope="col">Q3</th></tr></thead><tbody><tr><td>{scores.n}</td><td>{number(scores.mean)}</td><td>{number(scores.median)}</td><td>{number(scores.q1)}</td><td>{number(scores.q3)}</td></tr></tbody></table></div> : null}
      </Panel>
      <Panel className="analytics-chart-panel" title={tx('Scores by category', '专项评分')}>
        {byCategory.length ? <div className="table-wrap"><table aria-label={tx('Scores by category', '专项评分')}><thead><tr><th scope="col">{tx('Category', '专项')}</th><th scope="col">{tx('Scored', '已评分')}</th><th scope="col">{tx('Mean / 10', '均值 / 10')}</th></tr></thead><tbody>{byCategory.map(([category, values]) => <tr key={category}><td><a className="analytics-source" href={`#videos?category=${encodeURIComponent(category)}`}>{categories[category as keyof typeof categories] ? t(categories[category as keyof typeof categories].name) : category}</a></td><td>{number(values.n)}</td><td>{number(values.mean)}</td></tr>)}</tbody></table></div> : <p className="analytics-empty">{tx('No reviewed scores', '暂无已审核评分')}</p>}
      </Panel>
    </div>
  </section>;
}

function StatisticsRow({ label, value }: { label: string; value: Distribution }) {
  return <tr><td>{label}</td><td>{value.n}</td><td>{number(value.median)}</td><td>{number(value.q1)}</td><td>{number(value.q3)}</td></tr>;
}
