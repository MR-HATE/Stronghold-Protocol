// public/js/ui/statsSync.js — keep the local 对局统计 in step with the signed-in account (extension §account).
//
// The local history (ui/stats.js) stays the source of truth; the account holds a bounded mirror of it (server/stats.js).
// Two directions, both idempotent because the merge is a union by record id:
//   * push — after a local change (a finished match, an import) send the whole payload, but ONLY when this browser has
//     not already handed that exact payload over (`sp.pref.statsSync`, ui/stats.js statsSyncState). The mirror is
//     bounded, so asking "does the account hold all our records?" is always false for a player with more matches than
//     fit — the question has to be "did WE change since the last push?", or every reconnect would re-upload the lot.
//   * pull — once per `welcome` ask for the mirror back and merge it locally (`applyAccountStats`), which is what makes
//     a second device show the matches played on the first; the merge is followed by `push()`, which by itself decides
//     whether anything actually needs to go up.
//
// Both exchanges are deferred into the quiet window right after a `pong`: the client measures its latency with a ping
// every 4 s (net.js PING_INTERVAL_MS), and a stats frame sitting in front of that ping is counted into the number the
// player sees. `isBusy()` (a match on screen) defers them entirely — the client is simulating battles then.
//
// A 游客 never syncs: without an account store entry nothing is sent, and the server ignores the frames anyway (no
// `session.accountToken`). `stats.clear` is the one explicit write the stats page triggers (清空统计数据), so the
// clear sticks for the other devices instead of being re-uploaded by them.
//
// Dependencies are injectable (net + the account getter + the busy check + timers), like ui/loadoutSync.js: no import
// of the net.js singleton, so this module is Node-testable.

import {
  loadStats, statsSyncPayload, statsFingerprint, statsSyncState, setStatsSyncState, applyAccountStats, onStatsChanged,
} from './stats.js';

/** Wait this long after a local change before pushing (a match end and the settlement replay arrive together). */
export const PUSH_DEBOUNCE_MS = 2000;
/** Wait this long after `welcome` before pulling (the session is online; the loadout sync is sending its own frames). */
export const PULL_DEBOUNCE_MS = 200;
/** Retry delay after an OFFLINE / RATE / TIMEOUT refusal or a deferred (match running) exchange. */
const RETRY_MS = 15_000;
/** How long after a `pong` the exchange goes out: the next ping is ~4 s away, so it never shares the frame's queue. */
const AFTER_PONG_MS = 400;
/** Cap on waiting for that `pong` (the ping interval is 4 s; a stalled client must still sync eventually). */
const QUIET_TIMEOUT_MS = 6000;

const defaultTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

/** The sync `installStatsSync` wired (main.js calls it once at boot), or null before that / in a test. */
let activeStatsSync = null;

/**
 * Wire the account sync once (main.js calls it at boot). Returns the handle the stats page uses for 清空.
 * @param {{ net: any, getAccount?: () => ({ username?: string } | null), isBusy?: () => boolean,
 *   timers?: { setTimeout: Function, clearTimeout: Function } }} deps
 *   `getAccount` returns the remembered account (public/js/net.js accountStore), null for a 游客; `isBusy` says a match
 *   is on screen (main.js: the route is the game), which defers the exchange.
 * @returns {{ push: () => Promise<void>, pull: () => Promise<void>, clear: () => Promise<void>, dispose: () => void }}
 */
