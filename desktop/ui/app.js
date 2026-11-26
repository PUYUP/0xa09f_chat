/* a09f desktop client — IRC protocol logic over the Soju bouncer.
 * Rust side (src-tauri) is a raw TCP bridge: invoke('send', line) and
 * events 'irc-line' / 'irc-closed'.
 *
 * UI rule: everyday-user first. No server, protocol or bouncer details on
 * screen — just Sign In, rooms, private chats, people and messages.
 *
 * Conversations ("convs") are rooms (#channel) or private chats (a nick).
 * History and offline messages come from soju via IRCv3 draft/chathistory;
 * unread counts come from draft/read-marker (synced across devices).
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const { PhysicalPosition } = window.__TAURI__.dpi;

const $ = (id) => document.getElementById(id);

/* Fixed connection settings — like a classic messenger, nothing to pick. */
const SERVER = "127.0.0.1:16667";
const NETWORK = "solanum";        // soju upstream network name
const ACCOUNT_URL = "http://127.0.0.1:16680";     // server/register: create account, recovery email, reset
const REGISTER_URL = `${ACCOUNT_URL}/register`;
const DEFAULT_ROOM = "#lobby";    // everyone lands here if they're in no room yet
const BURST_TOKEN = "a09f-burst-done";
/* Hidden room every a09f app joins (server/scripts/setup-rooms.py). It carries
 * status messages ("STATUS busy …", kept in soju history) and, because
 * everyone shares it, live Online/Offline changes via away-notify. */
const PRESENCE_ROOM = "#a09f-presence";
const PRESENCE_HISTORY = 500;
const HISTORY_LIMIT = 100;        // messages fetched per conversation
const TARGETS_DAYS = 30;          // private chats active within this window are restored
const MAX_BUFFER = 1000;           // messages kept per conversation (a sliding window)

/* IRCv3 capabilities we use when the server offers them. */
const WANTED_CAPS = ["sasl", "server-time", "message-tags", "batch", "echo-message", "away-notify",
                     "draft/chathistory", "draft/read-marker", "draft/pre-away", "soju.im/search"];

const logEl = $("log"), roomsEl = $("channels"), pmsEl = $("pms"), usersEl = $("users");
const dotEl = $("dot"), whoEl = $("who");

const STATUS = "*status*";        // conv for messages before any room is open

const S = {
  phase: "offline",       // offline | signing-in | online
  me: null,               // my nick on the network
  caps: new Set(),        // acknowledged IRCv3 caps
  current: null,          // key of the conversation on screen
  convs: new Map(),       // key -> conv (see newConv)
  batches: new Map(),     // batch ref -> {type, params, lines[]}
  burstDone: false,
  account: null,          // the ID used to sign in (friends list is stored per account)
  friends: [],            // accepted friends' nicks (server-side list, see startSocial)
  friendGroups: new Map(),// nick key -> group name
  incoming: [],           // friend requests to me: {from, msg, created}
  outgoing: [],           // my pending requests: {to, group}
  token: null,            // account-service session (friends, typing)
  typing: new Map(),      // nick key -> hide timer, while they're typing to me
  prefs: { ignore: [], friendsOnly: false },   // privacy settings (account service)
  callerId: null,         // our +g state: null = unknown (fresh sign-in)
  redactions: new Set(),  // deleted messages (see isRedacted)
  admin: false,           // may send announcements
  style: { b: false, i: false, u: false, color: null },   // text style for what I send
  presence: new Map(),    // nick key -> {away: bool|null, online: bool|null, exists: bool|null}
  statuses: new Map(),    // nick key -> {code, text, time} from PRESENCE_ROOM
  myStatus: { code: "available", text: "" },
  inPresence: false,      // joined PRESENCE_ROOM
  presenceReady: false,   // initial presence known: start announcing changes
  whois: new Map(),       // pending WHOIS nick key -> {away}
  away: false,
  authFailed: false,
};

/* ---------- helpers ---------- */

function send(line) { invoke("send", { line }).catch(() => {}); }
const has = (cap) => S.caps.has(cap);

