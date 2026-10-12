// Title screen: season-style backdrop, big title 卫戍协议：盟约, remembered nickname, 开始, the language menu
// (中文 | English | every pack in public/i18n/, ui/lang.js; a title in an alphabetic script — English — is the big one and
// the small wordmark above it hides).
//
// Pressing 开始 validates the nickname (1..NAME_MAX_LEN chars, no control characters), stores it,
// marks this tab as "entered" (so reloads skip the title) and hands the name to net.js, which
// sends `hello` (now, or as soon as the socket is open). The router then shows the lobby.
//
// Backdrop art: if data/assets.json lists a UI backdrop (`ui.titleBackdrop`, or one of the
// entry/loading illustration names) it is layered under the CSS art; otherwise the screen is
// pure CSS/SVG (radar, ridgelines, glow), so it never issues a request that can 404.

import { ResumeMatchButton } from '../ui/resumeMatch.js';
import { useMemo, useState } from '../../vendor/hooks.module.js';
import { NAME_MAX_LEN, APP_VERSION, DEV_BUILD } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, TextField, PingPill, Modal } from '../ui/components.js';
import { GuideButton } from '../ui/guide.js';
import { openStats } from './stats.js';
import { toast } from '../ui/toasts.js';
import { net, identity, accountStore, guestStore } from '../net.js';
import { store, useStore, shallowEqual, loadPref, savePref } from '../store.js';
import { data, useData } from '../data.js';
import { FullscreenButton, PwaInstallButton, detectFeatures } from '../ui/device.js';
import { LangToggle, useLang } from '../ui/lang.js';
import { t, N_ } from '../../../shared/i18n.js';
import { scriptOf } from '../../../shared/i18nPacks.js';
import { GIcon } from '../ui/gameComponents.js';
import { SettingsModal } from '../ui/settings.js';
import { setEntries, setOpsMap, flushLoadout, pauseLoadoutSync, resumeLoadoutSync } from '../ui/loadoutSync.js';
import { parseStored, parseStoredOps } from '../ui/loadoutModel.js';
import { applyAccountStats } from '../ui/stats.js';

// Same character classes as server/net.js sanitizeName (control, zero-width, bidi, BOM), so a name
// the client accepts is never rejected by the server's hello validation.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Lone surrogates are removed by a scan, not a regex: the lookbehind such a regex needs is a *syntax error* in Safari
// < 16.4, which would stop the whole client from loading there.
export function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * Normalise a nickname like the server does (NFC, strip lone surrogates / control / invisible /
 * bidi characters, collapse whitespace, trim), then clamp to NAME_MAX_LEN UTF-16 code units — the
 * protocol's `hello.name` limit — without splitting a surrogate pair.
 * @param {any} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = stripLoneSurrogates(s).replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  if (s.length > NAME_MAX_LEN) {
    s = s.slice(0, NAME_MAX_LEN);
    // Don't leave half a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
    s = s.trim();
  }
  return s;
}

/** @param {any} raw @returns {boolean} */
export const isValidName = (raw) => sanitizeName(raw).length > 0;

/**
 * Enter the game shell with a nickname (title → lobby).
 * @param {string} rawName
 * @returns {boolean} false when the name is invalid
 */
export function enterSession(rawName) {
  const name = sanitizeName(rawName);
  if (!name) return false;
  identity.saveName(name);
  identity.setEntered(true);
  store.set((s) => ({ me: { ...s.me, name }, session: { ...s.session, entered: true } }));
  net.setName(name);
  return true;
}

/**
 * The 游客 login nudge: pressing 开始 without an account offers one first, because logging in is what keeps the
 * 干员调配 and a running 对局 with the account instead of the browser. It is shown on every 开始 until its 不再提示
 * checkbox is ticked, which stores this browser preference (store.js prefix `sp.pref.`) and never asks again.
 */
const NUDGE_PREF = 'guestLoginNudge';

/** Whether the 游客 login nudge is switched off for good on this browser. @returns {boolean} */
export function isLoginNudgeOff() { return loadPref(NUDGE_PREF, false) === true; }

