import { t, tx } from '../i18n';
import { useRef, useState, type FormEvent } from 'react';
import { api, navigate, uploadConfig, uploadVideo } from '../api';
import { Empty, Field, Icon, LoadState, PageHeader, Panel, useData, type Notify } from '../components';
import { categories, errorMessage, fileSize, type Athlete, type Session, type Video } from '../types';

export default function Upload({ notify, initialSession = '' }: { notify: Notify; initialSession?: string }) {
  const { data, loading, error, reload } = useData(async () => { const [sessions, athletes, config] = await Promise.all([api<Session[]>('/sessions'), api<Athlete[]>('/athletes'), uploadConfig()]); return { sessions, athletes, config }; });
  const [file, setFile] = useState<File | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState('');
  const [progress, setProgress] = useState(0);
  const uploadController = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  function selectFile(candidate: File | null) {
    setFileError('');
    if (candidate && data && candidate.size > data.config.max_size_bytes) { setFile(null); setFileError(tx(`Video exceeds ${fileSize(data.config.max_size_bytes)}`, `视频超过 ${fileSize(data.config.max_size_bytes)}`)); if (inputRef.current) inputRef.current.value = ''; return; }
    setFile(candidate);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!file || !authorized || !data) return;
    const form = new FormData(event.currentTarget); const controller = new AbortController(); uploadController.current = controller; setUploading(true); setProgress(0);
    try { const video = await uploadVideo<Video>(file, { session_id: String(form.get('session_id')), category: String(form.get('category')), authorized: true }, data.config, setProgress, controller.signal); notify("视频已上传，请选择分析方法。", 'success'); navigate(`videos/${video.id}`); }
    catch (err) { if (!controller.signal.aborted) notify(errorMessage(err), 'error'); } finally { setUploading(false); uploadController.current = null; }
  }
  return <>
    <PageHeader title={t("上传训练视频")} />
    <LoadState loading={loading} error={error} retry={reload} />
    {data ? data.sessions.length ? <div className="upload-layout"><Panel title={t("视频与训练信息")}>
      <form className="upload-form" onSubmit={submit}>
        <Field label={t("关联训练场次")}><select name="session_id" required defaultValue={initialSession}><option value="" disabled>{t("选择训练场次")}</option>{data.sessions.map(session => <option value={session.id} key={session.id}>{session.date} · {session.athlete_name || data.athletes.find(athlete => athlete.id === session.athlete_id)?.name || t("运动员")} · {session.objective}</option>)}</select></Field>
        <Field label={t("训练专项")}><select name="category" required defaultValue=""><option value="" disabled>{t("选择主要训练目的")}</option>{Object.entries(categories).map(([key, value]) => <option value={key} key={key}>{t(value.name)} · {t(value.description)}</option>)}</select></Field>
        <div className={`file-drop ${file ? 'has-file' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!uploading) selectFile(event.dataTransfer.files[0] || null); }}>
          <Icon name={file ? 'video' : 'upload'} size={32} /><strong>{file ? file.name : t("选择或拖入训练视频")}</strong><p>{file ? fileSize(file.size) : `MP4 / MOV / WebM / MKV / M4V · ${fileSize(data.config.max_size_bytes)} · ${tx('5 min', '5分钟')}`}</p>
          <input ref={inputRef} id="video-file" type="file" name="file" accept=".mkv,.mov,.mp4,.webm,.m4v" disabled={uploading} onChange={event => selectFile(event.target.files?.[0] || null)} aria-label={t("选择训练视频文件")} />
          <button type="button" className="button secondary" disabled={uploading} onClick={() => inputRef.current?.click()}>{file ? t("重新选择文件") : t("选择视频文件")}</button>
        </div>
        {fileError ? <div className="notice error" role="alert">{t(fileError)}</div> : null}
        <label className="checkbox-label authorization"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} required /><span>{t("我确认有权上传此视频，并已取得出镜人员对训练分析和存储的授权。")}</span></label>
        <div className="form-actions"><button className="button" disabled={!file || !authorized || uploading}><Icon name="upload" size={18} />{uploading ? `${tx('Uploading', '正在上传')} ${Math.floor(progress * 100)}%` : t("上传并归档")}</button>{uploading ? <button type="button" className="button secondary" onClick={() => uploadController.current?.abort()}>{tx('Cancel upload', '取消上传')}</button> : <a className="button secondary" href="#videos">{t("返回视频库")}</a>}</div>
        <p className="muted upload-validation">{t("上传时检查授权、扩展名与大小。解码、时长和画面规格在分析预处理阶段检查；超过 5 分钟或无效视频的分析任务会失败，不会生成指标。")}</p>
        {uploading ? <progress value={progress} max={1} aria-label={tx('Upload progress', '上传进度')} style={{ width: '100%' }} /> : null}
      </form>
    </Panel></div> : <Panel><Empty title={t("先记录一场训练")} action={<a className="button" href="#sessions">{t("前往记录训练")}</a>}></Empty></Panel> : null}
  </>;
}