/* "#lounge" -> "lounge" for display; IRC names stay intact internally. */
const roomName = (c) => (c || "").replace(/^[#&]/, "");
const isChannel = (t) => !!t && (t.startsWith("#") || t.startsWith("&"));
const keyOf = (t) => (t || "").toLowerCase();
const isService = (nick) => /Serv$/i.test(nick || "");

/* Services (NickServ, BouncerServ, ...) and the server itself are plumbing. */
const isPlumbing = (prefix, nick) => !prefix || !prefix.includes("!") || isService(nick);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Classic text emoticons -> emoji (runs on already-escaped HTML). */
const EMOTES = [[":D", "😁"], [":)", "🙂"], [";)", "😉"], [":(", "🙁"], [":P", "😛"], ["&lt;3", "❤️"]];
function emote(html) {
  for (const [k, v] of EMOTES) html = html.split(k).join(v);
  return html;
}

function fmtTime(ms) {
  const d = new Date(ms), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString()
    ? hm : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + hm;
}

/* ---------- IRC parsing ---------- */

function unescapeTag(v) {
  return v.replace(/\\(.)/g, (_, c) => ({ ":": ";", s: " ", "\\": "\\", r: "\r", n: "\n" }[c] ?? c));
}

/* Parse "@tags :prefix CMD params :trailing" */
function parse(line) {
  const tags = {};
  let rest = line;
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    for (const kv of rest.slice(1, sp).split(";")) {
      const eq = kv.indexOf("=");
      if (eq === -1) tags[kv] = true;
      else tags[kv.slice(0, eq)] = unescapeTag(kv.slice(eq + 1));
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = null;
  if (rest.startsWith(":")) {
    const i = rest.indexOf(" ");
    prefix = rest.slice(1, i);
    rest = rest.slice(i + 1);
  }
  const ti = rest.indexOf(" :");
  let trailing = null, head = rest;
  if (ti !== -1) { trailing = rest.slice(ti + 2); head = rest.slice(0, ti); }
  const parts = head.split(" ").filter(Boolean);
  const cmd = parts.shift();
  // The last parameter only gets a ":" when it needs one (spaces, empty, or a
  // leading ":"), so "PRIVMSG #room hello" carries its text in params, not in
  // trailing. `text` is the last parameter either way.
  const text = trailing ?? (parts.length ? parts[parts.length - 1] : null);
  return { tags, prefix, cmd, params: parts, trailing, text };
}

function nickOf(prefix) {
  if (!prefix) return "";
  const bang = prefix.indexOf("!");
  return bang === -1 ? prefix : prefix.slice(0, bang);
}

/* ---------- conversations ---------- */

function newConv(name, kind) {
  return {
    name, kind,             // kind: room | pm | status
    msgs: [],               // {who, txt, cls, time, id, others, live}
    ids: new Set(),         // msgids already stored (dedupe history vs live)
    members: new Map(),     // rooms: nick -> prefix
    topic: "",
    readAt: null,           // ms of last read message (from MARKREAD), null = unknown
    unread: 0,
    historyLoaded: false,   // history requested
    historyDone: false,     // history batch received
    notified: false,        // offline-message tip shown
  };
}

function getConv(name, kind) {
  const key = keyOf(name);
  if (!S.convs.has(key)) S.convs.set(key, newConv(name, kind));
  return S.convs.get(key);
}

const conv = (key) => S.convs.get(key);
const rooms = () => [...S.convs.values()].filter((c) => c.kind === "room");
const pms = () => [...S.convs.values()].filter((c) => c.kind === "pm");

/* Add a message to a conversation. `history` messages are merged in time
 * order; live ones are appended. */
function addMsg(target, m, { history = false } = {}) {
  if (m.others && target && isIgnored(m.who)) return;       // ignored: never shown, no chat opened
  const c = target ? getConv(target, isChannel(target) ? "room" : "pm")
                   : (S.current && conv(S.current)) || getConv(STATUS, "status");
  if (m.id && c.ids.has(m.id)) return;
  if (m.id) c.ids.add(m.id);
  m.time = m.time || Date.now();
  m.live = !history;
  // Scrolled far back (newest messages dropped from memory): a live message
  // isn't appended after the gap; the "jump to latest" bar counts it instead.
  if (!history && c.hasNewer) {
    if (isConvMsg(m)) c.newerCount = (c.newerCount || 0) + 1;
    if (keyOf(c.name) === S.current) renderNewerBar();
    if (m.others) { recountUnread(c); renderLists(); if (S.burstDone) onIncoming(c, m); }
    return;
  }
  if (history && c.msgs.length && c.msgs[c.msgs.length - 1].time > m.time) {
    let i = c.msgs.length;
    while (i > 0 && c.msgs[i - 1].time > m.time) i--;
    c.msgs.splice(i, 0, m);
  } else {
    c.msgs.push(m);
  }
  // Sliding window: loading older pages drops the newest messages (they can
  // be fetched again with "jump to latest"); new messages drop the oldest.
  while (c.msgs.length > MAX_BUFFER) {
    const gone = c.loadingOlder ? c.msgs.pop() : c.msgs.shift();
    if (gone.id) c.ids.delete(gone.id);
    if (c.loadingOlder) c.hasNewer = true; else c.noMore = false;
  }

  const key = keyOf(c.name);
  if (key === S.current) {
    // History arrives in pages: onHistoryBatch draws the log once per page.
    if (!history) renderMsg(m);
    // Only count it as read if the person can actually see the window.
    if (m.others) { if (S.focused) markRead(c); else { recountUnread(c); renderLists(); } }
  } else if (m.others) {
    recountUnread(c);
    renderLists();
  }
  if (!history && m.others && S.burstDone) onIncoming(c, m);
  // Keep "newest first" ordering when the open chat (or my own message) moves it up.
  if (!history && c.kind !== "status" && isConvMsg(m) && (key === S.current || !m.others)) renderLists();
  if (!history && m.others && c.kind === "pm" && S.typing.has(keyOf(c.name))) onTyping(c.name, false);
  if (!history && m.others && c.kind === "room" && S.roomTyping?.get(keyOf(c.name))?.has(keyOf(m.who))) {
    onRoomTyping({ room: c.name, from: m.who, active: false });
  }
  if (!history && !m.others && c.kind !== "status" && S.pendingExpire?.length) maybeRegisterExpiry(c, m);
}

/* App-generated messages: the sender label says what kind of message it is. */
const SYS_KINDS = {
  system: { who: "System", cls: "service" },   // sign-in, room joins
  status: { who: "Status", cls: "status" },    // your own away/online status
  error:  { who: "Error",  cls: "error" },     // something didn't work
  tip:    { who: "Tip",    cls: "tip" },       // guidance / offline-message notices
};
function sys(text, kind = "system", target = null) {
  const k = SYS_KINDS[kind] || SYS_KINDS.system;
  addMsg(target, { who: k.who, txt: text, cls: k.cls });
}

/* ---------- unread / read markers ---------- */

function recountUnread(c) {
  const unread = c.msgs.filter((m) => m.others && (c.readAt != null ? m.time > c.readAt : m.live));
  c.unread = unread.length;
  c.mentions = c.kind === "room" ? unread.filter((m) => mentionsMe(stripIrc(m.txt))).length : 0;
}

function markRead(c) {
  const latest = c.msgs.reduce((t, m) => (m.others || m.cls === "me" ? Math.max(t, m.time) : t), 0);
  c.unread = 0; c.mentions = 0;
  // "Seen" for the other person, once per new message of theirs we've now seen.
  const theirs = c.kind === "pm" ? c.msgs.reduce((t, m) => (m.others ? Math.max(t, m.time) : t), 0) : 0;
  if (c.kind === "room" && S.focused) sendRoomRead(c, latest);
  if (theirs && S.token && theirs > (c.seenSent || 0) && S.focused) {
    c.seenSent = latest;
    socialApi("/read", { to: c.name, time: latest }).catch(() => {});
  }
  if (latest && (c.readAt == null || latest > c.readAt)) {
    c.readAt = latest;
    if (has("draft/read-marker") && c.kind !== "status") {
      send(`MARKREAD ${c.name} timestamp=${new Date(latest).toISOString()}`);
    }
  }
  renderLists();
}

function onMarkRead(target, value) {
  const c = conv(keyOf(target));
  if (!c) return;
  const ts = value && value.startsWith("timestamp=") ? Date.parse(value.slice(10)) : NaN;
  if (!isNaN(ts)) {
    if (c.readAt == null || ts > c.readAt) c.readAt = ts;
  } else if (value === "*" && c.kind === "pm" && c.readAt == null) {
    // Never read: every stored private message is new. (Rooms stay quiet so a
    // fresh account isn't greeted by a wall of "unread" room history.)
    c.readAt = 0;
  }
  if (keyOf(c.name) === S.current) c.unread = 0; else recountUnread(c);
  notifyOffline(c);
  renderLists();
}

/* YM-style heads-up for private messages that arrived while signed out. */
function notifyOffline(c) {
  if (c.kind !== "pm" || c.notified || !c.historyDone || keyOf(c.name) === S.current) return;
  if (c.unread > 0) {
    c.notified = true;
    sys(`${c.name} sent you ${c.unread} message${c.unread > 1 ? "s" : ""} while you were away. ` +
        `Open it under Private Chats.`, "tip");
  }
}

/* ---------- history (offline messages) ---------- */

function fetchHistory(c) {
  if (!has("draft/chathistory") || c.historyLoaded || c.kind === "status") return;
  c.historyLoaded = true;
  if (c.kind === "pm" && has("draft/read-marker")) send(`MARKREAD ${c.name}`);
  send(`CHATHISTORY LATEST ${c.name} * ${HISTORY_LIMIT}`);
}

function fetchPrivateChats() {
  if (!has("draft/chathistory")) return;
  const now = new Date(), from = new Date(now - TARGETS_DAYS * 86400e3);
  send(`CHATHISTORY TARGETS timestamp=${now.toISOString()} timestamp=${from.toISOString()} 50`);
}

function onHistoryBatch(target, lines) {
  if (S.exporting && keyOf(target) === S.exporting.key) {            // exportConversation() is paging
    const ls = lines.filter((l) => (l.cmd === "PRIVMSG" || l.cmd === "NOTICE") && !isPlumbing(l.prefix, nickOf(l.prefix)));
    S.exporting.lines = ls.concat(S.exporting.lines);
    S.exporting.count = lines.filter((l) => l.cmd === "PRIVMSG" || l.cmd === "NOTICE").length;
    S.exporting.pageDone = true;
    return;
  }
  if (isPresenceRoom(target)) {
    for (const l of lines) if (l.cmd === "PRIVMSG") onStatusLine(nickOf(l.prefix), l);
    announceMyStatus();
    return;
  }
  for (const l of lines) {
    if (l.cmd !== "PRIVMSG" && l.cmd !== "NOTICE") continue;
    const from = nickOf(l.prefix);
    if (isPlumbing(l.prefix, from)) continue;
    const t = convTarget(l.params[0], from);
    addMsg(t, msgFrom(l, from), { history: true });
  }
  if (onOlderBatch(target, lines.filter((l) => l.cmd === "PRIVMSG" || l.cmd === "NOTICE").length)) return;
  const c = conv(keyOf(target));
  if (!c) return;
  const firstPage = !c.historyDone;
  c.historyDone = true;
  if (keyOf(c.name) === S.current) renderLog();          // one redraw per page
  if (firstPage && S.token && (keyOf(c.name) === S.current || S.meta?.has(keyOf(c.name)))) loadMeta(c);
  if (keyOf(c.name) === S.current) markRead(c);
  else { recountUnread(c); notifyOffline(c); }
  renderLists();
}

function onTargetsBatch(lines) {
  for (const l of lines) {
    if (l.cmd !== "CHATHISTORY" || l.params[0] !== "TARGETS") continue;
    const t = l.params[1];
    if (!t || isChannel(t) || isService(t) || keyOf(t) === keyOf(S.me)) continue;
    fetchHistory(getConv(t, "pm"));
  }
  renderLists();
}

/* For a PRIVMSG/NOTICE: which conversation does it belong to? */
function convTarget(target, from) {
  if (isChannel(target)) return target;
  return keyOf(from) === keyOf(S.me) ? target : from;   // private chat = the other person
}

function msgFrom(l, from) {
  const mine = keyOf(from) === keyOf(S.me);
  let txt = l.params.length > 1 ? (l.text ?? "") : (l.trailing ?? "");
  let cls = mine ? "me" : (l.cmd === "NOTICE" ? "service" : "");
  const action = txt.match(/^\x01ACTION (.*)\x01?$/);
  if (action) { txt = action[1].replace(/\x01$/, ""); cls += " action"; }
  const buzz = !!action && txt.trim().toUpperCase() === BUZZ_TEXT;
  if (buzz) cls += " buzz";
  const inv = action && (txt.match(INVITE_RE) || txt.match(ROOM_INVITE_RE));
  return {
    who: from, txt, cls, buzz, invite: inv ? inv[1] : null,
    time: l.tags.time ? Date.parse(l.tags.time) : Date.now(),
    id: l.tags.msgid || null,
    others: !mine,
  };
}

/* ---------- sign-in / screen state ---------- */

function setPhase(phase, message = "", isError = false) {
  S.phase = phase;
  document.body.classList.toggle("offline", phase !== "online");
  const online = phase === "online";
  dotEl.classList.toggle("on", online);
  const st = online ? statusOf(S.me) : null;
  dotEl.className = online ? "on st-" + st.state : "";
  dotEl.title = online ? st.label : "Offline";
  whoEl.textContent = online ? S.me : "";
  const btn = $("btnSignIn");
  btn.disabled = phase === "signing-in";
  btn.textContent = phase === "signing-in" ? "Signing in…" : "Sign In";
  $("buser").disabled = $("bpass").disabled = phase === "signing-in";
  showMsg("signinMsg", message, isError ? "error" : "");
}

function showMsg(id, text, kind = "") {
  const el = $(id);
  el.textContent = text;
  el.className = "form-msg" + (kind ? " " + kind : "");
}

/* Sign In / Create Account / Reset Password screens */
function showScreen(name) {
  $("signin").dataset.screen = name;
  for (const id of ["signinMsg", "createMsg", "resetMsg"]) showMsg(id, "");
  $({ signin: "buser", create: "cuser", reset: "ruser" }[name]).focus();
}
const showCreate = (on) => showScreen(on ? "create" : "signin");

/* POST JSON to the account service. Returns {ok, data} or throws when offline. */
async function accountApi(path, body) {
  const res = await fetch(ACCOUNT_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !!data.ok, data };
}
const OFFLINE_MSG = "Can't reach a09f right now. Please try again later.";
const EMAIL_RE = /^[^@\s<>"',;]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function syncStatusUi() {
  $("statusSel").value = S.myStatus.code;
  const custom = S.myStatus.code === "custom";
  $("statusCustom").style.display = custom ? "" : "none";
  if (custom && document.activeElement !== $("statusText")) $("statusText").value = S.myStatus.text;
  setPhase(S.phase);
}

/* ---------- rendering ---------- */

function renderMsg(m) {
  const div = document.createElement("div");
  div.className = `msg ${m.cls}`;
  const cur = S.current && conv(S.current);
  const deleted = cur && isRedacted(cur, m);
  const withMeta = cur && cur.kind !== "status" && isRealMsg(m);
  const edited = withMeta ? metaFor(keyOf(cur.name)).edits.get(msgKeyOf(cur, m)) : undefined;
  let body = edited ?? m.txt;
  let quote = "";
  const rp = !m.buzz && body.match(REPLY_RE);
  if (rp) { quote = `<span class="quote">↪ <b>${esc(rp[1])}</b>: ${emote(esc(rp[2]))}</span>`; body = rp[3]; }
  const poll = !m.buzz && m.txt.match(POLL_RE);
  let txt = m.buzz ? "BUZZ!!!" : emote(formatIrc(esc(body)));
  if (poll) txt = "started a poll:";
  if (m.invite) {
    const inRoom = conv(keyOf(m.invite))?.kind === "room";
    const what = isConference(m.invite) ? "a conference 🗣️" : `the room <b>${esc(roomName(m.invite))}</b> 💬`;
    txt = m.others
      ? `invited you to ${what} <button class="invite-join" data-room="${esc(m.invite)}">${inRoom ? "Open" : "Join"}</button>`
      : `sent an invite to ${what}`;
  }
  if (m.knock) txt += ` <button class="knock-btn" data-room="${esc(m.knock)}">🚪 Ask to join</button>`;
  if (m.letIn) txt += ` <button class="letin-btn" data-nick="${esc(m.letIn)}">Let them in</button>`;
  if (m.askKey) txt += ` <input class="key-input" type="password" placeholder="Room password" size="12">` +
    ` <button class="key-join" data-room="${esc(m.askKey)}">Join</button>`;
  if (!m.buzz && !m.invite && !poll) txt = linkify(txt);
  if (!m.buzz && !m.invite) txt = highlightMentions(txt);
  if (m.others && !m.cls.includes("service") && S.current && isChannel(S.current) && mentionsMe(stripIrc(body))) {
    div.classList.add("mention-me");
  }
  if (edited && !deleted) txt += ` <span class="edited">(edited)</span>`;
  if (deleted) { txt = "🚫 This message was deleted"; quote = ""; div.classList.add("deleted"); }
  div.innerHTML = `<span class="time">${esc(fmtTime(m.time))}</span>` +
    `<span class="who">${esc(m.who)}:</span> <span class="txt">${quote}${txt}</span>`;
  if (!m.cls.includes("service") && !m.cls.includes("error") && !m.cls.includes("tip") && !m.cls.includes("status")) {
    paintName(div.querySelector(".who"), m.who);
    div.querySelector(".who").dataset.nick = m.who;
  }
  if (withMeta) div.dataset.key = msgKeyOf(cur, m);      // for jumping to it
  if (S.jump && div.dataset.key === S.jump.key && Date.now() < S.jump.until) div.classList.add("flash");
  if (withMeta && !deleted) {
    const due = metaFor(keyOf(cur.name)).expiring.get(msgKeyOf(cur, m));
    if (due) div.querySelector(".txt").insertAdjacentHTML("beforeend", ` <span class="expiry" data-due="${due}" title="Disappears ${esc(new Date(due * 1000).toLocaleString())}">${expiryLabel(due)}</span>`);
    if (isSaved(cur, m)) div.querySelector(".txt").insertAdjacentHTML("beforeend", ` <span class="saved-star" title="Saved">⭐</span>`);
  }
  if (poll && !deleted) div.appendChild(pollCard(+poll[1]));
  const evm = !m.buzz && !deleted && m.txt.match(EVENT_RE);
  if (evm) { div.querySelector(".txt").textContent = "planned an event:"; div.appendChild(eventCard(+evm[1])); }
  if (m.reveal) {
    const b = document.createElement("button");
    b.className = "title-btn"; b.textContent = "Show in folder";
    b.onclick = () => invoke("plugin:opener|reveal_item_in_dir", { path: m.reveal }).catch(() => {});
    div.querySelector(".txt").appendChild(b);
  }
  const invite = !deleted && (inviteRoom((stripIrc(body).match(/a09f:\/\/join\/\S+/) || [])[0]) || inviteRoom(firstUrl(body)));
  const link = withMeta && !deleted && !poll && !evm && !invite && S.token && firstUrl(body);
  if (invite) div.querySelector(".txt").insertAdjacentHTML("beforeend",
    ` <button class="invite-join" data-room="${esc(invite)}">💬 Join ${esc(roomName(invite))}</button>`);
  if (link) div.appendChild(previewCard(link));
  if (withMeta && !deleted && S.token) {
    reactionChips(div, cur, m);
    // The hover toolbar is built on first hover, not for every message up front.
    div.addEventListener("mouseenter", () => { if (!div.querySelector(".mtools")) messageTools(div, cur, m); });
  }
  const stick = nearBottom();
  logEl.querySelector(".seen")?.remove();
  if (isConvMsg(m)) logEl.querySelector(".older.empty")?.remove();      // first message: drop the hint
  logEl.appendChild(div);
  // Follow new messages only when the reader is at the bottom (or it's mine).
  if (!S.bulkRender && (stick || m.cls.split(" ").includes("me"))) logEl.scrollTop = logEl.scrollHeight;
  if (!m.others && m.cls.includes("me")) renderSeen();
}

const nearBottom = () => logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;

/* Rebuild the log. A new conversation opens at the newest message; a redraw
 * of the same one (reactions, edits, …) keeps the reader's position. */
function renderLog() {
  const convKey = S.current || STATUS;
  const same = logEl.dataset.conv === convKey;
  const atBottom = !same || nearBottom();
  const prevTop = logEl.scrollTop;
  S.bulkRender = true;
  logEl.innerHTML = "";
  const c = conv(convKey);
  const older = olderLink(c);
  if (older) logEl.appendChild(older);
  try {
    for (const m of c?.msgs || []) if (!(m.others && isIgnored(m.who))) renderMsg(m);
    renderSeen();
    renderNewerBar();
  } finally { S.bulkRender = false; }
  logEl.dataset.conv = convKey;
  if (S.jump && Date.now() < S.jump.until) keepJump();
  else logEl.scrollTop = atBottom ? logEl.scrollHeight : prevTop;
}

function switchTo(key) {
  key = key && keyOf(key);
  if (key === S.current) return;
  if (S.typingTo && keyOf(S.typingTo) !== key) stopTyping();
  if ($("composerBar").style.display !== "none") { if (S.editing) $("input").value = ""; clearComposerBar(); }
  S.current = key;
  const c = key && conv(key);
  if (c && c.kind !== "status" && !metaFor(key).loaded) loadMeta(c);
  if (c) { fetchHistory(c); markRead(c); }
  renderLog();
  refreshSide();
  renderTyping();
  renderPins();
  renderScheduled();
  if (c?.kind === "room") loadRoomReads(c);
  if (c?.kind === "pm" && !S.imv?.has(key)) loadImv(c); else applyImv();
  $("input").focus();
}

function convItem(c, cls, onClose) {
  const d = document.createElement("div");
  d.className = cls + (keyOf(c.name) === S.current ? " active" : "") + (c.unread ? " unread" : "");
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = c.kind === "room" ? roomLabel(c.name) : c.name;
  if (c.kind === "room" && isConference(c.name)) {
    d.classList.add("conf");
    d.title = "Conference with " + (confPeople(c).join(", ") || "nobody yet");
  }
  d.appendChild(label);
  if (c.mentions) {
    const at = document.createElement("span");
    at.className = "badge at";
    at.textContent = "@";
    at.title = "Someone mentioned you here";
    d.appendChild(at);
  }
  if (c.unread) {
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = c.unread > 99 ? "99+" : c.unread;
    d.appendChild(b);
  }
  if (onClose) {
    const x = document.createElement("span");
    x.className = "close";
    x.textContent = "×";
    x.title = "Close this chat";
    x.onclick = (e) => { e.stopPropagation(); onClose(); };
    d.appendChild(x);
  }
  d.onclick = () => switchTo(c.name);
  return d;
}

function renderLists() {
  renderFriends();
  updateTitle();
  roomsEl.innerHTML = "";
  // Newest conversation first (join/leave lines don't count), then by name.
  const lastAt = (c) => c.msgs.reduce((t, m) => (isConvMsg(m) ? Math.max(t, m.time) : t), 0);
  const roomList = rooms().sort((a, b) => (lastAt(b) - lastAt(a)) || roomLabel(a.name).localeCompare(roomLabel(b.name)));
  for (const c of roomList) {
    const item = convItem(c, "chan", () => leaveRoom(c));
    item.querySelector(".close").title = "Leave this room";
    roomsEl.appendChild(item);
  }
  pmsEl.innerHTML = "";
  const list = pms().filter((c) => !isIgnored(c.name)).sort((a, b) => (b.msgs.at(-1)?.time || 0) - (a.msgs.at(-1)?.time || 0));
  for (const c of list) pmsEl.appendChild(convItem(c, "pm", () => closePm(c)));
  $("pmsEmpty").style.display = list.length ? "none" : "";
}

function renderUsers() {
  usersEl.innerHTML = "";
  const c = S.current && conv(S.current);
  if (!c) { $("usersTitle").textContent = "People here"; return; }
  let people;
  if (c.kind === "pm") {
    $("usersTitle").textContent = "Chatting with";
    people = [c.name];
  } else {
    $("usersTitle").textContent = "People here";
    people = [...c.members.keys()].filter((n) => !isService(n));   // hide ChanServ & co.
  }
  requestPresence(people);
  // Nearest timezone first, then by name.
  for (const nick of people.sort((a, b) => (tzSortKey(a) - tzSortKey(b)) || a.localeCompare(b))) {
    const self = keyOf(nick) === keyOf(S.me);
    const st = statusOf(nick);
    const d = document.createElement("div");
    d.className = `user st-${st.state}` + (self ? " self" : "");
    const name = document.createElement("span");
    name.className = "label";
    name.textContent = nick + (self ? " (you)" : "");
    if (c.kind === "room" && /[@~&]/.test(c.members.get(nick) || "")) {
      name.textContent += " 👑";
      name.title = "Room owner / moderator";
    }
    if (c.kind === "room" && isMuted(c, nick)) { name.textContent += " 🔇"; name.title = "Muted"; }
    paintName(name, nick);
    name.dataset.nick = nick;
    if (isAsleep(nick)) { name.textContent += " 😴"; name.title = "Outside their active hours"; }
    d.appendChild(name);
    d.appendChild(profileButton(nick));
    if (st.state !== "unknown") {
      const sl = document.createElement("span");
      sl.className = "status-text";
      sl.textContent = st.label;
      d.appendChild(sl);
    }
    if (!self) {
      d.title = `Chat privately with ${nick} (${st.label}). Right-click for more.`;
      d.onclick = () => openPm(nick);
      d.oncontextmenu = (e) => { e.preventDefault(); personMenu(e, nick); };
      if (isIgnored(nick)) d.classList.add("ignored");
      if (!isFriend(nick)) {
        const add = document.createElement("span");
        add.className = "add-friend";
        add.textContent = "➕";
        add.title = `Add ${nick} to Friends`;
        add.onclick = (e) => { e.stopPropagation(); addFriend(nick); };
        d.appendChild(add);
      }
    }
    usersEl.appendChild(d);
  }
}

/* Title bar: the name/topic may be cut short ("…"), the buttons never are.
 * Each button becomes icon + label; the label hides when the pane is narrow. */
function layoutTitle() {
  const t = $("chatTitle");
  const btns = [...t.querySelectorAll(".title-btn")];
  if (!btns.length || t.querySelector(".title-btns")) return;
  const box = document.createElement("span");
  box.className = "title-btns";
  for (const b of btns) {
    const [, icon, label] = b.textContent.match(/^(\S+)\s+(.*)$/) || [null, b.textContent, ""];
    b.title ||= label;
    b.innerHTML = `${icon}<span class="lbl"> ${esc(label)}</span>`;
    box.appendChild(b);
  }
  const text = document.createElement("span");
  text.className = "title-text";
  while (t.firstChild) text.appendChild(t.firstChild);
  t.append(text, box);
}

function refreshSide() {
  renderLists(); renderUsers();
  const c = S.current && conv(S.current);
  let title = "Conversation";
  if (c?.kind === "room" && isConference(c.name)) {
    const people = confPeople(c);
    title = esc(roomLabel(c.name)) + ` <span class="topic">— ${people.length ? "with " + esc(people.join(", ")) : "waiting for people to join"}</span>`;
    if (amOp(c)) title += ` <button id="btnInvite" class="title-btn" title="Invite more friends">➕ Invite</button>`;
    title += ` <button id="btnLeave" class="title-btn" title="Leave this conference">🚪 Leave</button>`;
  } else if (c?.kind === "room") {
    title = esc(roomName(c.name)) + (c.topic ? ` <span class="topic">— ${emote(esc(c.topic))}</span>` : "");
    if (amOp(c)) title += ` <button id="btnTopic" class="title-btn" title="Change this room's topic">✏️ Topic</button>`;
    if (!c.modes?.has("i") || amOp(c)) title += ` <button id="btnInvite" class="title-btn" title="Invite friends to this room">➕ Invite</button>`;
    if (amOp(c)) title += ` <button id="btnRoomSettings" class="title-btn" title="Room settings and moderation">⚙️ Settings</button>`;
    title += ` <button id="btnEvents" class="title-btn" title="Events in this room">📅 Events</button>`;
    if (!c.modes?.has("i") && !c.modes?.has("s")) title += ` <button id="btnInviteLink" class="title-btn" title="Copy an invite link">🔗 Link</button>`;
    title += ` <button id="btnLeave" class="title-btn" title="Leave this room">🚪 Leave</button>`;
  } else if (c?.kind === "pm") {
    const lt = localTimeText(c.name);
    title = `Private chat with ${esc(c.name)}` + (lt ? ` <span class="topic">— ${esc(lt)}</span>` : "") +
      ` <button id="btnPmProfile" class="title-btn" title="See ${esc(c.name)}'s profile">👤 Profile</button>` +
      ` <button id="btnPmTheme" class="title-btn" title="Chat theme (both of you see it)">🎨 Theme</button>` +
      ` <button id="btnPmIgnore" class="title-btn">${isIgnored(c.name) ? "✅ Unignore" : "🚫 Ignore"}</button>`;
  }
  $("chatTitle").innerHTML = title;
  if ($("btnTopic")) $("btnTopic").onclick = () => editTopic(c);
  if ($("btnLeave")) $("btnLeave").onclick = () => leaveRoom(c);
  if ($("btnInvite")) $("btnInvite").onclick = () => openConfDialog(c);
  if ($("btnRoomSettings")) $("btnRoomSettings").onclick = () => openRoomDialog(c);
  if ($("btnEvents")) $("btnEvents").onclick = () => openRoomEvents(c);
  if ($("btnInviteLink")) $("btnInviteLink").onclick = () => copyInvite(c);
  if ($("btnPmProfile")) $("btnPmProfile").onclick = () => openProfile(c.name);
  if ($("btnPmIgnore")) $("btnPmIgnore").onclick = () => ignoreUser(c.name, !isIgnored(c.name));
  if ($("btnPmTheme")) $("btnPmTheme").onclick = (e) => { e.stopPropagation(); imvMenu(e, c); };
  if (c && c.kind !== "status") {
    $("chatTitle").insertAdjacentHTML("beforeend", ` <button id="btnSearchConv" class="title-btn" title="Search messages">🔍 Search</button>` +
      ` <button id="btnExport" class="title-btn" title="Save this whole conversation as JSON (Downloads)">⬇ Export</button>`);
    $("btnSearchConv").onclick = openSearch;
    $("btnExport").onclick = () => exportConversation(c);
  }
  layoutTitle();
  $("input").placeholder = c?.kind === "pm" ? `Message ${c.name}…` : "Type your message here…";
  $("btnBuzz").disabled = c?.kind !== "pm";
  $("btnBuzz").title = c?.kind === "pm" ? `BUZZ! ${c.name}` : "Open a private chat to BUZZ someone";
}

/* ---------- IRC event handling ---------- */

function onWelcome(nick) {
  S.me = nick;
  rememberLogin();
  S.authFailed = false;
  setPhase("online");
  sys("You're signed in!");
  Sound.play("signin");
  ensureNotifyPermission();
}

function setTopic(channel, text) {
  if (!channel || isPresenceRoom(channel)) return;
  getConv(channel, "room").topic = text || "";
  if (keyOf(channel) === S.current) refreshSide();
}

/* Saved rooms have been replayed: fetch history + private chats. */
function onBurstDone() {
  S.burstDone = true;
  if (rooms().length === 0) joinRoom(DEFAULT_ROOM);
  if (!S.inPresence) send(`JOIN ${PRESENCE_ROOM}`);
  for (const c of rooms()) fetchHistory(c);
  fetchPrivateChats();
  startPresence();
  checkAccountLink();
  checkRecoveryEmail();
  startSocial();
}

function onJoin(fromNick, channel) {
  if (isPresenceRoom(channel)) {
    if (keyOf(fromNick) === keyOf(S.me)) {
      S.inPresence = true;
      if (has("draft/chathistory")) send(`CHATHISTORY LATEST ${PRESENCE_ROOM} * ${PRESENCE_HISTORY}`);
    }
    return;
  }
  const c = getConv(channel, "room");
  if (!c.members.has(fromNick)) c.members.set(fromNick, "");
  if (keyOf(fromNick) === keyOf(S.me)) {
    send(`NAMES ${channel}`);
    loadRoomState(c);
    if (S.burstDone) {
      sys(`You joined ${roomLabel(channel)}`, "system", channel); fetchHistory(c);
      // Only a JOIN this device asked for can mean "I just created this room";
      // soju also relays joins made from my other devices.
      c.justJoined = !!S.joining?.delete(keyOf(channel));
    }
    S.current = null;          // force switchTo to re-render
    switchTo(channel);
  } else if (!isService(fromNick)) {          // ChanServ & co. come and go silently
    addMsg(channel, { who: fromNick, txt: isConference(channel) ? "joined the conference" : "joined the room", cls: "action", local: true });
  }
  refreshSide();
}

function onPart(fromNick, channel) {
  if (isPresenceRoom(channel)) return;
  const key = keyOf(channel);
  if (keyOf(fromNick) === keyOf(S.me)) {
    S.convs.delete(key);
    if (S.current === key) { S.current = null; switchTo(rooms().at(-1)?.name || null); renderLog(); }
    if (S.confEnded?.delete(key)) {
      S.leaving?.delete(key);
      sys("That conference has already ended.", "tip");
    } else if (S.leaving?.delete(key)) {   // shown in whatever is on screen now
      sys(isConference(channel)
        ? `You left the conference. You'll need a new invite to join it again.`
        : `You left ${roomName(channel)}. You can rejoin it any time from 🔍 Rooms.`, "system");
    }
    refreshSide();
    return;
  }
  conv(key)?.members.delete(fromNick);
  if (!isService(fromNick)) addMsg(channel, { who: fromNick, txt: isConference(channel) ? "left the conference" : "left the room", cls: "action", local: true });
  refreshSide();
}

function onQuit(fromNick) {
  for (const c of rooms()) {
    if (c.members.delete(fromNick) && !isService(fromNick)) addMsg(c.name, { who: fromNick, txt: "signed out", cls: "action", local: true });
  }
  refreshSide();
}

function onNick(oldNick, newNick) {
  for (const c of rooms()) {
    if (c.members.has(oldNick)) { c.members.set(newNick, c.members.get(oldNick)); c.members.delete(oldNick); }
  }
  const pm = conv(keyOf(oldNick));
  if (pm?.kind === "pm") {          // keep the private chat under the new name
    S.convs.delete(keyOf(oldNick));
    pm.name = newNick;
    S.convs.set(keyOf(newNick), pm);
    if (S.current === keyOf(oldNick)) S.current = keyOf(newNick);
  }
  if (keyOf(oldNick) === keyOf(S.me)) { S.me = newNick; setPhase(S.phase); }
  refreshSide();
}

function onNames(params, trailing) {
  // "353 <me> <=|@|*> <#room> :names" — <me> may itself be "*", so find the
  // room by its prefix instead of by the visibility marker.
  const ci = params.findIndex(isChannel);
  const channel = params[ci];
  if (ci < 0 || isPresenceRoom(channel)) return;
  const c = getConv(channel, "room");
  c.members.clear();
  // A one-name list may arrive without the ":" (e.g. "353 * = #room @diana").
  const names = trailing ?? params.slice(ci + 1).join(" ");
  for (const tok of (names || "").split(/\s+/).filter(Boolean)) {
    const p = tok.match(/^([@+~&%]*)(.*)$/);
    c.members.set(p[2], p[1] || "");
  }
  if (c.justJoined) {
    c.justJoined = false;
    const mine = c.members.get(S.me) || "";
    const alone = c.members.size === 1 && /[@~&]/.test(mine);   // we just created it
    if (isConference(channel)) {
      const pc = S.pendingConf;
      if (pc?.key === keyOf(channel)) { S.pendingConf = null; if (alone) startConference(c, pc.invitees); }
      else if (alone) endedConference(c);        // everyone had left: don't revive it
    } else if (alone) claimRoom(c);
    else if (S.pendingCreate?.key === keyOf(channel)) S.pendingCreate = null;   // it existed after all
  }
  if (keyOf(channel) === S.current) refreshSide();
}

function onMessage(l) {
  const from = nickOf(l.prefix);
  if (isPresenceRoom(l.params[0])) { if (l.cmd === "PRIVMSG") onStatusLine(from, l); return; }
  if (from === "NickServ") { onNickServ(l.text || ""); return; }
  if (from === "ChanServ") { onChanServ(l.text || ""); return; }
  if (from === "BouncerServ") { onBouncerServ(l.text || ""); return; }
  if (isPlumbing(l.prefix, from)) return;
  addMsg(convTarget(l.params[0], from), msgFrom(l, from));
}

/* Room-related failures worth telling a person about; everything else is noise. */
const ROOM_ERRORS = {
  403: "That room doesn't exist.",
  404: "You can't talk in this room right now (you're muted, or only moderators can talk).",
  405: "You've joined too many rooms.",
  471: "That room is full.",
  473: "That room is invite-only.",
  474: "You're banned from that room.",
  475: "That room needs a password.",
  477: "You need a registered name to join that room.",
  401: "There's no a09f user with that ID.",
  482: "Only the room's moderators can do that.",
};

function onNumeric(num, params, trailing) {
  switch (num) {
    case 1: onWelcome(params[0]); return;
    // End of MOTD: soju replays saved room JOINs right after this. A PING
    // marker tells us when that replay is over (see onBurstDone).
    case 376: case 422: send(`PING :${BURST_TOKEN}`); return;
    case 353: onNames(params, trailing); return;
    case 332: setTopic(params[1], trailing); return;            // topic on join
    case 331: setTopic(params[1], ""); return;                  // no topic
    case 330: if (keyOf(params[1]) === keyOf(S.me)) { S.selfAccount = params[2]; return; } break;
    case 322: case 323:
      if (S.listProbe) {                                   // roomExists() is asking
        if (num === 322 && keyOf(params[1]) === S.listProbe.key) S.listProbe.found = true;
        if (num === 323) S.listProbe.done(S.listProbe.found);
        if (num === 323 || !S.listBuf) return;
      }
      break;
  }
  switch (num) {
    case 321: S.listBuf = []; return;                                             // LIST start
    case 322: S.listBuf?.push({ name: params[1], users: +params[2] || 0, topic: trailing || "" }); return;
    case 323: S.roomList = S.listBuf || []; S.listBuf = null; S.listLoading = false; renderRoomBrowser(); return;
    case 311: case 301: case 318: case 401:
      if (num === 318 && keyOf(params[1]) === keyOf(S.me) && S.link === "checking") { onSelfWhoisDone(); return; }
      if (onWhoisReply(num, params, trailing)) return;
      break;
    case 716: case 718: onCallerId(num, params); return;
    case 324: onChannelModes(params); return;
    case 367: case 368: case 728: case 729: onListEntry(num, params); return;
    case 710: onKnock(params); return;
    case 711: sys("Your request was sent to the room's moderators. You'll get an invite if they let you in.", "system"); return;
    case 712: sysError("You've asked too many times. Please wait a bit."); return;
    case 713: sysError("That room isn't private — you can just join it."); return;
    case 714: sysError("You're already in that room."); return;
    case 480: sysError("You can't ask to join that room."); return;
    case 742: sysError("Only the room's owner can change that setting."); return;
    case 717: return;
    case 730: onMonitor(trailing, true); return;
    case 731: onMonitor(trailing, false); return;
    // SASL finished (success or failure): end CAP negotiation so registration completes.
    case 903:
      // Invisible: be away before soju sees us, so friends never see us online.
      if (S.myStatus.code === "invisible" && has("draft/pre-away")) send("AWAY :Invisible");
      send("CAP END");
      return;
    case 902: case 904: case 905: case 906: case 907:
      S.authFailed = true;
      forgetSavedPassword();
      send("CAP END");
      doDisconnect("Wrong ID or password. Please try again.", true);
      return;
  }
  if (num === 401 && params[1]) { sysError(`There's no a09f user with the ID "${params[1]}".`); return; }
  if (num === 473 && isConference(params[1])) { sysError("You need a new invite to join this conference."); return; }
  if (num === 473) { offerKnock(params[1]); return; }
  if (num === 475) { addMsg(null, { who: "Error", txt: `${roomName(params[1])} needs a password.`, cls: "error", askKey: params[1] }); return; }
  if (num === 482 && isConference(params[1])) { sysError("Only the person who started the conference can invite people."); return; }
  if (ROOM_ERRORS[num]) sysError(ROOM_ERRORS[num]);
}

/* An invite to a wrong ID fails twice (INVITE + the invite message): say it once. */
function sysError(text) {
  const now = Date.now();
  if (S.lastError?.text === text && now - S.lastError.at < 3000) return;
  S.lastError = { text, at: now };
  sys(text, "error");
}

function onCap(params, trailing) {
  const sub = params[1];
  // Cap list may be trailing (":a b") or a bare param ("ACK sasl");
  // "CAP * LS * :..." marks a multi-line LS with more to come.
  const more = params[2] === "*";
  const caps = (trailing ?? params.slice(more ? 3 : 2).join(" ")).split(/\s+/).filter(Boolean);
  if (sub === "LS") {
    S.capLs = [...(S.capLs || []), ...caps.map((c) => c.split("=")[0])];
    if (more) return;
    const offered = new Set(S.capLs);
    S.capLs = [];
    const req = WANTED_CAPS.filter((c) => offered.has(c));
    if (!req.includes("sasl")) { send("CAP END"); return; }
    send(`CAP REQ :${req.join(" ")}`);
  } else if (sub === "ACK") {
    for (const c of caps) S.caps.add(c.replace(/^-/, ""));
    if (caps.includes("sasl")) send("AUTHENTICATE PLAIN");
  } else if (sub === "NAK") {
    // A rejected bundle: fall back to plain SASL so sign-in still works.
    if (caps.length > 1 || !caps.includes("sasl")) send("CAP REQ :sasl");
    else send("CAP END");
  }
}

function handleLine(line) {
  const l = parse(line);
  const { tags, prefix, cmd, params, trailing } = l;

  // Lines inside a chathistory batch are collected and handled together.
  if (tags.batch && S.batches.has(tags.batch)) { S.batches.get(tags.batch).lines.push(l); return; }

  if (/^\d+$/.test(cmd)) { onNumeric(parseInt(cmd, 10), params, l.text); return; }

  switch (cmd) {
    case "CAP": onCap(params, trailing); return;
    case "AUTHENTICATE":
      if (params[0] === "+") {
        const u = $("buser").value.trim(), p = $("bpass").value;
        send("AUTHENTICATE " + btoa(unescape(encodeURIComponent("\0" + u + "\0" + p))));
      }
      return;
    case "BATCH": {
      const ref = params[0].slice(1);
      if (params[0].startsWith("+")) {
        const type = params[1];
        if (type === "chathistory" || type === "draft/chathistory-targets" || type === "soju.im/search") {
          S.batches.set(ref, { type, params: params.slice(2), lines: [] });
        }
      } else {
        const b = S.batches.get(ref);
        S.batches.delete(ref);
        if (b?.type === "chathistory") onHistoryBatch(b.params[0], b.lines);
        else if (b?.type === "soju.im/search") onSearchBatch(b.lines);
        else if (b) onTargetsBatch(b.lines);
      }
      return;
    }
    case "MARKREAD": onMarkRead(params[0], params[1]); return;
    case "AWAY": setPresence(nickOf(prefix), { away: trailing != null || params.length > 0 }); return;
    case "JOIN": {
      const channel = params[0] || trailing || "";
      if (isChannel(channel)) onJoin(nickOf(prefix), channel);
      return;
    }
    case "TOPIC": setTopic(params[0], trailing ?? params[1] ?? ""); return;
    case "MODE": onMode(params, trailing); return;
    case "PART": onPart(nickOf(prefix), params[0]); return;
    case "KICK": onKick(nickOf(prefix), params[0], params[1], l.text); return;
    case "QUIT": onQuit(nickOf(prefix)); return;
    case "NICK": {
      if (params.length >= 2) onNick(params[0], params[1]);
      else onNick(nickOf(prefix), trailing || params[0]);
      return;
    }
    case "PRIVMSG": case "NOTICE": onMessage(l); return;
    case "PING": send(`PONG :${trailing || params[0]}`); return;
    case "PONG": if ((trailing || params[1]) === BURST_TOKEN) onBurstDone(); return;
    default: return; // ignore everything else
  }
}

/* ---------- presence: friends, Online/Offline, status messages ---------- */

const isPresenceRoom = (t) => keyOf(t) === keyOf(PRESENCE_ROOM);

/* What people see for each status choice. state drives the dot color. */
const STATUS_PRESETS = {
  available: { label: "Available",     state: "online" },
  busy:      { label: "Busy",          state: "busy" },
  brb:       { label: "Be Right Back", state: "away" },
  stepped:   { label: "Stepped Out",   state: "away" },
  // Its own color: a custom message says nothing about whether they're really there.
  custom:    { label: "",              state: "custom" },
  // Never posted: invisible = staying AWAY on IRC (sent before registration
  // with draft/pre-away), which everyone else already reads as Offline.
  invisible: { label: "Invisible",     state: "offline" },
};
const invisibleKey = () => `a09f.invisible.${S.account}`;

/* Effective status for a nick: {state: online|busy|away|offline|unknown, label}.
 * Offline = soju auto-away (no device connected), MONITOR offline, or no such
 * nick. Otherwise the person's last STATUS line decides. */
function statusOf(nick) {
  const key = keyOf(nick);
  const fromStatus = (st) => {
    const p = STATUS_PRESETS[st?.code] || STATUS_PRESETS.available;
    return { state: p.state, label: (st?.code === "custom" && st.text) || p.label || "Available" };
  };
  if (key === keyOf(S.me)) return fromStatus(S.myStatus);
  const p = S.presence.get(key);
  if (!p) return { state: "unknown", label: "…" };
  if (p.exists === false || p.online === false || p.away === true) return { state: "offline", label: "Offline" };
  if (p.away === false || p.online === true) return fromStatus(S.statuses.get(key));
  return { state: "unknown", label: "…" };
}

function setPresence(nick, patch) {
  if (!nick || isService(nick)) return;
  const key = keyOf(nick);
  const before = statusOf(nick).state;
  S.presence.set(key, { ...(S.presence.get(key) || {}), ...patch });
  presenceChanged(nick, before);
}

/* Re-render and, for friends, announce sign-ins / sign-outs like YM did. */
function presenceChanged(nick, before) {
  const after = statusOf(nick).state;
  if (before === after) return;
  if (S.presenceReady && isFriend(nick)) {
    if (before === "offline" && after !== "offline") {
      sys(`${nick} is now online.`, "system");
      Sound.play("online");
      notify(`${nick} is now online`, "", null);
    }
    if (after === "offline") (S.lastSeen ||= new Map()).set(keyOf(nick), Math.floor(Date.now() / 1000));
    if (before !== "offline" && before !== "unknown" && after === "offline") {
      sys(`${nick} signed off.`, "system");
      Sound.play("offline");
    }
  }
  schedulePresenceRender();
}

function schedulePresenceRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => { S.renderQueued = false; renderLists(); renderUsers(); renderFind(); refreshProfileStatus(); });
}

/* "STATUS <code> [text]" posted in PRESENCE_ROOM. Newest line wins. */
function onStatusLine(from, l) {
  // The text is usually the trailing parameter, so it isn't in l.params.
  const m = (l.text || "").match(/^STATUS (\w+)(?: (.*))?$/);
  if (!m || !STATUS_PRESETS[m[1]]) return;
  const time = l.tags.time ? Date.parse(l.tags.time) : Date.now();
  const key = keyOf(from);
  const prev = S.statuses.get(key);
  if (prev && prev.time > time) return;
  const st = { code: m[1], text: (m[2] || "").slice(0, 80), time };
  if (key === keyOf(S.me)) {          // our own status, e.g. set on another device
    if (S.myStatus.code === "invisible") { S.statuses.set(key, st); return; }   // stays hidden
    S.myStatus = { code: st.code, text: st.text };
    S.statuses.set(key, st);
    syncStatusUi();
    return;
  }
  const before = statusOf(from).state;
  S.statuses.set(key, st);
  presenceChanged(from, before);
  schedulePresenceRender();
}

/* soju keeps history per account, so friends who joined PRESENCE_ROOM after
 * our last STATUS line never saw it. Re-announce a non-default status on
 * every sign-in (once our own history told us what it is). */
function announceMyStatus() {
  if (S.announced || !S.inPresence) return;
  S.announced = true;
  if (S.myStatus.code === "invisible") return;
  const { code, text } = S.myStatus;
  if (code !== "available") send(`PRIVMSG ${PRESENCE_ROOM} :STATUS ${code}${text ? " " + text : ""}`);
}

function setMyStatus(code, text) {
  if (code === "custom" && !text) { $("statusText").focus(); return; }
  const wasInvisible = S.myStatus.code === "invisible";
  if (code === "invisible") {
    S.myStatus = { code, text: "" };
    localStorage.setItem(invisibleKey(), "1");
    send("AWAY :Invisible");
    syncStatusUi();
    sys("You're invisible: everyone sees you as Offline, but you can still chat.", "status");
    renderUsers();
    return;
  }
  if (wasInvisible) { localStorage.removeItem(invisibleKey()); send("AWAY"); }
  S.myStatus = { code, text };
  S.statuses.set(keyOf(S.me), { code, text, time: Date.now() });
  syncStatusUi();
  if (S.inPresence) send(`PRIVMSG ${PRESENCE_ROOM} :STATUS ${code}${text ? " " + text : ""}`);
  const label = statusOf(S.me).label;
  sys(code === "available" ? "You're shown as Available." : `Your status is now "${label}".`, "status");
  renderUsers();
}

/* Initial state: WHOIS (fresh, unlike soju's cached WHO) for friends and the
 * people on screen; MONITOR covers friends who aren't on a09f/soju. */
function startPresence() {
  // Friends arrive from the account service (startSocial → applyFriends).
  clearTimeout(S.presenceTimer);
  S.presenceTimer = setTimeout(() => { S.presenceReady = true; }, 4000);
  renderLists();
}

function requestPresence(nicks) {
  for (const n of nicks) {
    const key = keyOf(n);
    if (!n || key === keyOf(S.me) || isService(n) || S.whois.has(key) || S.presence.get(key)?.away != null) continue;
    S.whois.set(key, { away: false, nick: n });
    send(`WHOIS ${n}`);
  }
}

/* Returns true when the reply belonged to one of our presence WHOIS queries. */
function onWhoisReply(num, params, trailing) {
  const key = keyOf(params[1]);
  const q = S.whois.get(key);
  if (!q) return false;
  if (num === 311) q.nick = params[1];          // the ID as the server spells it
  if (num === 301) q.away = true;
  if (num === 401) {
    S.whois.delete(key); clearTimeout(q.addTimer);
    setPresence(q.nick, { exists: false });
    if (q.add) addFailed(q.nick, `There's no a09f user with the ID "${q.nick}".`);
  }
  if (num === 318 && S.whois.get(key) === q) {
    S.whois.delete(key); clearTimeout(q.addTimer);
    setPresence(q.nick, { away: q.away, exists: true });
    if (q.add) addConfirmed(q.nick, q.away);
  }
  return true;
}

function onMonitor(list, online) {
  for (const item of (list || "").split(",").filter(Boolean)) setPresence(nickOf(item), { online });
}

/* ----- friends: server-side list with groups and friend requests ----- */

/* The account service (server/register) keeps the friends list, so it
 * follows the person to any computer, and adding someone needs their OK.
 * A session token (password checked by the service) authorizes the calls;
 * live events (requests, answers, typing) arrive over Server-Sent Events. */
const DEFAULT_GROUP = "Friends";
const isFriend = (nick) => S.friends.some((f) => keyOf(f) === keyOf(nick));
const groupOf = (nick) => S.friendGroups.get(keyOf(nick)) || DEFAULT_GROUP;
const isPendingFriend = (nick) => S.outgoing.some((o) => keyOf(o.to) === keyOf(nick));

async function socialApi(path, body = null, retry = true) {
  if (!S.token) await openSession();
  const res = await fetch(ACCOUNT_URL + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${S.token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {          // service restarted: sign in to it again
    S.token = null;
    return socialApi(path, body, false);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

async function openSession() {
  S.deviceName ||= await invoke("device_name").catch(() => "a09f desktop");
  const { ok, data } = await accountApi("/session", { username: S.account, password: S.pw, device: S.deviceName });
  if (!ok) throw new Error(data.error || "Couldn't reach your friends list.");
  S.token = data.token;
  S.sid = data.sid;
  S.admin = !!data.admin;
  $("btnAnnounce").style.display = S.admin ? "" : "none";
  return S.token;
}

/* After sign-in: session, friends list, live events. */
async function startSocial() {
  try {
    await openSession();
    applyFriends(await socialApi("/friends"));
    await loadPrefs();
    await migrateLocalFriends();
    loadRedactions(); loadAnnouncements(); loadStats();
    loadLastSeen(); loadDueReminders(); loadSaved();
    shareMyTz(); S.friends.forEach(tzOf); loadScheduled(); loadNotes();
    if (S.pendingDeepLink) { joinOrCreate(S.pendingDeepLink); S.pendingDeepLink = null; }
    socialApi(`/tz?users=${encodeURIComponent(S.me)}`).then(({ tz }) => {
      const a = tz[keyOf(S.me)]?.active; (S.active ||= new Map()); if (a) S.active.set(keyOf(S.me), a);
    }).catch(() => {});
    nameColor(S.me); S.friends.forEach(nameColor);
    clearInterval(S.lastSeenTimer);
    S.lastSeenTimer = setInterval(loadLastSeen, 120000);
    const cur = S.current && conv(S.current);
    if (cur) loadMeta(cur);
    openEvents();
  } catch (e) {
    if (S.phase !== "online") return;
    sys("Your friends list couldn't be loaded right now. It will retry in a minute.", "error");
    clearTimeout(S.socialRetry);
    S.socialRetry = setTimeout(() => { if (S.phase === "online") startSocial(); }, 60000);
  }
}

/* Friends from the old this-computer-only list become friend requests. */
async function migrateLocalFriends() {
  const key = `a09f.friends.${S.account}`;
  let old = [];
  try { old = JSON.parse(localStorage.getItem(key)) || []; } catch {}
  localStorage.removeItem(key);
  for (const nick of old) {
    if (isFriend(nick) || isPendingFriend(nick) || keyOf(nick) === keyOf(S.me)) continue;
    try { applyFriends(await socialApi("/friends/request", { to: nick, group: DEFAULT_GROUP, msg: "" })); } catch {}
  }
}

function openEvents() {
  S.events?.close();
  const es = new EventSource(`${ACCOUNT_URL}/events?token=${encodeURIComponent(S.token)}`);
  S.events = es;
  const on = (type, fn) => es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch {} });
  on("friend-request", (d) => {
    refreshFriends();
    sys(`${d.from} wants to add you as a friend. Answer in your Friends list.`, "system");
    Sound.play("buzz");
    notify(`${d.from} wants to be your friend`, d.msg || "Open a09f to accept or decline.", null);
  });
  on("friend-accepted", (d) => {
    refreshFriends();
    sys(`${d.nick} accepted your friend request. 🎉`, "system");
    Sound.play("online");
    notify(`${d.nick} accepted your friend request`, "", null);
  });
  on("friend-declined", (d) => {
    refreshFriends();
    sys(`${d.nick} declined your friend request.`, "system");
  });
  on("friend-removed", (d) => {
    send(`MONITOR - ${d.nick}`);
    refreshFriends();
    sys(`${d.nick} is no longer on your Friends list.`, "system");
  });
  on("friend-request-cancelled", () => refreshFriends());
  // My other devices changed something: follow along quietly.
  on("friends-changed", (d) => { if (d.sid !== S.sid) refreshFriends(); });
  on("prefs-changed", (d) => { if (d.sid !== S.sid) loadPrefs().then(renderPrivacy); });
  on("profile-updated", (d) => onProfileUpdated(d.nick, d.sid));
  on("read", (d) => onSeen(d.from, d.time));
  on("redact", onRedact);
  on("announcement", (a) => showAnnouncement(a, true));
  on("online", (d) => setOnlineCount(d.count));
  on("reaction", onReactionEvent);
  on("edit", onEditEvent);
  on("pins", (d) => { const c = conv(keyOf(d.room)); if (c && S.meta?.has(keyOf(d.room))) loadMeta(c); });
  on("poll", (d) => { if (S.polls?.has(d.id)) loadPoll(d.id); });
  on("reminder", showReminder);
  on("namecolor", onNameColor);
  on("signed-out", (d) => {
    if (S.phase !== "online") return;
    if (d.only ? d.only !== S.sid : d.except === S.sid) return;
    forgetSavedPassword();
    doDisconnect(d.reason === "revoked" ? "This device was signed out from another device."
      : "Your password was changed, so you were signed out here. Please sign in with the new password.", true);
  });
  on("typing", (d) => (d.room ? onRoomTyping(d) : onTyping(d.from, d.active)));
  on("expire", onExpireEvent);
  on("saved-changed", loadSaved);
  on("imv", onImvEvent);
  on("scheduled-changed", loadScheduled);
  on("event", onEventChanged);
  on("event-soon", onEventSoon);
  on("roominfo", (d) => { S.roomInfo?.delete(keyOf(d.room)); });
  on("room-read", onRoomRead);
  on("notes-changed", loadNotes);
  on("active-changed", (d) => {
    if (keyOf(d.user) === keyOf(S.me)) return;
    S.tz?.delete(keyOf(d.user)); S.active?.delete(keyOf(d.user)); tzOf(d.user);
  });
  // EventSource reconnects by itself; a dead token (service restarted) shows
  // up as a closed stream: get a new session and listen again.
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED || S.events !== es || S.phase !== "online") return;
    clearTimeout(S.eventsRetry);
    S.eventsRetry = setTimeout(async () => {
      try { await openSession(); openEvents(); refreshFriends(); } catch { es.onerror(); }
    }, 5000);
  };
}

function stopSocial() {
  S.events?.close(); S.events = null;
  clearTimeout(S.socialRetry); clearTimeout(S.eventsRetry);
  if (S.token) {
    fetch(`${ACCOUNT_URL}/session/end`, { method: "POST", headers: { "Content-Type": "application/json",
      Authorization: `Bearer ${S.token}` }, body: "{}" }).catch(() => {});
  }
  S.token = null;
}

async function refreshFriends() {
  try { applyFriends(await socialApi("/friends")); } catch {}
}

function applyFriends(state) {
  const before = new Set(S.friends.map(keyOf));
  S.friends = state.friends.map((f) => f.nick);
  S.friendGroups = new Map(state.friends.map((f) => [keyOf(f.nick), f.group]));
  S.incoming = state.incoming || [];
  S.outgoing = state.outgoing || [];
  const added = S.friends.filter((n) => !before.has(keyOf(n)));
  if (added.length) { send(`MONITOR + ${added.join(",")}`); requestPresence(added); }
  applyFriendsOnly();
  renderLists(); renderUsers(); renderFind();
}

async function friendCall(path, body, okMessage) {
  try {
    const data = await socialApi(path, body);
    applyFriends(data);
    if (okMessage) sys(typeof okMessage === "function" ? okMessage(data) : okMessage, "system");
    return data;
  } catch (e) {
    sys(e.message, "error");
    return null;
  }
}

/* Ask someone to be your friend (or accept them, if they already asked). */
async function addFriend(nick, group = DEFAULT_GROUP, msg = "") {
  nick = (nick || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,15}$/.test(nick)) { addErr("That doesn't look like an a09f ID."); return false; }
  if (keyOf(nick) === keyOf(S.me)) { addErr("You can't add yourself as a friend."); return false; }
  if (isFriend(nick)) { addErr(`${nick} is already your friend.`); return false; }
  if (addFormOpen()) showAddMsg(`Sending a request to ${nick}…`);
  try {
    const data = await socialApi("/friends/request", { to: nick, group, msg });
    applyFriends(data);
    sys(data.result === "friends" ? `${nick} is now your friend. 🎉`
      : `Friend request sent to ${nick}. They'll appear in your Friends once they accept.`, "system");
    toggleAddFriend(false);
    return true;
  } catch (e) {
    addErr(e.message);
    return false;
  }
}

