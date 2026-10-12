// test/accounts.test.js — the optional account extension (§account): server/accounts.js plus the lobby's accountHello.
//
// The account username IS the in-game name: a registered / logged-in player never types a callsign on top of it.
// What is asserted here is the contract that makes that safe, and the parts a game update could quietly break:
//   * `hello { account }` resolves the token against the store and the VERIFIED username becomes the session name,
//     so a client cannot take another player's account name, and a name in the frame never overrides a valid token;
//   * an unknown / revoked token is inert — the frame's own name (or the default when it sent none) stands, so a
//     stale localStorage entry still enters the game. That `welcome` carries no `accountName`, which is how the
//     client knows the credential is dead: it forgets the bearer, says so and re-hellos as a 游客 under this
//     browser's callsign (public/js/net.js `_onWelcome` / `_accountRejected`, main.js);
//   * `hello.name` may be absent when `account` is present (a username is longer than NAME_MAX_LEN) and is still
//     required without a token;
//   * `auth.register` / `auth.login` work before hello (the title-screen flow: the socket is open, no session yet)
//     and answer with `auth.result`; the very next hello already shows the account name;
//   * the account behaves like the reconnect token: a second connection with the same token resumes the seat
//     (close 4001), which is what a player expects from logging in on another device;
//   * `room.loadout` is persisted to the account and comes back on the next login (cross-device 干员调配).
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { AccountStore } from '../server/accounts.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, DEFAULT_NAME, PHASE } from '../shared/constants.js';

const noopLog = { info() {}, warn() {}, debug() {}, error() {} };
const CHESS = 'chess_char_1_01_a'; // 隐现: a real chess id the loadout check accepts

/** Send an intent and assert the `ok` reply. */
const ok = async (c, msg) => {
  const r = await c.request(msg);
  assert.equal(r.t, 'ok', JSON.stringify(r));
  return r;
};

/** Every client opened by a test, so a failing assertion never leaks a socket. */
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

