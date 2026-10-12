// server/stats.js — the account's 对局统计 mirror (account extension §account; the client half is
// public/js/ui/stats.js).
//
// The client owns the schema: a record is whatever `public/js/ui/stats.js` normalized, and this module never reads a
// record's fields beyond the three it merges and bounds on — `id` (the union key), `t` (newest-first order) and
// `compact` (see the tie rule). Everything else travels through untouched, so a client-side field the server does not
// know survives a sync (the same stance the loadout takes: check what the server relies on, carry the rest).
//
// Three rules:
//   * UNION BY ID — `mergeStatsPayload` never replaces the stored mirror, it unions it with the incoming envelope.
//     That is what lets two devices push in any order without losing each other's matches, and makes a push
//     idempotent (the client repushes its whole list after every local change).
//   * A FULL RECORD BEATS A COMPACTED ONE on an id collision (the mirror keeps the replayable shape when either side
//     still has it); otherwise the stored copy wins, so an unchanged push does not rewrite the entry.
//   * BOUNDED — `STATS_MAX_BYTES` of JSON and `STATS_MAX_RECORDS` records, newest first (the envelope a client sends
//     is bounded the same way, so one push stays far inside the 64 KB frame limit; `net.js` WS_MAX_PAYLOAD). The
//     oldest records fall off the MIRROR; every client keeps its own full history locally, and a device that still
//     has an old match re-uploads it on its next push (the union brings it back).
//
// A push is refused (null) when it is not a stats envelope at all — the shape `shared/protocol.js` already
// validated — or when it is larger than the byte budget after bounding, which cannot happen for a client that bounds
// its own payload, but the server does not trust that.

import { STATS_VERSION, STATS_MAX_RECORDS } from '../shared/constants.js';

/**
 * JSON bytes one account's mirror may hold (the client sends at most this: public/js/ui/stats.js SYNC_MAX_BYTES).
 * Small on purpose: a push arrives over the same socket as the client's 4-second latency probe and makes this store
 * rewrite `accounts.json` whole, so the mirror is a window of ~25 compacted matches, not a full history.
 */
export const STATS_MAX_BYTES = 16_000;
/** Bytes of one single record: a record bigger than this is dropped rather than stored (a client cannot build one). */
export const STATS_MAX_RECORD_BYTES = 8_000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const recordId = (r) => (isObj(r) && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64 ? r.id : null);
const stamp = (r) => (Number.isFinite(r?.t) ? r.t : 0);

/** JSON byte length as the wire sees it (UTF-8; `Buffer` is Node's, this module is server-only). */
const byteLength = (s) => Buffer.byteLength(s, 'utf8');

/**
 * The envelope a client may push, or null when it is not one: `{ v, records }` of the current version, at most
 * STATS_MAX_RECORDS records, every record an object with a usable id and a bounded size.
 * @param {any} raw
 * @returns {{ v: number, records: any[] } | null}
 */
export function normalizeStatsPayload(raw) {
  if (!isObj(raw) || raw.v !== STATS_VERSION || !Array.isArray(raw.records)) return null;
  if (raw.records.length > STATS_MAX_RECORDS) return null;
  const records = [];
  for (const r of raw.records) {
    if (!recordId(r)) return null;
    if (byteLength(JSON.stringify(r)) > STATS_MAX_RECORD_BYTES) continue; // oversized row: drop it, keep the rest
    records.push(r);
  }
  return { v: STATS_VERSION, records };
}

/**
 * Bound a record list to the mirror's budget: newest first (the caller's order is kept), at most STATS_MAX_RECORDS
 * records and STATS_MAX_BYTES of JSON. The newest record is always kept.
 * @param {any[]} records newest first
 * @returns {any[]}
 */
export function fitStatsPayload(records) {
  const kept = [];
  let used = 24; // the envelope itself
  for (const r of records) {
    if (kept.length >= STATS_MAX_RECORDS) break;
    const n = byteLength(JSON.stringify(r)) + 1;
    if (kept.length && used + n > STATS_MAX_BYTES) break;
    used += n;
    kept.push(r);
  }
  return kept;
}

/**
 * Union the stored mirror with an incoming envelope (see the header): by record id, newest first, a full record
 * beating a compacted one, bounded. Either side may be empty/null.
 * @param {{ records?: any[] } | null | undefined} stored
 * @param {{ records?: any[] } | null | undefined} incoming
 * @returns {{ v: number, records: any[] }}
 */
export function mergeStatsPayload(stored, incoming) {
  const byId = new Map();
  for (const r of [...(Array.isArray(stored?.records) ? stored.records : []), ...(Array.isArray(incoming?.records) ? incoming.records : [])]) {
    const id = recordId(r);
    if (!id) continue;
    const prev = byId.get(id);
    if (!prev) { byId.set(id, r); continue; }
    if (prev.compact === true && r.compact !== true) byId.set(id, r); // the fuller shape wins
  }
  const records = [...byId.values()].sort((a, b) => stamp(b) - stamp(a));
  return { v: STATS_VERSION, records: fitStatsPayload(records) };
}