const addFormOpen = () => $("friendAdd").style.display !== "none";
function addErr(message) { if (addFormOpen()) showAddMsg(message, "error"); else sys(message, "error"); }

function answerRequest(from, accept) {
  return friendCall("/friends/respond", { from, accept, group: DEFAULT_GROUP },
    accept ? `${from} is now your friend. 🎉` : `You declined ${from}'s friend request.`);
}

function removeFriend(nick) {
  const pending = isPendingFriend(nick);
  send(`MONITOR - ${nick}`);
  return friendCall("/friends/remove", { nick },
    pending ? `Friend request to ${nick} cancelled.` : `${nick} was removed from your Friends.`);
}

const moveFriend = (nick, group) => friendCall("/friends/move", { nick, group }, `${nick} moved to ${group}.`);
const renameGroup = (from, to) => friendCall("/friends/rename-group", { from, to }, `Group renamed to ${to}.`);

function friendGroupNames() {
  const names = new Set([DEFAULT_GROUP, ...S.friendGroups.values(), ...S.outgoing.map((o) => o.group)]);
  return [...names].sort((a, b) => (a === DEFAULT_GROUP ? -1 : b === DEFAULT_GROUP ? 1 : a.localeCompare(b)));
}

function showAddMsg(text, kind = "") {
  const el = $("friendAddMsg");
  el.textContent = text;
  el.className = "form-msg" + (kind ? " " + kind : "");
}

function toggleAddFriend(on, nick = "") {
  $("friendAdd").style.display = on ? "" : "none";
  $("friendAddName").value = nick;
  $("friendAddNote").value = "";
  fillGroupSelect($("friendAddGroup"), DEFAULT_GROUP);
  $("friendAddNewGroup").style.display = "none";
  showAddMsg("");
  renderFriends();
  if (on) (nick ? $("friendAddNote") : $("friendAddName")).focus();
}

function fillGroupSelect(sel, current) {
  sel.innerHTML = "";
  for (const g of friendGroupNames()) sel.add(new Option(g, g, false, g === current));
  sel.add(new Option("➕ New group…", "__new__"));
}

function submitAddFriend() {
  let group = $("friendAddGroup").value;
  if (group === "__new__") group = $("friendAddNewGroup").value.trim() || DEFAULT_GROUP;
  addFriend($("friendAddName").value, group, $("friendAddNote").value.trim());
}

/* ----- the Friends list ----- */

const STATE_ORDER = { online: 0, custom: 1, busy: 2, away: 3, unknown: 4, offline: 5 };

function renderFriends() {
  const el = $("friends");
  // Redraw only when something visible changed: rebuilding the rows under the
  // mouse drops WebKit's :hover and swallows clicks on the ⋯ buttons.
  const sig = JSON.stringify([S.friends, [...S.friendGroups], S.outgoing, S.incoming.map((r) => r.from),
    S.friends.map((n) => [statusOf(n), S.typing.has(keyOf(n)), conv(keyOf(n))?.unread || 0, S.lastSeen?.get(keyOf(n)) || 0]),
    [...(S.collapsedGroups || [])], $("friendAdd").style.display, S.prefs.ignore,
    S.friends.map((n) => S.nameColors?.get(keyOf(n)) ?? ""), S.friends.map((n) => S.tz?.get(keyOf(n)) ?? "")]);
  if (sig === S.friendsSig) return;
  S.friendsSig = sig;
  el.innerHTML = "";
  renderRequests();
  const byGroup = new Map();
  for (const nick of S.friends) {
    const g = groupOf(nick);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push({ nick, pending: false });
  }
  for (const o of S.outgoing) {
    if (!byGroup.has(o.group)) byGroup.set(o.group, []);
    byGroup.get(o.group).push({ nick: o.to, pending: true });
  }
  S.collapsedGroups ||= new Set();
  const groups = [...byGroup.keys()].sort((a, b) =>
    (a === DEFAULT_GROUP ? -1 : b === DEFAULT_GROUP ? 1 : a.localeCompare(b)));
  for (const g of groups) {
    const items = byGroup.get(g).sort((a, b) =>
      (a.pending - b.pending) ||
      (STATE_ORDER[statusOf(a.nick).state] - STATE_ORDER[statusOf(b.nick).state]) ||
      (tzSortKey(a.nick) - tzSortKey(b.nick)) || a.nick.localeCompare(b.nick));
    const real = items.filter((i) => !i.pending);
    const on = real.filter((i) => !["offline", "unknown"].includes(statusOf(i.nick).state)).length;
    const head = document.createElement("div");
    head.className = "fgroup" + (S.collapsedGroups.has(g) ? " collapsed" : "");
    head.innerHTML = `<span>${esc(g)}</span> <span class="fcount">(${on}/${real.length})</span>` +
      `<span class="more" title="Group options">⋯</span>`;
    head.onclick = () => { S.collapsedGroups.has(g) ? S.collapsedGroups.delete(g) : S.collapsedGroups.add(g); renderFriends(); };
    head.querySelector(".more").onclick = (e) => { e.stopPropagation(); groupMenu(e, g); };
    el.appendChild(head);
    if (S.collapsedGroups.has(g)) continue;
    for (const { nick, pending } of items) el.appendChild(friendRow(nick, pending));
  }
  const adding = $("friendAdd").style.display !== "none";   // the add form replaces the hint
  const any = S.friends.length || S.outgoing.length || S.incoming.length;
  $("friendsEmpty").style.display = any || adding ? "none" : "";
  const online = S.friends.filter((n) => !["offline", "unknown"].includes(statusOf(n).state)).length;
  $("friendsCount").textContent = S.friends.length ? ` (${online}/${S.friends.length})` : "";
}

function friendRow(nick, pending) {
  let st = pending ? { state: "pending", label: "Waiting for approval" } : statusOf(nick);
  const seen = st.state === "offline" && S.lastSeen?.get(keyOf(nick));
  if (seen) st = { ...st, label: `Offline · seen ${agoText(seen)}` };
  const pm = conv(keyOf(nick));
  const d = document.createElement("div");
  d.className = `friend st-${st.state}` + (pm?.unread ? " unread" : "") + (pending ? " pending" : "");
  d.title = pending ? `${nick} hasn't accepted your friend request yet.` : `${nick} — ${st.label}. Click to chat.`;
  const typing = !pending && S.typing.has(keyOf(nick));
  d.innerHTML = `<span class="label">${esc(nick)}</span>` +
    `<span class="status-text">${esc(typing ? "typing…" : st.label + sleepMark(nick))}</span>` +
    (pm?.unread ? `<span class="badge">${pm.unread > 99 ? "99+" : pm.unread}</span>` : "") +
    `<span class="more" title="More">⋯</span>`;
  if (!pending && st.state !== "offline") paintName(d.querySelector(".label"), nick);
  d.querySelector(".label").dataset.nick = nick;
  d.querySelector(".more").onclick = (e) => { e.stopPropagation(); friendMenu(e, nick, pending); };
  d.oncontextmenu = (e) => { e.preventDefault(); friendMenu(e, nick, pending); };
  d.onclick = () => openPm(nick);
  return d;
}

function renderRequests() {
  const el = $("friendRequests");
  el.innerHTML = "";
  for (const r of S.incoming.filter((r) => !isIgnored(r.from))) {
    const d = document.createElement("div");
    d.className = "freq";
    d.innerHTML = `<div>📨 <b>${esc(r.from)}</b> wants to be your friend</div>` +
      (r.msg ? `<div class="freq-msg">“${emote(esc(r.msg))}”</div>` : "") +
      `<div class="freq-actions"><button class="ok">Accept</button><button class="no">Decline</button>` +
      `<a class="freq-prof">Profile</a></div>`;
    d.querySelector(".ok").onclick = () => answerRequest(r.from, true);
    d.querySelector(".no").onclick = () => answerRequest(r.from, false);
    d.querySelector(".freq-prof").onclick = () => openProfile(r.from);
    el.appendChild(d);
  }
}

/* ----- small popup menus (friends, groups) ----- */

function showMenu(e, items) {
  const m = $("ctxMenu");
  m.innerHTML = "";
  for (const it of items) {
    if (it === "-") { m.appendChild(Object.assign(document.createElement("div"), { className: "sep" })); continue; }
    const b = document.createElement("div");
    b.className = "item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.onclick = (ev) => { ev.stopPropagation(); if (!it.keepOpen) hideMenu(); it.run(); };
    m.appendChild(b);
  }
  m.style.display = "block";
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 6) + "px";
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 6) + "px";
}

function hideMenu() { $("ctxMenu").style.display = "none"; }

/* A one-line text box inside the menu (new group / rename group). */
function menuPrompt(title, value, onOk) {
  const m = $("ctxMenu");
  m.innerHTML = `<div class="menu-title">${esc(title)}</div>` +
    `<div class="menu-input"><input type="text" maxlength="24"><button>OK</button></div>`;
  const inp = m.querySelector("input");
  inp.value = value;
  const ok = () => { const v = inp.value.trim(); hideMenu(); if (v) onOk(v); };
  m.querySelector("button").onclick = (e) => { e.stopPropagation(); ok(); };
  inp.onclick = (e) => e.stopPropagation();
  inp.onkeydown = (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") hideMenu(); };
  inp.focus(); inp.select();
}

function friendMenu(e, nick, pending) {
  if (pending) {
    showMenu(e, [
      { label: "👤 View Profile", run: () => openProfile(nick) },
      "-",
      { label: "✖ Cancel friend request", danger: true, run: () => removeFriend(nick) },
    ]);
    return;
  }
  const current = groupOf(nick);
  const moves = friendGroupNames().filter((g) => g !== current)
    .map((g) => ({ label: `📁 Move to ${g}`, run: () => moveFriend(nick, g) }));
  showMenu(e, [
    { label: "💬 Send Message", run: () => openPm(nick) },
    { label: "👤 View Profile", run: () => openProfile(nick) },
    "-",
    ...moves,
    { label: "📁 Move to a new group…", keepOpen: true,
      run: () => menuPrompt("New group name", "", (g) => moveFriend(nick, g)) },
    "-",
    { label: isIgnored(nick) ? "✅ Unignore" : "🚫 Ignore", run: () => ignoreUser(nick, !isIgnored(nick)) },
    { label: "✖ Remove from Friends", danger: true, run: () => removeFriend(nick) },
  ]);
}

function groupMenu(e, group) {
  showMenu(e, [
    { label: "✏️ Rename group…", keepOpen: true,
      run: () => menuPrompt(`Rename "${group}"`, group, (to) => renameGroup(group, to)) },
  ]);
}

document.addEventListener("click", hideMenu);
window.addEventListener("blur", hideMenu);

/* ----- "is typing…" (private chats only) ----- */

const TYPING_SEND_EVERY = 3000;     // while typing, refresh at most this often
const TYPING_SHOW_FOR = 6000;       // hide the indicator after this long without news

function onComposerInput() {
  const c = S.current && conv(S.current);
  if (!canShareTyping(c) || !S.token) return;
  const typing = $("input").value.trim().length > 0;
  const now = Date.now();
  if (typing && (S.typingTo !== c.name || now - S.typingSent > TYPING_SEND_EVERY)) {
    if (S.typingTo && S.typingTo !== c.name) sendTyping(S.typingTo, false);
    S.typingTo = c.name; S.typingSent = now;
    sendTyping(c.name, true);
  } else if (!typing && S.typingTo) {
    stopTyping();
  }
}

function stopTyping() {
  if (!S.typingTo) return;
  sendTyping(S.typingTo, false);
  S.typingTo = null; S.typingSent = 0;
}

function sendTyping(to, active) {
  socialApi("/typing", { to, active }).catch(() => {});
}

function onTyping(from, active) {
  const key = keyOf(from);
  clearTimeout(S.typing.get(key));
  if (active) S.typing.set(key, setTimeout(() => onTyping(from, false), TYPING_SHOW_FOR));
  else S.typing.delete(key);
  renderTyping();
  renderFriends();
}

function renderTyping() {
  const c = S.current && conv(S.current);
  const who = c?.kind === "pm" && S.typing.has(keyOf(c.name)) ? c.name : null;
  $("typing").textContent = who ? `${who} is typing…` : c?.kind === "room" ? roomTypingText(c) : "";
}

/* ---------- alerts: sounds, desktop notifications, BUZZ! ---------- */

const BUZZ_TEXT = "BUZZ!!";           // sent as /me BUZZ!! so other IRC clients show "* bob BUZZ!!"
const BUZZ_COOLDOWN = 10000;          // ms between BUZZes you can send
const BUZZ_SHAKE_GAP = 3000;          // ms between shakes when receiving several

S.focused = document.hasFocus();

/* Original sounds synthesized with WebAudio — no audio files. */
const Sound = {
  ctx: null,
  muted: localStorage.getItem("a09f.muted") === "1",
  ensure() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },
  tone(freq, at, dur, { type = "sine", gain = 0.12, to = null } = {}) {
    const ctx = this.ctx, t = ctx.currentTime + at;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t); osc.stop(t + dur + 0.02);
  },
  play(name) {
    if (this.muted || isQuiet()) return;
    try { this.ensure(); } catch { return; }
    switch (name) {
      case "message":                                   // soft two-note ping
        this.tone(988, 0, 0.12); this.tone(1319, 0.09, 0.22); break;
      case "mention":
        this.tone(784, 0, 0.1); this.tone(988, 0.08, 0.1); this.tone(1319, 0.16, 0.25); break;
      case "buzz":                                      // low rattling buzz
        for (let i = 0; i < 6; i++) this.tone(i % 2 ? 95 : 120, i * 0.09, 0.1, { type: "square", gain: 0.09 });
        break;
      case "online":                                    // rising chime
        this.tone(523, 0, 0.15, { type: "triangle" }); this.tone(659, 0.1, 0.15, { type: "triangle" });
        this.tone(784, 0.2, 0.3, { type: "triangle" }); break;
      case "offline":                                   // falling chime
        this.tone(784, 0, 0.15, { type: "triangle", gain: 0.08 }); this.tone(523, 0.12, 0.3, { type: "triangle", gain: 0.08 });
        break;
      case "signin":
        this.tone(659, 0, 0.12, { type: "triangle" }); this.tone(988, 0.1, 0.35, { type: "triangle" }); break;
    }
  },
};

function setMuted(m) {
  Sound.muted = m;
  localStorage.setItem("a09f.muted", m ? "1" : "0");
  $("btnSound").firstElementChild.textContent = m ? "🔇" : "🔊";
  $("btnSound").lastElementChild.textContent = m ? "Muted" : "Sound";
  $("btnSound").title = "Sounds & Do Not Disturb";
  syncSoundButton();
}

/* Desktop notifications (tauri-plugin-notification). */
async function ensureNotifyPermission() {
  try {
    const granted = await invoke("plugin:notification|is_permission_granted");
    S.notifyOk = granted === true ||
      (granted == null && (await invoke("plugin:notification|request_permission")) === "granted");
  } catch { S.notifyOk = false; }
}

/* Only when the window isn't in front, or the message is for another chat. */
function notify(title, body, convKey) {
  if (!S.notifyOk || isQuiet()) return;
  if (S.focused && (convKey == null || convKey === S.current)) return;
  invoke("plugin:notification|notify", { options: { title, body: body.slice(0, 200) } }).catch(() => {});
}

function mentionsMe(text) {
  if (!S.me) return false;
  const nick = S.me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${nick}($|[^\\w-])`, "i").test(text);
}

/* A live message from someone else arrived (history never gets here). */
function onIncoming(c, m) {
  const key = keyOf(c.name);
  if (m.buzz) { if (c.kind === "pm") receiveBuzz(c, m); return; }
  if (c.kind === "pm") {
    if (!(S.focused && key === S.current)) Sound.play("message");
    notify(`${m.who}`, stripIrc(m.txt), key);
  } else if (c.kind === "room" && mentionsMe(m.txt)) {
    Sound.play("mention");
    notify(`${m.who} in ${roomName(c.name)}`, stripIrc(m.txt), key);
  }
}

function sendBuzz() {
  const c = S.current && conv(S.current);
  if (c?.kind !== "pm") return;
  const wait = BUZZ_COOLDOWN - (Date.now() - (S.lastBuzz || 0));
  if (wait > 0) { sys(`Easy there! You can BUZZ again in ${Math.ceil(wait / 1000)}s.`, "tip"); return; }
  S.lastBuzz = Date.now();
  sendTo(c.name, `\x01ACTION ${BUZZ_TEXT}\x01`);
}

async function receiveBuzz(c, m) {
  if (Date.now() - (S.lastShake || 0) < BUZZ_SHAKE_GAP) return;
  S.lastShake = Date.now();
  Sound.play("buzz");
  notify(`${m.who} buzzed you!`, "BUZZ!!!", null);
  switchTo(c.name);                     // like YM: the buzz opens that chat
  try {
    await appWindow.unminimize();
    await appWindow.show();
    await appWindow.setFocus();
  } catch { /* window control not allowed: the shake below still works */ }
  appWindow.requestUserAttention?.(2).catch?.(() => {});   // bounce the dock icon once
  shakeWindow();
}

/* Shake the real window; fall back to shaking the page if that's not allowed. */
async function shakeWindow() {
  try {
    const start = await appWindow.outerPosition();
    for (const dx of [14, -14, 11, -11, 8, -8, 5, -5, 2, 0]) {
      await appWindow.setPosition(new PhysicalPosition(start.x + dx, start.y + (dx % 3)));
      await new Promise((r) => setTimeout(r, 35));
    }
    await appWindow.setPosition(new PhysicalPosition(start.x, start.y));
  } catch {
    document.body.classList.remove("shake");
    void document.body.offsetWidth;
    document.body.classList.add("shake");
  }
}

function totalUnread() {
  let n = 0;
  for (const c of S.convs.values()) n += c.unread || 0;
  return n;
}

function updateTitle() {
  const n = S.phase === "online" ? totalUnread() : 0;
  const title = n ? `a09f (${n > 99 ? "99+" : n})` : "a09f";
  if (title === S.title) return;
  S.title = title;
  document.title = title;
  appWindow.setTitle(title).catch(() => {});
}

window.addEventListener("focus", () => {
  S.focused = true;
  const c = S.current && conv(S.current);
  if (c && c.unread) markRead(c);
});
window.addEventListener("blur", () => { S.focused = false; });
// Browsers only let audio start after the person interacts with the page.
document.addEventListener("pointerdown", () => { try { Sound.ensure(); } catch {} }, { capture: true });

/* ---------- NickServ account link + rooms you own ---------- */

/* Every a09f account gets a matching NickServ (Atheme) account, so rooms can
 * be owned and nicks protected. The app does it at sign-in because it's the
 * only place that knows the password; soju then logs in by itself via SASL. */
function checkAccountLink() {
  S.link = "checking";
  S.selfAccount = null;
  send(`WHOIS ${S.me}`);
}

function onSelfWhoisDone() {
  // Already identified (soju SASL) — but only counts if it's *our* account.
  if (S.selfAccount && keyOf(S.selfAccount) === keyOf(S.me)) { S.link = "linked"; return; }
  if (S.selfAccount && S.pw && !/\s/.test(S.pw)) {         // logged in as someone else: fix it
    S.link = "identifying";
    send(`PRIVMSG NickServ :IDENTIFY ${S.me} ${S.pw}`);
    return;
  }
  if (!S.pw || /\s/.test(S.pw)) { S.link = "unavailable"; return; }   // Atheme can't take spaces
  S.link = "registering";
  send(`PRIVMSG NickServ :REGISTER ${S.pw} ${S.me.toLowerCase()}@users.a09f.invalid`);
}

function onNickServ(text) {
  const raw = text.replace(/[\x02\x1d\x1f\x0f]/g, "");
  const t = raw.toLowerCase();
  if (S.pwChange?.step === "nickserv") return pwStepNickServ(t);
  if (S.infoReq && onInfoLine(raw)) return;
  if (S.profileSave && onProfileSaveReply(t)) return;
  if (S.link === "registering") {
    if (t.includes("is now registered to")) return linked();
    if (t.includes("is already registered") || t.includes("already registered")) {
      S.link = "identifying";
      send(`PRIVMSG NickServ :IDENTIFY ${S.pw}`);
      return;
    }
    if (t.includes("invalid") || t.includes("too many") || t.includes("cannot")) S.link = "failed";
  } else if (S.link === "identifying") {
    if (t.includes("you are now identified") || t.includes("you are now logged in")) return linked();
    if (t.includes("invalid password") || t.includes("incorrect")) S.link = "failed";
  }
}

function linked() {
  S.link = "linked";
  S.selfAccount = S.me;
  // From now on soju identifies by itself whenever it reconnects.
  send(`PRIVMSG BouncerServ :sasl set-plain ${S.me} ${S.pw}`);
}

/* Register a brand-new room to you with ChanServ, keep it around when empty. */
function claimRoom(c) {
  if (S.link !== "linked") {
    sys(`You created ${roomName(c.name)}. It will disappear when everyone leaves.`, "tip", c.name);
    applyCreateSettings(c, false);
    return;
  }
  S.claiming = c.name;
  serviceQueue([`PRIVMSG ChanServ :REGISTER ${c.name}`]);
}

function onChanServ(text) {
  if (onEntryMsg(text)) return;
  if (onCsReply(text)) return;
  const t = text.toLowerCase();
  const room = S.claiming;
  if (!room) return;
  if (t.includes("is now registered to")) {
    S.claiming = null;
    serviceQueue([`PRIVMSG ChanServ :SET ${room} GUARD ON`, `PRIVMSG ChanServ :SET ${room} KEEPTOPIC ON`]);
    sys(`🎉 You created ${roomName(room)} — it's your room now. It stays even when everyone leaves, ` +
        `and you can change its topic with ✏️ Topic.`, "system", room);
    const rc = conv(keyOf(room));
    if (rc) applyCreateSettings(rc, true);
  } else if (t.includes("too many") || t.includes("maximum")) {
    S.claiming = null;
    sys(`You already own the maximum number of rooms, so ${roomName(room)} will disappear when everyone leaves.`, "tip", room);
    const rc = conv(keyOf(room));
    if (rc) applyCreateSettings(rc, false);
  } else if (t.includes("already registered") || t.includes("must be") || t.includes("not")) {
    S.claiming = null;
  }
}

/* Atheme ignores clients that fire services commands too fast. */
function serviceQueue(lines) {
  S.svcQueue = (S.svcQueue || []).concat(lines);
  if (S.svcTimer) return;
  const next = () => {
    const l = S.svcQueue.shift();
    if (!l) { S.svcTimer = null; return; }
    send(l);
    S.svcTimer = setTimeout(next, 1200);
  };
  next();
}

const amOp = (c) => c?.kind === "room" && /[@~&]/.test(c.members.get(S.me) || "");

function editTopic(c) {
  const t = $("chatTitle");
  t.innerHTML = `${esc(roomName(c.name))} — <input id="topicInput" maxlength="300" placeholder="Room topic">` +
    ` <button id="topicSave" class="title-btn">Save</button> <button id="topicCancel" class="title-btn">Cancel</button>`;
  const inp = $("topicInput");
  inp.value = c.topic || "";
  inp.focus(); inp.select();
  const save = () => { send(`TOPIC ${c.name} :${inp.value.trim()}`); refreshSide(); };
  $("topicSave").onclick = save;
  $("topicCancel").onclick = () => refreshSide();
  inp.onkeydown = (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") refreshSide(); };
}

/* Track +o/-o/+v/-v so owner crowns and the Topic button stay correct. */
function onMode(params, trailing) {
  const [target, modes, ...args] = [...params, ...(trailing != null ? [trailing] : [])];
  const c = isChannel(target) && conv(keyOf(target));
  if (!c || !modes) return;
  let add = true, i = 0;
  for (const m of modes) {
    if (m === "+" || m === "-") { add = m === "+"; continue; }
    // solanum: PREFIX=(ov)@+ ; list modes eIbq ; k always takes an argument,
    // f/j/l only when set. (q is the mute list here, not an "owner" prefix.)
    const sym = { o: "@", v: "+" }[m];
    if (sym) {
      const nick = args[i++];
      if (!nick || !c.members.has(nick)) continue;
      const pre = c.members.get(nick).replace(sym, "");
      c.members.set(nick, add ? sym + pre : pre);
      continue;
    }
    const takesArg = "beIqk".includes(m) || ("fjl".includes(m) && add);
    trackRoomMode(c, add, m, takesArg ? args[i++] : undefined);
  }
  if (keyOf(target) === S.current) { refreshSide(); }
  renderRoomDialog();
}

/* ---------- change password ---------- */

/* The same password lives in three places, changed in this order so a
 * failure part-way never locks the person out:
 *   1. soju (what Sign In checks)        BouncerServ user update -password
 *   2. NickServ, if the account is linked NickServ SET PASSWORD
 *   3. soju's SASL login to NickServ     BouncerServ sasl set-plain
 */
const PW_STEP_TIMEOUT = 10000;

function openPwDialog() {
  $("pwDialog").style.display = "";
  for (const id of ["pwCur", "pwNew", "pwNew2"]) $(id).value = "";
  pwMsg("");
  $("pwCur").focus();
  loadRecoveryEmail();
  loadDevices();
}
function closePwDialog() { if (!S.pwChange) $("pwDialog").style.display = "none"; }
function pwMsg(text, kind = "") { showMsg("pwMsg", text, kind); }

function doChangePassword() {
  const cur = $("pwCur").value, next = $("pwNew").value;
  if (!cur || !next) return pwMsg("Please fill in all the fields.", "error");
  if (cur !== S.pw) return pwMsg("Your current password isn't right.", "error");
  if (next.length < 8) return pwMsg("New password must be at least 8 characters.", "error");
  if (/\s/.test(next)) return pwMsg("New password can't contain spaces.", "error");
  if (next !== $("pwNew2").value) return pwMsg("New passwords don't match.", "error");
  if (next === cur) return pwMsg("That's the same as your current password.", "error");
  S.pwChange = { next, step: "soju" };
  $("pwSave").disabled = true; $("pwSave").textContent = "Saving…";
  pwMsg("Changing your password…");
  pwSend(`PRIVMSG BouncerServ :user update -password ${next}`);
}

function pwSend(line) {
  clearTimeout(S.pwChange.timer);
  const step = S.pwChange.step;
  S.pwChange.timer = setTimeout(() => {
    if (S.pwChange?.step === step) pwFail(step === "soju"
      ? "Couldn't change your password right now. Please try again."
      : "Your password was changed, but a09f couldn't finish updating everything. Please sign out and back in.");
  }, PW_STEP_TIMEOUT);
  send(line);
}

function onBouncerServ(text) {
  const t = text.toLowerCase();
  const pc = S.pwChange;
  if (!pc) return;
  if (pc.step === "soju") {
    if (t.includes("updated user")) {
      S.pw = pc.next;                                 // Sign In now needs the new one
      if (S.link === "linked") { pc.step = "nickserv"; pwSend(`PRIVMSG NickServ :SET PASSWORD ${pc.next}`); }
      else pwDone();
    } else if (/error|invalid|denied|cannot|failed/.test(t)) {
      pwFail("Couldn't change your password right now. Please try again.");
    }
  } else if (pc.step === "sasl") {
    if (t.includes("credentials saved")) pwDone();
    else if (/error|invalid|failed/.test(t)) pwFail("Your password was changed, but auto sign-in to rooms may need a re-login.");
  }
}

function pwStepNickServ(t) {
  const pc = S.pwChange;
  if (t.includes("password") && (t.includes("changed") || t.includes("has been"))) {
    pc.step = "sasl";
    pwSend(`PRIVMSG BouncerServ :sasl set-plain ${S.me} ${pc.next}`);
  } else if (/not logged in|invalid|denied|error/.test(t)) {
    pwFail("Your sign-in password was changed, but your room ownership account wasn't. Please sign out and back in.");
  }
}

function pwDone() {
  clearTimeout(S.pwChange?.timer);
  S.pwChange = null;
  $("pwSave").disabled = false; $("pwSave").textContent = "Change Password";
  $("pwDialog").style.display = "none";
  sys("Your password was changed. Use the new one next time you sign in.", "status");
  if ($("optRemember").checked) invoke("cred_save", { account: S.account, password: S.pw }).catch(() => {});
  socialApi("/session/revoke-others", {}).catch(() => {});     // other devices must sign in again
}

function pwFail(message) {
  clearTimeout(S.pwChange?.timer);
  S.pwChange = null;
  $("pwSave").disabled = false; $("pwSave").textContent = "Change Password";
  pwMsg(message, "error");
}

/* ---------- room browser ---------- */

function openRoomBrowser() {
  loadTrending();
  $("roomBrowser").style.display = "";
  $("rbSearch").value = "";
  refreshRoomList();
  $("rbSearch").focus();
}

function closeRoomBrowser() { $("roomBrowser").style.display = "none"; }

function refreshRoomList() {
  S.listLoading = true;
  renderRoomBrowser();
  // Plain LIST in solanum hides quiet rooms; ">0" (ELIST U) lists every public room.
  send("LIST >0");
}

function renderRoomBrowser() {
  if ($("roomBrowser").style.display === "none") return;
  const el = $("rbList");
  if (S.listLoading && !S.roomList) { el.innerHTML = `<div class="rb-empty">Loading rooms…</div>`; return; }
  const q = $("rbSearch").value.trim().toLowerCase();
  const list = (S.roomList || [])
    .filter((r) => !isPresenceRoom(r.name))
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.topic.toLowerCase().includes(q))
    .filter((r) => !$("rbCat").value || S.roomInfo?.get(keyOf(r.name))?.category === $("rbCat").value)
    .filter((r) => !$("rbLang").value || S.roomInfo?.get(keyOf(r.name))?.lang === $("rbLang").value)
    .sort((a, b) => {
      const da = S.roomTz?.get(keyOf(a.name)), db = S.roomTz?.get(keyOf(b.name));
      const ka = da == null ? 360 : tzDistance(da, myOffset()), kb = db == null ? 360 : tzDistance(db, myOffset());
      return (ka - kb) || b.users - a.users || a.name.localeCompare(b.name);     // nearest first
    });
  loadRoomTz(list.map((r) => r.name));
  loadRoomInfo2((S.roomList || []).map((r) => r.name));
  const today = new Map((S.trending || []).map((t) => [keyOf(t.room), t.msgs]));
  const visible = new Set((S.roomList || []).map((r) => keyOf(r.name)));
  const hot = (S.trending || []).filter((t) => visible.has(keyOf(t.room)) && !isPresenceRoom(t.room));
  el.innerHTML = hot.length ? `<div class="rb-trending">🔥 <b>Trending today:</b> ${hot.map((t) =>
    `<span class="rb-hot" data-room="${esc(t.room)}">${esc(roomName(t.room))} <i>${t.msgs}</i></span>`).join("")}</div>` : "";
  el.querySelectorAll(".rb-hot").forEach((h) => { h.onclick = () => { joinOrSwitch(h.dataset.room); closeRoomBrowser(); }; });
  el.insertAdjacentHTML("beforeend", `<div class="rb-row rb-head"><span>Room</span><span>People</span><span>Topic</span><span></span></div>`);
  if (!list.length) {
    el.insertAdjacentHTML("beforeend", `<div class="rb-empty">${q ? "No rooms match your search." : "No rooms yet — start one below!"}</div>`);
    return;
  }
  for (const r of list) {
    const row = document.createElement("div");
    row.className = "rb-row";
    const joined = conv(keyOf(r.name))?.kind === "room";
    const ri = S.roomInfo?.get(keyOf(r.name));
    row.innerHTML = `<span class="rname" title="${esc(r.name)}">${esc(roomName(r.name))}` +
      (ri ? `<br><small class="rb-tags">${esc(catLabel(ri.category))}${ri.lang ? " · " + esc(langLabel(ri.lang)) : ""}</small>` : "") + `</span>` +
      `<span class="rcount">${r.users} ${r.users === 1 ? "person" : "people"}` +
      (today.get(keyOf(r.name)) ? `<br><small>🔥 ${today.get(keyOf(r.name))} today</small>` : "") +
      (roomTzText(r.name) ? `<br><small class="tz-note">${roomTzText(r.name)}</small>` : "") + `</span>` +
      `<span class="rtopic" title="${esc(r.topic)}">${emote(esc(r.topic)) || "<i>No topic</i>"}</span>` +
      (joined ? `<span class="joined" title="Open this room">✓ Joined</span>` : `<button>Join</button>`);
    const go = () => { joinOrSwitch(r.name); closeRoomBrowser(); };
    row.querySelector("button, .joined").onclick = go;
    row.ondblclick = go;
    el.appendChild(row);
  }
}