describe('accounts: the account name is the in-game name', () => {
  let srv;
  let tmp;
  let pool;
  let store;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-accounts-'));
    store = new AccountStore({ dir: tmp, log: noopLog });
    srv = await startServer({
      port: 0, host: '127.0.0.1', quiet: true, accounts: store,
      // auth.login / auth.register run scrypt (~10 ms) before the reply: keep a slow CI from failing a hello
      helloTimeoutMs: 10_000,
    });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });

  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Register / log in through a pre-hello socket, like the title screen does. */
  async function auth(c, t, username, password = 'hunter2') {
    const r = await c.request({ t, username, password }, 10_000);
    assert.equal(r.t, 'auth.result', JSON.stringify(r));
    return r;
  }

  async function register(username, password = 'hunter2') {
    const c = await pool.connect();
    const r = await auth(c, 'auth.register', username, password);
    assert.equal(r.username, username);
    assert.equal(typeof r.token, 'string');
    return { client: c, token: r.token };
  }

  test('auth.register before hello: the session is created and named after the account', async () => {
    const c = await pool.connect();
    const r = await auth(c, 'auth.register', 'Anna', 'hunter2');
    assert.equal(r.username, 'Anna');
    assert.equal(r.loadout, null);

    // pre-hello auth runs on a throwaway session; this hello renames it to the account.
    // No `name` field at all — that is what a logged-in client sends (a username need not fit NAME_MAX_LEN).
    const w = await c.hello(undefined, null, { account: r.token });
    assert.equal(w.name, 'Anna', 'the verified account username is the session name');
    assert.equal(w.accountName, 'Anna', 'welcome carries the account name');

    const w2 = await c.hello('typed', w.token, { account: r.token });
    assert.equal(w2.name, 'Anna', 'a client-supplied name never overrides the account');
    assert.equal(w2.playerId, w.playerId, 'the repeated hello stays on the same seat');
  });

  test('an account username may be longer than the callsign limit', async () => {
    const username = 'long_name_24_chars_okay'; // 23 chars, USERNAME_RE allows up to 24
    assert.equal(username.length, 23);
    const c = await pool.connect();
    const r = await auth(c, 'auth.register', username, 'hunter2');

    const w = await c.hello(undefined, null, { account: r.token });
    assert.equal(w.name, username, 'the protocol name limit (12) does not bound an account name');
    const created = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    assert.equal(created.t, 'ok', JSON.stringify(created));
    const state = await c.waitFor('room.state');
    assert.equal(state.seats[0].name, username, 'room.state carries the account name');
  });

  test('a name-less hello without an account token is refused', async () => {
    const c = await pool.connect();
    const r = await c.request({ t: 'hello', version: 1 });
    assert.equal(r.t, 'error');
    assert.equal(r.code, ERR.BAD_MSG);
    const r2 = await c.request({ t: 'hello', version: 1, account: 'f'.repeat(64) });
    assert.equal(r2.t, 'welcome', 'an unknown token falls back to a default name instead of rejecting the entry');
    assert.equal(r2.name, DEFAULT_NAME);
  });

  test('a valid account token outranks hello.name (no name spoofing, no rename)', async () => {
    const { token } = await register('Bob');
    const c = await pool.connect();
    const w = await c.hello('NotBob', null, { account: token });
    assert.equal(w.name, 'Bob');
    assert.equal(w.accountName, 'Bob');

    // a later rename attempt on the live socket is overwritten by accountHello as well
    const w2 = await c.hello('StillNotBob', w.token, { account: token });
    assert.equal(w2.name, 'Bob');
  });

  test('an unknown token is inert: the frame name stands and the session stays usable', async () => {
    const c = await pool.connect();
    const w = await c.hello('Solo', null, { account: 'f'.repeat(64) });
    assert.equal(w.name, 'Solo');
    assert.equal(w.accountName, undefined, 'no account was adopted');

    const created = await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    assert.equal(created.t, 'ok', JSON.stringify(created));
    const state = await c.waitFor('room.state');
    assert.equal(state.seats[0].name, 'Solo');
  });

  test('auth.login resolves the account name, pre-hello included', async () => {
    const { client: first, token } = await register('Carol', 'pw1234');
    assert.equal(token.length, 64);

    const bad = await first.request({ t: 'auth.login', username: 'Carol', password: 'wrong' });
    assert.equal(bad.t, 'error');
    assert.equal(bad.code, ERR.BAD_MSG);

    const missing = await first.request({ t: 'auth.login', username: 'Nobody', password: 'pw1234' });
    assert.equal(missing.t, 'error');
    assert.equal(missing.code, ERR.BAD_MSG, 'no account enumeration');

    const taken = await first.request({ t: 'auth.register', username: 'Carol', password: 'pw1234' });
    assert.equal(taken.t, 'error');
    assert.equal(taken.code, ERR.ALREADY);

    const ok = await auth(first, 'auth.login', 'carol', 'pw1234');
    assert.equal(ok.username, 'Carol', 'the stored spelling, not what was typed');
    assert.equal(ok.token, token, 'one stable bearer per account: a second device gets the same token');

    const w = await first.hello('Typed', null, { account: ok.token });
    assert.equal(w.name, 'Carol');
    assert.equal(w.resumed, false);
  });

  test('the resolved name is what the room sees', async () => {
    const { token } = await register('Dave');
    const host = await pool.connect();
    const w = await host.hello('ignored', null, { account: token });
    assert.equal(w.name, 'Dave');
    const created = await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    assert.equal(created.t, 'ok');
    const state = await host.waitFor('room.state');
    assert.equal(state.seats[0].name, 'Dave', 'room.state carries the account name');
  });

  test('an account session is taken over like a reconnect token (a second device resumes the seat)', async () => {
    const { token } = await register('Erin');
    const a = await pool.connect();
    const wa = await a.hello(undefined, null, { account: token });
    assert.equal(wa.name, 'Erin');

    // the second device presents the ACCOUNT token only (no reconnect token): the same seat comes back
    const b = await pool.connect();
    const wb = await b.hello(undefined, null, { account: token });
    assert.equal(wb.name, 'Erin');
    assert.equal(wb.playerId, wa.playerId, 'the same seat, not a second one');
    assert.equal(wb.resumed, true);
    assert.equal((await a.closed).code, 4001, 'the first socket is replaced');

    // and the seat keeps working for the new socket
    const created = await b.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    assert.equal(created.t, 'ok', JSON.stringify(created));
  });

  test('the account name wins over a hello that also carries a reconnect token', async () => {
    const { token } = await register('Gina');
    const a = await pool.connect();
    const wa = await a.hello(undefined, null, { account: token });

    // a third tab that knows both the seat token and the account: the pair resolves to one seat, named by the account
    const b = await pool.connect();
    const wb = await b.hello('Somebody', wa.token, { account: token });
    assert.equal(wb.playerId, wa.playerId);
    assert.equal(wb.name, 'Gina');
  });

  test('room.loadout is saved to the account and comes back on the next login', async () => {
    const { client: first, token } = await register('Hana', 'pw1234');
    await first.hello(undefined, null, { account: token });
    await first.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await first.waitFor('room.state');
    const entries = { [CHESS]: { skill: 0 } };
    const r = await first.request({ t: 'room.loadout', entries, ops: {} });
    assert.equal(r.t, 'ok', JSON.stringify(r));

    // a fresh device logs in: the account's loadout arrives in the login reply and in the welcome-driven session
    const other = await pool.connect();
    const login = await auth(other, 'auth.login', 'Hana', 'pw1234');
    assert.ok(login.loadout, 'auth.result carries the saved loadout');
    assert.deepEqual(login.loadout[CHESS], { skill: 0, module: 'uniequip_002_inside' }, 'normalised by checkLoadout');
    const w2 = await other.hello(undefined, null, { account: login.token });
    assert.equal(w2.name, 'Hana');

    // and the store itself kept it
    const fresh = new AccountStore({ dir: tmp, log: noopLog });
    const acct = await fresh.resolveToken(login.token);
    assert.deepEqual(acct.loadout[CHESS], { skill: 0, module: 'uniequip_002_inside' });
  });

  test('the store survives a reload of accounts.json', async () => {
    const { token } = await register('Frank', 'pw1234');
    const reopened = new AccountStore({ dir: tmp, log: noopLog });
    const acct = await reopened.resolveToken(token);
    assert.equal(acct.username, 'Frank');
    assert.equal(acct.loadout, null);

    await reopened.saveLoadout(token, { [CHESS]: { skill: 0, module: 'uniequip_002_inside' } });
    const again = new AccountStore({ dir: tmp, log: noopLog });
    const withLoadout = await again.resolveToken(token);
    assert.deepEqual(withLoadout.loadout, { [CHESS]: { skill: 0, module: 'uniequip_002_inside' } });
  });

  test('auth.logout detaches the session: a 游客 reset never reaches the account', async () => {
    const { client: first, token } = await register('Ida', 'pw1234');
    await first.hello(undefined, null, { account: token });
    await first.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await first.waitFor('room.state');
    await first.request({ t: 'room.loadout', entries: { [CHESS]: { skill: 0 } }, ops: {} });

    // the 游客 transition: the session lets go of the account, then the client clears its copy and syncs it
    const out = await first.request({ t: 'auth.logout' });
    assert.equal(out.t, 'ok', JSON.stringify(out));
    const cleared = await first.request({ t: 'room.loadout', entries: {}, ops: {} });
    assert.equal(cleared.t, 'ok', JSON.stringify(cleared));

    // the account still holds the loadout it had, and logging in again brings it back
    const fresh = await pool.connect();
    const login = await auth(fresh, 'auth.login', 'Ida', 'pw1234');
    assert.ok(login.loadout, 'the account kept its loadout through the 游客 round trip');
    assert.deepEqual(login.loadout[CHESS], { skill: 0, module: 'uniequip_002_inside' });
    const w = await fresh.hello(undefined, null, { account: login.token });
    assert.equal(w.name, 'Ida');
    assert.equal(w.accountName, 'Ida', 'the logged-in session is the account again');
  });

  test('a login on a second device restores the seat and the running match', async () => {
    const { token } = await register('Iris', 'pw1234');

    // the first device: the account opens the session, creates a solo run and starts its match
    const deviceA = await pool.connect();
    const wa = await deviceA.hello(undefined, null, { account: token });
    assert.equal(wa.name, 'Iris');
    await ok(deviceA, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    const state = await deviceA.waitFor('room.state');
    await ok(deviceA, { t: 'room.start' });
    await deviceA.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);

    // the second device signs in with the PASSWORD (a real login, not a copied token): the account resolves to
    // the seat it already holds, so the running match comes back here instead of a second empty session
    const deviceB = await pool.connect();
    const login = await auth(deviceB, 'auth.login', 'Iris', 'pw1234');
    const wb = await deviceB.hello(undefined, null, { account: login.token });
    assert.equal(wb.playerId, wa.playerId, 'the account seat is restored, not a second one');
    assert.equal(wb.resumed, true, 'the restore is a resume: the server resends room and match state');
    assert.equal((await deviceA.closed).code, 4001, 'one seat per account: the first socket is replaced');

    const restored = await deviceB.waitFor('room.state', (r) => r.code === state.code);
    assert.equal(restored.inMatch, true, 'the room is back in its running match');
    const priv = await deviceB.waitFor('m.private');
    assert.equal(priv.seat, 0, 'the match resynced to the restored seat');
    assert.equal(srv.lobby.rooms.get(state.code).activeHumans().length, 1, 'no duplicate seat was taken');

    // The client arms its post-resume restore grace when `welcome` arrives and counts only the frames that FOLLOW
    // it as fresh (public/js/main.js onWelcome / RESTORE_GRACE_MS). The resync must therefore not overtake the
    // welcome: it used to, so the restored state counted as stale and was dropped 1.5 s later — the player saw the
    // match and was then thrown back to the lobby (「重新登录后短暂显示对局界面又跳回选择界面」).
    const iw = deviceB.log.indexOf(wb);
    assert.ok(iw >= 0, 'the welcome is in the stream');
    assert.ok(deviceB.log.indexOf(restored) > iw, 'welcome leads room.state');
    assert.ok(deviceB.log.indexOf(priv) > iw, 'welcome leads the match resync');
  });

  test('a repeated hello answers welcome before the room / match resync', async () => {
    // The same-browser case: the title screen enters as the account it already opened a session with (开始), which
    // is a repeated hello on the live socket. Same contract as above — the client's restore grace measures the
    // welcome, so the resync has to follow it.
    const { token } = await register('Lena', 'pw1234');
    const c = await pool.connect();
    await c.hello(undefined, null, { account: token });
    await ok(c, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await c.waitFor('room.state');
    await ok(c, { t: 'room.start' });
    await c.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);

    c.clearInbox();
    const w = await c.hello(undefined, null, { account: token });
    const resent = await c.waitFor('room.state');
    const iw = c.log.indexOf(w);
    assert.ok(iw >= 0, 'the welcome is in the stream');
    assert.ok(c.log.indexOf(resent) > iw, `welcome leads room.state: ${c.log.map((m) => m.t).join(',')}`);
    assert.equal(resent.inMatch, true, 'the resend carries the running match');
  });

  test('another account signing in never inherits the seat (isolation)', async () => {
    const { token: jackToken } = await register('Jack', 'pw1234');
    await register('Kim', 'pw1234'); // Kim exists; the switch below signs in with the password

    // Jack plays a solo run in this browser (one session, one socket)
    const browser = await pool.connect();
    const wj = await browser.hello(undefined, null, { account: jackToken });
    assert.equal(wj.name, 'Jack');
    await ok(browser, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    const state = await browser.waitFor('room.state');
    await ok(browser, { t: 'room.start' });
    await browser.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);

    // somebody signs in as Kim on that same session (the shared browser's title screen). The credential exchange
    // itself already releases the seat, before it claims anything.
    const login = await auth(browser, 'auth.login', 'Kim', 'pw1234');
    assert.equal(srv.lobby.rooms.get(state.code), undefined, 'the login released Jack\'s seat');
    const wk = await browser.hello(undefined, null, { account: login.token });
    assert.equal(wk.name, 'Kim');
    assert.equal(wk.resumed, false, 'a repeat hello on this socket, not a resume of anything');
    const closed = await browser.waitFor('room.closed');
    assert.equal(closed.reason, 'account', 'the client is told the previous seat is gone');
    const notInRoom = await browser.request({ t: 'room.leave' });
    assert.equal(notInRoom.code, 'NOT_IN_ROOM', 'Kim starts in the lobby, not in Jack\'s match');
    assert.equal(srv.lobby.registry.byId(wk.playerId).roomCode, null, 'the account holds no seat it did not take');

    // and Jack is not silently dropped into that abandoned seat either: signing in again is a fresh session
    const again = await pool.connect();
    const wj2 = await again.hello(undefined, null, { account: jackToken });
    assert.equal(wj2.name, 'Jack');
    assert.equal(wj2.resumed, false, 'the released seat is not handed back from nowhere');
    assert.notEqual(wj2.playerId, wj.playerId);
  });

  test('a lobby without an account store refuses auth instead of crashing', async () => {
    const { Lobby } = await import('../server/lobby.js');
    const { SessionRegistry } = await import('../server/net.js');
    const lobby = new Lobby({ registry: new SessionRegistry(), log: noopLog, accounts: null });
    const registered = await lobby.authRegister({}, { username: 'Nobody', password: 'pw1234' });
    assert.equal(registered.error, ERR.BAD_MSG);
    const loggedIn = await lobby.authLogin({}, { username: 'Nobody', password: 'pw1234' });
    assert.equal(loggedIn.error, ERR.BAD_MSG);
    // accountHello is a no-op without a store (a plain hello path)
    const session = { accountToken: null };
    await lobby.accountHello(session);
    assert.equal(session.name, undefined);
  });
});
