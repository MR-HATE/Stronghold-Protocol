// test/accounts-stats.test.js — the account's 对局统计 mirror (extension §account): `stats.push` / `stats.pull` /
// `stats.clear` through a real server, plus the merge rules of server/stats.js.
//
// What is asserted:
//   * a push lands in the account and a pull reads it back (and a fresh store on the same file still has it);
//   * pushes from two devices UNION by record id — neither device's matches are lost, whatever the order;
//   * `auth.login` carries the mirror, so the second device shows the first device's matches from its first render;
//   * a 清空 (stats.clear) drops the mirror and stamps it: a device that still holds the cleared matches cannot push
//     them back;
//   * a 游客's pushes are silent no-ops (guest statistics never leave the browser);
//   * the small shape rules: a foreign version, a record without an id, a payload that is not an envelope → BAD_MSG,
//     and the byte budget bounds what the mirror keeps.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { AccountStore } from '../server/accounts.js';
import { mergeStatsPayload, normalizeStatsPayload, fitStatsPayload, STATS_MAX_BYTES } from '../server/stats.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, STATS_VERSION } from '../shared/constants.js';

const noopLog = { info() {}, warn() {}, debug() {}, error() {} };
const payload = (records) => ({ v: STATS_VERSION, records });
const rec = (id, t, extra = {}) => ({ id, t, end: 'settled', victory: true, roundsPassed: 3, ...extra });