/* ---------- conferences (private group chats) ---------- */

/* A conference is a secret, invite-only room (+si) named #conf-<owner>-<code>.
 * It is never registered with ChanServ, so it disappears once everyone has
 * left. Each invitee gets an IRC INVITE (lets them past +i) plus a private
 * "/me invited you to a conference: #room" line, which soju keeps in history,
 * so the invite still reaches people who are signed out. */
const CONF_PREFIX = "#conf-";
const INVITE_TEXT = "invited you to a conference:";
const INVITE_RE = /^invited you to a conference: (#conf-\S+)\s*$/i;
const isConference = (name) => keyOf(name).startsWith(CONF_PREFIX);

function confOwner(name) {
  return (name.slice(CONF_PREFIX.length).match(/^(.+)-[a-z0-9]{4}$/i) || [])[1] || "";
}

function roomLabel(name) {
  if (!isConference(name)) return roomName(name);
  const owner = confOwner(name);
  let label = keyOf(owner) === keyOf(S.me) ? "My conference" : `${owner || "Someone"}'s conference`;
  // Two conferences by the same person: tell them apart by their code.
  const twins = rooms().filter((r) => isConference(r.name) && keyOf(confOwner(r.name)) === keyOf(owner));
  if (twins.length > 1) label += ` (${name.slice(-4)})`;
  return label;
}

/* Everyone in the conference except you (and services). */
const confPeople = (c) => [...c.members.keys()].filter((n) => keyOf(n) !== keyOf(S.me) && !isService(n)).sort();

function openConfDialog(room) {
  S.confFor = room;            // null = start a new one, else invite more to it
  $("cfTitle").textContent = !room ? "Start a Conference"
    : isConference(room.name) ? "Invite to Conference" : `Invite to ${roomName(room.name)}`;
  $("cfStart").textContent = room ? "Send Invites" : "Start Conference";
  $("cfOther").value = "";
  showMsg("cfMsg", "");
  const el = $("cfFriends");
  el.innerHTML = "";
  const here = room ? new Set([...room.members.keys()].map(keyOf)) : new Set();
  const list = S.friends.filter((f) => !here.has(keyOf(f))).sort((a, b) =>
    (STATE_ORDER[statusOf(a).state] - STATE_ORDER[statusOf(b).state]) || a.localeCompare(b));
  for (const nick of list) {
    const st = statusOf(nick);
    const row = document.createElement("label");
    row.className = `st-${st.state}`;
    row.innerHTML = `<input type="checkbox" value="${esc(nick)}"><span class="st"></span>` +
      `<span>${esc(nick)}</span><span class="status-text">${esc(st.label)}</span>`;
    el.appendChild(row);
  }
  if (!list.length) {
    el.innerHTML = `<div class="empty-hint">${S.friends.length ? "All your friends are already here." :
      "No friends yet. Type someone's ID below, or add friends with 👥 Add Friend."}</div>`;
  }
  $("confDialog").style.display = "";
  (el.querySelector("input") || $("cfOther")).focus();
}

function closeConfDialog() { $("confDialog").style.display = "none"; S.confFor = null; }

function doConference() {
  const picked = [...$("cfFriends").querySelectorAll("input:checked")].map((i) => i.value);
  // Several IDs may be typed at once: "carol, dave eve"
  const others = $("cfOther").value.split(/[\s,;]+/).filter(Boolean);
  const bad = others.filter((o) => !/^[a-z][a-z0-9_-]{2,15}$/i.test(o));
  if (bad.length) return showMsg("cfMsg", `"${bad[0]}" doesn't look like an a09f ID.`, "error");
  if (others.some((o) => keyOf(o) === keyOf(S.me))) return showMsg("cfMsg", "You don't need to invite yourself!", "error");
  for (const o of others) if (!picked.some((p) => keyOf(p) === keyOf(o))) picked.push(o);
  if (!picked.length) return showMsg("cfMsg", "Pick at least one person to invite.", "error");
  const room = S.confFor;
  closeConfDialog();
  if (room) { inviteToRoom(room, picked); return; }
  const code = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const name = `${CONF_PREFIX}${S.me.toLowerCase()}-${code}`;
  S.pendingConf = { key: keyOf(name), invitees: picked };
  joinRoom(name);
}

/* We just created the room (and are its op): lock it down, then invite. */
function startConference(c, invitees) {
  send(`MODE ${c.name} +si`);
  sys("You started a conference. Only the people you invite can join.", "system", c.name);
  inviteToConference(c, invitees);
}

function inviteToConference(c, nicks) {
  const seen = new Set();
  const list = nicks.filter((n) => {
    const k = keyOf(n);
    if (seen.has(k) || k === keyOf(S.me) || c.members.has(n)) return false;
    seen.add(k);
    return true;
  });
  if (!list.length) return;
  for (const nick of list) {
    send(`INVITE ${nick} ${c.name}`);
    send(`PRIVMSG ${nick} :\x01ACTION ${INVITE_TEXT} ${c.name}\x01`);
  }
  sys(`Invite sent to ${list.join(", ")}.`, "system", c.name);
}

/* Joined a conference nobody was in any more: we'd only be reviving an empty
 * room, so leave it again and say so. */
function endedConference(c) {
  (S.confEnded ||= new Set()).add(keyOf(c.name));
  send(`PART ${c.name} :Conference ended`);
}

/* ---------- profiles (NickServ properties) ---------- */

/* Profiles are Atheme account metadata: SET PROPERTY <key> <value> to write,
 * INFO <nick> ("Metadata : key = value") for anyone to read. */
const PROFILE_FIELDS = { name: "pfName", location: "pfLocation", about: "pfAbout" };
const INFO_TIMEOUT = 8000;

function openProfile(nick) {
  if (!nick) return;
  const mine = keyOf(nick) === keyOf(S.me);
  S.profileNick = nick;
  const st = statusOf(nick);
  $("pfTitle").textContent = mine ? "My Profile" : `${nick}'s Profile`;
  $("pfNick").textContent = nick;
  $("pfStatus").textContent = (st.state === "unknown" ? "" : st.label) + (localTimeText(nick) ? `  ·  ${localTimeText(nick)}` : "");
  $("pfDot").className = `pf-dot st-${st.state}`;
  $("pfView").style.display = mine ? "none" : "";
  $("pfEdit").style.display = mine ? "" : "none";
  if (mine) { buildColorPicker(); tzOf(S.me); syncActiveUi(); }
  $("pfNick").style.color = nameColor(nick) || "";
  $("pfAddFriend").style.display = mine || isFriend(nick) ? "none" : "";
  $("pfNote").value = S.notes?.get(keyOf(nick)) || "";
  for (const id of ["pfvName", "pfvLocation", "pfvAbout", "pfvSince"]) $(id).textContent = "…";
  for (const id of Object.values(PROFILE_FIELDS)) { $(id).value = ""; $(id).disabled = true; }
  $("pfSave").disabled = true;
  showMsg("pfMsg", "Loading…");
  $("profileDialog").style.display = "";
  requestPresence([nick]);
  requestInfo(nick, (info) => showProfile(nick, info));
}

function closeProfile() {
  if (S.profileSave) return;          // let the save finish
  $("profileDialog").style.display = "none";
  S.profileNick = null;
}

function showProfile(nick, info) {
  if (keyOf(S.profileNick) !== keyOf(nick)) return;     // dialog moved on
  const mine = keyOf(nick) === keyOf(S.me);
  if (!info) { showMsg("pfMsg", "Couldn't load this profile right now. Please try again.", "error"); return; }
  const p = info.props;
  if (mine) {
    S.myProfile = { name: p.name || "", location: p.location || "", about: p.about || "" };
    for (const [k, id] of Object.entries(PROFILE_FIELDS)) { $(id).value = S.myProfile[k]; $(id).disabled = false; }
    $("pfSave").disabled = false;
    showMsg("pfMsg", S.link === "linked" ? "" : "Your profile can't be saved right now. Please sign out and back in.",
            S.link === "linked" ? "" : "error");
    $("pfName").focus();
    return;
  }
  const show = (id, v) => { $(id).innerHTML = v ? emote(esc(v)) : "<i>Not set</i>"; };
  show("pfvName", p.name); show("pfvLocation", p.location); show("pfvAbout", p.about);
  $("pfvSince").innerHTML = info.since ? esc(info.since) : "<i>Unknown</i>";
  showMsg("pfMsg", info.registered ? "" : `${nick} hasn't set up a profile yet.`);
}

/* One INFO at a time; a newer request replaces an older one. */
function requestInfo(nick, cb) {
  clearTimeout(S.infoReq?.timer);
  S.infoReq = { nick, cb, started: false, registered: true, since: "", props: {} };
  S.infoReq.timer = setTimeout(() => finishInfo(false), INFO_TIMEOUT);
  send(`PRIVMSG NickServ :INFO ${nick}`);
}

function finishInfo(ok) {
  const r = S.infoReq;
  if (!r) return;
  clearTimeout(r.timer);
  S.infoReq = null;
  r.cb(ok ? r : null);
}

/* Returns true when the NickServ line belonged to the pending INFO. */
function onInfoLine(t) {
  const r = S.infoReq;
  let m;
  if (/^Information on \S+/i.test(t)) { r.started = true; return true; }
  if (!r.started && (m = t.match(/^(\S+) is not registered/i)) && keyOf(m[1]) === keyOf(r.nick)) {
    r.registered = false; finishInfo(true); return true;
  }
  if (!r.started) return false;
  if (/\*\*\* End of Info \*\*\*/i.test(t)) { finishInfo(true); return true; }
  if ((m = t.match(/^Registered\s*:\s*(\w{3}) (\d+) [\d:]+ (\d{4})/))) r.since = `${m[1]} ${m[2]}, ${m[3]}`;
  else if ((m = t.match(/^Metadata\s*:\s*(\S+) = (.*)$/))) r.props[m[1].toLowerCase()] = m[2];
  return true;                       // other INFO lines (flags, last seen, …) are swallowed
}

const cleanField = (v) => v.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();

function saveProfile() {
  if (!S.myProfile) return;
  if (S.link !== "linked") {
    showMsg("pfMsg", "Your profile can't be saved right now. Please sign out and back in.", "error"); return;
  }
  const next = {};
  for (const [k, id] of Object.entries(PROFILE_FIELDS)) next[k] = cleanField($(id).value);
  const changed = Object.keys(next).filter((k) => next[k] !== S.myProfile[k]);
  if (!changed.length) { closeProfile(); return; }
  // Empty value = remove the property.
  const lines = changed.map((k) => `PRIVMSG NickServ :SET PROPERTY ${k}${next[k] ? " " + next[k] : ""}`);
  S.profileSave = { pending: changed.length, next };
  S.profileSave.timer = setTimeout(() => profileSaveDone(false), 5000 + 1200 * lines.length);
  $("pfSave").disabled = true; $("pfSave").textContent = "Saving…";
  showMsg("pfMsg", "");
  serviceQueue(lines);
}

function onProfileSaveReply(t) {
  if (/metadata entry \S+ (added|has been deleted|was not set)/.test(t)) {
    if (--S.profileSave.pending <= 0) profileSaveDone(true);
    return true;
  }
  if (/too many|invalid|cannot|denied|not logged in|you are not/.test(t)) { profileSaveDone(false); return true; }
  return false;
}

function profileSaveDone(ok) {
  const ps = S.profileSave;
  if (!ps) return;
  clearTimeout(ps.timer);
  S.profileSave = null;
  $("pfSave").disabled = false; $("pfSave").textContent = "Save Profile";
  if (!ok) { showMsg("pfMsg", "Couldn't save your profile right now. Please try again.", "error"); return; }
  S.myProfile = ps.next;
  closeProfile();
  sys("Your profile was saved.", "status");
  socialApi("/profile/updated", {}).catch(() => {});
}

function profileButton(nick) {
  const b = document.createElement("span");
  b.className = "profile-btn";
  b.textContent = "👤";
  b.title = keyOf(nick) === keyOf(S.me) ? "Edit your profile" : `See ${nick}'s profile`;
  b.onclick = (e) => { e.stopPropagation(); openProfile(nick); };
  return b;
}

/* ---------- privacy: ignore list, "only friends can message me" ---------- */

/* Both settings live in the account service (follow you to any computer).
 * Ignoring is done here in the app: their messages are simply not shown.
 * "Only friends" uses solanum's caller-id: user mode +g, with every friend on
 * the ACCEPT list; the server then drops anyone else's private messages. */
const isIgnored = (nick) => S.prefs.ignore.some((i) => keyOf(i) === keyOf(nick));

async function loadPrefs() {
  try {
    const p = await socialApi("/prefs");
    S.prefs = { ignore: p.ignore || [], friendsOnly: !!p.friendsOnly };
  } catch { return; }
  applyFriendsOnly();
  renderLists(); renderLog();
}

async function savePrefs(patch) {
  const p = await socialApi("/prefs", patch);
  S.prefs = { ignore: p.ignore || [], friendsOnly: !!p.friendsOnly };
  return S.prefs;
}

async function ignoreUser(nick, on) {
  const list = on ? [...S.prefs.ignore, nick] : S.prefs.ignore.filter((i) => keyOf(i) !== keyOf(nick));
  try {
    await savePrefs({ ignore: list });
    sys(on ? `You're ignoring ${nick}. You won't see their messages.` : `You're no longer ignoring ${nick}.`, "system");
    renderLists(); renderLog(); refreshSide(); renderPrivacy();
  } catch (e) { sys(e.message, "error"); }
}

/* Keep +g and the ACCEPT list in line with the setting and the friends list. */
function applyFriendsOnly() {
  if (S.phase !== "online" || !S.me) return;
  if (!S.prefs.friendsOnly) {
    // null = unknown: the bouncer may still be +g from an earlier session.
    if (S.callerId !== false) { send(`MODE ${S.me} -g`); S.callerId = false; }
    return;
  }
  const want = new Set(S.friends.map(keyOf));
  const have = S.accepted || new Set();
  const add = [...want].filter((n) => !have.has(n));
  const drop = [...have].filter((n) => !want.has(n));
  for (let i = 0; i < add.length; i += 10) send(`ACCEPT ${add.slice(i, i + 10).join(",")}`);
  for (let i = 0; i < drop.length; i += 10) send(`ACCEPT ${drop.slice(i, i + 10).map((n) => "-" + n).join(",")}`);
  S.accepted = want;
  if (!S.callerId) { send(`MODE ${S.me} +g`); S.callerId = true; }
}

function openPrivacy() {
  $("privacyDialog").style.display = "";
  $("pvFriendsOnly").checked = S.prefs.friendsOnly;
  showMsg("pvMsg", "");
  renderPrivacy();
}
function closePrivacy() { $("privacyDialog").style.display = "none"; }

function renderPrivacy() {
  if ($("privacyDialog").style.display === "none") return;
  const el = $("pvIgnored");
  el.innerHTML = "";
  if (!S.prefs.ignore.length) { el.innerHTML = `<div class="empty-hint">You're not ignoring anyone.</div>`; return; }
  for (const nick of S.prefs.ignore) {
    const row = document.createElement("div");
    row.className = "pv-row";
    row.innerHTML = `<span>🚫 ${esc(nick)}</span><button>Unignore</button>`;
    row.querySelector("button").onclick = () => ignoreUser(nick, false);
    el.appendChild(row);
  }
}

async function onFriendsOnlyToggle() {
  const on = $("pvFriendsOnly").checked;
  try {
    await savePrefs({ friendsOnly: on });
    applyFriendsOnly();
    showMsg("pvMsg", on ? "Only your friends can send you private messages now." :
      "Anyone can send you private messages now.", "ok");
  } catch (e) {
    $("pvFriendsOnly").checked = !on;
    showMsg("pvMsg", e.message, "error");
  }
}

/* 716: they only take messages from friends. 718: someone was blocked by our +g. */
function onCallerId(num, params) {
  const nick = params[1];
  if (num === 716) {
    sysError(`${nick} only accepts messages from friends. Send them a friend request first.`);
  } else if (num === 718 && !isIgnored(nick)) {
    S.blockedTold ||= new Set();
    if (S.blockedTold.has(keyOf(nick))) return;
    S.blockedTold.add(keyOf(nick));
    sys(`${nick} tried to message you, but only friends can message you (🔒 Privacy).`, "tip");
  }
}

/* Right-click menu for people in rooms / private chats. */
function personMenu(e, nick) {
  if (keyOf(nick) === keyOf(S.me)) return;
  showMenu(e, [
    { label: "💬 Send Message", run: () => openPm(nick) },
    { label: "👤 View Profile", run: () => openProfile(nick) },
    ...(isFriend(nick) || isPendingFriend(nick) ? [] : [{ label: "➕ Add Friend", run: () => addFriend(nick) }]),
    "-",
    isIgnored(nick)
      ? { label: "✅ Unignore", run: () => ignoreUser(nick, false) }
      : { label: "🚫 Ignore", danger: true, run: () => ignoreUser(nick, true) },
    ...(S.current && isChannel(S.current) ? moderatorItems(conv(S.current), nick) : []),
  ]);
}

/* ---------- text style (bold / italic / underline / color) ---------- */

/* Sent as standard IRC formatting codes, so other IRC clients show them too.
 * Like classic messengers, the style applies to everything you send. */
const IRC_COLORS = ["#ffffff", "#000000", "#00007f", "#009300", "#ff0000", "#7f0000", "#9c009c", "#fc7f00",
  "#ffff00", "#00fc00", "#009393", "#00ffff", "#0000fc", "#ff00ff", "#7f7f7f", "#d2d2d2"];
const PICKER_COLORS = [1, 2, 3, 4, 5, 6, 7, 10, 12, 13, 14];     // readable on white

function loadStyle() {
  try { S.style = { b: false, i: false, u: false, color: null, ...JSON.parse(localStorage.getItem("a09f.style")) }; }
  catch { S.style = { b: false, i: false, u: false, color: null }; }
  syncStyleUi();
}

function setStyle(patch) {
  S.style = { ...S.style, ...patch };
  localStorage.setItem("a09f.style", JSON.stringify(S.style));
  syncStyleUi();
}

function syncStyleUi() {
  const st = S.style;
  $("fmtB").classList.toggle("on", st.b);
  $("fmtI").classList.toggle("on", st.i);
  $("fmtU").classList.toggle("on", st.u);
  $("fmtColor").style.background = st.color == null ? "#000" : IRC_COLORS[st.color];
  const inp = $("input").style;
  inp.fontWeight = st.b ? "bold" : ""; inp.fontStyle = st.i ? "italic" : "";
  inp.textDecoration = st.u ? "underline" : ""; inp.color = st.color == null ? "" : IRC_COLORS[st.color];
}

function styled(text) {
  const st = S.style;
  let pre = "";
  if (st.color != null) pre += "\x03" + String(st.color).padStart(2, "0");
  if (st.b) pre += "\x02";
  if (st.i) pre += "\x1d";
  if (st.u) pre += "\x1f";
  return pre ? pre + text + "\x0f" : text;
}

function colorMenu(e) {
  const m = $("ctxMenu");
  m.innerHTML = `<div class="menu-title">Text color</div><div class="swatches"></div>`;
  const sw = m.querySelector(".swatches");
  const add = (code, title) => {
    const b = document.createElement("span");
    b.className = "swatch" + (S.style.color === code ? " on" : "");
    b.style.background = code == null ? "#000" : IRC_COLORS[code];
    b.title = title;
    b.onclick = (ev) => { ev.stopPropagation(); setStyle({ color: code }); hideMenu(); $("input").focus(); };
    sw.appendChild(b);
  };
  add(null, "Default");
  for (const c of PICKER_COLORS) add(c, "");
  m.style.display = "block";
  placeMenu(m, e);
}

function placeMenu(m, e) {
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 6) + "px";
  m.style.top = Math.max(6, Math.min(e.clientY - r.height - 8, innerHeight - r.height - 6)) + "px";
}

/* IRC formatting codes -> HTML. Input is already HTML-escaped (codes are
 * control characters, which esc() leaves alone). Colors use classes so the
 * smiley replacement never sees a ":" inside a style attribute. */
function formatIrc(html) {
  if (!/[\x02\x03\x0f\x16\x1d\x1e\x1f]/.test(html)) return html;
  let out = "", st = { b: 0, i: 0, u: 0, s: 0, fg: null, bg: null }, open = false, pending = false;
  const close = () => { if (open) { out += "</span>"; open = false; } };
  const openSpan = () => {
    const cls = [st.b && "f-b", st.i && "f-i", st.u && "f-u", st.s && "f-s",
      st.fg != null && `f-c${st.fg}`, st.bg != null && `f-bg${st.bg}`].filter(Boolean);
    if (cls.length) { out += `<span class="${cls.join(" ")}">`; open = true; }
  };
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if ("\x02\x1d\x1f\x1e\x0f\x16\x03".includes(ch)) {
      close();
      if (ch === "\x02") st.b ^= 1;
      else if (ch === "\x1d") st.i ^= 1;
      else if (ch === "\x1f") st.u ^= 1;
      else if (ch === "\x1e") st.s ^= 1;
      else if (ch === "\x0f") st = { b: 0, i: 0, u: 0, s: 0, fg: null, bg: null };
      else if (ch === "\x03") {
        const m = html.slice(i + 1).match(/^(\d{1,2})(?:,(\d{1,2}))?/);
        if (m) { st.fg = +m[1] % 16; if (m[2] != null) st.bg = +m[2] % 16; i += m[0].length; }
        else { st.fg = null; st.bg = null; }
      }
      pending = true;
    } else {
      if (pending) { openSpan(); pending = false; }
      out += ch;
    }
  }
  close();
  return out;
}

const stripIrc = (t) => (t || "").replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, "").replace(/[\x02\x0f\x16\x1d\x1e\x1f]/g, "");

/* ---------- smiley picker ---------- */

const SMILEYS = ["🙂", "😁", "😂", "🤣", "😉", "😊", "😍", "😘", "😎", "🤔", "😴", "😜", "🙁", "😢", "😭", "😡",
  "😱", "🤗", "🙄", "😇", "🥳", "👍", "👎", "👏", "🙏", "💪", "❤️", "💔", "🌹", "☕", "🍕", "🎉", "🔥", "⭐", "💯", "👋"];

function smileyMenu(e) {
  const m = $("ctxMenu");
  m.innerHTML = `<div class="smileys"></div>`;
  const box = m.querySelector(".smileys");
  for (const s of SMILEYS) {
    const b = document.createElement("span");
    b.textContent = s;
    b.onclick = (ev) => { ev.stopPropagation(); insertEmote(s); hideMenu(); };
    box.appendChild(b);
  }
  m.style.display = "block";
  placeMenu(m, e);
}

/* ---------- find people ---------- */

function openFind() {
  $("findDialog").style.display = "";
  $("fdQuery").value = "";
  $("fdResults").innerHTML = `<div class="empty-hint">Type part of an a09f ID to search.</div>`;
  $("fdQuery").focus();
  loadSuggestions();
}
function closeFind() { $("findDialog").style.display = "none"; }

async function doFind() {
  const q = $("fdQuery").value.trim();
  const el = $("fdResults");
  if (q.length < 2) { el.innerHTML = `<div class="empty-hint">Type at least 2 letters.</div>`; return; }
  el.innerHTML = `<div class="empty-hint">Searching…</div>`;
  try {
    const { users, tz } = await socialApi(`/users/search?q=${encodeURIComponent(q)}`);
    S.tz ||= new Map();
    S.active ||= new Map();
    for (const [u, v] of Object.entries(tz || {})) { S.tz.set(u, v.offset); if (v.active) S.active.set(u, v.active); }
    S.findResults = users;                       // already nearest timezone first
    requestPresence(users);
    renderFind();
  } catch (e) { el.innerHTML = `<div class="empty-hint">${esc(e.message)}</div>`; }
}

function renderFind() {
  if ($("findDialog").style.display === "none" || !S.findResults) return;
  const el = $("fdResults");
  el.innerHTML = "";
  if (!S.findResults.length) { el.innerHTML = `<div class="empty-hint">No one found with that ID.</div>`; return; }
  for (const nick of S.findResults) {
    const st = statusOf(nick);
    const row = document.createElement("div");
    row.className = `fd-row st-${st.state}`;
    const rel = isFriend(nick) ? `<span class="fd-tag">✓ Friend</span>`
      : isPendingFriend(nick) ? `<span class="fd-tag">Request sent</span>`
      : `<button class="fd-add">➕ Add Friend</button>`;
    const lt = localTimeText(nick);
    row.innerHTML = `<span class="st"></span><b>${esc(nick)}</b><span class="status-text">${esc(st.label)}` +
      (lt ? `<br><small class="tz-note">${esc(lt)}</small>` : "") + `</span>` +
      `<button class="fd-prof">Profile</button><button class="fd-msg">Message</button>${rel}`;
    row.querySelector(".fd-prof").onclick = () => openProfile(nick);
    row.querySelector(".fd-msg").onclick = () => { closeFind(); openPm(nick); };
    row.querySelector(".fd-add")?.addEventListener("click", async () => { await addFriend(nick); renderFind(); });
    el.appendChild(row);
  }
}

/* ---------- message archive: older messages + search ---------- */

const OLDER_PAGE = 100;

/* A message people actually sent (not a local join/leave line or a notice). */
const isConvMsg = (m) => isRealMsg(m) && !m.local;

function loadOlder(c, limit = OLDER_PAGE) {
  if (!c || c.loadingOlder || c.noMore || !has("draft/chathistory")) return;
  const oldest = c.msgs.find(isConvMsg);
  if (!oldest) { c.noMore = true; renderLog(); return; }
  c.loadingOlder = true;
  c.olderBefore = c.msgs.length;
  c.olderFrom = oldest.time;
  c.olderLimit = limit;
  S.olderFor = keyOf(c.name);
  send(`CHATHISTORY BEFORE ${c.name} timestamp=${new Date(oldest.time).toISOString()} ${limit}`);
}

/* Called after a chathistory batch: was it a "load older" page? */
function onOlderBatch(target, count) {
  const c = conv(keyOf(target));
  if (!c?.loadingOlder) return false;
  c.loadingOlder = false;
  if (count < (c.olderLimit || OLDER_PAGE)) c.noMore = true;
  const real = c.msgs.filter(isConvMsg);
  if (count && real.length && c.olderFrom) loadMeta(c, { from: real[0].time, to: c.olderFrom - 1, merge: true });
  if (keyOf(c.name) === S.current && !S.silentOlder) {
    // Keep the message at the top of the view where it was (pages are added
    // above it, and the window may drop messages below it).
    const top = logEl.getBoundingClientRect().top;
    const anchor = [...logEl.querySelectorAll(".msg[data-key]")].find((e) => e.getBoundingClientRect().bottom > top);
    const delta = anchor ? anchor.getBoundingClientRect().top - top : 0;
    renderLog();
    const again = anchor && logEl.querySelector(`.msg[data-key="${CSS.escape(anchor.dataset.key)}"]`);
    if (again) logEl.scrollTop += again.getBoundingClientRect().top - logEl.getBoundingClientRect().top - delta;
  }
  return true;
}

function olderLink(c) {
  if (!c || c.kind === "status" || !c.historyDone || !has("draft/chathistory")) return null;
  const d = document.createElement("div");
  d.className = "older";
  if (!c.msgs.some(isConvMsg)) {
    d.classList.add("empty");
    d.textContent = c.kind === "pm" ? `No messages yet — say hi to ${c.name}! 👋`
      : "No messages yet — say hi and start the conversation! 👋";
    return d;
  }
  if (c.noMore) { d.textContent = "— Start of conversation —"; return d; }
  d.innerHTML = `<a>${c.loadingOlder ? "Loading…" : "⬆ Load older messages"}</a>`;
  d.querySelector("a").onclick = () => { loadOlder(c); d.querySelector("a").textContent = "Loading…"; };
  return d;
}

function openSearch() {
  if (!has("soju.im/search")) { sys("Message search isn't available on this server.", "error"); return; }
  const c = S.current && conv(S.current);
  $("searchDialog").style.display = "";
  const sel = $("srIn");
  sel.innerHTML = "";
  sel.add(new Option("All conversations", ""));
  for (const x of [...rooms(), ...pms().filter((p) => !isIgnored(p.name))]) {
    sel.add(new Option(x.kind === "room" ? roomLabel(x.name) : `Chat with ${x.name}`, x.name, false,
      c && keyOf(x.name) === keyOf(c.name)));
  }
  $("srResults").innerHTML = `<div class="empty-hint">Search the messages a09f has kept for you.</div>`;
  $("srQuery").focus(); $("srQuery").select();
}
function closeSearch() { $("searchDialog").style.display = "none"; }

function doSearch() {
  const q = $("srQuery").value.trim();
  if (!q) { $("srQuery").focus(); return; }
  // Attributes use message-tag escaping (soju parses them like tags).
  const attrs = [`text=${escapeTag(q)}`, "limit=100"];
  const where = $("srIn").value;
  if (where) attrs.unshift(`in=${where}`);
  S.searching = true;
  $("srResults").innerHTML = `<div class="empty-hint">Searching…</div>`;
  send(`SEARCH ${attrs.join(";")}`);
}

function onSearchBatch(lines) {
  S.searching = false;
  const el = $("srResults");
  el.innerHTML = "";
  const hits = lines.filter((l) => l.cmd === "PRIVMSG" || l.cmd === "NOTICE")
    .map((l) => { const from = nickOf(l.prefix); return { from, target: convTarget(l.params[0], from), m: msgFrom(l, from) }; })
    .filter((h) => !isIgnored(h.from) && !isPresenceRoom(h.target))
    .sort((a, b) => b.m.time - a.m.time);
  if (!hits.length) { el.innerHTML = `<div class="empty-hint">No messages found.</div>`; return; }
  for (const h of hits) {
    const row = document.createElement("div");
    row.className = "sr-row";
    const where = isChannel(h.target) ? roomLabel(h.target) : `Chat with ${h.target}`;
    const d = new Date(h.m.time);
    row.innerHTML = `<div class="sr-meta">${esc(d.toLocaleDateString())} ${esc(fmtTime(h.m.time))} · ${esc(where)}</div>` +
      `<div><b>${esc(h.from)}:</b> ${emote(formatIrc(esc(h.m.txt)))}</div>`;
    row.onclick = () => {
      closeSearch();
      const c = { kind: isChannel(h.target) ? "room" : "pm", name: h.target };
      jumpToMessage(h.target, msgKeyStr(msgKeyParts(c, h.m)));
    };
    el.appendChild(row);
  }
}

