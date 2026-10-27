import { useEffect } from 'react';
import { t, tx } from '../i18n';
import { api } from '../api';
import { Icon, LoadState, PageHeader, Panel, useData } from '../components';
import { modelNames, type Models as ModelsData } from '../types';

export default function Models() {
  const { data, loading, error, reload } = useData(() => api<ModelsData>('/models'));
  useEffect(() => {
    if (!data || !Object.values(data).some(state => (state.active_jobs || 0) > 0)) return;
    const timer = window.setTimeout(reload, 5000); return () => window.clearTimeout(timer);
  }, [data, reload]);
  const rows = (research: boolean) => Object.entries(modelNames).filter(([key]) => ['fsw', 'wham', 'sample'].includes(key) === research).sort(([a],[b]) => Number(b !== 'sample' && data?.[b as keyof ModelsData]?.ready) - Number(a !== 'sample' && data?.[a as keyof ModelsData]?.ready)).map(([key, name]) => {
      const state = data?.[key as keyof ModelsData];
      return <div className="model-row" key={key}><span className={`model-symbol ${state?.ready ? 'ready' : ''}`}><Icon name={key === 'preprocessing' ? 'video' : 'model'} size={24} /></span><div className="model-content"><div className="model-title"><h3>{t(name)}</h3><span className={`status ${state?.ready ? 'success' : 'warning'}`}><i />{state?.ready ? t("可使用") : t("未就绪")}</span></div>{typeof state?.processed_videos === 'number' ? <p className="model-run-count">{tx(`${state.processed_videos} videos processed`, `已处理 ${state.processed_videos} 段视频`)}{typeof state.track_count === 'number' ? tx(` · ${state.track_count} tracklets`, ` · ${state.track_count} 条轨迹`) : ''}{typeof state.segmented_frames === 'number' ? tx(` · ${state.segmented_frames} mask frames`, ` · ${state.segmented_frames} 个分割帧`) : ''}{typeof state.joint_observed_videos === 'number' ? tx(` · ${state.joint_observed_videos} videos with joint curves`, ` · ${state.joint_observed_videos} 段关节曲线`) : ''}{state.active_jobs ? tx(` · ${state.active_jobs} queued/running`, ` · ${state.active_jobs} 项处理中`) : ''}</p> : null}<small>{t(state?.reason || (key === 'preprocessing' ? t("由服务端检测 FFmpeg / FFprobe 可用性") : t("服务端未返回具体状态")))}</small></div></div>;
    });
  return <>
    <PageHeader title={t("模型与方法状态")} action={<button className="button secondary" onClick={reload}>{t("刷新状态")}</button>} />
    <LoadState loading={loading} error={error} retry={reload} />
    {data ? <><Panel title={t("分析能力")}><div className="models-list">{rows(false)}</div></Panel>
      <details className="research-extensions"><summary>{tx('Research extensions', '研究扩展')}</summary><Panel><div className="models-list">{rows(true)}</div></Panel></details></> : null}
    <div className="notice"><strong>{t("测量与专项评价的边界")}</strong><p>{t("二维姿态指标不等同于自由式摔跤竞技水平。系统保留公式、质量提示和方法版本；专项综合评分留空，训练判断由教练结合视频与运动员背景完成。")}</p></div>
  </>;
}
