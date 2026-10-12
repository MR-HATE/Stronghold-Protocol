// server/accounts.js — lightweight account store (DESIGN extension §account).
//
// Optional and self-contained: the server runs without it (tests and a bare `node server/index.js` do), and the
// only things that need it are the lobby's auth handlers and accountHello.
//
// Persists accounts as a single JSON file under the account data dir (`accounts.json`):
//   { "alice": { name, salt, hash, loadout, ops, stats, statsClearedAt, createdAt, lastLoginAt, token } }
//
// The map key is the lowercased username (lookup); `name` keeps the spelling the player registered with,
// because the username IS the in-game name (server/lobby.js accountHello) and a display name must not be
// lowercased behind the player's back. An entry that lacks a field this build does not know is carried
// through the next write untouched, so a newer build's account data is never destroyed by an older one.
//
// - Password: Node's `scrypt` (built-in, no extra dep) with a per-user random salt.
// - "account token": a 32-byte random hex string returned on register / login; the client stores it like
//   the reconnect token (localStorage, public/js/net.js accountStore) and passes it on every `hello`. It
//   binds the 干员调配 — and the SEAT (a room / a running match) — to a human identity across tabs, devices
//   and server restarts, unlike the ephemeral session `playerId`, which is thrown away when the process
//   restarts. ONE bearer per account: `login` hands back the token the account already has, because the
//   lobby resolves the token to the account and then to the seat that account holds, so signing in on a
//   second device must land on that same seat (a rotated token would leave the first device holding it with
//   a dead one — extension §account, docs/design/network.md). It is a password-equivalent secret, valid
//   until the entry is deleted; there is no revocation and no device list (NOT a full auth system, below).
// - The loadout is stored verbatim in the shapes `room.loadout` expects (entries / ops), with no semantic
//   validation here: the lobby re-validates against the live game data, so a stale entry is dropped on the
//   next sync — exactly the way an unauthenticated loadout is.
// - `stats` is the 对局统计 mirror: the same envelope the browser keeps locally, UNIONED with what the account
//   already holds on every push and bounded to a byte budget (server/stats.js), so two devices pushing in any order
//   never lose each other's matches. `statsClearedAt` is the stamp of the last 清空统计数据: a client that still has
//   records older than it drops them instead of uploading them back (the clear sticks across devices).
// - Concurrency: single-process Node; a `fsync`-free write after every mutation is fine for this scale
//   (a few hundred accounts; the file is rewritten whole, so it is bounded per account — the loadout and the stats
//   mirror are the big fields and both are capped). Writes are atomic (write temp + rename) so a crash mid-write
//   never corrupts the store.
//
// NOT a full auth system: no email, no password reset, no rate limiting beyond the per-IP socket limit
// already in net.js, and no access control (anyone with the address may play without an account). Good
// enough for a friend group playing a fan remake — not production internet scale.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { mergeStatsPayload, normalizeStatsPayload } from './stats.js';

const scryptAsync = promisify(crypto.scrypt);
const USERNAME_RE = /^[a-zA-Z0-9_\-.]{2,24}$/;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }; // interactive login cost; ~10 ms per verify
const TOKEN_BYTES = 32;

/**
 * @typedef {{ name: string, salt: string, hash: string, loadout: Record<string, any> | null,
 *             ops: Record<string, any> | null, stats: { v: number, records: any[] } | null,
 *             statsClearedAt: number | null, createdAt: number, lastLoginAt: number,
 *             [extra: string]: any }} AccountRecord
 *   `loadout` / `ops` mirror `room.loadout`'s two maps (DESIGN §16 / the 0.2.2 潜能·练度 addition); both are
 *   null until the player has sent one. `stats` is the 对局统计 mirror (server/stats.js) and `statsClearedAt` the
 *   stamp of its last 清空. Unknown fields of an existing entry are preserved as-is.
 */