function escapeTag(v) {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\:").replace(/ /g, "\\s").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

/* ---------- live updates: "Seen", profile changes ---------- */

/* They read our private chat up to `time` (ms). */
function onSeen(from, time) {
  const c = conv(keyOf(from));
  if (c?.kind !== "pm") return;
  c.seenAt = Math.max(c.seenAt || 0, time);
  if (keyOf(c.name) === S.current) renderSeen();
}

/* "✓ Seen" under my last message, when it's the newest and they've read it. */
function renderSeen() {
  logEl.querySelector(".seen")?.remove();
  const c = S.current && conv(S.current);
  const last = c && c.msgs.filter((m) => m.others || m.cls.includes("me")).at(-1);
  if (!last || last.others) return;
  const d = document.createElement("div");
  d.className = "seen";
  if (c.kind === "room") {                                  // "Seen by bob, diana"
    const who = roomSeenBy(c, last);
    if (!who.length) return;
    d.textContent = who.length <= 3 ? `👁 Seen by ${who.join(", ")}` : `👁 Seen by ${who.length}`;
    d.title = who.join(", ");
  } else {
    if (c?.kind !== "pm" || !c.seenAt || last.time > c.seenAt) return;
    d.textContent = `✓ Seen ${fmtTime(c.seenAt)}`;
  }
  const stick = nearBottom();
  logEl.appendChild(d);
  if (!S.bulkRender && stick) logEl.scrollTop = logEl.scrollHeight;
}

/* Someone (or I, on another device) saved a profile: refresh what's open. */
function onProfileUpdated(nick, sid) {
  if ($("profileDialog").style.display === "none" || keyOf(S.profileNick) !== keyOf(nick)) return;
  const mine = keyOf(nick) === keyOf(S.me);
  if (mine && (sid === S.sid || S.profileSave)) return;      // our own save, or mid-edit save
  requestInfo(nick, (info) => showProfile(nick, info));
}

/* Status shown in an open profile follows presence changes. */
function refreshProfileStatus() {
  if ($("profileDialog").style.display === "none" || !S.profileNick) return;
  const st = statusOf(S.profileNick);
  $("pfStatus").textContent = st.state === "unknown" ? "" : st.label;
  $("pfDot").className = `pf-dot st-${st.state}`;
}

/* ---------- @mentions ---------- */

/* "@nick" in a message: shown as a chip (bold purple), or highlighted when
 * it's you. Runs on already-escaped HTML, outside of tags. */
function highlightMentions(html) {
  return html.replace(/(^|[\s(>])@([A-Za-z][A-Za-z0-9_\-\[\]\\`^{|}]{0,29})/g, (all, pre, nick) =>
    `${pre}<span class="mention${keyOf(nick) === keyOf(S.me) ? " me" : ""}">@${nick}</span>`);
}

/* Typing "@al" in a room pops up matching members; Tab/Enter/click completes. */
function mentionQuery() {
  const inp = $("input");
  const before = inp.value.slice(0, inp.selectionStart);
  const m = before.match(/(^|\s)@([^\s@]*)$/);
  return m ? { q: m[2], start: before.length - m[2].length - 1 } : null;
}

function updateMentionBox() {
  const c = S.current && conv(S.current);
  const mq = c?.kind === "room" && mentionQuery();
  if (!mq) return hideMentionBox();
  const q = mq.q.toLowerCase();
  const people = [...c.members.keys()]
    .filter((n) => !isService(n) && keyOf(n) !== keyOf(S.me) && n.toLowerCase().startsWith(q))
    .sort((a, b) => a.localeCompare(b)).slice(0, 8);
  if (!people.length) return hideMentionBox();
  S.mention = { ...mq, people, sel: Math.min(S.mention?.sel || 0, people.length - 1) };
  renderMentionBox();
}

function renderMentionBox() {
  const box = $("mentionBox");
  box.innerHTML = "";
  S.mention.people.forEach((nick, i) => {
    const st = statusOf(nick);
    const d = document.createElement("div");
    d.className = `mention-opt st-${st.state}` + (i === S.mention.sel ? " sel" : "");
    d.innerHTML = `<span class="st"></span>@${esc(nick)}`;
    d.onmousedown = (e) => { e.preventDefault(); completeMention(nick); };
    box.appendChild(d);
  });
  box.style.display = "block";
}

function hideMentionBox() { $("mentionBox").style.display = "none"; S.mention = null; }

function completeMention(nick) {
  const inp = $("input"), m = S.mention;
  if (!m) return;
  const after = inp.value.slice(inp.selectionStart).replace(/^\S*/, "");
  inp.value = inp.value.slice(0, m.start) + "@" + nick + " " + after.replace(/^\s/, "");
  const pos = m.start + nick.length + 2;
  inp.setSelectionRange(pos, pos);
  hideMentionBox();
  inp.focus();
}

/* Returns true when the key was used by the popup. */
function onMentionKey(e) {
  if (!S.mention || $("mentionBox").style.display === "none") return false;
  const n = S.mention.people.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    S.mention.sel = (S.mention.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    renderMentionBox();
  } else if (e.key === "Tab" || e.key === "Enter") {
    completeMention(S.mention.people[S.mention.sel]);
  } else if (e.key === "Escape") {
    hideMentionBox();
  } else return false;
  e.preventDefault();
  return true;
}

/* ---------- room management: moderation, settings, owner tools ---------- */

/* Everyone reaches solanum through soju from one IP, so bans and mutes must
 * never use the host: they target the account ($a:<id>, extb_account) and the
 * nick (<id>!*@*, for people not logged in to NickServ). In a09f the ID, the
 * nick and the NickServ account are the same word. */
const personMasks = (nick) => [`$a:${nick}`, `${nick}!*@*`];
const maskNick = (mask) => (mask.match(/^\$a:(.+)$/) || mask.match(/^([^!]+)!\*@\*$/) || [])[1] || null;

/* Channel modes we show as settings. */
const ROOM_FLAGS = { i: "Private", s: "Hidden", m: "Announcement" };

function roomState(c) {
  c.modes ||= new Set();
  c.bans ||= new Set();
  c.quiets ||= new Set();
  return c;
}

const isMuted = (c, nick) => [...(c?.quiets || [])].some((m) => keyOf(maskNick(m)) === keyOf(nick));
const isBanned = (c, nick) => [...(c?.bans || [])].some((m) => keyOf(maskNick(m)) === keyOf(nick));

/* 324: current modes, e.g. "+ntikl" "secret" "5". */
function onChannelModes(params) {
  const c = conv(keyOf(params[1]));
  if (!c) return;
  roomState(c);
  c.modes.clear(); c.key = ""; c.limit = 0;
  const args = params.slice(3);
  for (const m of (params[2] || "").replace(/^\+/, "")) {
    c.modes.add(m);
    if (m === "k") c.key = args.shift() || "";
    else if (m === "l") c.limit = +args.shift() || 0;
    else if ("fj".includes(m)) args.shift();
  }
  renderRoomDialog();
}

/* After joining a room: learn its modes, bans and mutes. */
function loadRoomState(c) {
  roomState(c);
  c.banBuf = new Set(); c.quietBuf = new Set();
  send(`MODE ${c.name}`);
  send(`MODE ${c.name} b`);
  send(`MODE ${c.name} q`);
}

function onListEntry(num, params) {
  const c = conv(keyOf(params[1]));
  if (!c) return;
  roomState(c);
  if (num === 367) (c.banBuf ||= new Set()).add(params[2]);
  else if (num === 368) { c.bans = c.banBuf || new Set(); c.banBuf = null; }
  else if (num === 728) (c.quietBuf ||= new Set()).add(params[3]);
  else if (num === 729) { c.quiets = c.quietBuf || new Set(); c.quietBuf = null; }
  if (num === 368 || num === 729) { if (keyOf(c.name) === S.current) renderUsers(); renderRoomDialog(); }
}

/* Mode changes that matter for settings and the lists (called from onMode). */
function trackRoomMode(c, add, m, arg) {
  roomState(c);
  if (m in ROOM_FLAGS || "nt".includes(m)) add ? c.modes.add(m) : c.modes.delete(m);
  else if (m === "k") { add ? c.modes.add("k") : c.modes.delete("k"); c.key = add ? arg || "" : ""; }
  else if (m === "l") { add ? c.modes.add("l") : c.modes.delete("l"); c.limit = add ? +arg || 0 : 0; }
  else if (m === "b" && arg) add ? c.bans.add(arg) : c.bans.delete(arg);
  else if (m === "q" && arg) add ? c.quiets.add(arg) : c.quiets.delete(arg);
}

/* ----- people: kick, ban, mute, moderators ----- */

function kickUser(c, nick) {
  send(`KICK ${c.name} ${nick} :Removed by ${S.me}`);
}

function banUser(c, nick) {
  send(`MODE ${c.name} +bb ${personMasks(nick).join(" ")}`);
  if (c.members.has(nick)) send(`KICK ${c.name} ${nick} :Banned by ${S.me}`);
  sys(`${nick} is banned from ${roomName(c.name)}.`, "system", c.name);
}

function unbanUser(c, nick) {
  const masks = [...c.bans].filter((m) => keyOf(maskNick(m)) === keyOf(nick));
  if (masks.length) send(`MODE ${c.name} -${"b".repeat(masks.length)} ${masks.join(" ")}`);
  sys(`${nick} can join ${roomName(c.name)} again.`, "system", c.name);
}

function muteUser(c, nick, on) {
  const masks = on ? personMasks(nick) : [...c.quiets].filter((m) => keyOf(maskNick(m)) === keyOf(nick));
  if (!masks.length) return;
  send(`MODE ${c.name} ${on ? "+" : "-"}${"q".repeat(masks.length)} ${masks.join(" ")}`);
  sys(on ? `${nick} is muted in ${roomName(c.name)}.` : `${nick} can talk again in ${roomName(c.name)}.`, "system", c.name);
}

/* Moderator = op. In a registered room it's also saved with ChanServ (AOP),
 * so it sticks when they leave and come back. */
async function setModerator(c, nick, on) {
  send(`MODE ${c.name} ${on ? "+o" : "-o"} ${nick}`);
  if (c.registered) {
    await csAsk(`FLAGS ${c.name} ${nick} ${on ? "AOP" : "-*"}`, /were set on|not authorized|not registered/i);
    if ($("roomDialog").style.display !== "none") loadRoomInfo(c);
  }
  sys(on ? `${nick} is now a moderator of ${roomName(c.name)}. 👑` : `${nick} is no longer a moderator.`, "system", c.name);
}

/* Extra menu items for moderators, added to the right-click menu in rooms. */
function moderatorItems(c, nick) {
  if (!amOp(c) || keyOf(nick) === keyOf(S.me)) return [];
  const isMod = /[@~&]/.test(c.members.get(nick) || "");
  return [
    "-",
    isMod ? { label: "👑 Remove moderator", run: () => setModerator(c, nick, false) }
          : { label: "👑 Make moderator", run: () => setModerator(c, nick, true) },
    isMuted(c, nick) ? { label: "🔊 Unmute", run: () => muteUser(c, nick, false) }
                     : { label: "🔇 Mute", run: () => muteUser(c, nick, true) },
    { label: "👢 Remove from room", danger: true, run: () => kickUser(c, nick) },
    { label: "⛔ Ban from room", danger: true, run: () => banUser(c, nick) },
  ];
}

/* KICK: say what happened; if it was us, the room is gone from our list. */
function onKick(by, channel, nick, reason) {
  const key = keyOf(channel);
  const c = conv(key);
  if (!c) return;
  if (keyOf(nick) === keyOf(S.me)) {
    S.convs.delete(key);
    if (S.current === key) { S.current = null; switchTo(rooms().at(-1)?.name || null); renderLog(); }
    sys(`${by} removed you from ${roomName(channel)}.`, "error");
    refreshSide();
    return;
  }
  c.members.delete(nick);
  addMsg(channel, { who: nick, txt: `was removed by ${by}`, cls: "action", local: true });
  refreshSide();
}

/* ----- ChanServ questions (INFO, FLAGS, …) with collected replies ----- */

/* Sends one ChanServ command (through the paced queue) and resolves with the
 * NOTICE lines it answers with, up to a line matching `endRe` or a quiet gap. */
function csAsk(command, endRe, timeout = 6000) {
  const run = () => new Promise((resolve) => {
    const req = { lines: [], endRe, resolve };
    const finish = () => { clearTimeout(req.timer); clearTimeout(req.quiet); if (S.csReq === req) S.csReq = null; resolve(req.lines); };
    req.finish = finish;
    req.timer = setTimeout(finish, timeout);
    S.csReq = req;
    serviceQueue([`PRIVMSG ChanServ :${command}`]);
  });
  S.csChain = (S.csChain || Promise.resolve()).then(run, run);
  return S.csChain;
}

/* Returns true when the line belonged to a pending csAsk. */
function onCsReply(text) {
  const req = S.csReq;
  if (!req) return false;
  const t = text.replace(/[\x02\x1d\x1f\x0f]/g, "");
  req.lines.push(t);
  clearTimeout(req.quiet);
  if (req.endRe.test(t)) req.finish();
  else req.quiet = setTimeout(req.finish, 1500);
  return true;
}

/* ChanServ "[#room] message" when you join a room with a welcome message. */
function onEntryMsg(text) {
  const m = text.replace(/[\x02\x1d\x1f\x0f]/g, "").match(/^\[([#&]\S+)\] (.*)$/);
  if (!m) return false;
  addMsg(m[1], { who: "Welcome", txt: m[2], cls: "service welcome" });
  return true;
}

/* ----- room settings dialog ----- */

async function loadRoomInfo(c) {
  c.infoLoaded = false;
  const info = await csAsk(`INFO ${c.name}`, /end of info|is not registered|not registered/i);
  const notReg = info.some((l) => /is not registered/i.test(l));
  c.registered = !notReg && info.some((l) => /^Founder\s*:/i.test(l));
  const f = info.find((l) => /^Founder\s*:/i.test(l));
  c.founders = f ? f.replace(/^Founder\s*:\s*/i, "").split(/,\s*/).map((x) => x.trim()) : [];
  const em = info.find((l) => /^Entrymsg\s*:/i.test(l));
  c.entryMsg = em ? em.replace(/^Entrymsg\s*:\s*/i, "") : "";
  c.mods = null;
  if (c.registered) {
    const lines = await csAsk(`FLAGS ${c.name}`, /end of .* flags listing|not authorized/i);
    c.mods = lines.map((l) => l.match(/^\d+\s+(\S+)\s+\+(\S+)/)).filter(Boolean)
      .filter((m) => /o/i.test(m[2])).map((m) => ({ nick: m[1], founder: m[2].includes("F") }));
  }
  c.infoLoaded = true;
  renderRoomDialog();
}

const amFounder = (c) => c.registered && c.founders?.some((f) => keyOf(f) === keyOf(S.me));

function openRoomDialog(c) {
  loadRoomInfo2([c.name]);
  S.roomDialogFor = keyOf(c.name);
  roomState(c);
  $("rdTitle").textContent = `${roomName(c.name)} — Room Settings`;
  showMsg("rdMsg", "");
  $("rdDelete").dataset.armed = "";
  $("rdDelete").textContent = "Delete this room…";
  $("roomDialog").style.display = "";
  send(`MODE ${c.name}`); send(`MODE ${c.name} b`); send(`MODE ${c.name} q`);
  fillRoomForm(c);
  $("rdOwner").style.display = "none";
  $("rdMods").innerHTML = `<div class="empty-hint">Loading…</div>`;
  c.infoLoaded = false;
  $("rdSave").disabled = true; $("rdSave").textContent = "Loading…";
  loadRoomInfo(c);
}

function closeRoomDialog() { $("roomDialog").style.display = "none"; S.roomDialogFor = null; }

function fillRoomForm(c) {
  $("rdPrivate").checked = c.modes.has("i");
  $("rdHidden").checked = c.modes.has("s");
  $("rdAnnounce").checked = c.modes.has("m");
  $("rdKey").value = c.key || "";
  $("rdLimit").value = c.limit || "";
}

function renderRoomDialog() {
  const c = S.roomDialogFor && conv(S.roomDialogFor);
  if (!c || $("roomDialog").style.display === "none") return;
  if (!S.roomFormDirty) fillRoomForm(c);
  // Welcome message + moderators come from ChanServ (registered rooms only).
  $("rdWelcomeBox").style.display = c.registered ? "" : "none";
  if (document.activeElement !== $("rdWelcome")) $("rdWelcome").value = c.entryMsg || "";
  const mods = $("rdMods");
  mods.innerHTML = "";
  const list = c.registered && c.mods ? c.mods
    : [...c.members.entries()].filter(([, p]) => /[@~&]/.test(p)).map(([n]) => ({ nick: n, founder: false }))
        .filter((m) => !isService(m.nick));
  if (!list.length) mods.innerHTML = `<div class="empty-hint">No moderators.</div>`;
  for (const m of list) {
    const row = document.createElement("div");
    row.className = "pv-row";
    row.innerHTML = `<span>👑 ${esc(m.nick)}${m.founder ? " <i>(owner)</i>" : ""}</span>` +
      (m.founder || keyOf(m.nick) === keyOf(S.me) ? "" : `<button>Remove</button>`);
    row.querySelector("button")?.addEventListener("click", () => setModerator(c, m.nick, false));
    mods.appendChild(row);
  }
  const people = (set) => [...new Set([...set].map(maskNick).filter(Boolean))];
  const fill = (el, names, label, undo) => {
    el.innerHTML = names.length ? "" : `<div class="empty-hint">Nobody.</div>`;
    for (const n of names) {
      const row = document.createElement("div");
      row.className = "pv-row";
      row.innerHTML = `<span>${esc(n)}</span><button>${label}</button>`;
      row.querySelector("button").onclick = () => undo(n);
      el.appendChild(row);
    }
  };
  fill($("rdBans"), people(c.bans), "Unban", (n) => unbanUser(c, n));
  fill($("rdMutes"), people(c.quiets), "Unmute", (n) => muteUser(c, n, false));
  $("rdOwner").style.display = amFounder(c) ? "" : "none";
  const ri = S.roomInfo?.get(keyOf(c.name));
  if (document.activeElement !== $("rdCategory")) $("rdCategory").value = ri?.category || "general";
  if (document.activeElement !== $("rdLang")) $("rdLang").value = ri?.lang || "";
  // Owner vs moderator decides how settings are saved: wait for ChanServ.
  $("rdSave").disabled = !c.infoLoaded;
  $("rdSave").textContent = c.infoLoaded ? "Save Settings" : "Loading…";
  $("rdRegHint").style.display = c.registered ? "none" : "";
}

async function saveRoomSettings() {
  const c = S.roomDialogFor && conv(S.roomDialogFor);
  if (!c || !c.infoLoaded) return;
  const want = { i: $("rdPrivate").checked, s: $("rdHidden").checked, m: $("rdAnnounce").checked };
  const key = $("rdKey").value.trim().replace(/\s+/g, "");
  const limit = parseInt($("rdLimit").value, 10) || 0;
  // Registered rooms: ChanServ's MLOCK (default +nt-lk) decides, and the owner
  // sets it. That also keeps the settings when the room is empty.
  if (amFounder(c)) {
    const on = "nt" + Object.keys(want).filter((m) => want[m]).join("") + (key ? "k" : "") + (limit > 0 ? "l" : "");
    const off = Object.keys(want).filter((m) => !want[m]).join("") + (key ? "" : "k") + (limit > 0 ? "" : "l");
    const args = [key, limit > 0 ? String(limit) : ""].filter(Boolean);
    const r = await csAsk(`SET ${c.name} MLOCK +${on}-${off}${args.length ? " " + args.join(" ") : ""}`,
      /mlock for|not authorized|invalid/i);
    S.roomFormDirty = false;
    const ok = r.some((l) => /mlock for/i.test(l));
    showMsg("rdMsg", ok ? "Saved." : "Couldn't save the settings right now.", ok ? "ok" : "error");
    setTimeout(() => send(`MODE ${c.name}`), 1500);
    return;
  }
  if (c.registered && (key !== (c.key || "") || limit !== (c.limit || 0))) {
    showMsg("rdMsg", "Only the room's owner can set a password or a people limit.", "error");
    return;
  }
  let plus = "", minus = "", args = [];
  for (const [m, on] of Object.entries(want)) {
    if (on && !c.modes.has(m)) plus += m;
    if (!on && c.modes.has(m)) minus += m;
  }
  if (key !== (c.key || "")) {
    if (c.modes.has("k")) { minus += "k"; }
    if (key) { plus += "k"; args.push(key); }
  }
  if (limit !== (c.limit || 0)) {
    if (limit > 0) { plus += "l"; args.push(String(limit)); } else minus += "l";
  }
  // "-k" needs the old key as its argument on most servers.
  const minusArgs = minus.includes("k") ? [c.key || "*"] : [];
  if (minus) send(`MODE ${c.name} -${minus} ${minusArgs.join(" ")}`.trim());
  if (plus) send(`MODE ${c.name} +${plus} ${args.join(" ")}`.trim());
  S.roomFormDirty = false;
  showMsg("rdMsg", plus || minus ? "Saved." : "Nothing changed.", "ok");
}

async function saveWelcome() {
  const c = S.roomDialogFor && conv(S.roomDialogFor);
  if (!c?.registered) return;
  const text = cleanField($("rdWelcome").value);
  const lines = await csAsk(`SET ${c.name} ENTRYMSG${text ? " " + text : ""}`, /entry message|not authorized|denied/i);
  const ok = lines.some((l) => /entry message/i.test(l));
  c.entryMsg = ok ? text : c.entryMsg;
  showMsg("rdMsg", ok ? (text ? "Welcome message saved." : "Welcome message removed.")
    : "Only the room owner can change the welcome message.", ok ? "ok" : "error");
}

/* Hand the room to someone else: they become founder, then we step down. */
async function giveRoom() {
  const c = S.roomDialogFor && conv(S.roomDialogFor);
  const to = $("rdGiveTo").value.trim().toLowerCase();
  if (!c || !amFounder(c)) return;
  if (!/^[a-z][a-z0-9_-]{2,15}$/.test(to) || keyOf(to) === keyOf(S.me)) {
    showMsg("rdMsg", "Type the a09f ID of the new owner.", "error"); return;
  }
  showMsg("rdMsg", `Giving ${roomName(c.name)} to ${to}…`);
  const r = await csAsk(`FLAGS ${c.name} ${to} +F`, /were set on|not registered|not authorized|too many/i);
  if (!r.some((l) => /were set on/i.test(l))) {
    const why = r.find((l) => /not registered/i.test(l)) ? `${to} needs to sign in to a09f once before they can own a room.`
      : r.find((l) => /too many/i.test(l)) ? `${to} already owns the maximum number of rooms.`
      : "Couldn't give the room away right now.";
    showMsg("rdMsg", why, "error");
    return;
  }
  await csAsk(`FLAGS ${c.name} ${S.me} -F`, /were set on|not authorized/i);
  sys(`${to} is now the owner of ${roomName(c.name)}.`, "system", c.name);
  $("rdGiveTo").value = "";
  loadRoomInfo(c);
}

/* Unregister the room (ChanServ DROP, which asks for a confirmation key). */
async function deleteRoom() {
  const c = S.roomDialogFor && conv(S.roomDialogFor);
  const btn = $("rdDelete");
  if (!c || !amFounder(c)) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = "Click again to delete it for good";
    return;
  }
  btn.dataset.armed = ""; btn.textContent = "Deleting…";
  const r = await csAsk(`DROP ${c.name}`, /drop \S+ \S+|has been dropped|not authorized/i);
  const key = r.join(" ").match(/DROP\s+\S+\s+([0-9a-f:]+)/i)?.[1];
  const done = key ? await csAsk(`DROP ${c.name} ${key}`, /has been dropped|invalid|not authorized/i) : r;
  btn.textContent = "Delete this room…";
  if (done.some((l) => /has been dropped/i.test(l))) {
    closeRoomDialog();
    sys(`${roomName(c.name)} isn't yours any more: it will disappear once everyone leaves.`, "system", c.name);
  } else {
    showMsg("rdMsg", "Couldn't delete the room right now.", "error");
  }
}

/* ----- invites to normal rooms, and "ask to join" (KNOCK) ----- */

const ROOM_INVITE_TEXT = "invited you to a room:";
const ROOM_INVITE_RE = /^invited you to a room: ([#&]\S+)\s*$/i;

function inviteToRoom(c, nicks) {
  if (isConference(c.name)) { inviteToConference(c, nicks); return; }
  const list = [...new Set(nicks.map(keyOf))].filter((n) => n !== keyOf(S.me) && !c.members.has(n));
  if (!list.length) return;
  for (const nick of list) {
    send(`INVITE ${nick} ${c.name}`);
    send(`PRIVMSG ${nick} :\x01ACTION ${ROOM_INVITE_TEXT} ${c.name}\x01`);
  }
  sys(`Invite sent to ${list.join(", ")}.`, "system", c.name);
}

/* 473 on a normal room: offer to knock. */
function offerKnock(channel) {
  addMsg(null, { who: "Error", txt: `${roomName(channel)} is private.`, cls: "error", knock: channel });
}

function knock(channel) {
  send(`KNOCK ${channel} :${S.me} would like to join`);
}

/* 710 (to moderators): someone knocked. */
function onKnock(params) {
  const channel = params[1];
  const who = nickOf(params[2] || "");
  if (!who || !conv(keyOf(channel))) return;
  addMsg(channel, { who: "System", txt: `${who} asked to join this room.`, cls: "service", letIn: who });
  Sound.play("buzz");
  notify(`${who} asked to join ${roomName(channel)}`, "", keyOf(channel));
}

function letIn(channel, nick) {
  const c = conv(keyOf(channel));
  if (c) inviteToRoom(c, [nick]);
}

/* ---------- auto-reply: tell senders when the other person is away ---------- */

function autoReply(target) {
  const c = conv(keyOf(target));
  if (!c || c.kind !== "pm") return;
  const st = statusOf(target);
  if (!["busy", "away", "offline", "custom"].includes(st.state)) { c.autoReplied = null; return; }
  const sig = st.state + "|" + st.label;
  if (c.autoReplied === sig) return;            // once per status
  c.autoReplied = sig;
  const text = st.state === "offline"
    ? `${target} is offline right now. They'll get your message when they sign in.`
    : st.state === "custom"
    ? `${target}'s status says: “${st.label}”.`
    : `${target} is ${st.label === "Busy" || st.label === "Be Right Back" || st.label === "Stepped Out" ? `“${st.label}”` : `away: “${st.label}”`}. ` +
      `They'll see your message when they're back.`;
  addMsg(target, { who: "Auto-reply", txt: text, cls: "service autoreply" });
}

/* ---------- deleting your own messages ---------- */

/* soju gives us no msgid to REDACT with, so a message is identified by
 * sender + where it was sent + server time (solanum stamps every copy with
 * the same time) + a hash of its text. The account service keeps the list
 * of deleted messages, so they stay hidden in everyone's history too. */
function msgHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/* Where a message was sent, as the sender saw it: the room, or the person. */
function msgTarget(c, m) {
  if (c.kind === "room") return keyOf(c.name);
  return keyOf(m.others ? S.me : c.name);
}

const redactKey = (sender, target, time, hash) => `${keyOf(sender)}|${keyOf(target)}|${time}|${hash}`;

function isRedacted(c, m) {
  if (!S.redactions?.size || !m.time || m.cls.includes("service")) return false;
  return S.redactions.has(msgKeyOf(c, m));
}

async function loadRedactions() {
  try {
    const since = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const { redactions } = await socialApi(`/redactions?since=${since}`);
    for (const r of redactions) S.redactions.add(redactKey(r.sender, r.target, r.time, r.hash));
    renderLog();
  } catch { /* not critical */ }
}

function onRedact(r) {
  S.redactions.add(redactKey(r.sender, r.target, r.time, r.hash));
  renderLog();
}

async function deleteMessage(m) {
  const c = S.current && conv(S.current);
  if (!c || m.others) return;
  try {
    await socialApi("/redact", { target: msgTarget(c, m), time: m.time, hash: msgHash(m.rawTxt ?? m.txt) });
  } catch (e) { sys(e.message, "error"); }
}

/* ---------- announcements from a09f admins ---------- */

const annSeenKey = () => `a09f.annSeen.${S.account}`;

async function loadAnnouncements() {
  try {
    const after = +localStorage.getItem(annSeenKey()) || 0;
    const { announcements } = await socialApi(`/announcements?after=${after}`);
    if (announcements.length) showAnnouncement(announcements.at(-1));
  } catch { /* not critical */ }
}

function showAnnouncement(a, live = false) {
  S.announcement = a;
  $("annText").innerHTML = emote(esc(a.text));
  $("annMeta").textContent = `— ${a.author}, ${new Date(a.created * 1000).toLocaleString()}`;
  $("annBar").style.display = "";
  if (live) {
    Sound.play("buzz");
    notify("📢 a09f announcement", a.text, null);
  }
}

function dismissAnnouncement() {
  if (S.announcement) localStorage.setItem(annSeenKey(), String(S.announcement.id));
  $("annBar").style.display = "none";
  S.announcement = null;
}

function openAnnounce() {
  $("annDialog").style.display = "";
  $("anText").value = "";
  showMsg("anMsg", "");
  $("anText").focus();
}
function closeAnnounce() { $("annDialog").style.display = "none"; }

async function sendAnnouncement() {
  const text = $("anText").value.trim();
  if (!text) { $("anText").focus(); return; }
  $("anSend").disabled = true;
  try {
    await socialApi("/announce", { text });
    closeAnnounce();
    sys("Your announcement was sent to everyone.", "system");
  } catch (e) {
    showMsg("anMsg", e.message, "error");
  } finally { $("anSend").disabled = false; }
}

/* ---------- people online (with a09f open) ---------- */

function setOnlineCount(n) {
  S.onlineCount = n;
  $("onlineCount").textContent = n ? `👥 ${n} online` : "";
}

async function loadStats() {
  try { setOnlineCount((await socialApi("/stats")).online); } catch {}
}

/* ---------- message extras: reactions, replies, edits, pins, polls ---------- */

/* A message's identity (shared with deletes): sender, where it was sent,
 * server time, hash of its original text. */
function msgKeyParts(c, m) {
  return { sender: keyOf(m.who), target: msgTarget(c, m), time: m.time, hash: msgHash(m.rawTxt ?? m.txt) };
}
const msgKeyStr = (k) => redactKey(k.sender, k.target, k.time, k.hash);
/* msgKeyStr(msgKeyParts(c, m)), computed once per message (hashing the text
 * for every message on every redraw adds up in long conversations). */
function msgKeyOf(c, m) {
  if (m._key && m._keyConv === c.name) return m._key;
  m._keyConv = c.name;
  return (m._key = msgKeyStr(msgKeyParts(c, m)));
}

/* The conversation a meta event belongs to, from this user's point of view. */
function metaConv(target, sender) {
  if (isChannel(target)) return keyOf(target);
  return keyOf(sender) === keyOf(S.me) ? keyOf(target) : keyOf(sender);
}

const isRealMsg = (m) => m.time && !m.buzz && !m.invite && !m.knock && !m.letIn && !m.askKey &&
  !m.cls.includes("service") && !m.cls.includes("error") && !m.cls.includes("tip") && !m.cls.includes("status");

function metaFor(convKey) {
  S.meta ||= new Map();
  if (!S.meta.has(convKey)) S.meta.set(convKey, { reactions: new Map(), edits: new Map(), expiring: new Map(), pins: [], loaded: false });
  return S.meta.get(convKey);
}

/* Reactions / edits / expiries for the messages we hold (a time range), not
 * the whole conversation. `merge` adds a range (an older page) to what we
 * have; otherwise it replaces it. Pins are per room and always fetched. */
async function loadMeta(c, { from = null, to = null, merge = false } = {}) {
  if (!c || c.kind === "status" || !S.token) return;
  const key = keyOf(c.name);
  const real = c.msgs.filter(isConvMsg);
  if (from == null) from = real.length ? real[0].time : Date.now();
  if (to == null && c.hasNewer && real.length) to = real.at(-1).time;
  try {
    const d = await socialApi(`/msgmeta?conv=${encodeURIComponent(c.name)}&from=${from}` + (to != null ? `&to=${to}` : ""));
    const meta = metaFor(key);
    if (!merge) { meta.reactions.clear(); meta.edits.clear(); meta.expiring.clear(); }
    for (const r of d.reactions) addReaction(meta, r, true);
    for (const e of d.edits) meta.edits.set(msgKeyStr(e), e.text);
    for (const x of d.expiring || []) meta.expiring.set(msgKeyStr(x), x.due);
    meta.pins = d.pins || [];
    meta.loaded = true;
    if (S.current === key && !S.silentOlder) { renderLog(); renderPins(); }
  } catch { /* not critical */ }
}

function addReaction(meta, r, on) {
  const k = msgKeyStr(r);
  if (!meta.reactions.has(k)) meta.reactions.set(k, new Map());
  const byEmoji = meta.reactions.get(k);
  if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, new Set());
  const users = byEmoji.get(r.emoji);
  on ? users.add(keyOf(r.user)) : users.delete(keyOf(r.user));
  if (!users.size) byEmoji.delete(r.emoji);
}

function onReactionEvent(r) {
  const ck = metaConv(r.target, r.sender);
  addReaction(metaFor(ck), r, r.on);
  if (S.current === ck) renderLog();
}

function onEditEvent(e) {
  const ck = metaConv(e.target, e.sender);
  metaFor(ck).edits.set(msgKeyStr(e), e.text);
  if (S.current === ck) renderLog();
}

function toggleReaction(c, m, emoji) {
  const k = msgKeyParts(c, m);
  const users = metaFor(keyOf(c.name)).reactions.get(msgKeyStr(k))?.get(emoji);
  const on = !users?.has(keyOf(S.me));
  socialApi("/react", { ...k, emoji, on }).catch((e) => sys(e.message, "error"));
}

const REACTION_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "🔥"];

function reactMenu(e, c, m) {
  const box = $("ctxMenu");
  box.innerHTML = `<div class="smileys react-pick"></div>`;
  for (const emo of REACTION_EMOJI) {
    const b = document.createElement("span");
    b.textContent = emo;
    b.onclick = (ev) => { ev.stopPropagation(); hideMenu(); toggleReaction(c, m, emo); };
    box.firstChild.appendChild(b);
  }
  box.style.display = "block";
  placeMenu(box, e);
}

/* ----- the little toolbar on each message ----- */

function messageTools(div, c, m) {
  const mine = !m.others;
  const bar = document.createElement("span");
  bar.className = "mtools";
  const add = (label, title, fn) => {
    const b = document.createElement("span");
    b.textContent = label; b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(e, b); };
    bar.appendChild(b);
  };
  add("😀", "React", (e) => reactMenu(e, c, m));
  add("↩", "Reply", () => startReply(m));
  add(isSaved(c, m) ? "★" : "⭐", isSaved(c, m) ? "Remove from Saved" : "Save this message", () => toggleSave(c, m));
  if (mine) add("✏️", "Edit", () => startEdit(c, m));
  if (c.kind === "room" && amOp(c)) add("📌", "Pin to the top of the room", () => pinMessage(c, m, true));
  if (mine) add("🗑", "Delete for everyone", (e, b) => {
    if (b.dataset.armed) { b.textContent = "…"; deleteMessage(m); return; }
    b.dataset.armed = "1"; b.textContent = "Delete?"; b.classList.add("armed");
    setTimeout(() => { if (b.isConnected) { b.dataset.armed = ""; b.textContent = "🗑"; b.classList.remove("armed"); } }, 4000);
  });
  div.appendChild(bar);
}

function reactionChips(div, c, m) {
  const byEmoji = metaFor(keyOf(c.name)).reactions.get(msgKeyOf(c, m));
  if (!byEmoji?.size) return;
  const row = document.createElement("div");
  row.className = "reactions";
  for (const [emoji, users] of byEmoji) {
    const chip = document.createElement("span");
    chip.className = "rchip" + (users.has(keyOf(S.me)) ? " mine" : "");
    chip.textContent = `${emoji} ${users.size}`;
    chip.title = [...users].join(", ");
    chip.onclick = () => toggleReaction(c, m, emoji);
    row.appendChild(chip);
  }
  div.appendChild(row);
}

/* ----- replies: "↪ bob: “quoted text” my answer" (plain text on IRC) ----- */

const REPLY_RE = /^↪ (\S+): “([^”]*)” ?([\s\S]*)$/;

function startReply(m) {
  S.editing = null;
  const own = stripIrc(m.txt).replace(REPLY_RE, "$3");          // a reply's own words, not its quote
  S.replyTo = { who: m.who, txt: own.slice(0, 60) + (own.length > 60 ? "…" : "") };
  showComposerBar(`↩ Replying to <b>${esc(m.who)}</b>: “${esc(S.replyTo.txt)}”`);
  $("input").focus();
}

function startEdit(c, m) {
  S.replyTo = null;
  S.editing = { c, m };
  const current = metaFor(keyOf(c.name)).edits.get(msgKeyStr(msgKeyParts(c, m))) ?? m.txt;
  showComposerBar("✏️ Editing your message — Enter to save, Esc to cancel");
  $("input").value = stripIrc(current);
  $("input").focus();
}

function showComposerBar(html) {
  $("composerBarText").innerHTML = html;
  $("composerBar").style.display = "";
}

function clearComposerBar() {
  S.replyTo = null; S.editing = null;
  $("composerBar").style.display = "none";
}

/* Wrap an outgoing message as a reply when one is pending. */
function withReply(text) {
  if (!S.replyTo) return text;
  const r = S.replyTo;
  clearComposerBar();
  return `↪ ${r.who}: “${r.txt.replace(/”/g, "\"")}” ${text}`;
}

async function saveEdit(text) {
  const { c, m } = S.editing;
  clearComposerBar();
  if (!text || text === stripIrc(m.txt)) return;
  try { await socialApi("/edit", { ...msgKeyParts(c, m), text }); }
  catch (e) { sys(e.message, "error"); }
}

/* ----- pinned messages (rooms) ----- */

async function pinMessage(c, m, on) {
  try {
    await socialApi("/pin", { room: keyOf(c.name), ...msgKeyParts(c, m), text: stripIrc(m.txt).slice(0, 300), on });
  } catch (e) { sys(e.message, "error"); }
}

async function unpin(c, p) {
  try {
    await socialApi("/pin", { room: keyOf(c.name), sender: p.sender, target: keyOf(c.name), time: p.time, hash: p.hash, on: false });
  } catch (e) { sys(e.message, "error"); }
}

function renderPins() {
  const el = $("pinBar");
  const c = S.current && conv(S.current);
  const pins = c?.kind === "room" ? metaFor(keyOf(c.name)).pins : [];
  if (!pins.length) { el.style.display = "none"; return; }
  el.innerHTML = "";
  for (const p of pins) {
    const row = document.createElement("div");
    row.className = "pin";
    row.innerHTML = `📌 <b>${esc(p.sender)}:</b> <span>${emote(esc(p.text))}</span>`;
    if (amOp(c)) {
      const x = document.createElement("span");
      x.className = "pin-x"; x.textContent = "✕"; x.title = "Unpin";
      x.onclick = () => unpin(c, p);
      row.appendChild(x);
    }
    el.appendChild(row);
  }
  el.style.display = "";
}

/* ----- polls: "/poll Question | A | B" in a room ----- */

const POLL_RE = /\[poll:(\d+)\]/;

async function createPoll(c, spec) {
  const parts = spec.split("|").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 3) { sys("Write it like: /poll Where to eat? | Bakso | Sate | Pizza", "tip"); return; }
  try {
    const { id } = await socialApi("/poll/create", { room: keyOf(c.name), question: parts[0], options: parts.slice(1) });
    sendTo(c.name, `📊 Poll: ${parts[0]} — ${parts.slice(1).join(" / ")} (vote in a09f) [poll:${id}]`);
  } catch (e) { sys(e.message, "error"); }
}

async function loadPoll(id) {
  S.polls ||= new Map();
  try {
    S.polls.set(id, await socialApi(`/poll?id=${id}`));
    document.querySelectorAll(`.poll[data-poll="${id}"]`).forEach((el) => fillPoll(el, id));
  } catch { S.polls.set(id, { error: true }); }
}

function pollCard(id) {
  const el = document.createElement("div");
  el.className = "poll";
  el.dataset.poll = id;
  if (S.polls?.has(id)) fillPoll(el, id); else { el.textContent = "📊 Loading poll…"; loadPoll(id); }
  return el;
}

function fillPoll(el, id) {
  const p = S.polls.get(id);
  if (!p || p.error) { el.textContent = "📊 This poll isn't available."; return; }
  const total = p.counts.reduce((a, b) => a + b, 0);
  el.innerHTML = `<div class="poll-q">📊 ${esc(p.question)}</div>`;
  p.options.forEach((opt, i) => {
    const pct = total ? Math.round((p.counts[i] / total) * 100) : 0;
    const row = document.createElement("div");
    row.className = "poll-opt" + (p.mine === i ? " mine" : "");
    row.title = p.voters[i].join(", ") || "No votes yet";
    row.innerHTML = `<span class="poll-bar" style="width:${pct}%"></span>` +
      `<span class="poll-label">${p.mine === i ? "✓ " : ""}${esc(opt)}</span><span class="poll-n">${p.counts[i]}</span>`;
    row.onclick = () => socialApi("/poll/vote", { id, option: p.mine === i ? null : i }).catch((e) => sys(e.message, "error"));
    el.appendChild(row);
  });
  el.insertAdjacentHTML("beforeend", `<div class="poll-foot">${total} vote${total === 1 ? "" : "s"} · click to vote, again to undo</div>`);
}

/* ---------- last seen ---------- */

async function loadLastSeen() {
  if (!S.friends.length || !S.token) return;
  try {
    const { lastSeen } = await socialApi(`/lastseen?users=${S.friends.map(encodeURIComponent).join(",")}`);
    S.lastSeen = new Map(Object.entries(lastSeen).filter(([, t]) => t && t !== "now"));
    renderFriends();
  } catch {}
}

function agoText(sec) {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 30 * 86400) return `${Math.floor(d / 86400)}d ago`;
  return new Date(sec * 1000).toLocaleDateString();
}

/* ---------- reminders: "/remind 10m drink water" ---------- */

async function addReminder(spec) {
  const m = spec.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s+(.+)$/i);
  if (!m) { sys("Write it like: /remind 10m drink water  (m = minutes, h = hours, d = days)", "tip"); return; }
  const n = parseFloat(m[1]), unit = m[2][0].toLowerCase();
  const minutes = unit === "m" ? n : unit === "h" ? n * 60 : n * 1440;
  try {
    const r = await socialApi("/remind", { text: m[3], minutes });
    sys(`⏰ OK! I'll remind you ${new Date(r.due * 1000).toLocaleString()}: “${r.text}”`, "system");
  } catch (e) { sys(e.message, "error"); }
}

