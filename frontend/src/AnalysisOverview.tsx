import { Panel } from './components';
import { t, tx, localeTag } from './i18n';
import { categories } from './types';
import type { AnalysisSummary } from './analyticsTypes';
import './analytics.css';

const metricLabels: Record<string, string> = { hip_sway_ratio: '髋中点横向离散度', trunk_lean_deg: '平均躯干倾角', ankle_span_ratio: '平均二维踝间距' };

function number(value: number | null | undefined, precision = 1) {
  return value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat(localeTag(), { maximumFractionDigits: precision }).format(value);
}
function percent(value: number | null) { return value == null || !Number.isFinite(value) ? '—' : `${number(value * 100)}%`; }
function storage(value: number) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1024 ** 3) return `${number(value / 1024 ** 3)} GiB`;
  if (value >= 1024 ** 2) return `${number(value / 1024 ** 2)} MiB`;
  return value >= 1024 ? `${number(value / 1024)} KiB` : `${number(value)} B`;
}

export default function AnalysisOverview({ data, compact = false }: { data: AnalysisSummary; compact?: boolean }) {
  const measurements = [...data.measurements].sort((a, b) => Number(b.quality_passed) - Number(a.quality_passed)).slice(0, 12);
  const metricDefinitions = new Map(measurements.flatMap(row => Object.entries(row.metrics)));
  const reviewQueue = data.review_queue.slice(0, 6);
  const showQueue = !data.review_counts || data.review_counts.pending > 0;
  return <section className={`analytics-overview${compact ? ' analytics-compact' : ''}`} aria-label={tx('Video analysis', '视频分析')}>
    {data.capabilities?.length ? <div className="analytics-capabilities" aria-label={tx('Analysis coverage', '分析覆盖')}>
      {data.capabilities.map(item => {
        const label = { rtmpose_tracking: tx('Tracking', '人物追踪'), sam2: tx('Person masks', '人物分割'), action: tx('Action analysis', '动作分析'), pose3d: tx('3D skeleton', '三维骨架') }[item.backend];
        const content = <><span>{label}</span><strong>{number(item.processed_videos, 0)} / {number(item.video_count, 0)}</strong></>;
        return item.processed_videos > 0 && item.first_video_id && item.first_job_id
          ? <a key={item.backend} href={`#videos/${encodeURIComponent(item.first_video_id)}?job=${encodeURIComponent(item.first_job_id)}`}>{content}<span aria-hidden="true">↗</span></a>
          : <div key={item.backend}>{content}</div>;
      })}
    </div> : null}
    {compact ? <div className="analytics-heading"><h2>{tx('Video analysis', '视频分析')}</h2><a className="text-link" href="#insights">{tx('View analysis', '查看分析')} <span aria-hidden="true">↗</span></a></div> : <div className="analytics-kpis">
      <div><span>{tx('Analyzed videos', '已分析视频')}</span><strong>{number(data.analyzed_videos, 0)}<small> / {number(data.video_count, 0)}</small></strong></div>
      <div><span>{tx('Sampled frames', '采样帧数')}</span><strong>{number(data.frames.total, 0)}</strong></div>
      <div><span>{tx('Archived clip time / min', '归档片段时长 / 分钟')}</span><strong>{number(data.footage_seconds == null ? null : data.footage_seconds / 60)}</strong></div>
      <div><span>{tx('Video storage', '视频存储')}</span><strong>{storage(data.storage_bytes)}</strong></div>
    </div>}
    <div className="analytics-charts">
      <FrameQuality data={data} />
      <DurationHistogram data={data} />
      {!compact ? <AnalysisStatus data={data} /> : null}
    </div>
    {!compact ? <>
      <Panel className="analytics-measurements" title={tx('Experimental 2D measurements', '实验性二维测量')} action={<span className="analytics-count">{number(measurements.length, 0)} / {number(data.measurement_count, 0)}</span>}>
        {measurements.length ? <div className="table-wrap"><table aria-label={tx('Experimental 2D measurements', '实验性二维测量')}><thead><tr>
          <th scope="col">{tx('Source', '来源')}</th><th scope="col">{tx('Pose frame checks', '关键点帧核查')}</th><th scope="col">{tx('Measurements', '测量值')}</th><th scope="col">{tx('Verification', '验证状态')}</th><th scope="col">{tx('Method', '方法版本')}</th>
        </tr></thead><tbody>{measurements.map(row => <tr key={row.job_id}>
          <td><a className="analytics-source" href={`#videos/${encodeURIComponent(row.video_id)}?job=${encodeURIComponent(row.job_id)}`}>{row.filename}</a><span className="cell-sub"><time dateTime={row.date}>{row.date || '—'}</time> · {categories[row.category] ? t(categories[row.category].name) : row.category}</span></td>
          <td><span className={`analytics-badge ${row.quality_passed || row.assessment_decision === 'accepted' ? 'passed' : 'review'}`}>{row.assessment_decision === 'accepted' ? tx('Reviewed', '已核查') : row.quality_passed ? tx('Passed', '通过') : data.review_counts ? tx('Limited coverage', '覆盖不足') : tx('Pose checks needed', '关键点待核查')}</span></td>
          <td><dl className="analytics-metrics">{[...metricDefinitions].map(([key, definition]) => {
            const metric = row.metrics[key];
            return <div key={key}><dt>{t(definition.label || metricLabels[key] || key)}</dt><dd title={metric?.formula ? t(metric.formula) : undefined}>{number(metric?.value, 5)}{metric?.value != null && Number.isFinite(metric.value) && metric.unit ? <small> {t(metric.unit)}</small> : null}</dd></div>;
          })}</dl></td>
          <td><span className={`analytics-verification${row.confirmed ? ' verified' : ''}`}>{row.confirmed ? tx('Verified', '已验证') : row.assessment_decision === 'accepted' ? tx('Reviewed · experimental', '已核查 · 实验性') : tx('Experimental', '实验性')}</span></td>
          <td><span className="analytics-method mono">{row.method_version || '—'}</span></td>
        </tr>)}</tbody></table></div> : <p className="analytics-empty">{tx('No stored 2D measurements', '暂无已保存的二维测量')}</p>}
      </Panel>
      <div className={`analytics-details${showQueue ? '' : ' analytics-details-closed'}`}>
        {showQueue ? <Panel title={data.review_counts ? tx('Pending assessments', '待审核分析') : tx('Pose checks', '关键点核查')} action={<span className="analytics-count">{number(data.needs_review, 0)}</span>}>
          {reviewQueue.length ? <ul className="analytics-review-list">{reviewQueue.map(row => <li key={row.job_id}>
            <a className="analytics-source" href={`#videos/${encodeURIComponent(row.video_id)}?job=${encodeURIComponent(row.job_id)}`}>{row.filename}<span aria-hidden="true">↗</span></a>
            <div><time dateTime={row.date}>{row.date || '—'}</time><span>{tx('Usable', '可用')} <strong>{percent(row.usable_ratio)}</strong></span><span>{tx('Ambiguous', '歧义')} <strong>{number(row.ambiguous_frames, 0)}</strong> / {number(row.total_frames, 0)} {tx('frames', '帧')}</span></div>
          </li>)}</ul> : <p className="analytics-empty">{tx('No videos waiting for pose checks', '暂无待关键点核查的视频')}</p>}
        </Panel> : null}
        <Panel title={tx('Session analysis', '场次分析')}>
          {data.by_session.length ? <div className="table-wrap"><table className="analytics-session-table" aria-label={tx('Session analysis', '场次分析')}><thead><tr><th scope="col">{tx('Date', '日期')}</th><th scope="col">{tx('Training / min', '训练 / 分钟')}</th><th scope="col">{tx('Analyzed', '已分析')}</th><th scope="col">{data.review_counts ? tx('Pending', '待审核') : tx('Pose checks', '关键点核查')}</th></tr></thead><tbody>{data.by_session.map(row => <tr key={row.session_id}><td><time dateTime={row.date}>{row.date}</time></td><td>{number(row.duration_min)}</td><td>{number(row.analyzed_videos, 0)} / {number(row.video_count, 0)}</td><td>{number(row.review_needed, 0)}</td></tr>)}</tbody></table></div> : <p className="analytics-empty">{tx('No sessions with archived videos', '暂无已归档视频的训练场次')}</p>}
        </Panel>
      </div>
    </> : null}
  </section>;
}