/** Switch the 游客 login nudge off for good (or back on) on this browser. @param {boolean} on */
export function setLoginNudgeOff(on) { savePref(NUDGE_PREF, !!on); }

/**
 * Enter the game as the logged-in account: its username is the in-game name (server/lobby.js accountHello
 * re-confirms it and `welcome` carries the server's own spelling back, so the name here is only the title
 * screen's local copy — an account username may be longer than a callsign and is never written back into
 * `accountStore`).
 * @returns {boolean} false when there is no usable account
 */
export function enterAsAccount() {
  const acct = accountStore.read();
  const name = sanitizeName(acct?.username || '');
  if (!name) return false;
  setGuest(false); // an account is being used again: the 游客 marker is no longer true
  return enterSession(name);
}

/**
 * Whether this browser is currently playing as a 游客 (no account). Remembered in localStorage (guestStore), so
 * it survives a reload: a player who deliberately logged out is not logged back in by the account-first naming.
 * @returns {boolean}
 */
export function isGuest() { return guestStore.read(); }

/** @param {boolean} on */
export function setGuest(on) { guestStore.write(on); }

/**
 * Drop the account on this device and continue as a 游客.
 *
 * Order matters: the SERVER must let go of the account first (`auth.logout`), because the session still carries its
 * account token — clearing the local 干员调配 and syncing it while that binding lived would write the empty copy
 * INTO the account. Only then does the local copy go back to the defaults (and is pushed to the now-guest session),
 * and the sync is paused so nothing else can reach the account by accident.
 * @returns {Promise<boolean>} false when this browser had no account to leave
 */
export async function enterAsGuest() {
  if (!accountStore.read()) return false;
  const detached = await net.request('auth.logout', {}).then(() => true, (err) => {
    // offline / a server without accounts: the local copy is still cleared, and the sync is paused below so it
    // cannot overwrite the account later either
    console.warn('[auth] logout not acknowledged', err?.code || err);
    return false;
  });
  accountStore.clear();
  setGuest(true);
  setOpsMap({});
  setEntries({});
  // The reset is an edit like any other: push it now instead of waiting for the debounce, so a run started right
  // after this cannot carry the account's tuning into the match. Skipped when the session never confirmed the
  // detach (paused below) — a stale account token must not receive this empty copy.
  if (detached) {
    await flushLoadout();
    pauseLoadoutSync(true);
  } else {
    pauseLoadoutSync(true);
  }
  return true;
}

// data/assets.json `ui` keys are 'group/key' (docs/ASSETS.md).
const BACKDROP_KEYS = ['titleBackdrop', 'entry/bkg_01', 'entry/bkg_02'];
const RIDGE_KEYS = ['titleRidges', 'entry/bg_mountains_tiled'];

/**
 * Find a UI image URL in data/assets.json (tolerant of a few plausible shapes).
 * @param {any} assets
 * @param {string[]} names
 * @returns {string|null}
 */
export function findUiAsset(assets, names) {
  if (!assets || typeof assets !== 'object') return null;
  const asUrl = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.url || v.path || v.src || null;
    return null;
  };
  const ui = assets.ui;
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    for (const n of names) {
      const u = asUrl(ui[n]);
      if (u) return u;
    }
  }
  const lists = [Array.isArray(ui) ? ui : null, Array.isArray(assets.files) ? assets.files : null].filter(Boolean);
  for (const list of lists) {
    for (const n of names) {
      const hit = list.map(asUrl).find((u) => typeof u === 'string' && u.includes('/ui/') && u.toLowerCase().split('/').pop().startsWith(n.toLowerCase()));
      if (hit) return hit;
    }
  }
  return null;
}

// Dot-matrix watchtower emblem (13×14 bitmap; dots grow toward the base for depth).
const EMBLEM = [
  'XXX..XXX..XXX',
  'XXX..XXX..XXX',
  'XXXXXXXXXXXXX',
  '.XXXXXXXXXXX.',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXX.XXXX..',
  '..XXXX.XXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '..XXXXXXXXX..',
  '.XXXXXXXXXXX.',
  'XXXXXXXXXXXXX',
  'XXXXXXXXXXXXX',
];

