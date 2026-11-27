/* Where the app finds the server. These are the local-dev values (the
 * docker stack in server/, ports from server/.env.example); the webapp
 * deploy (webapp/deploy.sh) replaces this file with webapp/config.js.
 *
 *   server      soju plaintext address, used by the desktop app (Tauri TCP)
 *   accountUrl  server/api: create account, sessions, live events, …
 *   wsUrl       soju WebSocket, used by the webapp (web-shim.js)
 *   allowWsOverride  let ?irc=… / localStorage "snailog.ws" pick another
 *               WebSocket. Dev only: in production it would let a crafted
 *               link send people's passwords to someone else's server.
 */
window.SNAILOG_CONFIG = {
  server: "127.0.0.1:16667",
  accountUrl: "http://127.0.0.1:16680",
  wsUrl: "ws://127.0.0.1:16668/socket",
  allowWsOverride: true,
};
