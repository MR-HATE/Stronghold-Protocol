// test/accounts-roundtrip.test.js — the account extension driven by the REAL client modules (public/js/net.js,
// ui/loadoutSync.js, screens/title.js) against a REAL server, over a real socket.
//
// This is the shape the browser runs, and it is where the 干员调配 losses happened: a hand-written frame sequence
// in accounts.test.js can look correct while the assembled client still pushes the wrong copy. What is covered:
//   * a preset imported while signed in is saved to the account;
//   * leaving the account for 游客 (the title screen's enterAsGuest: `auth.logout` → clear → sync) does NOT touch
//     the account's copy;
//   * signing in again applies the account's copy locally (submitAuth's own sequence) and the account keeps it;
//   * an empty local copy arriving on a session that has never written the account is not stored, so a client that
//     has not received the account's copy yet cannot wipe it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { startServer } from '../server/index.js';
import { AccountStore } from '../server/accounts.js';
import { getData } from '../server/data.js';
import { TestClient } from './helpers/wsClient.js';

const noopLog = { info() {}, warn() {}, debug() {}, error() {} };
const CHESS = 'chess_char_1_01_a'; // 隐现: S1 / S2 (default S2), module MAR-X
const CH = getData({ log: noopLog }).chess[CHESS];

/** A promise that settles when `pred` holds, or rejects after `ms`. */
function waitFor(pred, ms = 5000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve(true);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('accounts × the real client: a 干员调配 survives the 游客 round trip', () => {
  let srv;
  let tmp;
  let store;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rt-'));
    store = new AccountStore({ dir: tmp, log: noopLog });
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accounts: store, helloTimeoutMs: 10_000 });
  });
  after(async () => {
    await srv?.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('import → 游客 → sign in again: the account copy is neither lost nor overwritten', async () => {
    // The client modules are singletons with web globals: install a browser-ish environment BEFORE importing them.
    const backing = new Map();
    const prev = { localStorage: globalThis.localStorage, WebSocket: globalThis.WebSocket, location: globalThis.location };
    globalThis.localStorage = {
      getItem: (k) => (backing.has(k) ? backing.get(k) : null),
      setItem: (k, v) => backing.set(k, String(v)),
      removeItem: (k) => backing.delete(k),
    };
    globalThis.WebSocket = WebSocket;
    globalThis.location = { protocol: 'http:', host: '127.0.0.1' };

    const close = [];
    try {
      const { net, accountStore, guestStore } = await import('../public/js/net.js');
      const { loadoutStore, applyLoadoutEntries, installLoadoutSync, setEntries, setOpsMap, resumeLoadoutSync } = await import('../public/js/ui/loadoutSync.js');
      const { parseStored, parseStoredOps } = await import('../public/js/ui/loadoutModel.js');
      const { enterAsGuest, enterAsAccount, enterSession } = await import('../public/js/screens/title.js');
      close.push(() => net.close());

      net.url = `ws://127.0.0.1:${srv.port}/ws`;
      installLoadoutSync({ net, getChessReady: async () => ({}), lookupChess: (id) => (id === CHESS ? CH : null) });
      net.connect();
      await waitFor(() => net.status === 'connected' || net.status === 'handshaking', 5000, 'the socket to open');

      // 1) register and enter as the account
      const reg = await net.request('auth.register', { username: 'RoundTrip', password: 'pw1234' }, { timeout: 10_000 });
      accountStore.write({ token: reg.token, username: reg.username });
      guestStore.write(false);
      enterSession('RoundTrip');
      await waitFor(() => net.status === 'online', 5000, 'the session to come online');

      // 2) import a preset (the path 导入 uses), which the sync must store on the account
      const imported = applyLoadoutEntries({ [CHESS]: { skill: 0 } }, (id) => (id === CHESS ? CH : null));
      assert.deepEqual([imported.applied, imported.dropped], [1, 0], JSON.stringify(imported));
      await waitFor(() => store.accounts.get('roundtrip')?.loadout?.[CHESS]?.skill === 0, 5000, 'the account to receive the import');
      const saved = (await store.resolveToken(reg.token)).loadout;
      assert.deepEqual(saved[CHESS], { skill: 0, module: 'uniequip_002_inside' });

      // 3) leave for 游客: the account must keep exactly what it had
      assert.equal(await enterAsGuest(), true);
      assert.equal(guestStore.read(), true);
      assert.equal(accountStore.read(), null);
      assert.deepEqual(loadoutStore.get().entries, {}, 'the local copy is cleared for guest play');
      await waitFor(() => net.status === 'online', 5000, 'the guest session');
      await new Promise((r) => setTimeout(r, 200)); // let any stray sync land
      assert.deepEqual((await store.resolveToken(reg.token)).loadout, saved, 'the account copy is untouched');

      // 4) sign in again the way submitAuth does: apply the reply, then enter
      const login = await net.request('auth.login', { username: 'RoundTrip', password: 'pw1234' }, { timeout: 10_000 });
      accountStore.write({ token: login.token, username: login.username });
      assert.deepEqual(login.loadout, saved, 'auth.result carries the account copy');
      setOpsMap(parseStoredOps({ ops: login.ops || {} }));
      setEntries(parseStored(login.loadout));
      resumeLoadoutSync();
      assert.deepEqual(loadoutStore.get().entries, saved, 'the account copy is applied locally');
      guestStore.write(false);
      enterAsAccount();
      await waitFor(() => net.status === 'online', 5000, 'the signed-in session');
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(loadoutStore.get().entries, saved, 'still there after the session syncs');
      assert.deepEqual((await store.resolveToken(login.token)).loadout, saved, 'and the account still holds it');
    } finally {
      for (const f of close) { try { f(); } catch { /* ignore */ } }
      if (prev.localStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev.localStorage;
      if (prev.WebSocket === undefined) delete globalThis.WebSocket; else globalThis.WebSocket = prev.WebSocket;
      if (prev.location === undefined) delete globalThis.location; else globalThis.location = prev.location;
    }
  });

  test('a blank 干员调配 never creates an account copy (a client that has not synced yet cannot seed one)', async () => {
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    const reg = await client.request({ t: 'auth.register', username: 'Blank', password: 'pw1234' }, 10_000);
    await client.hello(undefined, null, { account: reg.token });
    await client.request({ t: 'room.loadout', entries: {}, ops: {} });
    const acct = await store.resolveToken(reg.token);
    assert.equal(acct.loadout, null, 'nothing was stored');

    // a real preset still lands and, from then on, stays (the deliberate-reset case stays possible too)
    await client.request({ t: 'room.loadout', entries: { [CHESS]: { skill: 0 } }, ops: {} });
    assert.ok((await store.resolveToken(reg.token)).loadout[CHESS], 'the imported copy is stored');
    await client.request({ t: 'room.loadout', entries: {}, ops: {} });
    assert.deepEqual((await store.resolveToken(reg.token)).loadout, {}, 'a session that already wrote may clear it');
    await client.close();
  });
});