function showReminder(r) {
  sys(`⏰ Reminder: ${r.text}`, "tip");
  Sound.play("buzz");
  notify("⏰ Reminder", r.text, null);
}

async function loadDueReminders() {
  try { for (const r of (await socialApi("/reminders/due")).reminders) showReminder(r); } catch {}
}

/* ---------- custom name colors ---------- */

/* Each person may pick a color for their name (👤 Profile). Same palette as
 * the account service accepts: all readable on the white chat background. */
const NAME_COLORS = ["#c0392b", "#d35400", "#b7950b", "#27ae60", "#16a085", "#2980b9",
  "#1f3a93", "#8e44ad", "#c2185b", "#6d4c41", "#546e7a", "#000000"];

/* The color for a nick, or null for the default. Unknown nicks are fetched
 * in one batch a moment later, then everything re-renders. */
function nameColor(nick) {
  if (!nick || isService(nick)) return null;
  const key = keyOf(nick);
  S.nameColors ||= new Map();
  if (S.nameColors.has(key)) return S.nameColors.get(key);
  if (S.token) {
    (S.colorQueue ||= new Set()).add(key);
    clearTimeout(S.colorTimer);
    S.colorTimer = setTimeout(fetchNameColors, 250);
  }
  return null;
}

async function fetchNameColors() {
  const users = [...(S.colorQueue || [])];
  S.colorQueue = new Set();
  if (!users.length || !S.token) return;
  for (const u of users) S.nameColors.set(u, null);          // don't ask twice
  try {
    const { colors } = await socialApi(`/namecolors?users=${users.map(encodeURIComponent).join(",")}`);
    let changed = false;
    for (const [u, c] of Object.entries(colors)) { S.nameColors.set(u, c); changed = true; }
    if (changed) repaintNames();
  } catch {}
}

function repaintNames() {
  S.friendsSig = null;
  renderLog(); renderLists(); renderUsers();
}

function onNameColor(d) {
  (S.nameColors ||= new Map()).set(keyOf(d.user), d.color || null);
  repaintNames();
  if (keyOf(d.user) === keyOf(S.me)) syncColorPicker();
}

/* Paint an element's text in someone's color (if they picked one). */
function paintName(el, nick) {
  const c = nameColor(nick);
  if (c) el.style.color = c;
}

function syncColorPicker() {
  const mine = S.nameColors?.get(keyOf(S.me)) || null;
  document.querySelectorAll("#pfColors .swatch").forEach((b) => b.classList.toggle("on", (b.dataset.color || null) === mine));
  $("pfColorPreview").textContent = S.me || "";
  $("pfColorPreview").style.color = mine || "";
}

function buildColorPicker() {
  const box = $("pfColors");
  box.innerHTML = "";
  const add = (color, title) => {
    const b = document.createElement("span");
    b.className = "swatch" + (color ? "" : " none");
    if (color) { b.style.background = color; b.dataset.color = color; } else b.textContent = "✕";
    b.title = title;
    b.onclick = async () => {
      try { await socialApi("/namecolor", { color }); }
      catch (e) { showMsg("pfMsg", e.message, "error"); }
    };
    box.appendChild(b);
  };
  add(null, "Default color");
  for (const c of NAME_COLORS) add(c, c);
  syncColorPicker();
}

/* ---------- disappearing messages ---------- */

/* ⏳ in the format bar: what you send next disappears for everyone after the
 * chosen time. The app registers it once the server echoes the message back
 * (that's when its time is known); the account service deletes it on time. */
const EXPIRE_CHOICES = [[0, "Off"], [60, "1 minute"], [3600, "1 hour"], [86400, "1 day"]];

function expireMenu(e) {
  showMenu(e, EXPIRE_CHOICES.map(([secs, label]) => ({
    label: (S.expireAfter === secs ? "✓ " : "   ") + (secs ? `Disappear after ${label}` : "Don't disappear"),
    run: () => setExpire(secs),
  })));
}

function setExpire(secs) {
  S.expireAfter = secs;
  const label = EXPIRE_CHOICES.find(([s]) => s === secs)?.[1];
  $("fmtExpire").classList.toggle("on", !!secs);
  $("fmtExpire").textContent = secs ? `⏳ ${{ 60: "1m", 3600: "1h", 86400: "1d" }[secs]}` : "⏳";
  $("fmtExpire").title = secs ? `Messages disappear after ${label} (click to change)` : "Disappearing messages";
}

/* Our own message came back from the server: register it if it should go. */
function maybeRegisterExpiry(c, m) {
  const p = S.pendingExpire?.find((x) => x.conv === keyOf(c.name) && x.txt === m.txt);
  if (!p) return;
  S.pendingExpire = S.pendingExpire.filter((x) => x !== p);
  socialApi("/expire", { ...msgKeyParts(c, m), after: p.after }).catch(() => {});
}

function onExpireEvent(e) {
  const ck = metaConv(e.target, e.sender);
  metaFor(ck).expiring.set(msgKeyStr(e), e.due);
  if (S.current === ck) renderLog();
}

function expiryLabel(due) {
  const left = due - Math.floor(Date.now() / 1000);
  if (left <= 0) return "⏳ now";
  if (left < 60) return `⏳ ${left}s`;
  if (left < 3600) return `⏳ ${Math.ceil(left / 60)}m`;
  if (left < 86400) return `⏳ ${Math.ceil(left / 3600)}h`;
  return `⏳ ${Math.ceil(left / 86400)}d`;
}

setInterval(() => {
  document.querySelectorAll("#log .expiry").forEach((el) => { el.textContent = expiryLabel(+el.dataset.due); });
}, 5000);

/* ---------- dark mode ---------- */

function setDark(on) {
  document.body.classList.toggle("dark", on);
  localStorage.setItem("a09f.dark", on ? "1" : "0");
  $("btnDark").textContent = on ? "☀️" : "🌙";
  $("btnDark").title = on ? "Switch to light mode" : "Switch to dark mode";
}

/* ---------- quick switcher (Ctrl/Cmd+K) ---------- */

function openSwitcher() {
  if (S.phase !== "online") return;
  $("qsDialog").style.display = "";
  $("qsInput").value = "";
  S.qsSel = 0;
  renderSwitcher();
  $("qsInput").focus();
}
function closeSwitcher() { $("qsDialog").style.display = "none"; }

function switcherItems(q) {
  const inv = inviteRoom(q);
  if (inv) return [{ kind: "join", label: `Join ${inv} (invite link)`, sub: "", go: () => joinOrCreate(inv) }];
  q = q.trim().toLowerCase();
  const items = [];
  for (const c of rooms()) items.push({ kind: "room", label: roomLabel(c.name), sub: c.topic || "Chat room", go: () => switchTo(c.name), unread: c.unread });
  const seen = new Set();
  for (const c of pms()) { seen.add(keyOf(c.name)); items.push({ kind: "pm", label: c.name, sub: statusOf(c.name).label, go: () => openPm(c.name), unread: c.unread }); }
  for (const f of S.friends) if (!seen.has(keyOf(f))) items.push({ kind: "friend", label: f, sub: statusOf(f).label, go: () => openPm(f), unread: 0 });
  const score = (it) => {
    const l = it.label.toLowerCase();
    if (!q) return 1 + (it.unread ? 1 : 0);
    if (l.startsWith(q)) return 3;
    if (l.includes(q)) return 2;
    let i = 0; for (const ch of l) if (ch === q[i]) i++;           // letters in order ("lby" -> lobby)
    return i === q.length ? 1 : 0;
  };
  const out = items.map((it) => ({ ...it, s: score(it) })).filter((it) => it.s > 0)
    .sort((a, b) => b.s - a.s || (b.unread || 0) - (a.unread || 0) || a.label.localeCompare(b.label)).slice(0, 12);
  if (q && /^[#&]?[^\s,]{2,}$/.test(q) && !rooms().some((c) => keyOf(c.name) === keyOf(normRoom(q)))) {
    out.push({ kind: "join", label: `Join or create ${normRoom(q)}`, sub: "", go: () => joinOrCreate(q) });
  }
  return out;
}

function renderSwitcher() {
  const items = switcherItems($("qsInput").value);
  S.qsItems = items;
  S.qsSel = Math.min(S.qsSel, Math.max(0, items.length - 1));
  const el = $("qsList");
  el.innerHTML = items.length ? "" : `<div class="empty-hint">Nothing found.</div>`;
  const icon = { room: "💬", pm: "👤", friend: "👥", join: "➕" };
  items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "qs-row" + (i === S.qsSel ? " sel" : "");
    row.innerHTML = `<span>${icon[it.kind]}</span><b>${esc(it.label)}</b><span class="qs-sub">${esc(it.sub || "")}</span>` +
      (it.unread ? `<span class="badge">${it.unread}</span>` : "");
    row.onclick = () => { closeSwitcher(); it.go(); };
    el.appendChild(row);
  });
}

function onSwitcherKey(e) {
  const n = S.qsItems?.length || 0;
  if (e.key === "ArrowDown") { S.qsSel = (S.qsSel + 1) % Math.max(n, 1); renderSwitcher(); e.preventDefault(); }
  else if (e.key === "ArrowUp") { S.qsSel = (S.qsSel + n - 1) % Math.max(n, 1); renderSwitcher(); e.preventDefault(); }
  else if (e.key === "Enter") { const it = S.qsItems?.[S.qsSel]; closeSwitcher(); it?.go(); e.preventDefault(); }
  else if (e.key === "Escape") closeSwitcher();
}

/* ---------- saved messages ---------- */

async function loadSaved() {
  try {
    const { saved } = await socialApi("/saved");
    S.saved = saved;
    S.savedKeys = new Set(saved.map(msgKeyStr));
    renderLog(); renderSaved();
  } catch {}
}

function isSaved(c, m) { return !!S.savedKeys?.size && S.savedKeys.has(msgKeyOf(c, m)); }

function toggleSave(c, m) {
  const on = !isSaved(c, m);
  socialApi("/save", { ...msgKeyParts(c, m), conv: c.name, text: stripIrc(m.txt).slice(0, 500), on })
    .then(() => sys(on ? "⭐ Saved. Find it under ⭐ Saved." : "Removed from ⭐ Saved.", "status"))
    .catch((e) => sys(e.message, "error"));
}

function openSaved() { $("savedDialog").style.display = ""; renderSaved(); loadSaved(); }
function closeSaved() { $("savedDialog").style.display = "none"; }

function renderSaved() {
  if ($("savedDialog").style.display === "none") return;
  const el = $("svList");
  const list = S.saved || [];
  el.innerHTML = list.length ? "" : `<div class="empty-hint">Nothing saved yet. Hover a message and click ⭐ to keep it here.</div>`;
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "sr-row";
    const where = isChannel(s.conv) ? roomLabel(s.conv) : `Chat with ${s.conv}`;
    row.innerHTML = `<div class="sr-meta">${esc(new Date(s.time).toLocaleString())} · ${esc(where)}` +
      `<span class="sv-x" title="Remove">✕</span></div><div><b>${esc(s.sender)}:</b> ${emote(esc(s.text))}</div>`;
    row.querySelector(".sv-x").onclick = (e) => {
      e.stopPropagation();
      socialApi("/save", { ...s, on: false }).catch(() => {});
    };
    row.onclick = () => { closeSaved(); jumpToMessage(s.conv, msgKeyStr(s)); };
    el.appendChild(row);
  }
}

/* ---------- Do Not Disturb / quiet hours ---------- */

function dnd() {
  try { return { until: 0, quiet: false, from: "22:00", to: "07:00", ...JSON.parse(localStorage.getItem("a09f.dnd")) }; }
  catch { return { until: 0, quiet: false, from: "22:00", to: "07:00" }; }
}
function setDnd(patch) { localStorage.setItem("a09f.dnd", JSON.stringify({ ...dnd(), ...patch })); syncSoundButton(); }

const minutesOf = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

/* Quiet now? Sounds and desktop notifications stay off; unread counts still work. */
function isQuiet() {
  const d = dnd();
  if (Date.now() < d.until) return true;
  if (!d.quiet) return false;
  const now = new Date(), t = now.getHours() * 60 + now.getMinutes();
  const a = minutesOf(d.from), b = minutesOf(d.to);
  return a <= b ? t >= a && t < b : t >= a || t < b;       // window may cross midnight
}

function syncSoundButton() {
  const quiet = isQuiet();
  const ico = $("btnSound").querySelector(".ico");
  ico.textContent = quiet ? "🌙" : Sound.muted ? "🔇" : "🔊";
  $("btnSound").querySelector("span:last-child").textContent = quiet ? "Quiet" : "Sound";
}

