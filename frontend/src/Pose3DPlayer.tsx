import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { tx } from './i18n';
import { useData } from './components';
import type { Job, Pose3D } from './types';
import './Pose3DPlayer.css';

const bones = [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6], [0, 7], [7, 8], [8, 9], [9, 10], [8, 11], [11, 12], [12, 13], [8, 14], [14, 15], [15, 16]];
export function projectJoint(joint: number[], azimuth: number, elevation: number, scale: number): [number, number] | null {
  if (joint.length !== 3 || !joint.every(Number.isFinite) || !Number.isFinite(scale) || scale <= 0) return null;
  const yaw = azimuth * Math.PI / 180; const pitch = elevation * Math.PI / 180;
  const x = (joint[0] * Math.cos(yaw) + joint[2] * Math.sin(yaw)) / scale;
  const z = (-joint[0] * Math.sin(yaw) + joint[2] * Math.cos(yaw)) / scale;
  const y = joint[1] / scale;
  const projectedY = y * Math.cos(pitch) - z * Math.sin(pitch);
  const depth = y * Math.sin(pitch) + z * Math.cos(pitch);
  const perspective = 4 / (4 + depth);
  return [320 + x * 160 * perspective, 220 + projectedY * 160 * perspective];
}
export function pose3DForJob(payload: { jobId: string; value: Pose3D } | null | undefined, id?: string) {
  return payload?.jobId === id && payload?.value.kind === 'pose3d' && payload.value.synthetic === false && payload.value.layout === 'h36m17' ? payload.value : null;
}
export function nearestPose3DFrame(frames: Pose3D['frames'], time: number, tolerance = Infinity) {
  let low = 0; let high = frames.length - 1;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (frames[mid].t < time) low = mid + 1; else high = mid; }
  if (low > 0 && Math.abs(frames[low - 1].t - time) < Math.abs(frames[low]?.t - time)) low--;
  return frames[low] && Math.abs(frames[low].t - time) <= tolerance ? frames[low] : null;
}
export default function Pose3DPlayer({ job, seekTime, onTime }: { job: Job; seekTime: number | null; onTime: (time: number) => void }) {
  const state = useData(() => api<Pose3D>(`/jobs/${job.id}/pose3d`).then(value => ({ jobId: job.id, value })), [job.id]);
  const pose = pose3DForJob(state.data, job.id);
  const [time, setTime] = useState(0);
  const [track, setTrack] = useState<number | null>(null);
  const [azimuth, setAzimuth] = useState(25);
  const [elevation, setElevation] = useState(-10);
  const [mediaError, setMediaError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const pendingTime = useRef<number | null>(null);
  const offset = typeof job.metadata?.time_offset === 'number' ? job.metadata.time_offset : 0;
  const geometry = useMemo(() => {
    const tracks = new Set<number>(); let scale = 0;
    for (const frame of pose?.frames || []) for (const person of frame.people) {
      if (!Number.isInteger(person.track_id)) continue;
      tracks.add(person.track_id);
      for (const joint of person.joints) if (joint.length === 3 && joint.every(Number.isFinite)) scale = Math.max(scale, Math.hypot(...joint));
    }
    return { tracks: [...tracks].sort((a, b) => a - b), scale };
  }, [pose]);
  const selectedTrack = track !== null && geometry.tracks.includes(track) ? track : geometry.tracks[0];
  const fps = typeof job.metadata?.sample_fps === 'number' && job.metadata.sample_fps > 0 ? job.metadata.sample_fps : 10;
  const frame = pose ? nearestPose3DFrame(pose.frames, time, .75 / fps) : null;
  const person = frame?.people.find(value => value.track_id === selectedTrack);
  const points = person?.joints.length === 17 ? person.joints.map(joint => projectJoint(joint, azimuth, elevation, geometry.scale)) : [];
  const frameIndex = pose && frame ? pose.frames.indexOf(frame) : 0;
  function seekLocal(value: number) {
    setTime(value); onTime(value + offset);
    if (video.current && video.current.readyState >= 1) { video.current.currentTime = value; video.current.pause(); }
    else pendingTime.current = value;
  }
  function selectTrack(value: number) {
    setTrack(value);
    if (frame?.people.some(person => person.track_id === value)) return;
    const first = pose?.frames.find(observation => observation.people.some(person => person.track_id === value));
    if (first) seekLocal(first.t);
  }
  useEffect(() => { setTime(0); setTrack(null); setMediaError(false); }, [job.id]);
  useEffect(() => { if (pose?.frames.length && time === 0) seekLocal(pose.frames[0].t); }, [pose]);
  useEffect(() => { if (seekTime !== null) seekLocal(Math.max(0, seekTime - offset)); }, [seekTime, offset]);
  return <div className="pose3d-player">
    <div className="pose3d-toolbar"><span>MotionBERT · {tx('Experimental', '实验性')}</span><label>{tx('Track', '轨迹')} <select aria-label={tx('3D track', '三维轨迹')} value={selectedTrack ?? ''} onChange={event => selectTrack(Number(event.target.value))}>{geometry.tracks.map(id => <option key={id} value={id}>T{id}</option>)}</select></label></div>
    <div className="pose3d-stage"><video ref={video} src={`/api/jobs/${job.id}/media`} controls preload="metadata" playsInline onLoadedMetadata={event => { if (pendingTime.current !== null) { event.currentTarget.currentTime = pendingTime.current; pendingTime.current = null; } }} onTimeUpdate={event => { setTime(event.currentTarget.currentTime); onTime(event.currentTarget.currentTime + offset); }} onError={() => setMediaError(true)} />
      <svg className="pose3d-skeleton" viewBox="0 0 640 440" role="img" aria-label={tx('Predicted 3D skeleton', '预测三维骨架')}><path d="M110 385 H530 M320 360 V410" stroke="#d4d9df" fill="none" />{points.length ? <g stroke={selectedTrack % 2 ? '#27efbd' : '#ffb94f'} fill={selectedTrack % 2 ? '#27efbd' : '#ffb94f'} strokeWidth="4" strokeLinecap="round">{bones.map(([from, to]) => { const a = points[from]; const b = points[to]; return a && b ? <line key={`${from}-${to}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} /> : null; })}{points.map((point, index) => point ? <circle key={index} cx={point[0]} cy={point[1]} r="5" stroke="#233449" strokeWidth="1" /> : null)}</g> : <text x="320" y="220" textAnchor="middle" fill="#8793a4" fontSize="16">{state.loading ? tx('Loading…', '加载中…') : tx('No 3D observation at this time', '当前时间无三维观测')}</text>}</svg>
    </div>
    {pose?.frames.length ? <label className="pose3d-time">{tx('Source', '原片')} {(frame ? frame.t + offset : time + offset).toFixed(3)} {tx('s', '秒')}<input aria-label={tx('3D frame', '三维帧')} type="range" min="0" max={pose.frames.length - 1} step="1" value={frameIndex} onChange={event => seekLocal(pose.frames[Number(event.target.value)].t)} /></label> : null}
    <div className="pose3d-orbit"><label>{tx('Rotate', '旋转')} {azimuth}°<input aria-label={tx('Azimuth', '方位角')} type="range" min="-180" max="180" value={azimuth} onChange={event => setAzimuth(Number(event.target.value))} /></label><label>{tx('Elevation', '仰角')} {elevation}°<input aria-label={tx('Elevation', '仰角')} type="range" min="-75" max="75" value={elevation} onChange={event => setElevation(Number(event.target.value))} /></label></div>
    {state.error ? <p className="notice error" role="alert">{state.error}</p> : null}{mediaError ? <p className="notice error">{tx('Processed video unavailable.', '分析视频暂不可用。')}</p> : null}
    <p className="media-caption">{tx('Root-relative model units · Predicted depth', '根节点相对模型单位 · 预测深度')}</p>
  </div>;
}
