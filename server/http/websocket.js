// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * the optional account store (extension §account, server/accounts.js): loaded here so the lobby can resolve
//     accounts during `hello`. `opts.accounts` injects one (tests); otherwise config.js picks the directory and a
//     store that cannot load is logged and skipped — the game plays fine without accounts;
//   * WebSocket (ws) at /ws, maxPayload 64 KB, no per-message deflate → Network.handleConnection. Refused at the
//     upgrade: any other path 404; per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js
//     clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { Lobby } from '../lobby.js';
import { AccountStore } from '../accounts.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom, accountsDirFrom } from './config.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, accounts?: AccountStore, accountsDir?: string, [option: string]: any }} opts
 *   startServer() options
 * @param {{ data: object, log: object }} deps the game data the lobby's matches use, the logger
 * @returns {Promise<{ registry: SessionRegistry, lobby: Lobby, network: Network, accounts: AccountStore|null }>}
 */
export async function createSessionStack(opts, { data, log }) {
  const netOptions = netOptionsFrom(opts);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = lobbyOptionsFrom(opts);
  // The account store is optional: a store that cannot be read/created (a read-only home, a typo'd
  // ACCOUNTS_DIR) must not stop the server — the player simply cannot log in until it is fixed.
  let accounts = opts.accounts ?? null;
  if (!accounts) {
    try {
      accounts = new AccountStore({ dir: accountsDirFrom(opts), log });
      await accounts.load();
    } catch (e) {
      log.error('[accounts] disabled: cannot load the account store', e);
      accounts = null;
    }
  }
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions, accounts });
  const network = new Network({ registry, handler: lobby, log, options: netOptions });
  return { registry, lobby, network, accounts };
}

/**
 * Serve the WebSocket endpoint /ws on `server` (its 'upgrade' event).
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object }} deps
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  wss.on('connection', (ws, req) => network.handleConnection(ws, req));
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