function soundMenu(e) {
  const d = dnd();
  const until = Date.now() < d.until ? ` (until ${new Date(d.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : "";
  const tomorrow8 = () => { const t = new Date(); t.setDate(t.getDate() + (t.getHours() >= 8 ? 1 : 0)); t.setHours(8, 0, 0, 0); return t.getTime(); };
  showMenu(e, [
    { label: Sound.muted ? "🔊 Turn sounds on" : "🔇 Turn sounds off", run: () => setMuted(!Sound.muted) },
    "-",
    ...(Date.now() < d.until ? [{ label: `🔔 End Do Not Disturb${until}`, run: () => setDnd({ until: 0 }) }] : [
      { label: "🌙 Do Not Disturb for 1 hour", run: () => setDnd({ until: Date.now() + 3600e3 }) },
      { label: "🌙 Do Not Disturb until tomorrow 8:00", run: () => setDnd({ until: tomorrow8() }) },
    ]),
    "-",
    { label: `${d.quiet ? "✓" : "   "} Quiet hours ${d.from}–${d.to}`, run: () => setDnd({ quiet: !d.quiet }) },
    { label: "   Change quiet hours…", keepOpen: true, run: () => menuPrompt("Quiet hours (e.g. 22:00-07:00)", `${d.from}-${d.to}`, (v) => {
      const m = v.match(/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/);
      if (!m || +m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59) { sys("Write quiet hours like 22:00-07:00", "tip"); return; }
      const f = (h, mi) => `${String(+h).padStart(2, "0")}:${mi}`;
      setDnd({ quiet: true, from: f(m[1], m[2]), to: f(m[3], m[4]) });
    }) },
  ]);
}
setInterval(syncSoundButton, 60000);

/* ---------- typing in rooms ---------- */

/* Room typing goes to every open app (the service doesn't know who's in a
 * room), so it's never sent for hidden rooms or conferences. */
const canShareTyping = (c) => c?.kind === "pm" || (c?.kind === "room" && !isConference(c.name) && !c.modes?.has("s"));

function onRoomTyping(d) {
  const c = conv(keyOf(d.room));
  if (!c || keyOf(d.from) === keyOf(S.me) || isIgnored(d.from)) return;
  S.roomTyping ||= new Map();
  const m = S.roomTyping.get(keyOf(c.name)) || new Map();
  clearTimeout(m.get(keyOf(d.from)));
  if (d.active) m.set(keyOf(d.from), setTimeout(() => onRoomTyping({ ...d, active: false }), TYPING_SHOW_FOR));
  else m.delete(keyOf(d.from));
  S.roomTyping.set(keyOf(c.name), m);
  renderTyping();
}

function roomTypingText(c) {
  const names = [...(S.roomTyping?.get(keyOf(c.name))?.keys() || [])];
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

/* ---------- trending rooms ---------- */

async function loadTrending() {
  try { S.trending = (await socialApi("/trending")).trending; renderRoomBrowser(); } catch {}
}

function noteRoomActivity(c) {
  if (c?.kind !== "room" || isConference(c.name) || c.modes?.has("s") || !S.token) return;
  socialApi("/activity", { room: keyOf(c.name) }).catch(() => {});
}

/* ---------- hover profile card ---------- */

function cardInfo(nick, cb) {
  S.cardCache ||= new Map();
  const hit = S.cardCache.get(keyOf(nick));
  if (hit && Date.now() - hit.at < 300000) { cb(hit.info); return; }
  if (S.infoReq) { cb(null); return; }                 // don't step on the Profile dialog's request
  requestInfo(nick, (info) => { S.cardCache.set(keyOf(nick), { at: Date.now(), info }); cb(info); });
}

function showCard(el, nick) {
  if (!nick || isService(nick)) return;
  const card = $("hoverCard");
  const st = statusOf(nick);
  const me = keyOf(nick) === keyOf(S.me);
  card.dataset.nick = nick;
  card.innerHTML = `<div class="hc-head"><span class="pf-dot st-${st.state}"></span><b class="hc-nick">${esc(nick)}</b></div>` +
    `<div class="hc-status">${esc(st.state === "unknown" ? "" : st.label)}</div>` +
    (localTimeText(nick) ? `<div class="hc-time">${esc(localTimeText(nick))}</div>` : "") + `<div class="hc-info">…</div>` +
    (S.notes?.get(keyOf(nick)) ? `<div class="hc-note">📝 ${esc(S.notes.get(keyOf(nick)).slice(0, 80))}</div>` : "") +
    `<div class="hc-btns">${me ? "" : `<button class="hc-msg">💬 Message</button>`}<button class="hc-prof">👤 Profile</button>` +
    (me || isFriend(nick) || isPendingFriend(nick) ? "" : `<button class="hc-add">➕</button>`) + `</div>`;
  card.querySelector(".hc-nick").style.color = nameColor(nick) || "";
  card.querySelector(".hc-msg")?.addEventListener("click", () => { hideCard(); openPm(nick); });
  card.querySelector(".hc-prof").onclick = () => { hideCard(); openProfile(nick); };
  card.querySelector(".hc-add")?.addEventListener("click", () => { hideCard(); addFriend(nick); });
  const r = el.getBoundingClientRect();
  card.style.display = "block";
  const cr = card.getBoundingClientRect();
  card.style.left = Math.min(r.left, innerWidth - cr.width - 8) + "px";
  card.style.top = (r.bottom + 6 + cr.height > innerHeight ? r.top - cr.height - 6 : r.bottom + 6) + "px";
  requestPresence([nick]);
  cardInfo(nick, (info) => {
    if (card.dataset.nick !== nick || card.style.display === "none") return;
    const p = info?.props || {};
    const bits = [p.name, p.location && `📍 ${p.location}`].filter(Boolean).map(esc);
    card.querySelector(".hc-info").innerHTML = bits.length ? bits.join("<br>") : `<i>${info ? "No profile details" : ""}</i>`;
  });
}

function hideCard() { $("hoverCard").style.display = "none"; }

document.addEventListener("mouseover", (e) => {
  const t = e.target.closest?.("[data-nick]");
  if (e.target.closest?.("#hoverCard")) { clearTimeout(S.cardHide); return; }
  clearTimeout(S.cardShow);
  if (!t) { clearTimeout(S.cardHide); S.cardHide = setTimeout(hideCard, 300); return; }
  S.cardShow = setTimeout(() => showCard(t, t.dataset.nick), 550);
});

/* ---------- IMVironments: themes for private chats ---------- */

const IMV_THEMES = [
  ["none", "No theme", "⬜"], ["beach", "Beach", "🏖️"], ["night", "Starry night", "🌌"], ["rain", "Rainy day", "🌧️"],
  ["love", "Love", "💕"], ["space", "Outer space", "🚀"], ["forest", "Forest", "🌲"], ["snow", "Snowfall", "❄️"],
  ["sunset", "Sunset", "🌅"],
];

async function loadImv(c) {
  if (c?.kind !== "pm" || !S.token) return;
  S.imv ||= new Map();
  try {
    const r = await socialApi(`/imv?with=${encodeURIComponent(c.name)}`);
    S.imv.set(keyOf(c.name), r.theme);
    applyImv();
  } catch {}
}

function applyImv() {
  const c = S.current && conv(S.current);
  const theme = c?.kind === "pm" ? (S.imv?.get(keyOf(c.name)) || "none") : "none";
  const layer = $("imvLayer");
  layer.className = theme === "none" ? "" : `imv imv-${theme}`;
  logEl.classList.toggle("themed", theme !== "none");
  positionImv();
}

function positionImv() {
  const layer = $("imvLayer");
  layer.style.top = logEl.offsetTop + "px";
  layer.style.height = logEl.offsetHeight + "px";
}
new ResizeObserver(positionImv).observe(document.getElementById("log"));

function imvMenu(e, c) {
  const cur = S.imv?.get(keyOf(c.name)) || "none";
  showMenu(e, IMV_THEMES.map(([id, label, icon]) => ({
    label: `${cur === id ? "✓" : "  "} ${icon} ${label}`,
    run: () => socialApi("/imv", { with: c.name, theme: id }).catch((err) => sys(err.message, "error")),
  })));
}

function onImvEvent(d) {
  const other = keyOf(d.a) === keyOf(S.me) ? d.b : d.a;
  (S.imv ||= new Map()).set(keyOf(other), d.theme);
  const label = IMV_THEMES.find(([id]) => id === d.theme);
  const who = keyOf(d.by) === keyOf(S.me) ? "You" : d.by;
  if (conv(keyOf(other))) {
    sys(d.theme === "none" ? `${who} removed the chat theme.` : `${who} changed the chat theme to ${label[2]} ${label[1]}.`, "system", other);
  }
  if (S.current === keyOf(other)) applyImv();
}

/* ---------- sliding window: back to the newest messages ---------- */

function renderNewerBar() {
  logEl.querySelector(".newer")?.remove();
  const c = S.current && conv(S.current);
  if (!c?.hasNewer) return;
  const d = document.createElement("div");
  d.className = "older newer";
  d.innerHTML = `<a>⬇ ${c.newerCount ? `${c.newerCount} new message${c.newerCount === 1 ? "" : "s"} — ` : ""}Jump to latest</a>`;
  d.querySelector("a").onclick = () => jumpToLatest(c);
  logEl.appendChild(d);
}

/* Drop the old window and load the newest page again. */
function jumpToLatest(c) {
  c.msgs = []; c.ids.clear();
  c.hasNewer = false; c.newerCount = 0; c.noMore = false;
  c.historyLoaded = false; c.historyDone = false;
  logEl.dataset.conv = "";                      // reopen at the bottom
  renderLog();
  fetchHistory(c);
}

/* ---------- jump to a message (Saved, Search) ---------- */

/* Open the conversation, load older pages until the message is there (up to
 * MAX_JUMP_PAGES), scroll it to the middle and flash it. */
const JUMP_PAGE = 500;             // bigger pages when hunting for a message (soju allows 1000)
const MAX_JUMP_PAGES = 40;         // ~20,000 messages back

async function jumpToMessage(convName, key) {
  if (isChannel(convName)) {
    if (conv(keyOf(convName))?.kind !== "room") { joinOrSwitch(convName); sys("Joining the room… open the message again once you're in.", "tip"); return; }
    switchTo(convName);
  } else openPm(convName);
  const c = conv(keyOf(convName));
  const find = () => logEl.querySelector(`.msg[data-key="${CSS.escape(key)}"]`);
  const inMemory = () => c.msgs.some((m) => isConvMsg(m) && msgKeyOf(c, m) === key);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let t = 0; t < 40 && (!c.historyDone || (S.token && !metaFor(keyOf(c.name)).loaded)); t++) await wait(150);
  // Page back without redrawing each page; draw once when it's found.
  S.silentOlder = true;
  try {
    for (let page = 0; !inMemory() && page < MAX_JUMP_PAGES && !c.noMore && S.current === keyOf(c.name); page++) {
      $("typing").textContent = `Looking back for the message… (${c.msgs.length} loaded)`;
      loadOlder(c, JUMP_PAGE);
      for (let t = 0; t < 300 && c.loadingOlder; t++) await wait(50);
    }
  } finally { S.silentOlder = false; }
  renderTyping();
  renderLog();
  let el = find();
  if (!el) { sys("That message isn't in the chat history any more (it may have been deleted).", "tip"); return; }
  // Re-renders in the next moments (reactions/edits loading, …) keep the spot.
  S.jump = { key, until: Date.now() + 2000 };
  el.scrollIntoView({ block: "center" });
  el.classList.add("flash");
}

/* After a re-render: stay on the message we just jumped to. */
function keepJump() {
  if (!S.jump || Date.now() > S.jump.until) { S.jump = null; return; }
  logEl.querySelector(`.msg[data-key="${CSS.escape(S.jump.key)}"]`)?.scrollIntoView({ block: "center" });
}

/* ---------- timezones: nearest first, local time, far-away warning ---------- */

/* Offsets are minutes east of UTC. Distances wrap around the clock, so
 * UTC+12 and UTC-11 are 1 hour apart. */
const MY_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
const myOffset = () => -new Date().getTimezoneOffset();
const TZ_FAR = 5 * 60;                    // more than 5h apart: warn before the first message

function tzDistance(a, b) { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d); }

function shareMyTz() {
  socialApi("/tz", { tz: MY_TZ, offset: myOffset() }).catch(() => {});
}

/* Someone's UTC offset, or null when unknown (fetched in batches). */
function tzOf(nick) {
  if (!nick || isService(nick)) return null;
  const key = keyOf(nick);
  if (key === keyOf(S.me)) return myOffset();
  S.tz ||= new Map();
  if (S.tz.has(key)) return S.tz.get(key);
  if (S.token) {
    (S.tzQueue ||= new Set()).add(key);
    clearTimeout(S.tzTimer);
    S.tzTimer = setTimeout(fetchTz, 250);
  }
  return null;
}

async function fetchTz() {
  const users = [...(S.tzQueue || [])];
  S.tzQueue = new Set();
  if (!users.length || !S.token) return;
  for (const u of users) S.tz.set(u, null);
  try {
    const { tz } = await socialApi(`/tz?users=${users.map(encodeURIComponent).join(",")}`);
    if (!Object.keys(tz).length) return;
    S.active ||= new Map();
    for (const [u, v] of Object.entries(tz)) { S.tz.set(u, v.offset); if (v.active) S.active.set(u, v.active); else S.active.delete(u); }
    S.friendsSig = null;
    renderLists(); renderUsers(); renderFind(); refreshSide();
  } catch {}
}

/* Distance from me in minutes (null = unknown). */
function tzGap(nick) {
  const o = tzOf(nick);
  return o == null ? null : tzDistance(o, myOffset());
}

/* "03:12 · 12h behind" style text for someone (null when unknown). */
function localTimeText(nick) {
  const o = tzOf(nick);
  if (o == null || keyOf(nick) === keyOf(S.me)) return null;
  const t = new Date(Date.now() + (o - myOffset()) * 60000);
  const hm = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  let diff = o - myOffset();
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  const h = Math.round(Math.abs(diff) / 60 * 2) / 2;          // to the half hour
  const rel = diff === 0 ? "same time as you" : `${h}h ${diff > 0 ? "ahead" : "behind"}`;
  const night = isAsleep(nick) ? " 😴" : t.getHours() < 7 || t.getHours() >= 22 ? " 🌙" : "";
  return `🕑 ${hm}${night} · ${rel}`;
}

/* Sort helper: nearest timezone first, unknown in the middle-ish (6h). */
const tzSortKey = (nick) => tzGap(nick) ?? 360;

/* Rooms: typical timezone of the people chatting there. */
async function loadRoomTz(names) {
  S.roomTz ||= new Map();
  const want = names.map(keyOf).filter((n) => !S.roomTz.has(n));
  if (!want.length || !S.token) return;
  for (const n of want) S.roomTz.set(n, null);
  try {
    const { tz } = await socialApi(`/roomtz?rooms=${want.map(encodeURIComponent).join(",")}`);
    for (const [r, o] of Object.entries(tz)) S.roomTz.set(r, o);
    renderRoomBrowser();
  } catch {}
}

function roomTzText(name) {
  const o = S.roomTz?.get(keyOf(name));
  if (o == null) return "";
  let diff = o - myOffset();
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  const h = Math.round(Math.abs(diff) / 60);
  return h === 0 ? "🕑 your time" : `🕑 ${diff > 0 ? "+" : "−"}${h}h`;
}

/* First message to a far-away stranger: confirm before sending. */
function needsTzConfirm(c) {
  if (c?.kind !== "pm" || c.tzOk) return false;
  if (isAsleep(c.name)) return true;                // their own active hours: everyone is asked
  if (isFriend(c.name)) return false;
  const gap = tzGap(c.name);
  return gap != null && gap > TZ_FAR;
}

function askTzConfirm(c, send) {
  const o = tzOf(c.name);
  const their = new Date(Date.now() + (o - myOffset()) * 60000);
  const hm = their.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const night = their.getHours() < 7 || their.getHours() >= 22;
  const rel = localTimeText(c.name).split(" · ").pop();
  const act = S.active?.get(keyOf(c.name));
  const asleep = isAsleep(c.name);
  const wake = act ? act[0] : 480;
  showComposerBar((asleep
    ? `😴 It's ${esc(hm)} for <b>${esc(c.name)}</b> — outside their active hours (${fmtMin(act[0])}–${fmtMin(act[1])}).`
    : `${night ? "🌙" : "🕑"} It's ${esc(hm)} for <b>${esc(c.name)}</b> (${esc(rel)})` +
      (night ? " — they may be asleep." : " — far from your timezone.")) +
    ` <button id="tzLater" class="title-btn">Send at their ${fmtMin(wake)}</button>` +
    ` <button id="tzSend" class="title-btn">Send anyway</button>`);
  $("tzLater").onclick = () => scheduleMessage(c, withReply(styled($("input").value.trim())), theirNext(c.name, wake));
  $("tzSend").onclick = () => { c.tzOk = true; clearComposerBar(); send(); };
}

/* ---------- links: clickable + previews ---------- */

/* On already-escaped HTML: turn http(s) URLs into links (opened in the
 * system browser). Trailing punctuation stays outside the link. */
const URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}']/gi;

function linkify(html) {
  return html.replace(URL_RE, (u) => `<a class="link" data-url="${u}" title="${u}">${u}</a>`);
}

const firstUrl = (text) => (stripIrc(text).match(URL_RE) || [])[0] || null;

function openLink(url) {
  if (!/^https?:\/\//i.test(url)) return;
  invoke("plugin:opener|open_url", { url }).catch(() => window.open(url, "_blank"));
}

/* Preview card for the first link of a message (fetched by the account
 * service, which checks every address; thumbnails come through it too). */
function previewCard(url) {
  S.previews ||= new Map();
  const el = document.createElement("div");
  el.className = "lp";
  el.dataset.url = url;
  const p = S.previews.get(url);
  if (p === undefined) { loadPreview(url); el.style.display = "none"; }
  else if (!p) el.style.display = "none";
  else fillPreview(el, p);
  return el;
}

async function loadPreview(url) {
  S.previews.set(url, null);                         // one request per URL
  try {
    const p = await socialApi(`/preview?url=${encodeURIComponent(url)}`);
    S.previews.set(url, p);
    document.querySelectorAll(".lp").forEach((el) => {
      if (el.dataset.url === url) { fillPreview(el, p); el.style.display = ""; }
    });
  } catch { /* no preview for this link */ }
}

function fillPreview(el, p) {
  const img = p.image && S.token
    ? `<img src="${ACCOUNT_URL}/preview/img?u=${encodeURIComponent(p.image)}&token=${encodeURIComponent(S.token)}" alt="" onerror="this.remove()">`
    : "";
  el.innerHTML = `${img}<div class="lp-body"><div class="lp-site">${esc(p.site || "")}</div>` +
    `<a class="link lp-title" data-url="${esc(p.url)}">${esc(p.title || p.url)}</a>` +
    (p.description ? `<div class="lp-desc">${esc(p.description)}</div>` : "") + `</div>`;
}

/* ---------- active hours ("😴 outside their active hours") ---------- */

/* Someone's active hours are in their own local time, minutes after midnight. */
function theirMinutes(nick) {
  const o = tzOf(nick);
  if (o == null) return null;
  const d = new Date(Date.now() + (o - myOffset()) * 60000);
  return d.getHours() * 60 + d.getMinutes();
}

function isAsleep(nick) {
  const a = S.active?.get(keyOf(nick));
  const t = theirMinutes(nick);
  if (!a || t == null) return false;
  const [s, e] = a;
  const inside = s < e ? t >= s && t < e : t >= s || t < e;     // may cross midnight
  return !inside;
}

const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const sleepMark = (nick) => (isAsleep(nick) ? " 😴" : "");

/* Unix time of someone's next local hh:mm (in minutes after midnight). */
function theirNext(nick, minutes) {
  const now = theirMinutes(nick);
  let wait = minutes - now;
  if (wait <= 1) wait += 1440;
  return Math.floor(Date.now() / 1000) + wait * 60;
}

function syncActiveUi() {
  const a = S.active?.get(keyOf(S.me));
  $("pfActiveAlways").checked = !a;
  $("pfActiveFrom").value = fmtMin(a ? a[0] : 480);
  $("pfActiveTo").value = fmtMin(a ? a[1] : 1320);
  $("pfActiveFrom").disabled = $("pfActiveTo").disabled = !a;
}

async function saveActive() {
  const always = $("pfActiveAlways").checked;
  const toMin = (v) => { const [h, m] = v.split(":").map(Number); return h * 60 + m; };
  const body = always ? { start: null, end: null } : { start: toMin($("pfActiveFrom").value), end: toMin($("pfActiveTo").value) };
  try {
    await socialApi("/active", body);
    S.active ||= new Map();
    if (always) S.active.delete(keyOf(S.me)); else S.active.set(keyOf(S.me), [body.start, body.end]);
    syncActiveUi();
  } catch (e) { showMsg("pfMsg", e.message, "error"); }
}

/* ---------- scheduled messages ---------- */

async function loadScheduled() {
  try { S.scheduled = (await socialApi("/scheduled")).scheduled; renderScheduled(); } catch {}
}

async function scheduleMessage(c, text, due) {
  try {
    await socialApi("/schedule", { target: c.name, text, due });
    $("input").value = "";
    clearComposerBar();
    sys(`🕒 Scheduled for ${new Date(due * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.`, "status", c.name);
  } catch (e) { sys(e.message, "error"); }
}

function scheduleMenu(e) {
  const c = S.current && conv(S.current);
  const text = $("input").value.trim();
  if (!c || c.kind === "status") return;
  if (!text) { sys("Type your message first, then pick when to send it.", "tip"); $("input").focus(); return; }
  const body = withReplyPreview(styled(text));
  const now = Math.floor(Date.now() / 1000);
  const tomorrow8 = (() => { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(8, 0, 0, 0); return Math.floor(t / 1000); })();
  const items = [
    { label: "🕐 In 1 hour", run: () => scheduleMessage(c, body, now + 3600) },
    { label: "🌅 Tomorrow 08:00 (your time)", run: () => scheduleMessage(c, body, tomorrow8) },
  ];
  if (c.kind === "pm" && tzOf(c.name) != null && tzGap(c.name) > 0) {
    const due = theirNext(c.name, S.active?.get(keyOf(c.name))?.[0] ?? 480);
    items.push({ label: `☀️ Their next morning (${new Date(due * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} your time)`,
      run: () => scheduleMessage(c, body, due) });
  }
  items.push({ label: "✏️ Pick a time…", keepOpen: true, run: () => menuPrompt("When? (HH:MM, or YYYY-MM-DD HH:MM)", "", (v) => {
    let d = null;
    const m1 = v.match(/^\s*(\d{1,2}):(\d{2})\s*$/), m2 = v.match(/^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})\s*$/);
    if (m1) { d = new Date(); d.setHours(+m1[1], +m1[2], 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); }
    else if (m2) d = new Date(+m2[1], +m2[2] - 1, +m2[3], +m2[4], +m2[5]);
    if (!d || isNaN(d)) { sys("Write the time like 21:30 or 2026-12-01 08:00", "tip"); return; }
    scheduleMessage(c, body, Math.floor(d / 1000));
  }) });
  showMenu(e, items);
}

/* withReply without consuming the pending reply (the menu may be cancelled). */
function withReplyPreview(text) {
  if (!S.replyTo) return text;
  return `↪ ${S.replyTo.who}: “${S.replyTo.txt.replace(/”/g, "\"")}” ${text}`;
}

/* Pending scheduled messages of the open conversation, under the log. */
function renderScheduled() {
  const el = $("schedBar");
  const c = S.current && conv(S.current);
  const list = (S.scheduled || []).filter((x) => c && keyOf(x.target) === keyOf(c.name));
  if (!list.length) { el.style.display = "none"; return; }
  el.innerHTML = "";
  for (const x of list) {
    const row = document.createElement("div");
    row.className = "sched";
    row.innerHTML = `🕒 <b>${esc(new Date(x.due * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }))}</b> ` +
      `<span>${emote(formatIrc(esc(x.text)))}</span><span class="sched-x" title="Cancel">✕</span>`;
    row.querySelector(".sched-x").onclick = () => socialApi("/scheduled/cancel", { id: x.id }).catch(() => {});
    el.appendChild(row);
  }
  el.style.display = "";
}

/* ---------- room events (local times, RSVP) ---------- */