export class AccountStore {
  /**
   * @param {{ dir: string, log?: object }} opts `dir` holds `accounts.json`; it is created on the first write
   */
  constructor({ dir, log }) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'accounts.json');
    /** @type {Map<string, AccountRecord>} lowercased username → record */
    this.accounts = new Map();
    /** @type {Map<string, string>} account token → lowercased username */
    this.tokens = new Map();
    this.log = log || { info() {}, warn() {}, error() {} };
    this._loadPromise = null;
  }

  /** Load the file (idempotent; a missing file → empty store). */
  async load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      let raw;
      try { raw = await fsp.readFile(this.file, 'utf8'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; return; }
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { this.log.warn('[accounts] corrupt accounts.json, starting empty', e.message); return; }
      if (!parsed || typeof parsed !== 'object') return;
      for (const [stored, rec] of Object.entries(parsed)) {
        if (!rec || typeof rec !== 'object') continue;
        const key = stored.toLowerCase();
        this.accounts.set(key, {
          ...rec,
          // the registered spelling; an entry written before this field existed keeps its key
          name: typeof rec.name === 'string' && rec.name ? rec.name : stored,
          salt: String(rec.salt || ''),
          hash: String(rec.hash || ''),
          loadout: rec.loadout && typeof rec.loadout === 'object' ? rec.loadout : null,
          ops: rec.ops && typeof rec.ops === 'object' ? rec.ops : null,
          // the 对局统计 mirror is validated on the way in, not on the way out (an entry written by a newer build
          // is carried through untouched: `...rec` already holds it, this only normalizes the known field)
          stats: normalizeStatsPayload(rec.stats) || (rec.stats && typeof rec.stats === 'object' ? rec.stats : null),
          statsClearedAt: Number.isFinite(rec.statsClearedAt) ? rec.statsClearedAt : null,
          createdAt: Number(rec.createdAt) || Date.now(),
          lastLoginAt: Number(rec.lastLoginAt) || Date.now(),
        });
        if (typeof rec.token === 'string' && rec.token.length === TOKEN_BYTES * 2) this.tokens.set(rec.token, key);
      }
      this.log.info(`[accounts] loaded ${this.accounts.size} account(s)`);
    })().catch((e) => { this._loadPromise = null; throw e; });
    return this._loadPromise;
  }

  /** Persist atomically. Failures are logged, never thrown (a lost write is not worth dropping the socket). */
  async _persist() {
    const out = {};
    for (const [key, rec] of this.accounts) {
      const token = [...this.tokens.entries()].find(([, u]) => u === key)?.[0];
      out[key] = { ...rec, ...(token ? { token } : {}) };
    }
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(out), 'utf8');
      await fsp.rename(tmp, this.file);
    } catch (e) {
      this.log.error('[accounts] persist failed', e);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /**
   * Register a new account.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<{ ok: true, key: string, username: string, token: string, loadout: Record<string,any>|null, ops: Record<string,any>|null, stats: { v: number, records: any[] }|null, statsClearedAt: number|null }
   *                   | { error: 'BAD_MSG'|'TAKEN'|'WEAK', detail: string }>}
   */
  async register(username, password) {
    await this.load();
    const name = typeof username === 'string' ? username.trim() : '';
    if (!USERNAME_RE.test(name)) return { error: 'BAD_MSG', detail: 'username must be 2-24 chars: a-z A-Z 0-9 _ - .' };
    if (typeof password !== 'string' || password.length < 4 || password.length > 128) return { error: 'WEAK', detail: 'password must be 4-128 chars' };
    const key = name.toLowerCase();
    if (this.accounts.has(key)) return { error: 'TAKEN', detail: 'username already taken' };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt, 64, SCRYPT_OPTS)).toString('hex');
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    this.accounts.set(key, { name, salt, hash, loadout: null, ops: null, stats: null, statsClearedAt: null, createdAt: Date.now(), lastLoginAt: Date.now() });
    this.tokens.set(token, key);
    await this._persist();
    return { ok: true, key, username: name, token, loadout: null, ops: null, stats: null, statsClearedAt: null };
  }

  /**
   * Log in.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<{ ok: true, key: string, username: string, token: string, loadout: Record<string,any>|null, ops: Record<string,any>|null, stats: { v: number, records: any[] }|null, statsClearedAt: number|null }
   *                   | { error: 'BAD_MSG'|'NOT_FOUND'|'BAD_PASSWORD', detail: string }>}
   */
  async login(username, password) {
    await this.load();
    const name = typeof username === 'string' ? username.trim() : '';
    const key = name.toLowerCase();
    const rec = this.accounts.get(key);
    if (!rec) return { error: 'NOT_FOUND', detail: 'no such account' };
    const hash = await scryptAsync(String(password || ''), rec.salt, 64, SCRYPT_OPTS);
    const expected = Buffer.from(rec.hash, 'hex');
    if (hash.length !== expected.length || !(crypto.timingSafeEqual(hash, expected))) {
      return { error: 'BAD_PASSWORD', detail: 'wrong password' };
    }
    // The account keeps its one bearer (see the header): a login from a second device must be able to reach the
    // seat the first device holds, which needs the same token — the lobby resolves it to the account and then to
    // that account's session (lobby.js sessionForAccount). A legacy entry without a token gets one now.
    const token = this.tokenFor(key);
    rec.lastLoginAt = Date.now();
    await this._persist();
    // the registered spelling, not what was typed (login is case-insensitive)
    return { ok: true, key, username: rec.name || name, token, loadout: rec.loadout || null, ops: rec.ops || null,
      stats: rec.stats || null, statsClearedAt: rec.statsClearedAt ?? null };
  }

  /**
   * The account's bearer token: the stored one, or a fresh one for an entry that has none yet (data written
   * before the field existed, or an account whose token was dropped by hand). Stable on purpose — see `login`.
   * @param {string} key
   * @returns {string}
   */
  tokenFor(key) {
    for (const [tok, u] of this.tokens) if (u === key) return tok;
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    this.tokens.set(token, key);
    return token;
  }

  /**
   * Synchronous token → account lookup, for the one path that cannot await: a `hello` frame resolving to the
   * seat its account holds (server/lobby.js sessionForAccount), which happens inside the transport's hello
   * handling. The store is loaded once at boot — server/http/websocket.js awaits `load()` before the server
   * accepts connections — so everything is in memory by then; an unloaded store (a unit test that never
   * called `load`) or an unknown token simply answers null.
   * @param {unknown} token
   * @returns {{ key: string, username: string, loadout: Record<string,any>|null, ops: Record<string,any>|null,
   *             stats: { v: number, records: any[] }|null, statsClearedAt: number|null } | null}
   */
  lookupToken(token) {
    if (typeof token !== 'string') return null;
    const key = this.tokens.get(token.toLowerCase());
    if (!key) return null;
    const rec = this.accounts.get(key);
    if (!rec) return null;
    return { key, username: rec.name || key, loadout: rec.loadout || null, ops: rec.ops || null,
      stats: rec.stats || null, statsClearedAt: rec.statsClearedAt ?? null };
  }

  /**
   * Resolve a previously issued account token.
   * @param {string} token
   * @returns {Promise<{ key: string, username: string, loadout: Record<string,any>|null, ops: Record<string,any>|null,
   *                     stats: { v: number, records: any[] }|null, statsClearedAt: number|null } | null>}
   */
  async resolveToken(token) {
    await this.load();
    return this.lookupToken(token);
  }

  /**
   * Persist the current 干员调配 for an account token (no-op when the token is unknown). Both maps are stored
   * as sent (`null` clears one); the lobby has already checked them against the game data.
   * @param {string} token
   * @param {Record<string, any>} loadout `room.loadout.entries`
   * @param {Record<string, any>|null} [ops] `room.loadout.ops`
   */
  async saveLoadout(token, loadout, ops = null) {
    await this.load();
    if (typeof token !== 'string') return;
    const key = this.tokens.get(token.toLowerCase());
    const rec = key && this.accounts.get(key);
    if (!rec) return;
    const nextLoadout = loadout && typeof loadout === 'object' ? loadout : null;
    const nextOps = ops && typeof ops === 'object' ? ops : null;
    // Never create an account's copy as empty: an account with nothing saved and a session that sends nothing is a
    // client that has not received the account's copy yet (or a stray reset), not a deliberate blank 干员调配.
    // Clearing a copy that DOES exist stays possible — that is the deliberate reset, and it goes through a session
    // the account was already written on (see enterAsGuest / auth.logout in DESIGN §account).
    if (rec.loadout == null && rec.ops == null && !hasEntries(nextLoadout) && !hasEntries(nextOps)) return;
    rec.loadout = nextLoadout;
    rec.ops = nextOps;
    await this._persist();
  }

  /**
   * Merge a 对局统计 envelope into the account's mirror (no-op when the token is unknown or the payload is not one).
   * The union is what makes the mirror safe to push from any device in any order (server/stats.js
   * mergeStatsPayload); records the account already has, or that a 清空 stamped as gone, are dropped.
   * @param {string} token
   * @param {any} payload `{ v, records }` from `stats.push`
   * @returns {Promise<{ v: number, records: any[] } | null>} the mirror after the merge
   */
  async saveStats(token, payload) {
    await this.load();
    if (typeof token !== 'string') return null;
    const key = this.tokens.get(token.toLowerCase());
    const rec = key && this.accounts.get(key);
    if (!rec) return null;
    const incoming = normalizeStatsPayload(payload);
    if (!incoming) return null;
    // a 清空 is a lower bound on the mirror's timeline: a device that still holds the records it cleared must not
    // push them back (the clear has to stick across devices, see statsClearedAt)
    const clearedAt = Number.isFinite(rec.statsClearedAt) ? rec.statsClearedAt : null;
    const kept = clearedAt == null ? incoming.records : incoming.records.filter((r) => !(Number.isFinite(r?.t) && r.t <= clearedAt));
    rec.stats = mergeStatsPayload(rec.stats, { v: incoming.v, records: kept });
    await this._persist();
    return rec.stats;
  }

  /**
   * Drop the account's 对局统计 mirror and stamp the moment (清空统计数据): every client drops the records it holds
   * that are older than the stamp on its next pull, so the clear survives a device that had not synced yet.
   * @param {string} token
   * @returns {Promise<number | null>} the stamp, or null when the token is unknown
   */
  async clearStats(token) {
    await this.load();
    if (typeof token !== 'string') return null;
    const key = this.tokens.get(token.toLowerCase());
    const rec = key && this.accounts.get(key);
    if (!rec) return null;
    rec.stats = null;
    rec.statsClearedAt = Date.now();
    await this._persist();
    return rec.statsClearedAt;
  }

  /**
   * The account's 对局统计 mirror, or null (no token / nothing stored).
   * @param {string} token
   * @returns {Promise<{ stats: { v: number, records: any[] } | null, clearedAt: number | null } | null>}
   */
  async readStats(token) {
    await this.load();
    if (typeof token !== 'string') return null;
    const key = this.tokens.get(token.toLowerCase());
    const rec = key && this.accounts.get(key);
    if (!rec) return null;
    return { stats: rec.stats || null, clearedAt: rec.statsClearedAt ?? null };
  }
}

/** Whether a `room.loadout` map carries anything at all. @param {Record<string, any>|null} map */
function hasEntries(map) {
  return !!map && typeof map === 'object' && Object.keys(map).length > 0;
}
