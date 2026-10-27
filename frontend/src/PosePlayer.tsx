import { t, tx } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Synthetic, useData } from './components';
import { type Job, type Pose, type Segmentation } from './types';

const bones = [[5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 1], [0, 2], [1, 3], [2, 4]];
type TrackTrail = { track_id: number; points: [number, number][] };
export function trackTrails(pose: Pose, time: number, sampleFps = 10): TrackTrail[] {
  const trails: TrackTrail[] = [];
  const previous = new Map<number, { index: number; time: number; trail: TrackTrail }>();
  const maxGap = Number.isFinite(sampleFps) && sampleFps > 0 ? 1.5 / sampleFps : .15;
  for (let index = 0; index < pose.frames.length; index++) {
    const frame = pose.frames[index];
    if (!Number.isFinite(frame.t) || frame.t < time - 2 - 1e-9) continue;
    if (frame.t > time + 1e-9) break;
    for (const person of frame.people) {
      const id = person.track_id; const box = person.bbox;
      if (id == null || !Number.isInteger(id) || !box || box.length < 4 || !box.slice(0, 4).every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) continue;
      const last = previous.get(id);
      if (last?.index === index) continue;
      const connected = last && last.index === index - 1 && frame.t > last.time && frame.t - last.time <= maxGap + 1e-9;
      const trail = connected ? last.trail : { track_id: id, points: [] };
      if (!connected) trails.push(trail);
      trail.points.push([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
      previous.set(id, { index, time: frame.t, trail });
    }
  }
  return trails.filter(trail => trail.points.length > 1);
}
function nearestFrame<T extends { t: number }>(pose: { frames: T[] }, time: number, tolerance = 0.25) {
  let low = 0; let high = pose.frames.length - 1;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (pose.frames[mid].t < time) low = mid + 1; else high = mid; }
  if (low > 0 && Math.abs(pose.frames[low - 1].t - time) < Math.abs(pose.frames[low]?.t - time)) low--;
  const frame = pose.frames[low];
  return frame && Math.abs(frame.t - time) < tolerance ? frame : null;
}
export default function PosePlayer({ videoId, job, seekTime, onTime, preferredMode = 'original', showModeControls = true }: { videoId: string; job: Job | undefined; seekTime: number | null; onTime: (time: number) => void; preferredMode?: 'original' | 'analysis'; showModeControls?: boolean }) {
  const [mode, setMode] = useState<'original' | 'analysis'>(preferredMode);
  const [time, setTime] = useState(0);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [mediaError, setMediaError] = useState(false);
  const [showTrails, setShowTrails] = useState(true);
  const video = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const offset = typeof job?.metadata?.time_offset === 'number' ? job.metadata.time_offset : 0;
  const hasPose = !!job?.result?.metrics && (job.backend === 'rtmpose' || job.backend === 'rtmpose_tracking' || job.backend === 'sample');
  const hasProcessedMedia = !!job?.metadata;
  const poseState = useData(() => hasPose && job ? api<Pose>(`/jobs/${job.id}/pose`).then(value => ({ jobId: job.id, value })) : Promise.resolve(null), [job?.id, hasPose]);
  const hasSegmentation = job?.backend === 'sam2' && job.result?.kind === 'segmentation';
  const segmentState = useData(() => hasSegmentation && job ? api<Segmentation>(`/jobs/${job.id}/segmentation`).then(value => ({ jobId: job.id, value })) : Promise.resolve(null), [job?.id, hasSegmentation]);
  const segmentation = hasSegmentation && segmentState.data?.jobId === job?.id ? segmentState.data.value : null;
  const pose = hasPose && poseState.data?.jobId === job?.id ? poseState.data.value : null;
  const maskFrame = segmentation && mode === 'analysis' ? nearestFrame(segmentation, time, 0.3) : null;
  const overlay = pose || segmentation;
  const frame = pose && mode === 'analysis' ? nearestFrame(pose, time) : null;
  const isTracking = job?.backend === 'rtmpose_tracking';
  const requestedFps = typeof job?.result?.sample_fps === 'number' ? job.result.sample_fps : 10;
  const sourceFps = typeof job?.metadata?.fps === 'number' ? job.metadata.fps : requestedFps;
  const trails = pose && mode === 'analysis' && isTracking && showTrails ? trackTrails(pose, time, Math.min(requestedFps, sourceFps)) : [];
  useEffect(() => { setMode(preferredMode); setMediaError(false); }, [job?.id, preferredMode]);
  useEffect(() => { setMediaError(false); setTime(0); }, [mode]);
  useEffect(() => {
    if (seekTime === null) return;
    const duration = typeof job?.metadata?.duration === 'number' ? job.metadata.duration : 0;
    if (preferredMode === 'analysis' && mode === 'analysis' && seekTime >= offset && seekTime <= offset + duration) {
      const localTime = seekTime - offset;
      if (video.current && video.current.readyState >= 1) { video.current.currentTime = localTime; video.current.pause(); }
      else pendingSeek.current = localTime;
      return;
    }
    if (mode === 'analysis') { pendingSeek.current = seekTime; setMode('original'); }
    else if (video.current) { video.current.currentTime = seekTime; video.current.pause(); }
    // Event markers always seek to the original source video timeline.
  }, [seekTime]);
  return <div className="media-section">{showModeControls || mode === 'analysis' && (hasPose || hasSegmentation) ? <div className="media-toolbar">{showModeControls ? <div className="tabs compact"><button className={mode === 'original' ? 'active' : ''} onClick={() => setMode('original')}>{t("原始视频")}</button>{hasProcessedMedia ? <button className={mode === 'analysis' ? 'active' : ''} onClick={() => setMode('analysis')}>{hasSegmentation ? tx("Analysis / person masks", "分析视频 / 人物分割") : hasPose ? t("分析视频 / 2D 骨架") : t("预处理视频")}</button> : null}</div> : null}{mode === 'analysis' && isTracking ? <label className="checkbox-label" title={tx('Image-plane box centers', '画面内检测框中心轨迹')}><input type="checkbox" checked={showTrails} onChange={event => setShowTrails(event.target.checked)} />{tx('Track trails', '移动轨迹')}</label> : null}{mode === 'analysis' && (hasPose || hasSegmentation) ? <label className="checkbox-label"><input type="checkbox" checked={showSkeleton} onChange={event => setShowSkeleton(event.target.checked)} />{hasSegmentation ? tx("Show masks", "显示遮罩") : t("显示骨架")}</label> : null}</div> : null}
    {mode === 'analysis' && job?.result?.synthetic ? <div className="notice sample-notice"><Synthetic value /><p>{t("以下骨架为合成样例，仅用于验证播放和报告流程，不代表画面中运动员的真实动作或成绩。")}</p></div> : null}
    <div className="video-frame" style={{ aspectRatio: overlay && mode === 'analysis' ? `${overlay.width}/${overlay.height}` : '16/9' }}>
      <video ref={video} key={`${videoId}-${job?.id}-${mode}`} controls preload="metadata" playsInline src={mode === 'analysis' && job ? `/api/jobs/${job.id}/media` : `/api/videos/${videoId}/media`} onLoadedMetadata={event => { if (pendingSeek.current !== null) { event.currentTarget.currentTime = pendingSeek.current; pendingSeek.current = null; } }} onTimeUpdate={event => { const value = event.currentTarget.currentTime; setTime(value); onTime(value + (mode === 'analysis' ? offset : 0)); }} onError={() => setMediaError(true)} />
      {pose && trails.length ? <svg className="pose-overlay" viewBox={`0 0 ${pose.width} ${pose.height}`} preserveAspectRatio="xMidYMid meet" aria-label={tx('Image-plane box centers', '画面内检测框中心轨迹')}><title>{tx('Track trails', '移动轨迹')}</title>{trails.map((trail, index) => <polyline key={`${trail.track_id}:${index}`} data-track-id={trail.track_id} points={trail.points.map(point => point.join(',')).join(' ')} fill="none" stroke={trail.track_id % 2 ? '#27efbd' : '#ffb94f'} strokeWidth={Math.max(pose.width / 180, 3)} strokeOpacity="0.85" strokeLinecap="round" strokeLinejoin="round" />)}</svg> : null}
      {mode === 'analysis' && segmentation && maskFrame && showSkeleton ? <svg className="pose-overlay" viewBox={`0 0 ${segmentation.width} ${segmentation.height}`} preserveAspectRatio="xMidYMid meet" aria-label={tx('SAM2 person masks', 'SAM2 人物遮罩')}>{maskFrame.masks.map(mask => <g key={mask.object_id} fill={mask.object_id % 2 ? '#27efbd' : '#ffb94f'} stroke={mask.object_id % 2 ? '#27efbd' : '#ffb94f'} strokeWidth="2">{mask.polygons.map((polygon,index) => <polygon key={index} points={polygon.map(point=>point.join(',')).join(' ')} fillOpacity="0.3" />)}</g>)}</svg> : null}
      {mode === 'analysis' && pose && frame && showSkeleton ? <svg className="pose-overlay" viewBox={`0 0 ${pose.width} ${pose.height}`} preserveAspectRatio="xMidYMid meet" aria-label={t("当前画面的二维姿态骨架")}>{frame.people.map((person, personIndex) => <g key={person.track_id ?? `unassigned-${personIndex}`} stroke={person.track_id == null ? '#abb8ca' : person.track_id % 2 ? '#27efbd' : '#ffb94f'} fill={person.track_id == null ? '#abb8ca' : person.track_id % 2 ? '#27efbd' : '#ffb94f'} strokeWidth={Math.max(pose.width / 250, 2)}>{person.bbox ? <><rect x={person.bbox[0]} y={person.bbox[1]} width={person.bbox[2]-person.bbox[0]} height={person.bbox[3]-person.bbox[1]} fill="none" strokeDasharray={person.track_id == null ? '6 4' : undefined} /><text x={person.bbox[0]+5} y={Math.max(22,person.bbox[1]-5)} fontSize={Math.max(18,pose.width/40)} stroke="#14213d" strokeWidth="1" paintOrder="stroke">{person.track_id == null ? '—' : `T${person.track_id}`}</text></> : null}{bones.map(([from, to]) => {
        const a = person.keypoints[from]; const b = person.keypoints[to]; return a?.[2] >= .3 && b?.[2] >= .3 ? <line key={`${from}-${to}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} /> : null;
      })}{person.keypoints.map(([x, y, confidence], index) => confidence >= .3 ? <circle key={index} cx={x} cy={y} r={Math.max(pose.width / 180, 2.5)} stroke="#102c40" strokeWidth="1" /> : null)}</g>)}</svg> : null}
    </div>
    {mediaError ? <p className="notice error" role="alert">{t("视频无法播放。请检查媒体是否仍可用，或下载后使用本地播放器查看。")}</p> : null}
    {mode === 'analysis' && poseState.error ? <p className="notice error" role="alert">{t("骨架数据加载失败：")}{t(poseState.error)}</p> : null}
    {mode === 'analysis' && segmentState.error ? <p className="notice error" role="alert">{segmentState.error}</p> : null}
    {mode === 'analysis' && hasSegmentation ? <p className="media-caption">SAM2 · 2 Hz</p> : null}
    <p className="media-caption">{mode === 'analysis' ? tx(`Source ${(time + offset).toFixed(2)} s · Clip offset ${offset.toFixed(2)} s`, `原片 ${(time + offset).toFixed(2)} 秒 · 片段起点 ${offset.toFixed(2)} 秒`) : tx(`Source ${time.toFixed(2)} s`, `原片 ${time.toFixed(2)} 秒`)}</p>
    {mode === 'analysis' && hasPose ? <p className="media-caption">{tx('Low confidence points hidden. Colors do not confirm athlete identity.', '低置信度点已隐藏；颜色不代表身份确认。')}</p> : null}
  </div>;
}
