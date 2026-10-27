import { t, tx, localeTag, useLocale } from './i18n';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, configureApi, loginAccount, post } from './api';
import { Field, Icon, type Notify } from './components';
import { errorMessage, type Auth } from './types';
import { getWorkspaceTimezone, setWorkspaceTimezone } from './planningTypes';
import Dashboard from './pages/Dashboard';
import Athletes from './pages/Athletes';
import Sessions from './pages/Sessions';
import VideoLibrary from './pages/VideoLibrary';
import Upload from './pages/Upload';
import Models from './pages/Models';
import VideoDetail from './pages/VideoDetail';
import Planning from './pages/Planning';
import Insights from './pages/Insights';

const navigation = [
  { path: 'dashboard', title: '训练工作台', icon: 'dashboard' },
  { path: 'athletes', title: '运动员画像', icon: 'users' },
  { path: 'plans', title: '训练计划', icon: 'target' },
  { path: 'insights', title: '数据洞察', icon: 'activity' },
  { path: 'sessions', title: '训练场次', icon: 'calendar' },
  { path: 'videos', title: '专项视频库', icon: 'video' },
  { path: 'upload', title: '上传视频', icon: 'upload' },
  { path: 'models', title: '模型状态', icon: 'model' },
];
function Brand() {
  return <a href="#dashboard" className="brand"><img className="brand-mark" src="/images/arena-mark.svg" alt="" width="35" height="40" /><div>NeuroStability<small>ARENA</small></div></a>;
}
function getRoute() { return window.location.hash.slice(1) || 'dashboard'; }
export default function App() {
  useLocale();
  const [auth, setAuth] = useState<Auth | null>(null);
  const [checking, setChecking] = useState(true);
  const [startupError, setStartupError] = useState('');
  const [route, setRoute] = useState(getRoute);
  const [menuOpen, setMenuOpen] = useState(false);
  const navigationRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [toast, setToast] = useState<{ message: string; kind: string; id: number } | null>(null);
  const notify: Notify = useCallback((message, kind = 'success') => setToast({ message, kind, id: Date.now() }), []);
  const signedIn = useCallback((value: Auth) => {
    setWorkspaceTimezone(value.timezone || 'Asia/Shanghai');
    setAuth(value); setMenuOpen(false); configureApi(value.csrf, () => { setAuth(null); setMenuOpen(false); configureApi(''); setStartupError("登录已过期，请重新登录。"); });
  }, []);
  useEffect(() => {
    const change = () => { setRoute(getRoute()); setMenuOpen(false); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    let alive = true;
    api<Auth>('/me').then(value => { if (alive) signedIn(value); }).catch(err => { if (alive && !(err instanceof ApiError && err.status === 401)) setStartupError(errorMessage(err)); }).finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [signedIn]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 6000); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!menuOpen || !navigationRef.current) return;
    const panel = navigationRef.current;
    const mobile = window.matchMedia('(max-width: 760px)');
    (panel.querySelector<HTMLElement>('a[aria-current="page"]') || panel.querySelector<HTMLElement>('nav a'))?.focus();
    const closeOnDesktop = () => { if (!mobile.matches) setMenuOpen(false); };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); }
      if (event.key !== 'Tab') return;
      const links = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button'));
      const first = links[0]; const last = links[links.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keys);
    mobile.addEventListener('change', closeOnDesktop);
    return () => {
      window.removeEventListener('keydown', keys); mobile.removeEventListener('change', closeOnDesktop);
      if (menuButtonRef.current?.getClientRects().length) menuButtonRef.current.focus();
    };
  }, [menuOpen]);
  async function logout() {
    try { await api('/logout', { method: 'POST' }); setAuth(null); setMenuOpen(false); configureApi(''); setStartupError(''); }
    catch (err) { notify(errorMessage(err), 'error'); }
  }
  if (checking) return <div className="startup"><span className="spinner" /><p>{t("正在连接训练工作台…")}</p></div>;
  if (!auth) return <Login initialError={startupError} signedIn={signedIn} />;
  const [pathname, query] = route.split('?');
  const params = new URLSearchParams(query);
  const section = pathname.split('/')[0];
  const active = navigation.find(item => item.path === section) || navigation[0];
  let content;
  if (pathname.startsWith('videos/')) content = <VideoDetail key={`${pathname}:${params.get('job') || ''}`} id={pathname.slice(7)} initialJobId={params.get('job') || ''} notify={notify} />;
  else if (section === 'athletes') content = <Athletes notify={notify} />;
  else if (section === 'sessions') content = <Sessions notify={notify} planId={params.get('plan') || ''} />;
  else if (section === 'videos') content = <VideoLibrary key={query} initialCategory={params.get('category') || ''} />;
  else if (section === 'upload') content = <Upload key={query} notify={notify} initialSession={params.get('session') || ''} />;
  else if (section === 'plans') content = <Planning notify={notify} />;
  else if (section === 'insights') content = <Insights />;
  else if (section === 'models') content = <Models />;
  else content = <Dashboard />;
  return <div className="app-shell">
    {menuOpen ? <button className="sidebar-backdrop" aria-label={t("关闭导航")} onClick={() => setMenuOpen(false)} /> : null}
    <aside id="arena-nav" ref={navigationRef} role={menuOpen ? 'dialog' : undefined} aria-modal={menuOpen || undefined} aria-label={t("主导航面板")} className={`sidebar ${menuOpen ? 'open' : ''}`}><Brand /><button className="icon-button nav-close" aria-label={t("关闭导航面板")} onClick={() => setMenuOpen(false)}><Icon name="close" size={18} /></button><nav aria-label={t("主导航")}>{navigation.map(item => <a key={item.path} href={`#${item.path}`} className={section === item.path ? 'active' : ''} aria-current={section === item.path ? 'page' : undefined}><Icon name={item.icon} /><span>{t(item.title)}</span>{section === item.path ? <span className="nav-indicator" /> : null}</a>)}</nav></aside>
    <div className="workspace"><header className="topbar"><span className="monumental-id" aria-hidden="true">ARENA</span><div className="breadcrumb"><button ref={menuButtonRef} className="icon-button menu-button" aria-controls="arena-nav" aria-label={t("打开导航")} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" /></button><strong>{t(active.title)}</strong></div><div className="account"><LocaleSwitch /><span className="topbar-date"><Icon name="calendar" size={15} />{new Date().toLocaleDateString(localeTag(), { month: 'long', day: 'numeric', timeZone: getWorkspaceTimezone() })}</span><span className="account-avatar">{auth.username.slice(0, 1).toUpperCase()}</span><span className="account-name">{auth.username}</span><button className="icon-button" title={t("退出登录")} aria-label={t("退出登录")} onClick={logout}><Icon name="logout" size={18} /></button></div></header><main key={pathname} className={`main-content ${section === 'dashboard' ? 'studio-content' : ''}`}>{content}</main></div>
    {toast ? <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}><Icon name={toast.kind === 'error' ? 'close' : 'check'} size={18} /><span>{t(toast.message)}</span><button className="icon-button" aria-label={t("关闭提示")} onClick={() => setToast(null)}><Icon name="close" size={15} /></button></div> : null}
  </div>;
}
function Login({ initialError, signedIn }: { initialError: string; signedIn: (auth: Auth) => void }) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const value = new FormData(event.currentTarget);
    try { signedIn(await loginAccount<Auth>(String(value.get('username') || ''), String(value.get('password') || ''))); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <div className="login-page">
    <div className="login-story">
      <Brand />
      <div className="login-copy"><h1>{t("每一次交锋，")}<br />{t("都有迹可循。")}</h1></div>
      <div className="login-visual"><img src="/images/womens-wrestling.svg" alt={t("女子自由式摔跤低姿对抗插画")} width="900" height="540" fetchPriority="high" /></div>
    </div>
    <div className="login-form-area">
      <form onSubmit={login} className="login-form">
        <div className="login-heading"><h2>{t("登录")}</h2><LocaleSwitch /></div>
        {error ? <div className="notice error" role="alert">{t(error)}</div> : null}
        <Field label={t("账号")}><input name="username" autoComplete="username" required autoFocus /></Field>
        <Field label={t("密码")}><input name="password" type="password" autoComplete="current-password" required /></Field>
        <button className="button full" disabled={busy}>{busy ? t("登录中…") : t("进入工作台")}<Icon name="arrow" size={18} /></button>
      </form>
    </div>
  </div>;
}

function LocaleSwitch() {
  const { locale, setLocale } = useLocale();
  return <button type="button" className="locale-switch" aria-label={tx('Switch to Chinese', '切换为英文')} onClick={() => setLocale(locale === 'en' ? 'zh' : 'en')}><span lang="en" className={locale === 'en' ? 'selected' : ''}>EN</span><span aria-hidden="true"> / </span><span lang="zh-CN" className={locale === 'zh' ? 'selected' : ''}>中文</span></button>;
}