function Emblem() {
  const dots = useMemo(() => {
    const out = [];
    EMBLEM.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch !== 'X') return;
        const rad = 0.2 + (r / (EMBLEM.length - 1)) * 0.2;
        const accent = (r === 6 || r === 7) && (c === 5 || c === 7);
        out.push({ cx: c + 0.5, cy: r + 0.5, r: rad, accent, d: (r * 13 + c) % 7 });
      });
    });
    return out;
  }, []);
  return html`<div class="emblem" aria-hidden="true">
    <span class="emblem__bracket emblem__bracket--l"></span>
    <svg class="emblem__svg" viewBox="-0.5 -0.5 14 15">
      ${dots.map((d, i) => html`<circle key=${i} cx=${d.cx} cy=${d.cy} r=${d.r} class=${d.accent ? 'is-accent' : `d${d.d}`} />`)}
    </svg>
    <span class="emblem__bracket emblem__bracket--r"></span>
  </div>`;
}

function Ridges() {
  return html`<svg class="title-bg__ridges" viewBox="0 0 1920 420" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="ridge-far" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#16231f" /><stop offset="1" stop-color="#0a0e0d" />
      </linearGradient>
      <linearGradient id="ridge-near" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0f1714" /><stop offset=".6" stop-color="#080b0a" />
      </linearGradient>
      <linearGradient id="ridge-edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#17f9b7" stop-opacity="0" />
        <stop offset=".3" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset=".7" stop-color="#17f9b7" stop-opacity=".55" />
        <stop offset="1" stop-color="#17f9b7" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path class="ridge ridge--far" fill="url(#ridge-far)" stroke="url(#ridge-edge)"
      d="M0 420V250l120-40 90 30 90-70 60 20 80-70 80 55 80-25 90 70 90-20 80 50 100-15 90 25 90-55 90-55 70-55 70 45 80-20 90 65 80-20 100 55 100-20 100 40v180z" />
    <path class="ridge ridge--near" fill="url(#ridge-near)" stroke="url(#ridge-edge)"
      d="M0 420V322l160-32 100 20 120-50 90 40 130-20 120 50 140-30 140 35 120-35 140 20 140-50 120 30 120-20 120 40 160-20v147z" />
  </svg>`;
}

const STATUS_TEXT = {
  idle: N_('准备连接'), connecting: N_('正在连接服务器'), connected: N_('已连接服务器'), handshaking: N_('正在验证身份'),
  online: N_('已连接服务器'), reconnecting: N_('连接中断，正在重连'), closed: N_('连接已关闭'),
};

