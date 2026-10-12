// test/ui/statsSync.test.js — the account half of the 对局统计 (public/js/ui/statsSync.js, extension §account).
//
// The module is wired to the real transport in the browser, so here it runs against a fake net: what matters is WHEN it
// talks to the account and what it decides to send.
//   * a 游客 (no remembered account) sends nothing at all;
//   * nothing goes out before a `pong` — the exchange waits for the quiet window after one, because the client measures
//     its latency with a ping every 4 s and a stats frame in front of that ping is counted into the number it shows;
//   * a match on screen defers the exchange entirely;
//   * `welcome` schedules the pull; a payload the account already has (the digest in `sp.pref.statsSync`) is not pushed
//     again — only a NEW match is, or an account whose mirror came back empty;
//   * a local change schedules a push, and the same payload is not sent twice;
//   * 清空 asks the account to drop its mirror and forgets the digest.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { installStatsSync, clearAccountStats, PUSH_DEBOUNCE_MS } from '../../public/js/ui/statsSync.js';
import { loadStats, saveStats, emptyStats, appendRecord, statsSyncState, setStatsSyncState } from '../../public/js/ui/stats.js';
import { STATS_VERSION } from '../../shared/constants.js';

/** Map-backed localStorage (Node has none). */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/** A manual clock: scheduled callbacks run only when `flush()` is called. */
function fakeTimers() {
  let seq = 0;
  const queue = new Map();
  return {
    timers: {
      setTimeout: (fn) => { const id = ++seq; queue.set(id, fn); return id; },
      clearTimeout: (id) => queue.delete(id),
    },
    flush() {
      const due = [...queue.entries()];
      queue.clear();
      for (const [, fn] of due) fn();
    },
    get pending() { return queue.size; },
  };
}

/** A fake Net: records every request and answers them in order from `replies` (a missing one is a bare `ok`). */
function fakeNet({ status = 'online', replies = [], events = true } = {}) {
  const sent = [];
  const listeners = new Map();
  const net = {
    status,
    sent,
    on(type, fn) {
      if (!events) return () => {};
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) { for (const fn of [...(listeners.get(type) || [])]) fn(payload); },
    async request(t, fields) {
      const reply = replies[sent.length];
      sent.push({ t, fields });
      if (reply) return { ...reply };
      return { t: 'ok', rid: 1 };
    },
  };
  return net;
}

/**
 * Drive the module's quiet-window gate: the client's ping loop delivers a pong (net.js emits `ping` for each), the
 * module waits its short delay, then the exchange goes out — and a pull is followed by a push that gates again.
 */
async function quiet(clock, net, pred = () => true, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    net.emit('ping', i);
    clock.flush();
    await new Promise((r) => setTimeout(r, 0));
    if (pred()) return true;
  }
  return pred();
}

/** A stored-record shape `normalizeRecord` keeps (it needs a player row: an id-only object is dropped on load). */
const record = (id, t) => ({ id, t, end: 'settled', victory: true, roundsPassed: 3, players: [{ playerId: 'p1', seat: 0 }] });

/** Run an (async) test body with a fake localStorage holding `records` and a stats envelope. */
const withLocal = async (records, fn) => {
  const ls = fakeStorage();
  globalThis.localStorage = ls;
  try {
    let stats = emptyStats();
    for (const r of records) stats = appendRecord(stats, r).stats;
    saveStats(stats);
    return await fn(ls);
  } finally { delete globalThis.localStorage; }
};