const EVENT_RE = /\[event:(\d+)\]/;
const fmtWhen = (unix) => new Date(unix * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function relWhen(unix) {
  const d = unix - Math.floor(Date.now() / 1000);
  if (d < -3600) return "ended";
  if (d < 0) return "happening now";
  if (d < 3600) return `in ${Math.max(1, Math.round(d / 60))} min`;
  if (d < 86400) return `in ${Math.round(d / 3600)}h`;
  return `in ${Math.round(d / 86400)} days`;
}

async function loadEvent(id) {
  S.evCache ||= new Map();
  try {
    S.evCache.set(id, await socialApi(`/event?id=${id}`));
  } catch { S.evCache.set(id, { gone: true }); }
  document.querySelectorAll(`.evc[data-ev="${id}"]`).forEach((el) => fillEventCard(el, id));
}

function eventCard(id) {
  const el = document.createElement("div");
  el.className = "evc";
  el.dataset.ev = id;
  if (S.evCache?.has(id)) fillEventCard(el, id); else { el.textContent = "📅 Loading event…"; loadEvent(id); }
  return el;
}

function fillEventCard(el, id) {
  const ev = S.evCache.get(id);
  if (!ev || ev.gone) { el.innerHTML = "📅 <i>This event was cancelled.</i>"; return; }
  const n = (k) => ev.people[k]?.length || 0;
  el.innerHTML = `<div class="evc-title">📅 ${esc(ev.title)}</div>` +
    `<div class="evc-when">${esc(fmtWhen(ev.start))} <span class="tz-note">your time · ${esc(relWhen(ev.start))}</span></div>` +
    `<div class="evc-rsvp">` +
    [["going", "✅ Going"], ["maybe", "🤔 Maybe"], ["no", "❌ Can't"]].map(([k, l]) =>
      `<button data-st="${k}" class="${ev.mine === k ? "on" : ""}" title="${esc((ev.people[k] || []).join(", ") || "Nobody yet")}">${l} ${n(k)}</button>`).join("") +
    (keyOf(ev.creator) === keyOf(S.me) ? `<a class="evc-x">Cancel event</a>` : "") + `</div>`;
  el.querySelectorAll("button[data-st]").forEach((b) => {
    b.onclick = () => socialApi("/event/rsvp", { id, status: ev.mine === b.dataset.st ? null : b.dataset.st }).catch((e) => sys(e.message, "error"));
  });
  el.querySelector(".evc-x")?.addEventListener("click", () => socialApi("/event/delete", { id }).catch((e) => sys(e.message, "error")));
}

function onEventChanged(d) {
  if (d.deleted) S.evCache?.set(d.id, { gone: true }); else if (S.evCache?.has(d.id)) { loadEvent(d.id); }
  document.querySelectorAll(`.evc[data-ev="${d.id}"]`).forEach((el) => fillEventCard(el, d.id));
  if ($("eventsDialog").style.display !== "none" && keyOf(S.evCacheRoom || "") === keyOf(d.room)) loadRoomEvents();
}

function openRoomEvents(c) {
  S.evCacheRoom = c.name;
  $("evTitle").textContent = `📅 Events in ${roomName(c.name)}`;
  $("evName").value = "";
  const d = new Date(Date.now() + 86400000); d.setMinutes(0, 0, 0);
  $("evWhen").value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  showMsg("evMsg", "");
  $("eventsDialog").style.display = "";
  loadRoomEvents();
}
function closeRoomEvents() { $("eventsDialog").style.display = "none"; }

async function loadRoomEvents() {
  const el = $("evList");
  try {
    const { events } = await socialApi(`/roomevents?room=${encodeURIComponent(S.evCacheRoom)}`);
    S.evCache ||= new Map();
    el.innerHTML = events.length ? "" : `<div class="empty-hint">No upcoming events. Plan one below!</div>`;
    for (const ev of events) { S.evCache.set(ev.id, ev); el.appendChild(eventCard(ev.id)); }
  } catch (e) { el.innerHTML = `<div class="empty-hint">${esc(e.message)}</div>`; }
}

async function createEvent() {
  const title = $("evName").value.trim();
  const when = $("evWhen").value;                    // local time (datetime-local)
  if (!title || !when) { showMsg("evMsg", "Give it a name and a time.", "error"); return; }
  const start = Math.floor(new Date(when).getTime() / 1000);
  try {
    const { id } = await socialApi("/event/create", { room: S.evCacheRoom, title, start });
    sendTo(S.evCacheRoom, `📅 Event: ${title} — ${new Date(start * 1000).toISOString().replace(".000", "")} (RSVP in a09f) [event:${id}]`);
    $("evName").value = "";
    showMsg("evMsg", "Event created and announced in the room.", "ok");
    loadRoomEvents();
  } catch (e) { showMsg("evMsg", e.message, "error"); }
}

function onEventSoon(ev) {
  sys(`📅 “${ev.title}” starts ${relWhen(ev.start)} in ${roomName(ev.room)}.`, "tip");
  Sound.play("buzz");
  notify(`📅 ${ev.title}`, `Starts ${relWhen(ev.start)} in ${roomName(ev.room)}`, keyOf(ev.room));
}

/* ---------- room category & language ---------- */

const ROOM_CATEGORIES = [["general", "💬 General"], ["games", "🎮 Games"], ["music", "🎵 Music"], ["tech", "💻 Tech"],
  ["sports", "⚽ Sports"], ["study", "📚 Study"], ["movies", "🎬 Movies"], ["hangout", "☕ Hangout"], ["other", "✨ Other"]];
const ROOM_LANGS = [["", "Any language"], ["id", "🇮🇩 Indonesian"], ["en", "🇬🇧 English"], ["ms", "🇲🇾 Malay"], ["jv", "Javanese"],
  ["su", "Sundanese"], ["ja", "🇯🇵 Japanese"], ["ko", "🇰🇷 Korean"], ["zh", "🇨🇳 Chinese"], ["es", "🇪🇸 Spanish"],
  ["fr", "🇫🇷 French"], ["de", "🇩🇪 German"], ["ar", "🇸🇦 Arabic"], ["other", "Other"]];
const catLabel = (k) => ROOM_CATEGORIES.find(([v]) => v === k)?.[1] || "";
const langLabel = (k) => ROOM_LANGS.find(([v]) => v === k)?.[1] || "";

function fillSelect(sel, items, first) {
  sel.innerHTML = "";
  if (first) sel.add(new Option(first[1], first[0]));
  for (const [v, l] of items) sel.add(new Option(l, v));
}

async function loadRoomInfo2(names) {
  S.roomInfo ||= new Map();
  const want = names.map(keyOf).filter((n) => !S.roomInfo.has(n));
  if (!want.length || !S.token) return;
  for (const n of want) S.roomInfo.set(n, null);
  try {
    const { info } = await socialApi(`/roominfo?rooms=${want.map(encodeURIComponent).join(",")}`);
    for (const [r, v] of Object.entries(info)) S.roomInfo.set(r, v);
    renderRoomBrowser();
    renderRoomDialog?.();
  } catch {}
}

async function saveRoomCategory() {
  const c = S.roomDialogFor && conv(S.roomDialogFor);
  if (!c) return;
  try {
    await socialApi("/roominfo", { room: keyOf(c.name), category: $("rdCategory").value, lang: $("rdLang").value });
    (S.roomInfo ||= new Map()).set(keyOf(c.name), { category: $("rdCategory").value, lang: $("rdLang").value });
    showMsg("rdMsg", "Category and language saved.", "ok");
  } catch (e) { showMsg("rdMsg", e.message, "error"); }
}

/* ---------- friend suggestions ---------- */

async function loadSuggestions() {
  const el = $("fdResults");
  try {
    const { suggestions } = await socialApi("/suggestions");
    if ($("fdQuery").value.trim()) return;                  // they started searching meanwhile
    el.innerHTML = suggestions.length ? `<div class="fd-sugg-h">✨ People you may know</div>`
      : `<div class="empty-hint">Type part of an a09f ID to search.</div>`;
    for (const sgg of suggestions) {
      tzOf(sgg.nick);
      const row = document.createElement("div");
      row.className = `fd-row st-${statusOf(sgg.nick).state}`;
      const lt = localTimeText(sgg.nick);
      row.innerHTML = `<span class="st"></span><b data-nick="${esc(sgg.nick)}">${esc(sgg.nick)}</b>` +
        `<span class="status-text">${esc(sgg.reasons.join(" · "))}${lt ? `<br><small class="tz-note">${esc(lt)}</small>` : ""}</span>` +
        `<button class="fd-prof">Profile</button><button class="fd-add">➕ Add Friend</button>`;
      row.querySelector(".fd-prof").onclick = () => openProfile(sgg.nick);
      row.querySelector(".fd-add").onclick = async () => { await addFriend(sgg.nick); row.remove(); };
      el.appendChild(row);
    }
  } catch {}
}

/* ---------- invite links ---------- */

const inviteUrl = (room) => `${ACCOUNT_URL}/join/${encodeURIComponent(roomName(room))}`;
const INVITE_LINK_RE = new RegExp(`^(?:a09f://join/|${ACCOUNT_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/join/)([^\\s/?#]+)$`, "i");

/* An invite link (a09f://join/x or the web page) -> "#x", else null. */
function inviteRoom(text) {
  const m = (text || "").trim().match(INVITE_LINK_RE);
  return m ? "#" + decodeURIComponent(m[1]).replace(/^#/, "") : null;
}

async function copyInvite(c) {
  const link = inviteUrl(c.name);
  try { await navigator.clipboard.writeText(link); sys(`🔗 Invite link copied: ${link}`, "system", c.name); }
  catch { sys(`🔗 Invite link: ${link}`, "system", c.name); }
}

/* ---------- "Seen by" in rooms ---------- */

function sendRoomRead(c, latest) {
  if (!canShareTyping(c) || c.kind !== "room" || !S.token || latest <= (c.roomReadSent || 0)) return;
  c.roomReadSent = latest;
  socialApi("/roomread", { room: keyOf(c.name), time: latest }).catch(() => {});
}

async function loadRoomReads(c) {
  if (c?.kind !== "room" || !canShareTyping(c) || !S.token) return;
  try {
    const { reads } = await socialApi(`/roomreads?room=${encodeURIComponent(keyOf(c.name))}`);
    (S.roomReads ||= new Map()).set(keyOf(c.name), new Map(Object.entries(reads)));
    if (S.current === keyOf(c.name)) renderSeen();
  } catch {}
}

function onRoomRead(d) {
  if (keyOf(d.user) === keyOf(S.me)) return;
  const m = (S.roomReads ||= new Map()).get(keyOf(d.room)) || new Map();
  m.set(keyOf(d.user), Math.max(m.get(keyOf(d.user)) || 0, d.time));
  S.roomReads.set(keyOf(d.room), m);
  if (S.current === keyOf(d.room)) renderSeen();
}

/* People in the room (not me) who read up to my last message. */
function roomSeenBy(c, last) {
  const reads = S.roomReads?.get(keyOf(c.name));
  if (!reads) return [];
  return [...reads].filter(([u, t]) => t >= last.time && u !== keyOf(S.me) && !isIgnored(u)).map(([u]) => u).sort();
}

/* ---------- private notes about people ---------- */

async function loadNotes() {
  try { S.notes = new Map(Object.entries((await socialApi("/notes")).notes)); } catch {}
}

function saveNote(nick, text) {
  clearTimeout(S.noteTimer);
  S.noteTimer = setTimeout(() => {
    (S.notes ||= new Map());
    if (text.trim()) S.notes.set(keyOf(nick), text.trim()); else S.notes.delete(keyOf(nick));
    socialApi("/note", { about: keyOf(nick), text }).then(() => showMsg("pfMsg", "Note saved — only you can see it.", "ok"))
      .catch((e) => showMsg("pfMsg", e.message, "error"));
  }, 600);
}

/* ---------- export a conversation (JSON) ---------- */

const EXPORT_PAGE = 1000, EXPORT_MAX = 50000;

/* All of a conversation's history from soju (paged, not drawn), with edits,
 * deletions and reactions, saved to Downloads as JSON. */
async function exportConversation(c) {
  if (!has("draft/chathistory") || S.exporting) return;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ex = { key: keyOf(c.name), lines: [], pageDone: false, count: 0 };
  S.exporting = ex;
  let before = "*";
  try {
    for (let total = 0; total < EXPORT_MAX;) {
      $("typing").textContent = `Exporting… ${ex.lines.length} messages`;
      ex.pageDone = false; ex.count = 0;
      send(`CHATHISTORY BEFORE ${c.name} ${before === "*" ? "timestamp=" + new Date(Date.now() + 60000).toISOString() : before} ${EXPORT_PAGE}`);
      for (let t = 0; t < 300 && !ex.pageDone; t++) await wait(50);
      if (!ex.pageDone || !ex.count) break;
      total += ex.count;
      const oldest = ex.lines[0];
      before = `timestamp=${oldest.tags.time}`;
      if (ex.count < EXPORT_PAGE) break;
    }
  } finally { S.exporting = null; renderTyping(); }
  let meta = { reactions: [], edits: [] };
  try { meta = await socialApi(`/msgmeta?conv=${encodeURIComponent(c.name)}`); } catch {}
  const edits = new Map(meta.edits.map((e) => [msgKeyStr(e), e.text]));
  const reacts = new Map();
  for (const r of meta.reactions) {
    const k = msgKeyStr(r), o = reacts.get(k) || {};
    (o[r.emoji] ||= []).push(r.user);
    reacts.set(k, o);
  }
  const messages = ex.lines.map((l) => {
    const from = nickOf(l.prefix);
    const m = msgFrom(l, from);
    const k = msgKeyOf(c, m);
    const out = { time: new Date(m.time).toISOString(), from, text: stripIrc(m.txt) };
    if (m.cls.includes("action")) out.action = true;
    if (edits.has(k)) out.edited_text = stripIrc(edits.get(k));
    if (S.redactions?.has(k)) { out.deleted = true; delete out.text; }
    if (reacts.has(k)) out.reactions = reacts.get(k);
    return out;
  });
  const doc = {
    app: "a09f", exported_by: S.me, exported_at: new Date().toISOString(), timezone: MY_TZ,
    conversation: { name: c.name, type: c.kind === "room" ? "room" : "private" }, count: messages.length, messages,
  };
  const name = `a09f-${roomName(c.name)}-${new Date().toISOString().slice(0, 10)}`;
  try {
    const path = await invoke("save_export", { name, contents: JSON.stringify(doc, null, 2) });
    addMsg(c.name, { who: "System", txt: `⬇ Exported ${messages.length} messages to ${path}`, cls: "service", reveal: path });
  } catch (e) { sys(`Couldn't save the export: ${e}`, "error"); }
}

/* ---------- signed-in devices ---------- */

async function loadDevices() {
  const el = $("devList");
  el.innerHTML = `<div class="empty-hint">Loading…</div>`;
  try {
    const { sessions } = await socialApi("/sessions");
    el.innerHTML = "";
    for (const d of sessions) {
      const row = document.createElement("div");
      row.className = "pv-row dev-row";
      row.innerHTML = `<span>💻 <b>${esc(d.device || "Unknown device")}</b>${d.current ? " <i>(this device)</i>" : ""}` +
        `<br><small>Active ${esc(agoText(d.last))} · signed in ${esc(new Date(d.created * 1000).toLocaleString())}</small></span>` +
        (d.current ? "" : `<button>Sign out</button>`);
      row.querySelector("button")?.addEventListener("click", async () => {
        try { await socialApi("/session/revoke", { sid: d.sid }); loadDevices(); }
        catch (e) { showMsg("pwMsg", e.message, "error"); }
      });
      el.appendChild(row);
    }
  } catch (e) { el.innerHTML = `<div class="empty-hint">${esc(e.message)}</div>`; }
}

/* ---------- actions ---------- */

async function doSignIn() {
  const u = $("buser").value.trim();
  if (!u || !$("bpass").value) { setPhase("offline", "Please enter your ID and password.", true); return; }
  S.authFailed = false;
  S.account = u.toLowerCase();
  S.pw = $("bpass").value;          // memory only: used to link the NickServ account
  if (localStorage.getItem(invisibleKey())) { S.myStatus = { code: "invisible", text: "" }; syncStatusUi(); }
  setPhase("signing-in", "Signing in…");
  try {
    await invoke("connect", { addr: SERVER });
    send("CAP LS 302");
    send(`NICK ${u}/${NETWORK}`);
    send(`USER ${u}/${NETWORK} 0 * :a09f`);
  } catch {
    setPhase("offline", "Can't reach a09f right now. Please try again later.", true);
  }
}

function doDisconnect(message = "", isError = false) {
  invoke("disconnect");
  S.me = null; S.current = null; S.burstDone = false;
  S.caps.clear(); S.convs.clear(); S.batches.clear(); S.away = false;
  S.presence.clear(); S.statuses.clear(); S.whois.clear(); S.friends = [];
  stopSocial(); S.friendGroups.clear(); S.incoming = []; S.outgoing = []; S.friendsSig = null;
  S.prefs = { ignore: [], friendsOnly: false }; S.callerId = null; S.accepted = null; S.blockedTold = null;
  S.findResults = null; S.searching = false;
  for (const id of ["privacyDialog", "findDialog", "searchDialog", "roomDialog", "annDialog", "annBar", "createRoomDialog"]) $(id).style.display = "none";
  S.pendingCreate = null; S.listProbe = null; S.createName = null;
  S.meta = new Map(); S.polls = new Map(); S.lastSeen = new Map(); clearInterval(S.lastSeenTimer);
  S.nameColors = new Map(); S.colorQueue = new Set(); S.tz = new Map(); S.tzQueue = new Set(); S.roomTz = new Map();
  S.previews = new Map(); S.active = new Map(); S.scheduled = []; $("schedBar").style.display = "none";
  S.evCache = new Map(); S.roomInfo = new Map(); S.roomReads = new Map(); S.notes = new Map(); S.exporting = null;
  $("eventsDialog").style.display = "none";
  S.saved = []; S.savedKeys = new Set(); S.imv = new Map(); S.roomTyping = new Map(); S.pendingExpire = []; S.cardCache = new Map();
  for (const id of ["qsDialog", "savedDialog"]) $(id).style.display = "none";
  hideCard(); setExpire(0); applyImv();
  S.replyTo = null; S.editing = null; $("composerBar").style.display = "none"; $("pinBar").style.display = "none";
  S.redactions.clear(); S.admin = false; S.announcement = null; $("btnAnnounce").style.display = "none"; setOnlineCount(0);
  S.csReq = null; S.csChain = null; S.roomDialogFor = null;
  for (const t of S.typing.values()) clearTimeout(t);
  S.typing.clear(); S.typingTo = null; $("typing").textContent = ""; hideMenu();
  S.inPresence = false; S.presenceReady = false; S.announced = false;
  S.pw = null; S.link = null; S.selfAccount = null; S.claiming = null; S.svcQueue = [];
  clearTimeout(S.pwChange?.timer); S.pwChange = null; S.roomList = null; S.listBuf = null;
  $("roomBrowser").style.display = "none"; $("pwDialog").style.display = "none";
  $("profileDialog").style.display = "none"; $("confDialog").style.display = "none";
  clearTimeout(S.infoReq?.timer); S.infoReq = null; clearTimeout(S.profileSave?.timer); S.profileSave = null;
  S.myProfile = null; S.pendingConf = null; S.confEnded = null;
  $("pfSave").disabled = false; $("pfSave").textContent = "Save Profile";
  $("pwSave").disabled = false; $("pwSave").textContent = "Change Password"; S.myStatus = { code: "available", text: "" };
  clearTimeout(S.presenceTimer);
  logEl.innerHTML = "";
  updateTitle();
  syncStatusUi();
  refreshSide();
  setPhase("offline", message, isError);
}

/* JOIN, remembering that this device asked for it (see onJoin). */
function joinRoom(name, key = "") {
  (S.joining ||= new Set()).add(keyOf(name));
  send(`JOIN ${name}${key ? " " + key : ""}`);
}

const normRoom = (name) => { name = name.trim().replace(/\s+/g, "-"); return !name ? "" : isChannel(name) ? name : "#" + name; };

function joinOrSwitch(name) {
  name = normRoom(name);
  if (!name) return;
  if (conv(keyOf(name))?.kind === "room") switchTo(name);
  else joinRoom(name);
}

/* ---------- create room: settings first ---------- */

/* Typed room names (Join box, Rooms → Create, /join): an existing room is
 * joined straight away; a new one first gets the Create Room dialog, and
 * the room only comes into being when the person confirms. */
async function joinOrCreate(name) {
  name = normRoom(inviteRoom(name) || name);
  if (!name) return;
  if (conv(keyOf(name))?.kind === "room") { switchTo(name); return; }
  if (isConference(name) || !/^[#&][^\s,\x07]{1,49}$/.test(name)) { joinRoom(name); return; }
  const exists = await roomExists(name);
  if (exists) joinRoom(name);
  else openCreateRoom(name);
}

/* LIST <name>: a visible room answers 322. Registered rooms always show up
 * (ChanServ stays in them); an unknown answer counts as "new". */
function roomExists(name) {
  return new Promise((resolve) => {
    const probe = { key: keyOf(name), found: false };
    probe.done = (v) => { clearTimeout(probe.timer); if (S.listProbe === probe) S.listProbe = null; resolve(v); };
    probe.timer = setTimeout(() => probe.done(false), 5000);
    S.listProbe = probe;
    send(`LIST ${name}`);
  });
}

function openCreateRoom(name) {
  S.createName = name;
  $("crTitle").textContent = `Create “${roomName(name)}”`;
  for (const id of ["crTopic", "crKey", "crLimit", "crWelcome"]) $(id).value = "";
  $("crPrivate").checked = false; $("crHidden").checked = false;
  const owned = S.link === "linked";
  $("crOwnerHint").textContent = owned
    ? "This room doesn't exist yet. It will be yours: it stays even when everyone leaves."
    : "This room doesn't exist yet. It will disappear when everyone leaves.";
  $("crWelcomeBox").style.display = owned ? "" : "none";
  showMsg("crMsg", "");
  $("createRoomDialog").style.display = "";
  $("crTopic").focus();
}

function closeCreateRoom() { $("createRoomDialog").style.display = "none"; S.createName = null; }

function confirmCreateRoom() {
  const name = S.createName;
  if (!name) return;
  const limit = parseInt($("crLimit").value, 10) || 0;
  if ($("crLimit").value && (limit < 2 || limit > 9999)) { showMsg("crMsg", "Max people must be between 2 and 9999.", "error"); return; }
  S.pendingCreate = {
    key: keyOf(name),
    topic: cleanField($("crTopic").value).slice(0, 300),
    private: $("crPrivate").checked,
    hidden: $("crHidden").checked,
    password: $("crKey").value.trim().replace(/\s+/g, ""),
    limit,
    welcome: cleanField($("crWelcome").value).slice(0, 200),
  };
  closeCreateRoom();
  joinRoom(name);
}

/* The new room exists and we're its op: apply what the dialog asked for.
 * Registered → ChanServ MLOCK (Atheme locks -lk by default, and MLOCK keeps
 * the settings while the room is empty); otherwise plain MODE. */
function applyCreateSettings(c, registered) {
  const p = S.pendingCreate;
  if (!p || p.key !== keyOf(c.name)) return;
  S.pendingCreate = null;
  if (p.topic) send(`TOPIC ${c.name} :${p.topic}`);
  const on = (p.private ? "i" : "") + (p.hidden ? "s" : "") + (p.password ? "k" : "") + (p.limit ? "l" : "");
  const args = [p.password, p.limit ? String(p.limit) : ""].filter(Boolean);
  if (registered) {
    const lines = [`PRIVMSG ChanServ :SET ${c.name} MLOCK +nt${on}${args.length ? " " + args.join(" ") : ""}`];
    if (p.welcome) lines.push(`PRIVMSG ChanServ :SET ${c.name} ENTRYMSG ${p.welcome}`);
    serviceQueue(lines);
  } else if (on) {
    send(`MODE ${c.name} +${on}${args.length ? " " + args.join(" ") : ""}`);
  }
  const bits = [p.private && "private", p.hidden && "hidden", p.password && "password-protected",
    p.limit && `up to ${p.limit} people`].filter(Boolean);
  if (bits.length) sys(`Room settings: ${bits.join(", ")}. Change them any time with ⚙️ Settings.`, "system", c.name);
}

/* Leave a room. soju forgets it too, so it won't come back at next sign-in;
 * it can be rejoined any time from 🔍 Rooms. */
function leaveRoom(c) {
  if (!c || c.kind !== "room") return;
  (S.leaving ||= new Set()).add(keyOf(c.name));
  send(`PART ${c.name} :${isConference(c.name) ? "Left the conference" : "Left the room"}`);
}

function openPm(nick) {
  if (!nick || keyOf(nick) === keyOf(S.me)) return;
  getConv(nick, "pm");
  switchTo(nick);
}

function closePm(c) {
  S.convs.delete(keyOf(c.name));
  if (S.current === keyOf(c.name)) { S.current = null; switchTo(rooms().at(-1)?.name || null); renderLog(); }
  refreshSide();
}

function sendTo(target, body) {
  send(`PRIVMSG ${target} :${body}`);
  if (!isChannel(target)) setTimeout(() => autoReply(target), 300);
  // Without echo-message the server won't send our own message back.
  if (!has("echo-message")) addMsg(target, { who: S.me, txt: body, cls: "me", others: false });
}

function sendChat() {
  const text = $("input").value.trim();
  if (!text) return;
  $("input").value = "";
  // Power-user shortcuts still work, but nothing on screen relies on them.
  if (S.editing) { saveEdit(text); return; }
  if (text.startsWith("/join ")) { joinOrCreate(text.slice(6)); return; }
  if (/^\/remind\b/.test(text)) { addReminder(text.replace(/^\/remind\s*/, "")); return; }
  if (/^\/poll\b/.test(text)) {
    const pc = S.current && conv(S.current);
    if (pc?.kind !== "room") { sys("Polls work in chat rooms.", "tip"); return; }
    createPoll(pc, text.replace(/^\/poll\s*/, ""));
    return;
  }
  if (/^\/me\s+\S/.test(text)) {               // action: "* alice waves"
    const c = S.current && conv(S.current);
    if (!c || c.kind === "status") { sys("Join a room first, then say hi!", "tip"); return; }
    stopTyping();
    sendTo(c.name, `\x01ACTION ${text.replace(/^\/me\s+/, "")}\x01`);
    return;
  }
  if (text.startsWith("/part ")) { send(`PART ${text.slice(6).trim()}`); return; }
  if (text.startsWith("/msg ")) {
    const i = text.indexOf(" ", 5);
    if (i > 0) { const nick = text.slice(5, i).trim(); openPm(nick); sendTo(nick, text.slice(i + 1)); }
    return;
  }
  const c = S.current && conv(S.current);
  if (!c || c.kind === "status") { sys("Join a room first, then say hi!", "tip"); return; }
  if (needsTzConfirm(c)) {
    $("input").value = text;               // keep it until they decide
    askTzConfirm(c, () => sendChat());     // the text is still in the box; tzOk lets it through
    return;
  }
  stopTyping();
  const body = withReply(styled(text));
  if (S.expireAfter) (S.pendingExpire ||= []).push({ conv: keyOf(c.name), txt: body, after: S.expireAfter });
  sendTo(c.name, body);
  noteRoomActivity(c);
}

async function doCreateAccount() {
  const username = $("cuser").value.trim().toLowerCase();
  const password = $("cpass").value;
  const email = $("cemail").value.trim();
  if (!username || !password) { showMsg("createMsg", "Please choose an ID and a password.", "error"); return; }
  if (!EMAIL_RE.test(email)) { showMsg("createMsg", "Please enter a valid email address.", "error"); return; }
  if (!/^[a-z][a-z0-9_-]{2,15}$/.test(username)) {
    showMsg("createMsg", "ID must be 3–16 letters or numbers and start with a letter.", "error"); return;
  }
  if (password.length < 8) { showMsg("createMsg", "Password must be at least 8 characters.", "error"); return; }
  if (/\s/.test(password)) { showMsg("createMsg", "Password can't contain spaces.", "error"); return; }
  if (password !== $("cpass2").value) { showMsg("createMsg", "Passwords don't match.", "error"); return; }

  const btn = $("btnCreate");
  btn.disabled = true; btn.textContent = "Creating…";
  showMsg("createMsg", "");
  try {
    const res = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      showMsg("createMsg", data.error || "Couldn't create the account right now. Please try again later.", "error");
      return;
    }
    // Account ready: carry the credentials over and sign straight in.
    $("buser").value = data.username || username;
    $("bpass").value = password;
    $("cuser").value = $("cpass").value = $("cpass2").value = $("cemail").value = "";
    showCreate(false);
    showMsg("signinMsg", "Account created! Signing you in…", "ok");
    doSignIn();
  } catch {
    showMsg("createMsg", "Can't reach a09f right now. Please try again later.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Create Account";
  }
}

/* ---------- forgot password (emailed code) ---------- */

async function sendResetCode() {
  const username = $("ruser").value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,15}$/.test(username)) { showMsg("resetMsg", "Please enter your a09f ID.", "error"); return; }
  const btn = $("btnSendCode");
  btn.disabled = true; btn.textContent = "Sending…";
  showMsg("resetMsg", "");
  try {
    const { ok, data } = await accountApi("/reset/request", { username });
    if (!ok) { showMsg("resetMsg", data.error || "Couldn't send the email right now. Please try again later.", "error"); return; }
    $("resetStep2").style.display = "";
    btn.textContent = "Send a New Code";
    showMsg("resetMsg", `We emailed a 6-digit code to ${data.email}. It works for 15 minutes.`, "ok");
    $("rcode").focus();
  } catch {
    showMsg("resetMsg", OFFLINE_MSG, "error");
  } finally {
    btn.disabled = false;
    if (btn.textContent === "Sending…") btn.textContent = "Email Me a Code";
  }
}

async function doResetPassword() {
  const username = $("ruser").value.trim().toLowerCase();
  const code = $("rcode").value.trim(), password = $("rpass").value;
  if (!/^\d{6}$/.test(code)) { showMsg("resetMsg", "Please enter the 6-digit code from the email.", "error"); return; }
  if (password.length < 8) { showMsg("resetMsg", "Password must be at least 8 characters.", "error"); return; }
  if (/\s/.test(password)) { showMsg("resetMsg", "Password can't contain spaces.", "error"); return; }
  if (password !== $("rpass2").value) { showMsg("resetMsg", "Passwords don't match.", "error"); return; }
  const btn = $("btnReset");
  btn.disabled = true; btn.textContent = "Resetting…";
  try {
    const { ok, data } = await accountApi("/reset/confirm", { username, code, password });
    if (!ok) { showMsg("resetMsg", data.error || "Couldn't reset your password. Please try again.", "error"); return; }
    resetResetForm();
    showScreen("signin");
    $("buser").value = username; $("bpass").value = "";
    $("bpass").focus();
    showMsg("signinMsg", "Your password was changed. Sign in with your new password.", "ok");
  } catch {
    showMsg("resetMsg", OFFLINE_MSG, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Reset Password";
  }
}

function resetResetForm() {
  for (const id of ["rcode", "rpass", "rpass2"]) $(id).value = "";
  $("resetStep2").style.display = "none";
  $("btnSendCode").textContent = "Email Me a Code";
}

/* ---------- recovery email (signed in) ---------- */

async function loadRecoveryEmail() {
  $("pwEmail").value = ""; $("pwEmail").disabled = true; $("pwEmailSave").disabled = true;
  showMsg("pwEmailMsg", "Loading…");
  try {
    const { ok, data } = await accountApi("/email", { username: S.account, password: S.pw });
    if (!ok) { showMsg("pwEmailMsg", data.error || "Couldn't load your recovery email.", "error"); return; }
    $("pwEmail").value = data.email || "";
    showMsg("pwEmailMsg", data.email ? "" : "No recovery email yet: add one so you can reset a forgotten password.",
            data.email ? "" : "error");
  } catch {
    showMsg("pwEmailMsg", OFFLINE_MSG, "error");
  } finally {
    $("pwEmail").disabled = false; $("pwEmailSave").disabled = false;
  }
}

async function saveRecoveryEmail() {
  const email = $("pwEmail").value.trim();
  if (!EMAIL_RE.test(email)) { showMsg("pwEmailMsg", "Please enter a valid email address.", "error"); return; }
  $("pwEmailSave").disabled = true;
  try {
    const { ok, data } = await accountApi("/email", { username: S.account, password: S.pw, email });
    if (!ok) { showMsg("pwEmailMsg", data.error || "Couldn't save your recovery email.", "error"); return; }
    S.hasEmail = true;
    showMsg("pwEmailMsg", "Recovery email saved.", "ok");
  } catch {
    showMsg("pwEmailMsg", OFFLINE_MSG, "error");
  } finally {
    $("pwEmailSave").disabled = false;
  }
}

/* Once per sign-in: nudge accounts that can't reset their password yet. */
async function checkRecoveryEmail() {
  try {
    const { ok, data } = await accountApi("/email", { username: S.account, password: S.pw });
    if (ok && !data.email && S.phase === "online") {
      sys("Add a recovery email in 🔑 Password so you can reset your password if you ever forget it.", "tip");
    }
  } catch { /* account service down: not worth bothering anyone */ }
}

/* ---------- remember me, auto sign-in, start at login ---------- */

/* The ID and the checkboxes live in localStorage; the password only ever in
 * the OS keychain (Rust cred_* commands). */
const LS = { lastId: "a09f.lastId", remember: "a09f.remember", auto: "a09f.autoSignIn" };

async function initSignInOptions() {
  const remember = localStorage.getItem(LS.remember) === "1";
  const auto = remember && localStorage.getItem(LS.auto) === "1";
  $("optRemember").checked = remember;
  $("optAuto").checked = auto;
  invoke("plugin:autostart|is_enabled").then((on) => { $("optStartup").checked = !!on; }).catch(() => {
    $("optStartup").closest("label").style.display = "none";
  });
  const id = localStorage.getItem(LS.lastId) || "";
  if (!remember || !id) return;
  $("buser").value = id;
  const pw = await invoke("cred_load", { account: id }).catch(() => null);
  if (pw) $("bpass").value = pw;
  if (auto && pw) doSignIn();
  else $(pw ? "btnSignIn" : "bpass").focus();
}

/* Signed in: remember (or forget) this ID and password. */
function rememberLogin() {
  localStorage.setItem(LS.lastId, S.account);
  if ($("optRemember").checked) invoke("cred_save", { account: S.account, password: S.pw }).catch(() => {});
  else invoke("cred_clear", { account: S.account }).catch(() => {});
}

/* The saved password stopped working (changed elsewhere / reset). */
function forgetSavedPassword() {
  if (!S.account) return;
  invoke("cred_clear", { account: S.account }).catch(() => {});
  $("bpass").value = "";
}

function onRememberToggle() {
  const on = $("optRemember").checked;
  localStorage.setItem(LS.remember, on ? "1" : "0");
  if (!on) {
    $("optAuto").checked = false;
    localStorage.setItem(LS.auto, "0");
    const id = localStorage.getItem(LS.lastId);
    if (id) invoke("cred_clear", { account: id }).catch(() => {});
  }
}

function onAutoToggle() {
  const on = $("optAuto").checked;
  if (on && !$("optRemember").checked) { $("optRemember").checked = true; onRememberToggle(); }
  localStorage.setItem(LS.auto, on ? "1" : "0");
}

function onStartupToggle() {
  const on = $("optStartup").checked;
  invoke(on ? "plugin:autostart|enable" : "plugin:autostart|disable").catch(() => {
    $("optStartup").checked = !on;
  });
}

/* ---------- wiring ---------- */

$("signinForm").addEventListener("submit", (e) => { e.preventDefault(); doSignIn(); });
$("createForm").addEventListener("submit", (e) => { e.preventDefault(); doCreateAccount(); });
$("toCreate").onclick = () => showCreate(true);
$("toReset").onclick = () => { $("ruser").value = $("buser").value.trim(); resetResetForm(); showScreen("reset"); };
$("resetToSignIn").onclick = () => showScreen("signin");
$("btnSendCode").onclick = sendResetCode;
$("resetForm").addEventListener("submit", (e) => { e.preventDefault(); doResetPassword(); });
$("ruser").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendResetCode(); } });
$("pwEmailSave").onclick = saveRecoveryEmail;
$("pwEmail").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveRecoveryEmail(); } });
$("toSignIn").onclick = () => showCreate(false);
$("btnConnect").onclick = () => doDisconnect("You've signed out.");
$("btnSend").onclick = sendChat;
$("input").addEventListener("keydown", (e) => {
  if (onMentionKey(e)) return;
  if (e.key === "Enter") sendChat();
  if (e.key === "Escape" && $("composerBar").style.display !== "none") {
    if (S.editing) $("input").value = "";
    clearComposerBar();
  }
});
$("composerBarX").onclick = () => { if (S.editing) $("input").value = ""; clearComposerBar(); };
$("input").addEventListener("input", updateMentionBox);
$("input").addEventListener("blur", () => setTimeout(hideMentionBox, 150));
$("btnJoin").onclick = () => { joinOrCreate($("newChan").value); $("newChan").value = ""; };
$("crClose").onclick = closeCreateRoom;
$("crCancel").onclick = closeCreateRoom;
$("crCreate").onclick = confirmCreateRoom;
$("createRoomDialog").addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCreateRoom();
  if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "checkbox") confirmCreateRoom();
});
$("newChan").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnJoin").click(); });
$("statusSel").onchange = () => {
  const code = $("statusSel").value;
  if (code === "custom") { syncCustomBox(); $("statusText").focus(); return; }
  setMyStatus(code, "");
};
function syncCustomBox() { $("statusCustom").style.display = ""; }
$("btnStatusSet").onclick = () => setMyStatus("custom", $("statusText").value.trim());
$("statusText").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnStatusSet").click(); });
$("btnAddFriend").onclick = () => toggleAddFriend(true);
$("btnRooms").onclick = openRoomBrowser;
$("btnPassword").onclick = openPwDialog;
$("btnProfile").onclick = () => openProfile(S.me);
$("btnConference").onclick = () => openConfDialog(null);
$("pfClose").onclick = closeProfile;
$("profileForm").addEventListener("submit", (e) => { e.preventDefault(); saveProfile(); });
$("profileDialog").addEventListener("keydown", (e) => { if (e.key === "Escape") closeProfile(); });
$("pfMessage").onclick = () => { const n = S.profileNick; closeProfile(); openPm(n); };
$("pfAddFriend").onclick = () => { addFriend(S.profileNick); $("pfAddFriend").style.display = "none"; };
$("cfClose").onclick = closeConfDialog;
$("confForm").addEventListener("submit", (e) => { e.preventDefault(); doConference(); });
$("confDialog").addEventListener("keydown", (e) => { if (e.key === "Escape") closeConfDialog(); });
logEl.addEventListener("click", (e) => {
  const a = e.target.closest("a.link");
  if (a) { e.preventDefault(); openLink(a.dataset.url); return; }
  const b = e.target.closest(".invite-join");
  if (b) joinOrSwitch(b.dataset.room);
  const k = e.target.closest(".knock-btn");
  if (k) { knock(k.dataset.room); k.disabled = true; k.textContent = "Asked ✓"; }
  const li = e.target.closest(".letin-btn");
  if (li && S.current) { letIn(S.current, li.dataset.nick); li.disabled = true; li.textContent = "Invited ✓"; }
  const kj = e.target.closest(".key-join");
  if (kj) {
    const key = kj.parentElement.querySelector(".key-input")?.value.trim();
    if (key) joinRoom(kj.dataset.room, key);
  }
});
$("pwClose").onclick = closePwDialog;
$("pwForm").addEventListener("submit", (e) => { e.preventDefault(); doChangePassword(); });
$("pwDialog").addEventListener("keydown", (e) => { if (e.key === "Escape") closePwDialog(); });
$("rbClose").onclick = closeRoomBrowser;
$("rbRefresh").onclick = refreshRoomList;
$("rbSearch").addEventListener("input", renderRoomBrowser);
$("rbCreate").onclick = () => {
  const name = $("rbNew").value.trim();
  if (!name) { $("rbNew").focus(); return; }
  $("rbNew").value = "";
  closeRoomBrowser();
  joinOrCreate(name);
};
$("rbNew").addEventListener("keydown", (e) => { if (e.key === "Enter") $("rbCreate").click(); });
$("roomBrowser").addEventListener("keydown", (e) => { if (e.key === "Escape") closeRoomBrowser(); });
$("friendAddCancel").onclick = () => toggleAddFriend(false);
$("friendAddOk").onclick = submitAddFriend;
$("friendAddName").addEventListener("input", () => showAddMsg(""));
for (const id of ["friendAddName", "friendAddNote", "friendAddNewGroup"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAddFriend();
    if (e.key === "Escape") toggleAddFriend(false);
  });
}
$("friendAddGroup").onchange = () => {
  const isNew = $("friendAddGroup").value === "__new__";
  $("friendAddNewGroup").style.display = isNew ? "" : "none";
  if (isNew) $("friendAddNewGroup").focus();
};
$("input").addEventListener("input", onComposerInput);
$("btnPrivacy").onclick = openPrivacy;
$("btnSaved").onclick = openSaved;
$("svClose").onclick = closeSaved;
$("savedDialog").addEventListener("keydown", (e) => { if (e.key === "Escape") closeSaved(); });
$("btnDark").onclick = () => setDark(!document.body.classList.contains("dark"));
setDark(localStorage.getItem("a09f.dark") === "1");
$("fmtExpire").onclick = (e) => { e.stopPropagation(); expireMenu(e); };
$("fmtSchedule").onclick = (e) => { e.stopPropagation(); scheduleMenu(e); };
listen("deep-link", (e) => {
  const room = inviteRoom(String(e.payload || ""));
  if (!room) return;
  if (S.phase === "online" && S.burstDone) joinOrCreate(room); else S.pendingDeepLink = room;
}).catch(() => {});
$("evClose").onclick = closeRoomEvents;
$("evCreate").onclick = createEvent;
$("eventsDialog").addEventListener("keydown", (e) => { if (e.key === "Escape") closeRoomEvents(); });
$("rdCatSave").onclick = saveRoomCategory;
fillSelect($("rdCategory"), ROOM_CATEGORIES);
fillSelect($("rdLang"), ROOM_LANGS);
fillSelect($("rbCat"), ROOM_CATEGORIES, ["", "All categories"]);
fillSelect($("rbLang"), ROOM_LANGS.slice(1), ["", "All languages"]);
$("rbCat").onchange = renderRoomBrowser;
$("rbLang").onchange = renderRoomBrowser;
$("pfNote").addEventListener("input", () => S.profileNick && saveNote(S.profileNick, $("pfNote").value));
$("pfActiveAlways").onchange = saveActive;
$("pfActiveFrom").onchange = saveActive;
$("pfActiveTo").onchange = saveActive;
$("qsInput").addEventListener("input", () => { S.qsSel = 0; renderSwitcher(); });
$("qsInput").addEventListener("keydown", onSwitcherKey);
$("qsDialog").addEventListener("mousedown", (e) => { if (e.target === $("qsDialog")) closeSwitcher(); });
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSwitcher(); }
});
$("btnAnnounce").onclick = openAnnounce;
$("anClose").onclick = closeAnnounce;
$("anSend").onclick = sendAnnouncement;
$("annDialog").addEventListener("keydown", (e) => { if (e.key === "Escape") closeAnnounce(); });
$("annClose").onclick = dismissAnnouncement;
$("fmtAction").onclick = () => {
  const inp = $("input");
  if (!inp.value.startsWith("/me ")) inp.value = "/me " + inp.value;
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
};
$("rdClose").onclick = closeRoomDialog;
$("roomDialog").addEventListener("keydown", (e) => { if (e.key === "Escape") closeRoomDialog(); });
for (const id of ["rdPrivate", "rdHidden", "rdAnnounce", "rdKey", "rdLimit"]) $(id).addEventListener("input", () => { S.roomFormDirty = true; });
$("rdSave").onclick = saveRoomSettings;
$("rdWelcomeSave").onclick = saveWelcome;
$("rdGive").onclick = giveRoom;
$("rdDelete").onclick = deleteRoom;
$("pvClose").onclick = closePrivacy;
$("pvFriendsOnly").onchange = onFriendsOnlyToggle;
$("privacyDialog").addEventListener("keydown", (e) => { if (e.key === "Escape") closePrivacy(); });
$("fdClose").onclick = closeFind;
$("fdGo").onclick = doFind;
$("fdQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") doFind(); if (e.key === "Escape") closeFind(); });
$("toFind").onclick = () => { toggleAddFriend(false); openFind(); };
$("emptyFind").onclick = openFind;
$("srClose").onclick = closeSearch;
$("srGo").onclick = doSearch;
$("srQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); if (e.key === "Escape") closeSearch(); });
$("fmtB").onclick = () => { setStyle({ b: !S.style.b }); $("input").focus(); };
$("fmtI").onclick = () => { setStyle({ i: !S.style.i }); $("input").focus(); };
$("fmtU").onclick = () => { setStyle({ u: !S.style.u }); $("input").focus(); };
$("fmtColor").onclick = (e) => { e.stopPropagation(); colorMenu(e); };
$("fmtMore").onclick = (e) => { e.stopPropagation(); smileyMenu(e); };
loadStyle();

listen("irc-line", (e) => handleLine(e.payload))
  .catch(() => setPhase("offline", "Something went wrong starting a09f. Please restart the app.", true));
listen("irc-closed", () => {
  if (S.phase === "offline" || S.authFailed) return;
  const wasOnline = S.phase === "online";
  doDisconnect(wasOnline ? "You were signed out because the connection was lost."
                         : "Can't sign in right now. Please try again later.", true);
}).catch(() => {});

/* ---------- messenger chrome ---------- */

document.querySelectorAll("[data-toggle]").forEach((g) => {
  g.onclick = () => g.classList.toggle("collapsed");
});
function insertEmote(code) {
  const inp = $("input");
  inp.value += (inp.value && !inp.value.endsWith(" ") ? " " : "") + code + " ";
  inp.focus();
}
document.querySelectorAll("#fmtbar [data-emo]").forEach((b) => {
  b.onclick = () => insertEmote(b.dataset.emo);
});
$("btnEmote").onclick = () => insertEmote(":)");
$("btnBuzz").onclick = sendBuzz;
$("btnSound").onclick = (e) => { e.stopPropagation(); soundMenu(e); };
setMuted(Sound.muted);

$("optRemember").onchange = onRememberToggle;
$("optAuto").onchange = onAutoToggle;
$("optStartup").onchange = onStartupToggle;
listen("tray-signout", () => { if (S.phase !== "offline") doDisconnect("You've signed out."); }).catch(() => {});

setPhase("offline");
$("buser").focus();
initSignInOptions();