/** Title screen component. */
export function TitleScreen() {
  const conn = useStore((s) => s.connection, shallowEqual);
  const pendingJoin = useStore((s) => s.ui.pendingJoin);
  useLang(); // re-render on a language switch
  // A logged-in account owns the in-game name (server/lobby.js accountHello): the remembered callsign is only
  // the fallback for a logged-out player, so read the account first.
  const [name, setName] = useState(() => accountStore.lastUsername() || store.get().me.name || identity.loadName() || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const assetsSettled = useData('assets');
  const assets = data.get('assets');
  const backdrop = findUiAsset(assets, BACKDROP_KEYS);
  const ridges = findUiAsset(assets, RIDGE_KEYS);
  // Track load/fail per URL (not as booleans reset in effects: an image can load before an effect runs).
  const [bgLoadedUrl, setBgLoadedUrl] = useState(null);
  const [ridgesLoadedUrl, setRidgesLoadedUrl] = useState(null);
  const [ridgesFailedUrl, setRidgesFailedUrl] = useState(null);
  const bgLoaded = !!backdrop && bgLoadedUrl === backdrop;
  const ridgesLoaded = !!ridges && ridgesLoadedUrl === ridges;
  const ridgesFailed = !!ridges && ridgesFailedUrl === ridges;
  // CSS ridgelines only when there is no ridge art (avoids a swap flash when the art arrives).
  const cssRidges = assetsSettled && (!ridges || ridgesFailed);

  // ---- account (extension §account: register / login, binds the in-game name and the 干员调配) ----
  // The modal is user-driven only: a remembered account shows as the read-only 代号 row + a chip rather than
  // popping the form up again, so an already-logged-in player is never asked to sign in a second time.
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login'); // 'login' | 'register'
  const [authUser, setAuthUser] = useState(accountStore.lastUsername());
  const [authPass, setAuthPass] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authShow, setAuthShow] = useState(false); // 显示密码 toggle of the account modal
  const acct = accountStore.read();

  // ---- 游客 login nudge (see isLoginNudgeOff): 开始 as a guest offers the account first ----
  const [nudgeOpen, setNudgeOpen] = useState(false);
  const [nudgeOff, setNudgeOff] = useState(() => isLoginNudgeOff());
  const toggleNudgeOff = (on) => { setNudgeOff(on); setLoginNudgeOff(on); };
  const startAsGuest = () => { setNudgeOpen(false); enterSession(name); };

  // ---- an account the server no longer knows (main.js onWelcome sets ui.accountExpired) ----
  // 不放行: the player is back on this screen (selectRoute: not entered → title) and has to sign in or register
  // again; the notice is the only thing that says why, so it is a dialog rather than a toast that fades.
  const accountExpired = useStore((s) => s.ui.accountExpired);
  const dismissExpired = () => { if (accountExpired) store.patch('ui', { accountExpired: null }); };
  const recoverAccount = () => {
    dismissExpired();
    setAuthUser(accountStore.lastUsername()); // who this browser was playing as, ready to register again
    setAuthMode('register');
    setAuthOpen(true);
  };
  const continueAsGuest = () => { dismissExpired(); startAsGuest(); };
  const startLogin = () => {
    setNudgeOpen(false);
    setAuthMode('login');
    // Carry the typed callsign over when it is already a legal username — it is the name they want to be called by.
    const typed = sanitizeName(name);
    if (/^[a-zA-Z0-9_\-.]{2,24}$/.test(typed)) setAuthUser(typed);
    setAuthOpen(true);
  };

  const submitAuth = async (e) => {
    e?.preventDefault?.();
    if (authBusy) return;
    const typed = authUser.trim();
    if (!/^[a-zA-Z0-9_\-.]{2,24}$/.test(typed)) { toast(t('账号需为 2-24 位字母数字 _ - .'), 'warn'); return; }
    // The account already on this device is signed in: say so and just close the form (no password, no re-login).
    if (typed.toLowerCase() === (acct?.username || '').toLowerCase()) {
      setGuest(false);
      setAuthOpen(false);
      setAuthPass('');
      toast(t('该账号已登录，直接进入即可'), 'info');
      return;
    }
    if (authPass.length < 4) { toast(t('密码至少 4 位'), 'warn'); return; }
    setAuthBusy(true);
    try {
      const r = await net.request(authMode === 'login' ? 'auth.login' : 'auth.register', { username: typed, password: authPass });
      accountStore.write({ token: r.token, username: r.username });
      // The account's saved 干员调配 is authoritative: put it into the local store BEFORE entering, so the sync
      // that runs on welcome sends those entries back instead of overwriting the account with whatever this
      // browser happened to have (a fresh device sends {} and would otherwise wipe it).
      if (r.ops && typeof r.ops === 'object') setOpsMap(parseStoredOps({ ops: r.ops }));
      if (r.loadout && typeof r.loadout === 'object') setEntries(parseStored(r.loadout));
      resumeLoadoutSync(); // the account's own 干员调配 is local again: it may be pushed to the session
      // 对局统计: the account's mirror joins this browser's history before entering — a foreign history (another
      // account's, see ui/stats.js applyAccountStats) is replaced instead of adopted, and a 游客's own records are
      // adopted by the account (the same rule the 干员调配 follows). The welcome-driven sync pushes the union back.
      applyAccountStats(r.stats, { key: String(r.username || '').toLowerCase(), clearedAt: r.statsClearedAt });
      toast(authMode === 'login'
        ? t('已登录 {name}，以该账号进入游戏', { name: r.username })
        : t('账号 {name} 已创建，正在进入游戏', { name: r.username }), 'success');
      setGuest(false); // an account is in use again
      setAuthOpen(false);
      setAuthPass('');
      // No callsign to fill in any more: the username IS the in-game name (enforced server-side too).
      enterAsAccount();
    } catch (err) {
      toast(err?.detail || err?.msg || err?.code || t('操作失败'), 'error');
      console.warn('[auth] failed', err);
    } finally { setAuthBusy(false); }
  };

  const logout = async (e) => {
    e?.preventDefault?.();
    setAuthPass('');
    if (await enterAsGuest()) {
      // The account's 干员调配 is left on the account (the server detached first) and cleared locally.
      toast(t('已退出账号，已切换为游客；干员调配已清除'), 'info');
    } else {
      setGuest(false);
      toast(t('已退出账号'), 'info');
    }
  };

  const acctName = sanitizeName(acct?.username || '');
  // the account this page is already signed into: its form needs no password (submitAuth answers with a toast)
  const sameAccount = !!acct && authUser.trim().toLowerCase() === acct.username.toLowerCase();
  const valid = !!acctName || isValidName(name);
  const start = () => {
    // Logged in → the account name, no callsign step; logged out → the typed callsign.
    if (acctName) { enterAsAccount(); return; }
    if (!valid) { toast(t('请输入博士代号'), 'warn'); return; }
    // A 游客 still enters without an account, but first say what an account would keep in sync (the nudge below).
    // Once they tick 不再提示 this browser never asks again.
    if (!nudgeOff) { setNudgeOpen(true); return; }
    enterSession(name);
  };

  const online = conn.status === 'online' || conn.status === 'connected';
  const dotClass = online ? 'is-on' : conn.status === 'reconnecting' || conn.status === 'connecting' || conn.status === 'handshaking' ? 'is-warn' : 'is-bad';

  // touch screens: no autofocus (it would pop the on-screen keyboard over a landscape phone's whole view)
  const touchUi = useMemo(() => detectFeatures().coarse, []);
  // a title in an alphabetic script (English, French …) is the big one in the display face and the wordmark above it
  // hides; a CJK / kana / Hangul title keeps the Chinese layout (shared/i18nPacks.js scriptOf — a pack needs no flag)
  const alphabetic = scriptOf(t('卫戍协议')) === 'alphabetic';
  return html`<div class="screen title-screen">
    <div class=${`title-bg${bgLoaded ? ' has-art' : ''}${ridgesLoaded ? ' has-ridges' : ''}`} aria-hidden="true">
      ${backdrop ? html`<img class="title-bg__art" src=${backdrop} alt="" draggable=${false}
        onLoad=${() => setBgLoadedUrl(backdrop)} />` : null}
      <div class="title-bg__glow"></div>
      <div class="title-bg__radar"><div class="title-bg__sweep"></div></div>
      <div class="title-bg__target"></div>
      ${cssRidges ? html`<${Ridges} />` : null}
      ${ridges && !ridgesFailed ? html`<div class="title-bg__ridge-art" style=${`background-image:url("${ridges}")`}>
        <img src=${ridges} alt="" hidden onLoad=${() => setRidgesLoadedUrl(ridges)} onError=${() => setRidgesFailedUrl(ridges)} />
      </div>` : null}
      <div class="title-bg__haze"></div>
      <span class="cross" style="left:7%;top:22%"></span>
      <span class="cross" style="left:93%;top:30%"></span>
      <span class="cross" style="left:14%;top:70%"></span>
      <span class="cross" style="left:88%;top:62%"></span>
      <span class="cross" style="left:60%;top:12%"></span>
    </div>

    <div class="title-corner title-corner--tl">
      <span class="title-corner__mark"></span>
      <div><${MicroLabel} tone="mint">RHODES ISLAND // SIMULATION SERVICE<//><br /><${MicroLabel}>TACTICAL CO-OP NODE · 02<//></div>
    </div>
    <div class="title-corner title-corner--tr">
      <div>
        <div class="title-corner__tools">
          <${Button} variant="ghost" size="sm" icon="chart" class="title-stats" onClick=${openStats} title=${t('统计数据')}>${t('统计')}<//>
          <${LangToggle} class="title-lang" />
        </div>
        <${MicroLabel} tone="hi">TARGET POINT<//><br /><${MicroLabel}>STRONGHOLD PROTOCOL<//>
      </div>
    </div>

    <main class="title-main">
      <${Emblem} />
      ${alphabetic ? null : html`<div class="title-en">
        <span class="title-en__a">STRONGHOLD PROTOCOL</span>
        <span class="title-en__b">ALLIANCE</span>
      </div>`}
      <h1 class=${`title-cn${alphabetic ? ' title-cn--latin' : ''}`}>${t('卫戍协议')}<span class="title-cn__colon">${alphabetic ? ': ' : '：'}</span><em>${t('盟约')}</em></h1>
      <p class="title-tag">${t('调配资金与干员，与同伴协同布防，抵御多波次进攻，直至击败敌方领袖。')}</p>

      <div class="title-login">
        ${pendingJoin ? html`<div class="title-invite">
          <${Icon} name="key" />
          <span>${t('收到同盟邀请')}</span><b class="num">${pendingJoin}</b><span class="t-lo">${t('· 输入代号后将自动加入')}</span>
        </div>` : null}
        ${acctName
          ? html`<div class="field field--lg title-account-name">
              <span class="field__label">${t('博士代号')}<em class="micro">ACCOUNT</em></span>
              <span class="field__box brackets" title=${t('游戏内代号取自账号名')}>
                <${Icon} name="user" class="field__icon" />
                <b class="title-account-name__value">${acctName}</b>
                <span class="title-account-name__note">${t('账号名即游戏内代号')}</span>
              </span>
            </div>`
          : html`<${TextField} label=${t('博士代号')} micro="CALLSIGN" size="lg" icon="user" value=${name} maxLength=${NAME_MAX_LEN}
              placeholder=${t('输入你的代号（最多 {NAME_MAX_LEN} 字）', { NAME_MAX_LEN })} autoFocus=${!touchUi}
              onInput=${setName} onEnter=${start} />`}
        <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" disabled=${!valid} onClick=${start}>${t('开始')}<//>
        <div class="title-conn">
          <span class=${`status-dot ${dotClass}`}></span>
          <span>${STATUS_TEXT[conn.status] ? t(STATUS_TEXT[conn.status]) : conn.status}</span>
          ${conn.status === 'online' ? html`<${PingPill} ms=${conn.ping} />` : null}
          <${GuideButton} class="title-guide" label=${t('玩法说明')} />
          <button type="button" class="title-settings fsbtn tapx" aria-label=${t('设置')} title=${t('设置')}
            onClick=${() => setSettingsOpen(true)}><${GIcon} name="gear" /></button>
          <${FullscreenButton} class="title-fs" />
        </div>
        <div class="title-account">
          ${acct
            ? html`<span class="title-account__me">${t('已登录')} <b>${acct.username}</b> · ${t('干员调配已同步')}</span>
                   <button type="button" class="title-account__link" onClick=${() => setAuthOpen(true)}>${t('切换账号')}</button>
                   <button type="button" class="title-account__link" onClick=${logout}>${t('以游客身份继续')}</button>`
            : html`<span class="title-account__me">${t('游客：干员调配只存在这台设备上')}</span>
                   <button type="button" class="title-account__link" onClick=${() => setAuthOpen(true)}>${t('登录 / 注册 · 同步干员调配')}</button>`}
        </div>
      </div>
    </main>

    ${authOpen ? html`<div class="auth-modal" role="dialog" aria-modal="true">
      <form class="auth-modal__box" onSubmit=${submitAuth}>
        <${MicroLabel} tone="mint">ACCOUNT<//>
        <h3>${authMode === 'login' ? t('登录账号') : t('注册账号')}</h3>
        <p class="t-lo">${t('登录后你的账号名就是游戏内代号，干员调配与统计数据也会绑定账号，换设备或刷新都不会丢。')}</p>
        <${TextField} label=${t('账号')} icon="user" value=${authUser} placeholder=${t('字母数字 _ - .')} maxLength=${24}
          autoFocus=${!touchUi} onInput=${(v) => setAuthUser(v)} />
        ${sameAccount
          ? html`<p class="t-lo">${t('该账号已登录，直接进入即可')}</p>`
          : html`<div class="auth-pass">
              <${TextField} label=${t('密码')} icon="lock" value=${authPass} type=${authShow ? 'text' : 'password'}
                placeholder=${t('至少 4 位')} maxLength=${128} onInput=${(v) => setAuthPass(v)} onEnter=${submitAuth} />
              <button type="button" class="auth-pass__toggle" aria-pressed=${authShow}
                onClick=${() => setAuthShow(!authShow)}>${authShow ? t('隐藏') : t('显示')}</button>
            </div>`}
        <${Button} type="submit" variant="primary" block=${true} disabled=${authBusy} iconRight="login">${authBusy ? t('处理中…') : (authMode === 'login' ? t('登录') : t('注册'))}<//>
        <div class="auth-modal__row">
          <button type="button" class="auth-modal__link" onClick=${() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
            ${authMode === 'login' ? t('没有账号？点击注册') : t('已有账号？去登录')}
          </button>
          <button type="button" class="auth-modal__link" onClick=${() => setAuthOpen(false)}>${t('稍后再说')}</button>
        </div>
      </form>
    </div>` : null}

    ${accountExpired ? html`<${Modal} open=${true} micro="ACCOUNT" title=${t('账号已失效')}
        onClose=${dismissExpired}
        actions=${html`<${Button} variant="primary" icon="login" block=${true} data-autofocus=${true} onClick=${recoverAccount}>${t('重新登录 / 注册')}<//>
          <${Button} variant="secondary" block=${true} onClick=${continueAsGuest}>${t('以游客身份继续')}<//>`}>
      <div class="title-nudge">
        <p>${t('服务器上已经没有这个账号（账号数据被清空或换了服务器）。请重新登录或注册。')}</p>
        <p class="t-lo">${t('本机的干员调配与统计数据还在：用同一个账号名重新注册就能传回账号。')}</p>
      </div>
    <//>` : null}

    ${nudgeOpen ? html`<${Modal} open=${true} micro="ACCOUNT" title=${t('登录可同步干员调配、统计与对局')}
        onClose=${() => setNudgeOpen(false)}
        actions=${html`<${Button} variant="primary" icon="login" block=${true} data-autofocus=${true} onClick=${startLogin}>${t('登录 / 注册')}<//>
          <${Button} variant="secondary" block=${true} onClick=${startAsGuest}>${t('以游客身份继续')}<//>`}>
      <div class="title-nudge">
        <p>${t('登录后，干员调配（技能 / 模组、潜能 · 练度）、统计数据与正在进行的对局都会绑定你的账号；换设备或换浏览器登录时，可以接回原来的座位继续这一局。')}</p>
        <p class="t-lo">${t('游客的干员调配与统计数据只保存在这台设备上，对局也不会跟随账号。')}</p>
        <label class="title-nudge__off">
          <input type="checkbox" checked=${nudgeOff} onChange=${(e) => toggleNudgeOff(!!e.currentTarget.checked)} />
          <span>${t('不再提示')}</span>
        </label>
      </div>
    <//>` : null}

    <${SettingsModal} open=${settingsOpen} onClose=${() => setSettingsOpen(false)} />

    <footer class="title-foot">
      <${ResumeMatchButton} />
      <${PwaInstallButton} />
      <span>${t('非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有')}</span>
      <span class="title-foot__meta">
        <a class="title-repo" href="https://github.com/sganggs/Stronghold-Protocol" target="_blank" rel="noopener noreferrer">${t('项目仓库')}</a>
        <${MicroLabel}>v${APP_VERSION} · WEB SIMULATION<//>
        ${DEV_BUILD ? html`<span class="title-dev" role="note">${t('开发版 · 不稳定，请勿用于公开服务器')}</span>` : null}
      </span>
    </footer>
  </div>`;
}