function FrameQuality({ data }: { data: AnalysisSummary }) {
  const { frames } = data;
  const parts = [
    { key: 'usable', label: tx('Usable', '可用'), count: frames.usable },
    { key: 'ambiguous', label: tx('Ambiguous', '歧义'), count: frames.ambiguous },
    { key: 'missing', label: tx('Missing', '缺失'), count: frames.missing },
  ];
  const valid = frames.total > 0 && parts.every(part => Number.isFinite(part.count) && part.count >= 0) && parts.reduce((sum, part) => sum + part.count, 0) === frames.total && frames.usable_ratio != null && Number.isFinite(frames.usable_ratio) && frames.usable_ratio >= 0 && frames.usable_ratio <= 1;
  let offset = 0;
  const label = `${tx('Pose frame checks', '关键点帧核查')}: ${parts.map(part => `${part.label} ${number(part.count, 0)}`).join(', ')}; ${tx('weighted usable', '加权可用率')} ${percent(frames.usable_ratio)}`;
  return <Panel className="analytics-chart-panel" title={data.review_counts ? tx('Measurement quality', '测量质量') : tx('Pose frame checks', '关键点帧核查')} action={<span className="analytics-count">{number(data.quality_known, 0)} {tx('videos', '段视频')}</span>}>
    <div className="analytics-quality">
      {valid ? <svg className="analytics-donut" viewBox="0 0 160 160" role="img" aria-label={label}>
        <title>{label}</title>
        {parts.map(part => {
          const length = part.count / frames.total * 100;
          const start = offset; offset += length;
          return length > 0 ? <circle key={part.key} className={`analytics-segment ${part.key}`} cx="80" cy="80" r="59" fill="none" strokeWidth="17" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-start} transform="rotate(-90 80 80)" /> : null;
        })}
        <text className="analytics-donut-value" x="80" y="79" textAnchor="middle">{percent(frames.usable_ratio)}</text><text className="analytics-donut-label" x="80" y="99" textAnchor="middle">{tx('usable', '可用率')}</text>
      </svg> : <p className="analytics-empty analytics-chart-empty">{tx('No usable frame summary', '暂无有效帧质量汇总')}</p>}
      <dl className="analytics-legend">{parts.map(part => <div key={part.key}><dt><i className={`analytics-dot ${part.key}`} />{part.label}</dt><dd>{number(part.count, 0)}</dd></div>)}</dl>
    </div>
    <p className="analytics-chart-foot">{data.review_counts ? tx('Automatic thresholds met', '自动阈值达标') : tx('Pose checks passed', '关键点核查通过')} <strong>{number(data.quality_passed, 0)} / {number(data.quality_known, 0)}</strong></p>
  </Panel>;
}