export function installStatsSync({ net, getAccount = () => null, isBusy = () => false, timers = defaultTimers }) {
  let disposed = false;
  let pushTimer = null;
  let pullTimer = null;
  /** Digest of the last payload this session pushed (the persisted statsSyncState is the cross-session record). */
  let lastSent = null;

  /** The verified account key (lowercased username) of the remembered account, or null. */
  const accountKey = () => {
    const acct = getAccount();
    const name = acct && typeof acct.username === 'string' ? acct.username.toLowerCase() : '';
    return name || null;
  };
  const signedIn = () => accountKey() != null;

  const schedulePush = (ms = PUSH_DEBOUNCE_MS) => {
    if (disposed) return;
    timers.clearTimeout(pushTimer);
    pushTimer = timers.setTimeout(() => { pushTimer = null; void push(); }, ms);
  };
  const schedulePull = (ms = PULL_DEBOUNCE_MS) => {
    if (disposed) return;
    timers.clearTimeout(pullTimer);
    pullTimer = timers.setTimeout(() => { pullTimer = null; void pull(); }, ms);
  };

  /**
   * Resolve in the socket's quiet window: `AFTER_PONG_MS` after the next pong (net.js emits `ping` for every pong), so
   * the stats frame does not sit in front of the latency probe's own pong. Resolves false when a match is on screen
   * (the caller retries later) or when the session is not online; a stalled client still gets an answer after
   * QUIET_TIMEOUT_MS.
   * @returns {Promise<boolean>} whether the socket is quiet and the exchange may go out
   */
  function waitForQuiet() {
    if (disposed || net.status !== 'online') return Promise.resolve(false);
    if (isBusy()) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let off = null;
      let fallback = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(fallback);
        off?.();
        resolve(!disposed && net.status === 'online' && !isBusy());
      };
      off = net.on?.('ping', () => { timers.setTimeout(finish, AFTER_PONG_MS); });
      fallback = timers.setTimeout(finish, QUIET_TIMEOUT_MS);
    });
  }

  async function push({ force = false } = {}) {
    if (disposed || !signedIn()) return;
    if (net.status !== 'online') { schedulePush(RETRY_MS); return; } // the next welcome pulls (and pushes what is new)
    const key = accountKey();
    let payload;
    let hash;
    try {
      const local = loadStats();
      // a history written by a NEWER client is neither merged nor uploaded (its records are not this build's schema)
      if (local.newer) return;
      payload = statsSyncPayload(local);
      hash = statsFingerprint(payload);
    } catch (e) {
      console.warn('[stats] cannot build the account payload', e);
      return;
    }
    // The account already has exactly this payload (this session or a previous one): do not spend the frame again —
    // the mirror is bounded, so "the account is missing our older records" is always true and is not a reason to push.
    const known = statsSyncState();
    if (!force && hash && (hash === lastSent || (known && known.account === key && known.hash === hash))) return;
    if (!(await waitForQuiet())) { schedulePush(RETRY_MS); return; }
    try {
      await net.request('stats.push', { stats: payload });
      lastSent = hash;
      if (key) setStatsSyncState({ account: key, hash });
    } catch (err) {
      // a refusal is not worth telling the player: the local history is intact and the next welcome tries again
      console.warn('[stats] push refused', err?.code || err);
      schedulePush(RETRY_MS);
    }
  }

  async function pull() {
    if (disposed || !signedIn() || net.status !== 'online') return;
    if (!(await waitForQuiet())) { schedulePull(RETRY_MS); return; }
    let reply;
    try {
      reply = await net.request('stats.pull');
    } catch (err) {
      console.warn('[stats] pull refused', err?.code || err);
      return;
    }
    // a plain `ok` is the server saying "no account here" (a 游客 session, or a server without the store)
    if (!reply || reply.t !== 'stats.sync') return;
    const key = accountKey();
    if (!key) return;
    const { added, replaced, cleared, blocked } = applyAccountStats(reply.stats, { key, clearedAt: reply.clearedAt });
    if (blocked) return; // a newer-format envelope on either side: nothing merged, nothing to hand over
    // the merge wrote the history, which scheduled a debounced push; this call is the follow-up that decides whether
    // anything goes up, so drop that redundant frame
    timers.clearTimeout(pushTimer);
    pushTimer = null;
    if (replaced) console.info('[stats] another account owns the local history: starting from this account\'s copy');
    if (added || replaced || cleared) console.info(`[stats] account mirror merged (+${added}${replaced ? ', replaced' : ''}${cleared ? `, cleared ${cleared}` : ''})`);
    // A mirror that came back EMPTY while this browser has a history means the account lost it (a wiped or replaced
    // store): hand it over again. Otherwise `push()` decides by itself whether our payload changed since the last push.
    const empty = !Array.isArray(reply.stats?.records) || reply.stats.records.length === 0;
    void push(empty ? { force: true } : {});
  }

  /**
   * 清空统计数据 on the account side (the page clears the local copy itself): the mirror is dropped and stamped, so a
   * device that still holds the cleared matches drops them on its next pull instead of pushing them back.
   */
  async function clear() {
    if (disposed || !signedIn()) return;
    try {
      await net.request('stats.clear');
      // nothing has been handed over any more: the next local change (or a new match) pushes again
      lastSent = null;
      setStatsSyncState(null);
    } catch (err) {
      console.warn('[stats] clear refused', err?.code || err);
    }
  }

  const offChange = onStatsChanged(() => schedulePush());
  // every welcome asks the account for its copy (the merge then decides whether anything needs to go up)
  const offWelcome = net.on('welcome', () => schedulePull());

  const handle = {
    push,
    pull,
    clear,
    dispose() {
      disposed = true;
      timers.clearTimeout(pushTimer);
      timers.clearTimeout(pullTimer);
      offChange();
      offWelcome?.();
      if (activeStatsSync === handle) activeStatsSync = null;
    },
  };
  activeStatsSync = handle;
  return handle;
}

/**
 * Ask the account to drop its 对局统计 mirror (清空统计数据). The stats page clears the local copy itself and calls
 * this so the clear sticks for the other devices; a 游客 / an offline client is a no-op.
 * @returns {Promise<void>}
 */
export function clearAccountStats() { return activeStatsSync ? activeStatsSync.clear() : Promise.resolve(); }