/** Settle when `pred` holds (the store persists stats fire-and-forget, like the loadout). */
function waitFor(pred, ms = 3000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let ok;
      try { ok = pred(); } catch { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect() {
      const c = await TestClient.connect(getUrl());
      open.add(c);
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}

describe('server/stats.js: the mirror merges', () => {
  test('normalizeStatsPayload accepts only the current envelope with usable ids', () => {
    assert.equal(normalizeStatsPayload(null), null);
    assert.equal(normalizeStatsPayload({ v: 2, records: [] }), null, 'a newer version is not this build\'s');
    assert.equal(normalizeStatsPayload({ v: STATS_VERSION, records: {} }), null);
    assert.equal(normalizeStatsPayload({ v: STATS_VERSION, records: [{ t: 1 }] }), null, 'a record needs an id');
    assert.deepEqual(normalizeStatsPayload(payload([rec('a', 1)])).records.length, 1);
  });

  test('a full record wins over a compacted one on the same id; the union is newest first', () => {
    const stored = payload([rec('a', 1, { compact: true }), rec('b', 2)]);
    const incoming = payload([rec('a', 1, { lineup: ['x'] }), rec('c', 3)]);
    const merged = mergeStatsPayload(stored, incoming);
    assert.deepEqual(merged.records.map((r) => r.id), ['c', 'b', 'a']);
    assert.equal(merged.records.find((r) => r.id === 'a').compact, undefined, 'the richer shape survives');
    // the reverse order keeps the stored full one
    const back = mergeStatsPayload(merged, payload([rec('a', 1, { compact: true })]));
    assert.equal(back.records.find((r) => r.id === 'a').compact, undefined);
  });

  test('fitStatsPayload keeps the newest records inside the byte budget', () => {
    const many = Array.from({ length: 500 }, (_, i) => rec(`r${i}`, i, { pad: 'x'.repeat(60) }));
    const kept = fitStatsPayload(many);
    assert.ok(kept.length < many.length, `bounded (${kept.length}/${many.length})`);
    assert.equal(kept[0].id, 'r0', 'newest first survives');
    assert.ok(Buffer.byteLength(JSON.stringify(kept), 'utf8') <= STATS_MAX_BYTES);
  });
});

describe('accounts: the 对局统计 mirror over the wire', () => {
  let srv;
  let tmp;
  let pool;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-stats-sync-'));
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accounts: new AccountStore({ dir: tmp, log: noopLog }) });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Register + hello in one step (a signed-in session). */
  async function signedIn(username) {
    const c = await pool.connect();
    const auth = await c.request({ t: 'auth.register', username, password: 'pw1234' }, 10_000);
    assert.equal(auth.t, 'auth.result', JSON.stringify(auth));
    const w = await c.hello(undefined, null, { account: auth.token });
    assert.equal(w.name, username);
    return { client: c, token: auth.token };
  }

  const idsOf = (reply) => (reply.stats?.records || []).map((r) => r.id).sort();

  test('a push lands in the account, a pull reads it back, and it is on disk', async () => {
    const { client, token } = await signedIn('StatsA');
    assert.equal((await client.request({ t: 'stats.push', stats: payload([rec('m1', 10), rec('m2', 20)]) })).t, 'ok');
    const pulled = await client.request({ t: 'stats.pull' });
    assert.equal(pulled.t, 'stats.sync', JSON.stringify(pulled));
    assert.deepEqual(idsOf(pulled), ['m1', 'm2']);
    // newest first in the mirror
    assert.deepEqual(pulled.stats.records.map((r) => r.id), ['m2', 'm1']);

    // the write is fire-and-forget (like the loadout): wait until it lands on disk, then read it back with a store of
    // its own — a reopen proves the mirror is persisted, not only held in memory
    const file = path.join(tmp, 'accounts.json');
    await waitFor(() => {
      try { return (JSON.parse(fs.readFileSync(file, 'utf8')).statsa?.stats?.records || []).length === 2; } catch { return false; }
    }, 3000, 'the account file to carry the mirror');
    const reopened = new AccountStore({ dir: tmp, log: noopLog });
    const acct = await reopened.resolveToken(token);
    assert.deepEqual((acct.stats?.records || []).map((r) => r.id), ['m2', 'm1'], 'persisted, not just in memory');
  });

  test('two devices pushing in any order keep each other\'s matches, and login carries the mirror', async () => {
    const first = await signedIn('StatsB');
    assert.equal((await first.client.request({ t: 'stats.push', stats: payload([rec('b1', 100)]) })).t, 'ok');

    // the second device signs in (a real login: `auth.result` carries the mirror) and pushes its own match. It does
    // not `hello`, deliberately: a hello would take the account's SEAT over from the first device (one account = one
    // seat, accounts.test.js) and close it, while this test is about the mirror only.
    const second = await pool.connect();
    const login = await second.request({ t: 'auth.login', username: 'StatsB', password: 'pw1234' }, 10_000);
    assert.equal(login.t, 'auth.result');
    assert.deepEqual((login.stats?.records || []).map((r) => r.id), ['b1'], 'auth.result carries the mirror');

    assert.equal((await second.request({ t: 'stats.push', stats: payload([rec('b2', 200)]) })).t, 'ok');
    const back = await first.client.request({ t: 'stats.pull' });
    assert.deepEqual(idsOf(back), ['b1', 'b2'], 'the union, not the last writer');

    // …and pushing the same list again changes nothing (the client repushes after every change)
    assert.equal((await first.client.request({ t: 'stats.push', stats: payload([rec('b1', 100)]) })).t, 'ok');
    assert.deepEqual(idsOf(await first.client.request({ t: 'stats.pull' })), ['b1', 'b2']);
  });

  test('stats.clear drops the mirror and stamps it: a stale device cannot push the cleared matches back', async () => {
    const { client } = await signedIn('StatsC');
    await client.request({ t: 'stats.push', stats: payload([rec('c1', 1_000), rec('c2', 2_000)]) });
    assert.equal((await client.request({ t: 'stats.clear' })).t, 'ok');

    const cleared = await client.request({ t: 'stats.pull' });
    assert.equal(cleared.t, 'stats.sync');
    assert.deepEqual(cleared.stats?.records || [], [], 'the mirror is empty');
    assert.ok(Number.isFinite(cleared.clearedAt), 'and stamped');

    // another device still holding those records pushes them again: they are older than the stamp, so they stay gone
    await client.request({ t: 'stats.push', stats: payload([rec('c1', 1_000), rec('c2', 2_000), rec('c3', cleared.clearedAt + 10_000)]) });
    const after = await client.request({ t: 'stats.pull' });
    assert.deepEqual(idsOf(after), ['c3'], 'only what was recorded after the 清空 comes back');
  });

  test('a 游客 push is a silent no-op and a pull has nothing to hand over', async () => {
    const guest = await pool.connect();
    await guest.hello('游客甲');
    assert.equal((await guest.request({ t: 'stats.push', stats: payload([rec('g1', 5)]) })).t, 'ok', 'no error for a guest');
    const pulled = await guest.request({ t: 'stats.pull' });
    assert.equal(pulled.t, 'ok', 'a plain ok: there is no account here');
    assert.equal(pulled.stats, undefined);
    assert.equal((await guest.request({ t: 'stats.clear' })).t, 'ok');
  });

  test('the shape rules: a foreign version / a record without an id / a non-envelope are BAD_MSG', async () => {
    const { client } = await signedIn('StatsD');
    const bad = [
      { v: STATS_VERSION + 1, records: [rec('x', 1)] },
      payload([{ t: 1 }]),
      { v: STATS_VERSION, records: 'nope' },
      // 1001 minimal records: over the count cap while staying well inside the 64 KB frame limit
      { v: STATS_VERSION, records: Array.from({ length: 1001 }, (_, i) => ({ id: `r${i}`, t: i })) },
    ];
    for (const stats of bad) {
      const r = await client.request({ t: 'stats.push', stats });
      assert.equal(r.t, 'error', JSON.stringify(stats).slice(0, 80));
      assert.equal(r.code, ERR.BAD_MSG);
    }
    // nothing was stored by the refusals
    assert.deepEqual(idsOf(await client.request({ t: 'stats.pull' })), []);
  });

  test('the mirror is bounded: a big push keeps the newest records only', async () => {
    const { client } = await signedIn('StatsE');
    // ~50 KB of records: over the server's byte budget, comfortably inside the 64 KB frame limit
    const many = Array.from({ length: 300 }, (_, i) => rec(`p${String(i).padStart(3, '0')}`, 1_000 + i, { pad: 'x'.repeat(90) }));
    const pushed = await client.request({ t: 'stats.push', stats: payload(many) });
    assert.equal(pushed.t, 'ok', JSON.stringify(pushed));
    const pulled = await client.request({ t: 'stats.pull' });
    const kept = pulled.stats.records;
    assert.ok(kept.length > 0 && kept.length < many.length, `bounded: ${kept.length}/${many.length}`);
    assert.equal(kept[0].id, 'p299', 'the newest match survives');
    assert.ok(Buffer.byteLength(JSON.stringify(kept), 'utf8') <= STATS_MAX_BYTES);
  });
});
