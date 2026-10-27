import { memo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Field, Panel } from '../components';
import { tx } from '../i18n';
import type { Job, JointName, JointSample } from '../types';
import './JointObservations.css';

const jointNames: JointName[] = ['left_knee', 'right_knee', 'left_elbow', 'right_elbow', 'trunk_lean'];
const labels: Record<JointName, [string, string]> = {
  left_knee: ['Left knee', '左膝'], right_knee: ['Right knee', '右膝'],
  left_elbow: ['Left elbow', '左肘'], right_elbow: ['Right elbow', '右肘'],
  trunk_lean: ['Trunk lean', '躯干倾斜'],
};
type Observation = { t: number; value: number };
const width = 720; const height = 240;
const plot = { left: 60, right: 18, top: 18, bottom: 38 };
const angle = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}°` : '—';

export function jointSegments(series: JointSample[], joint: JointName, sampleFps = 10): Observation[][] {
  const segments: Observation[][] = [];
  const maxGap = Number.isFinite(sampleFps) && sampleFps > 0 ? 1.5 / sampleFps : 0.15;
  let current: Observation[] | null = null;
  for (const sample of series) {
    const value = sample[joint];
    if (!Number.isFinite(sample.t) || typeof value !== 'number' || !Number.isFinite(value)) { current = null; continue; }
    const previous = current?.[current.length - 1];
    if (!current || (previous && (sample.t <= previous.t || sample.t - previous.t > maxGap + 1e-9))) {
      current = []; segments.push(current);
    }
    current.push({ t: sample.t, value });
  }
  return segments;
}

function JointObservations({ job, onSeek }: { job: Job; onSeek: (sourceTime: number) => void }) {
  const [trackId, setTrackId] = useState<number | null>(null);
  const [joint, setJoint] = useState<JointName>('left_knee');
  const [sampleIndex, setSampleIndex] = useState(0);
  const tracks = job.result?.kinematics?.tracks || [];
  const track = tracks.find(value => value.track_id === trackId) || tracks[0];
  if (!track) return null;
  const offset = typeof job.metadata?.time_offset === 'number' && Number.isFinite(job.metadata.time_offset) ? job.metadata.time_offset : 0;
  const requestedFps = typeof job.result?.sample_fps === 'number' ? job.result.sample_fps : 10;
  const sourceFps = typeof job.metadata?.fps === 'number' ? job.metadata.fps : requestedFps;
  const segments = jointSegments(track.series, joint, Math.min(requestedFps, sourceFps));
  const points = segments.flat();
  const selectedIndex = Math.min(sampleIndex, Math.max(points.length - 1, 0));
  const selected = points[selectedIndex];
  const first = track.first_t; const last = track.last_t;
  const x = (time: number) => plot.left + (last > first ? (time - first) / (last - first) : 0.5) * (width - plot.left - plot.right);
  const y = (value: number) => plot.top + (180 - value) / 180 * (height - plot.top - plot.bottom);
  const label = tx(...labels[joint]);
  function seek(index: number) {
    const point = points[index];
    if (point) { setSampleIndex(index); onSeek(point.t + offset); }
  }
  function keydown(event: KeyboardEvent<SVGSVGElement>) {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
      : event.key === 'ArrowLeft' ? Math.max(0, selectedIndex - 1)
        : event.key === 'ArrowRight' ? Math.min(points.length - 1, selectedIndex + 1) : null;
    if (next !== null) { event.preventDefault(); seek(next); }
  }
  function chartClick(event: MouseEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - bounds.left) / bounds.width * width;
    let nearest = 0;
    for (let index = 1; index < points.length; index++) {
      if (Math.abs(x(points[index].t) - position) < Math.abs(x(points[nearest].t) - position)) nearest = index;
    }
    seek(nearest);
  }
  return <Panel className="joint-observations" title={tx('Joint observations', '关节观测')} action={<span className="status neutral">{tx('Experimental', '实验性')}</span>}>
    <div className="joint-controls">
      <Field label={tx('Track', '轨迹')}><select aria-label={tx('Track', '轨迹')} value={track.track_id} onChange={event => { setTrackId(Number(event.target.value)); setSampleIndex(0); }}>{tracks.map(value => <option key={value.track_id} value={value.track_id}>T{value.track_id}</option>)}</select></Field>
      <Field label={tx('Joint', '关节')}><select aria-label={tx('Joint', '关节')} value={joint} onChange={event => { setJoint(event.target.value as JointName); setSampleIndex(0); }}>{jointNames.map(name => <option key={name} value={name}>{tx(...labels[name])}</option>)}</select></Field>
      <p className="joint-track-summary">T{track.track_id} · {track.n_samples} {tx('sampled frames', '采样帧')}<span>{tx('Source', '原片')} {(first + offset).toFixed(2)}–{(last + offset).toFixed(2)} {tx('s', '秒')}</span></p>
    </div>
    {selected ? <div className="joint-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="slider" tabIndex={0} aria-label={tx(`${label} · source time / s`, `${label} · 原片时间 / 秒`)} aria-valuemin={first + offset} aria-valuemax={last + offset} aria-valuenow={selected.t + offset} aria-valuetext={`${(selected.t + offset).toFixed(2)} ${tx('s', '秒')} · ${angle(selected.value)}`} onKeyDown={keydown} onClick={chartClick}>
        {[0, 60, 120, 180].map(value => <g key={value}><line className="joint-grid" x1={plot.left} x2={width - plot.right} y1={y(value)} y2={y(value)} /><text className="joint-axis" x={plot.left - 9} y={y(value) + 4} textAnchor="end">{value}°</text></g>)}
        {[0, 0.5, 1].map(fraction => <text className="joint-axis" key={fraction} x={plot.left + fraction * (width - plot.left - plot.right)} y={height - 17} textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}>{(first + fraction * (last - first) + offset).toFixed(2)} {tx('s', '秒')}</text>)}
        {segments.filter(segment => segment.length > 1).map((segment, index) => <path className="joint-line" key={index} d={segment.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'}${x(point.t).toFixed(2)},${y(point.value).toFixed(2)}`).join(' ')} />)}
        <line className="joint-cursor" x1={x(selected.t)} x2={x(selected.t)} y1={plot.top} y2={height - plot.bottom} />
        {points.map((point, index) => <g className={`joint-sample ${index === selectedIndex ? 'selected' : ''}`} key={`${point.t}:${index}`} data-source-time={point.t + offset} onClick={event => { event.stopPropagation(); seek(index); }}><title>{`${label} · ${(point.t + offset).toFixed(2)} ${tx('s', '秒')} · ${angle(point.value)}`}</title><circle className="joint-hit" cx={x(point.t)} cy={y(point.value)} r="8" /><circle className="joint-dot" cx={x(point.t)} cy={y(point.value)} r={index === selectedIndex ? 4 : 2.5} /></g>)}
      </svg>
      <p className="joint-readout">{label} <strong>{angle(selected.value)}</strong><span>{tx('Source', '原片')} {(selected.t + offset).toFixed(2)} {tx('s', '秒')}</span></p>
    </div> : <p className="joint-empty">{tx('No observed samples for this joint.', '此关节暂无有效观测。')}</p>}
    <div className="table-wrap"><table aria-label={tx('Joint observation statistics', '关节观测统计')}><thead><tr><th scope="col">{tx('Joint', '关节')}</th><th scope="col">n</th><th scope="col">{tx('Median', '中位数')}</th><th scope="col">{tx('Observed range', '观测范围')}</th></tr></thead><tbody>{jointNames.map(name => {
      const summary = track.joints[name];
      return <tr key={name} className={name === joint ? 'joint-selected-row' : ''}><th scope="row">{tx(...labels[name])}</th><td>{summary.n}</td><td>{angle(summary.median)}</td><td>{summary.min == null || summary.max == null ? '—' : `${summary.min.toFixed(1)}–${summary.max.toFixed(1)}°`}</td></tr>;
    })}</tbody></table></div>
  </Panel>;
}

export default memo(JointObservations);