function DurationHistogram({ data }: { data: AnalysisSummary }) {
  const bins = data.duration_bins;
  const maximum = Math.max(1, ...bins.map(bin => bin.count));
  const label = `${tx('Clip duration / s', '片段时长 / 秒')}: ${bins.map(bin => `${bin.key}: ${number(bin.count, 0)}`).join(', ')}`;
  return <Panel className="analytics-chart-panel" title={tx('Clip duration / s', '片段时长 / 秒')} action={<span className="analytics-count">{number(data.duration_known, 0)} / {number(data.video_count, 0)}</span>}>
    {data.duration_known > 0 ? <svg className="analytics-histogram" viewBox="0 0 320 164" role="img" aria-label={label}>
      <title>{label}</title><line className="analytics-axis" x1="12" y1="133" x2="308" y2="133" />
      {bins.map((bin, index) => {
        const height = bin.count / maximum * 101;
        const x = 29 + index * 74;
        return <g key={bin.key}><rect x={x} y={133 - height} width="40" height={height} rx="2" /><text className="analytics-bin-count" x={x + 20} y={123 - height} textAnchor="middle">{number(bin.count, 0)}</text><text className="analytics-bin-label" x={x + 20} y="155" textAnchor="middle">{bin.key.replace('-', '–')}</text></g>;
      })}
    </svg> : <p className="analytics-empty analytics-chart-empty">{tx('No known video durations', '暂无已知视频时长')}</p>}
    <p className="analytics-chart-foot">{tx('Median', '中位数')} <strong>{number(data.duration_stats.median)} {tx('s', '秒')}</strong><span>{tx('Range', '范围')} {number(data.duration_stats.min)}–{number(data.duration_stats.max)} {tx('s', '秒')}</span></p>
  </Panel>;
}