describe('statsSync: the account mirror over the transport', () => {
  test('a 游客 sends nothing: no pull, no push, no clear', async () => {
    await withLocal([record('a', 5)], async () => {
      const net = fakeNet();
      const clock = fakeTimers();
      const sync = installStatsSync({ net, getAccount: () => null, timers: clock.timers });
      net.emit('welcome');
      await quiet(clock, net, () => false, 3);
      await sync.push();
      await sync.clear();
      await clearAccountStats(); // nothing wired by this test, must not throw
      assert.deepEqual(net.sent, [], 'a guest never talks to the account');
      sync.dispose();
    });
  });

  test('the exchange waits for the quiet window after a pong', async () => {
    await withLocal([record('local', 9)], async () => {
      const net = fakeNet({ replies: [{ t: 'stats.sync', stats: { v: STATS_VERSION, records: [record('remote', 4)] }, clearedAt: null }] });
      const clock = fakeTimers();
      const sync = installStatsSync({ net, getAccount: () => ({ username: 'Alice' }), timers: clock.timers });
      net.emit('welcome');
      clock.flush(); // the welcome's short delay: the pull now waits for the pong
      await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(net.sent, [], 'nothing is sent before the client has seen a pong');
      assert.ok(clock.pending > 0, 'the gate is armed');
      await quiet(clock, net, () => net.sent.length >= 2);
      assert.deepEqual(net.sent.map((s) => s.t), ['stats.pull', 'stats.push'], 'pull after the pong, then the union');
      assert.deepEqual(loadStats().records.map((r) => r.id).sort(), ['local', 'remote'], 'the mirror was merged locally');
      sync.dispose();
    });
  });

  test('a payload the account already has is not pushed again; a new match is', async () => {
    await withLocal([record('a', 1)], async () => {
      const pushed = () => net.sent.filter((s) => s.t === 'stats.push').length;
      // the account already holds our record, so the pull's follow-up push is decided by the digest alone
      const net = fakeNet({ replies: [{ t: 'stats.sync', stats: { v: STATS_VERSION, records: [record('a', 1)] }, clearedAt: null }] });
      const clock = fakeTimers();
      const sync = installStatsSync({ net, getAccount: () => ({ username: 'alice' }), timers: clock.timers });
      // the first exchange: the pull gates on the pong, so drive the clock while it waits
      const first = sync.pull();
      await quiet(clock, net, () => pushed() >= 1);
      await first;
      assert.equal(statsSyncState()?.account, 'alice');
      assert.match(statsSyncState()?.hash || '', /^[0-9a-f]{8}$/, 'the digest of what the account got is remembered');
      // the same payload again (a reconnect, another welcome): the digest blocks the frame
      const again = sync.pull();
      await quiet(clock, net, () => false, 4);
      await again;
      assert.equal(pushed(), 1, 'the same payload is not re-uploaded');
      // …but a finished match changes the payload, and that does go up
      saveStats(appendRecord(loadStats(), record('b', 2)).stats);
      await quiet(clock, net, () => pushed() >= 2);
      assert.equal(pushed(), 2, 'a new match is pushed');
      assert.ok(PUSH_DEBOUNCE_MS > 0);
      sync.dispose();
    });
  });

  test('a mirror that came back empty is handed the history again', async () => {
    await withLocal([record('a', 1)], async () => {
      setStatsSyncState({ account: 'alice', hash: 'deadbeef' }); // as if this browser had pushed before
      const net = fakeNet({ replies: [{ t: 'stats.sync', stats: { v: STATS_VERSION, records: [] }, clearedAt: null }] });
      const clock = fakeTimers();
      const sync = installStatsSync({ net, getAccount: () => ({ username: 'alice' }), timers: clock.timers });
      const pending = sync.pull();
      await quiet(clock, net, () => net.sent.some((s) => s.t === 'stats.push'));
      await pending;
      assert.ok(net.sent.some((s) => s.t === 'stats.push'), 'the account lost its mirror: send ours');
      sync.dispose();
    });
  });

  test('a match on screen defers the exchange; it goes out once the game is over', async () => {
    await withLocal([record('a', 1)], async () => {
      let busy = true;
      const net = fakeNet({ replies: [{ t: 'stats.sync', stats: { v: STATS_VERSION, records: [] }, clearedAt: null }] });
      const clock = fakeTimers();
      const sync = installStatsSync({ net, getAccount: () => ({ username: 'alice' }), isBusy: () => busy, timers: clock.timers });
      await sync.pull();
      await quiet(clock, net, () => false, 3);
      assert.deepEqual(net.sent, [], 'nothing is sent while a match is on screen');
      busy = false;
      await quiet(clock, net, () => net.sent.length > 0);
      assert.ok(net.sent.some((s) => s.t === 'stats.pull'), 'the deferred pull runs afterwards');
      sync.dispose();
    });
  });

  test('an offline push is retried later instead of being lost silently', async () => {
    await withLocal([record('a', 1)], async () => {
      const net = fakeNet({ status: 'reconnecting' });
      const clock = fakeTimers();
      const sync = installStatsSync({ net, getAccount: () => ({ username: 'alice' }), timers: clock.timers });
      await sync.push();
      assert.deepEqual(net.sent, [], 'nothing is sent while the session is not online');
      assert.equal(clock.pending, 1, 'and a retry is scheduled');
      sync.dispose();
      clock.flush();
      assert.deepEqual(net.sent, [], 'a disposed sync stops retrying');
    });
  });

  test('清空 asks the account to drop its mirror and forgets the digest (signed in only)', async () => {
    await withLocal([record('a', 1)], async () => {
      setStatsSyncState({ account: 'alice', hash: 'deadbeef' });
      const net = fakeNet();
      const sync = installStatsSync({ net, getAccount: () => ({ username: 'alice' }), timers: fakeTimers().timers });
      await sync.clear();
      assert.deepEqual(net.sent.map((s) => s.t), ['stats.clear']);
      assert.equal(statsSyncState(), null, 'the next change pushes again');
      sync.dispose();
    });
  });
});
