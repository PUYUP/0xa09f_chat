/* Production endpoints for im.snailog.com. webapp/deploy.sh puts this file in
 * place of desktop/ui/config.js (see that file for what each field means). */
window.SNAILOG_CONFIG = {
  server: "irc.snailog.com:6697",          // not used by the webapp
  accountUrl: "https://irc.snailog.com",
  wsUrl: "wss://irc.snailog.com/socket",
  allowWsOverride: false,
};