function AnalysisStatus({ data }: { data: AnalysisSummary }) {
  if (data.review_counts) return <AnalysisAssessments data={data} />;
  const entries = [
    { key: 'completed', label: tx('Complete', '完成') }, { key: 'needs_review', label: tx('Pose checks needed', '关键点待核查') },
    { key: 'queued', label: tx('Queued', '排队中') }, { key: 'running', label: tx('Analyzing', '分析中') },
    { key: 'failed', label: tx('Failed', '失败') }, { key: 'blocked', label: tx('Blocked', '受阻') },
    { key: 'not_analyzed', label: tx('Not analyzed', '未分析') },
  ] as const;
  const label = entries.map(entry => `${entry.label}: ${number(data.status_counts[entry.key], 0)}`).join(', ');
  return <Panel className="analytics-chart-panel analytics-status-panel" title={tx('Latest analysis status', '最新分析状态')}>
    {data.video_count ? <div className="analytics-status-stack" role="img" aria-label={label}>{entries.map(entry => data.status_counts[entry.key] > 0 ? <span className={entry.key} key={entry.key} style={{ width: `${data.status_counts[entry.key] / data.video_count * 100}%` }} /> : null)}</div> : <p className="analytics-empty">{tx('No archived videos', '暂无归档视频')}</p>}
    <dl className="analytics-status-legend">{entries.map(entry => <div key={entry.key}><dt><i className={`analytics-dot ${entry.key}`} />{entry.label}</dt><dd>{number(data.status_counts[entry.key], 0)}</dd></div>)}</dl>
    <div className="analytics-score-workflow"><span>{tx('Training scores', '训练评分')}</span><dl><div><dt>{tx('Reviewed', '已审核')}</dt><dd>{number(data.scores.confirmed, 0)}</dd></div><div><dt>{tx('Draft', '草稿')}</dt><dd>{number(data.scores.draft, 0)}</dd></div><div><dt>{tx('Unscored', '未评分')}</dt><dd>{number(data.scores.unscored, 0)}</dd></div></dl></div>
  </Panel>;
}

function AnalysisAssessments({ data }: { data: AnalysisSummary }) {
  const counts = data.review_counts!;
  const total = counts.reviewed + counts.pending;
  const entries = [
    { key: 'accepted', label: tx('Experimental observations', '实验性观测') },
    { key: 'excluded', label: tx('Not adopted', '本次不采纳') },
    { key: 'superseded', label: tx('Superseded', '已有后续分析') },
    { key: 'pending', label: tx('Pending', '待审核') },
  ] as const;
  const label = entries.map(entry => `${entry.label}: ${number(counts[entry.key], 0)}`).join(', ');
  return <Panel className="analytics-chart-panel analytics-status-panel" title={tx('Analysis assessments', '分析审核')}>
    <div className="analytics-assessment-total"><span>{tx('Pending', '待审核')}<strong>{number(counts.pending, 0)}</strong></span><span>{tx('Reviewed', '已处理')}<strong>{number(counts.reviewed, 0)}<small> / {number(total, 0)}</small></strong></span></div>
    {total > 0 ? <div className="analytics-status-stack" role="img" aria-label={label}>{entries.map(entry => counts[entry.key] > 0 ? <span className={entry.key} key={entry.key} style={{ width: `${counts[entry.key] / total * 100}%` }} /> : null)}</div> : null}
    <dl className="analytics-status-legend">{entries.map(entry => <div key={entry.key}><dt><i className={`analytics-dot ${entry.key}`} />{entry.label}</dt><dd>{number(counts[entry.key], 0)}</dd></div>)}</dl>
    {(data.status_counts.queued > 0 || data.status_counts.running > 0) ? <p className="analytics-chart-foot">{tx('Queued', '排队中')} <strong>{number(data.status_counts.queued, 0)}</strong><span>{tx('Analyzing', '分析中')} {number(data.status_counts.running, 0)}</span></p> : null}
  </Panel>;
}
