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
const REGISTER_URL = "http://127.0.0.1:16680/register";   // server/register service
const DEFAULT_ROOM = "#lobby";    // everyone lands here if they're in no room yet
const BURST_TOKEN = "a09f-burst-done";
/* Hidden room every a09f app joins (server/scripts/setup-rooms.py). It carries
 * status messages ("STATUS busy …", kept in soju history) and, because
 * everyone shares it, live Online/Offline changes via away-notify. */
const PRESENCE_ROOM = "#a09f-presence";
const PRESENCE_HISTORY = 500;
const HISTORY_LIMIT = 100;        // messages fetched per conversation
const TARGETS_DAYS = 30;          // private chats active within this window are restored
const MAX_BUFFER = 500;

/* IRCv3 capabilities we use when the server offers them. */
const WANTED_CAPS = ["sasl", "server-time", "message-tags", "batch", "echo-message", "away-notify",
                     "draft/chathistory", "draft/read-marker"];

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
  friends: [],            // nicks, persisted in localStorage
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
  const c = target ? getConv(target, isChannel(target) ? "room" : "pm")
                   : (S.current && conv(S.current)) || getConv(STATUS, "status");
  if (m.id && c.ids.has(m.id)) return;
  if (m.id) c.ids.add(m.id);
  m.time = m.time || Date.now();
  m.live = !history;
  if (history && c.msgs.length && c.msgs[c.msgs.length - 1].time > m.time) {
    let i = c.msgs.length;
    while (i > 0 && c.msgs[i - 1].time > m.time) i--;
    c.msgs.splice(i, 0, m);
  } else {
    c.msgs.push(m);
  }
  if (c.msgs.length > MAX_BUFFER) c.msgs.shift();

  const key = keyOf(c.name);
  if (key === S.current) {
    if (history) renderLog(); else renderMsg(m);
    // Only count it as read if the person can actually see the window.
    if (m.others) { if (S.focused) markRead(c); else { recountUnread(c); renderLists(); } }
  } else if (m.others) {
    recountUnread(c);
    renderLists();
  }
  if (!history && m.others && S.burstDone) onIncoming(c, m);
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
  c.unread = c.msgs.filter((m) => m.others && (c.readAt != null ? m.time > c.readAt : m.live)).length;
}

function markRead(c) {
  const latest = c.msgs.reduce((t, m) => (m.others || m.cls === "me" ? Math.max(t, m.time) : t), 0);
  c.unread = 0;
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
  const c = conv(keyOf(target));
  if (!c) return;
  c.historyDone = true;
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
  const inv = action && txt.match(INVITE_RE);
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

/* Sign In <-> Create Account screens */
function showCreate(on) {
  $("signin").classList.toggle("create", on);
  showMsg("signinMsg", ""); showMsg("createMsg", "");
  $(on ? "cuser" : "buser").focus();
}

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
  let txt = m.buzz ? "BUZZ!!!" : emote(esc(m.txt));
  if (m.invite) {
    const inRoom = conv(keyOf(m.invite))?.kind === "room";
    txt = m.others
      ? `invited you to a conference 🗣️ <button class="invite-join" data-room="${esc(m.invite)}">${inRoom ? "Open" : "Join"}</button>`
      : "sent a conference invite 🗣️";
  }
  div.innerHTML = `<span class="time">${esc(fmtTime(m.time))}</span>` +
    `<span class="who">${esc(m.who)}:</span> <span class="txt">${txt}</span>`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderLog() {
  logEl.innerHTML = "";
  for (const m of conv(S.current || STATUS)?.msgs || []) renderMsg(m);
}

function switchTo(key) {
  key = key && keyOf(key);
  if (key === S.current) return;
  S.current = key;
  const c = key && conv(key);
  if (c) { fetchHistory(c); markRead(c); }
  renderLog();
  refreshSide();
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
  for (const c of rooms()) {
    const item = convItem(c, "chan", () => leaveRoom(c));
    item.querySelector(".close").title = "Leave this room";
    roomsEl.appendChild(item);
  }
  pmsEl.innerHTML = "";
  const list = pms().sort((a, b) => (b.msgs.at(-1)?.time || 0) - (a.msgs.at(-1)?.time || 0));
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
  for (const nick of people.sort((a, b) => a.localeCompare(b))) {
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
    d.appendChild(name);
    d.appendChild(profileButton(nick));
    if (st.state !== "unknown") {
      const sl = document.createElement("span");
      sl.className = "status-text";
      sl.textContent = st.label;
      d.appendChild(sl);
    }
    if (!self) {
      d.title = `Chat privately with ${nick} (${st.label})`;
      d.onclick = () => openPm(nick);
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
    title += ` <button id="btnLeave" class="title-btn" title="Leave this room">🚪 Leave</button>`;
  } else if (c?.kind === "pm") {
    title = `Private chat with ${esc(c.name)}` +
      ` <button id="btnPmProfile" class="title-btn" title="See ${esc(c.name)}'s profile">👤 Profile</button>`;
  }
  $("chatTitle").innerHTML = title;
  if ($("btnTopic")) $("btnTopic").onclick = () => editTopic(c);
  if ($("btnLeave")) $("btnLeave").onclick = () => leaveRoom(c);
  if ($("btnInvite")) $("btnInvite").onclick = () => openConfDialog(c);
  if ($("btnPmProfile")) $("btnPmProfile").onclick = () => openProfile(c.name);
  $("input").placeholder = c?.kind === "pm" ? `Message ${c.name}…` : "Type your message here…";
  $("btnBuzz").disabled = c?.kind !== "pm";
  $("btnBuzz").title = c?.kind === "pm" ? `BUZZ! ${c.name}` : "Open a private chat to BUZZ someone";
}

/* ---------- IRC event handling ---------- */

function onWelcome(nick) {
  S.me = nick;
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
  if (rooms().length === 0) send(`JOIN ${DEFAULT_ROOM}`);
  if (!S.inPresence) send(`JOIN ${PRESENCE_ROOM}`);
  for (const c of rooms()) fetchHistory(c);
  fetchPrivateChats();
  startPresence();
  checkAccountLink();
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
    if (S.burstDone) {
      sys(`You joined ${roomLabel(channel)}`, "system", channel); fetchHistory(c);
      c.justJoined = true;      // onNames decides whether this is a brand-new room
    }
    S.current = null;          // force switchTo to re-render
    switchTo(channel);
  } else if (!isService(fromNick)) {          // ChanServ & co. come and go silently
    addMsg(channel, { who: fromNick, txt: isConference(channel) ? "joined the conference" : "joined the room", cls: "action" });
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
  if (!isService(fromNick)) addMsg(channel, { who: fromNick, txt: isConference(channel) ? "left the conference" : "left the room", cls: "action" });
  refreshSide();
}

function onQuit(fromNick) {
  for (const c of rooms()) {
    if (c.members.delete(fromNick) && !isService(fromNick)) addMsg(c.name, { who: fromNick, txt: "signed out", cls: "action" });
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
  404: "You can't send messages to this room.",
  405: "You've joined too many rooms.",
  471: "That room is full.",
  473: "That room is invite-only.",
  474: "You're banned from that room.",
  475: "That room needs a password.",
  477: "You need a registered name to join that room.",
  401: "There's no a09f user with that ID.",
  482: "Only the owner can do that.",
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
    case 321: S.listBuf = []; return;                                             // LIST start
    case 322: S.listBuf?.push({ name: params[1], users: +params[2] || 0, topic: trailing || "" }); return;
    case 323: S.roomList = S.listBuf || []; S.listBuf = null; S.listLoading = false; renderRoomBrowser(); return;
    case 311: case 301: case 318: case 401:
      if (num === 318 && keyOf(params[1]) === keyOf(S.me) && S.link === "checking") { onSelfWhoisDone(); return; }
      if (onWhoisReply(num, params, trailing)) return;
      break;
    case 730: onMonitor(trailing, true); return;
    case 731: onMonitor(trailing, false); return;
    // SASL finished (success or failure): end CAP negotiation so registration completes.
    case 903: send("CAP END"); return;
    case 902: case 904: case 905: case 906: case 907:
      S.authFailed = true;
      send("CAP END");
      doDisconnect("Wrong ID or password. Please try again.", true);
      return;
  }
  if (num === 401 && params[1]) { sysError(`There's no a09f user with the ID "${params[1]}".`); return; }
  if (num === 473 && isConference(params[1])) { sysError("You need a new invite to join this conference."); return; }
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
        if (type === "chathistory" || type === "draft/chathistory-targets") {
          S.batches.set(ref, { type, params: params.slice(2), lines: [] });
        }
      } else {
        const b = S.batches.get(ref);
        S.batches.delete(ref);
        if (b?.type === "chathistory") onHistoryBatch(b.params[0], b.lines);
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
  custom:    { label: "",              state: "online" },
};

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
  requestAnimationFrame(() => { S.renderQueued = false; renderLists(); renderUsers(); });
}

/* "STATUS <code> [text]" posted in PRESENCE_ROOM. Newest line wins. */
function onStatusLine(from, l) {
  const m = (l.params.length > 1 ? l.text || "" : "").match(/^STATUS (\w+)(?: (.*))?$/);
  if (!m || !STATUS_PRESETS[m[1]]) return;
  const time = l.tags.time ? Date.parse(l.tags.time) : Date.now();
  const key = keyOf(from);
  const prev = S.statuses.get(key);
  if (prev && prev.time > time) return;
  const st = { code: m[1], text: (m[2] || "").slice(0, 80), time };
  if (key === keyOf(S.me)) {          // our own status, e.g. set on another device
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
  const { code, text } = S.myStatus;
  if (code !== "available") send(`PRIVMSG ${PRESENCE_ROOM} :STATUS ${code}${text ? " " + text : ""}`);
}

function setMyStatus(code, text) {
  if (code === "custom" && !text) { $("statusText").focus(); return; }
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
  S.friends = loadFriends();
  if (S.friends.length) send(`MONITOR + ${S.friends.join(",")}`);
  requestPresence(S.friends);
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

/* ----- friends list (stored per account on this computer) ----- */

const friendsKey = () => `a09f.friends.${S.account}`;
function loadFriends() {
  try { return JSON.parse(localStorage.getItem(friendsKey())) || []; } catch { return []; }
}
function saveFriends() { localStorage.setItem(friendsKey(), JSON.stringify(S.friends)); }
const isFriend = (nick) => S.friends.some((f) => keyOf(f) === keyOf(nick));

function addFriend(nick) {
  nick = (nick || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}$/.test(nick)) {
    sys("That doesn't look like a valid ID.", "error"); return false;
  }
  if (keyOf(nick) === keyOf(S.me)) { sys("You can't add yourself as a friend.", "tip"); return false; }
  if (isFriend(nick)) { sys(`${nick} is already in your Friends.`, "tip"); return true; }
  // Only real IDs: every a09f account is always on IRC through soju, so a
  // WHOIS that answers 401 (no such nick) means the ID doesn't exist.
  const key = keyOf(nick);
  const q = S.whois.get(key) || { away: false, nick };
  q.add = true;
  if (!S.whois.has(key)) { S.whois.set(key, q); send(`WHOIS ${nick}`); }
  showAddMsg(`Looking up ${nick}…`);
  clearTimeout(q.addTimer);
  q.addTimer = setTimeout(() => {
    if (S.whois.get(key) !== q) return;
    S.whois.delete(key);
    addFailed(nick, "Couldn't check that ID right now. Please try again.");
  }, 8000);
  return false;
}

/* WHOIS confirmed the ID exists: now it's a friend. */
function addConfirmed(nick, away) {
  if (isFriend(nick)) return;
  S.friends.push(nick);
  saveFriends();
  send(`MONITOR + ${nick}`);
  setPresence(nick, { away, exists: true });
  sys(`${nick} was added to your Friends.`, "system");
  toggleAddFriend(false);
  renderLists(); renderUsers();
}

function addFailed(nick, message) {
  if ($("friendAdd").style.display !== "none") showAddMsg(message, "error");
  else sys(message, "error");
}

function showAddMsg(text, kind = "") {
  const el = $("friendAddMsg");
  el.textContent = text;
  el.className = "form-msg" + (kind ? " " + kind : "");
}

function removeFriend(nick) {
  S.friends = S.friends.filter((f) => keyOf(f) !== keyOf(nick));
  saveFriends();
  send(`MONITOR - ${nick}`);
  sys(`${nick} was removed from your Friends.`, "system");
  renderLists(); renderUsers();
}

function toggleAddFriend(on) {
  $("friendAdd").style.display = on ? "" : "none";
  $("friendAddName").value = "";
  showAddMsg("");
  renderFriends();
  if (on) $("friendAddName").focus();
}

const STATE_ORDER = { online: 0, busy: 1, away: 2, unknown: 3, offline: 4 };

function renderFriends() {
  const el = $("friends");
  el.innerHTML = "";
  const list = [...S.friends].sort((a, b) =>
    (STATE_ORDER[statusOf(a).state] - STATE_ORDER[statusOf(b).state]) || a.localeCompare(b));
  for (const nick of list) {
    const st = statusOf(nick);
    const pm = conv(keyOf(nick));
    const d = document.createElement("div");
    d.className = `friend st-${st.state}` + (pm?.unread ? " unread" : "");
    d.title = `${nick} — ${st.label}. Click to chat.`;
    d.innerHTML = `<span class="label">${esc(nick)}</span><span class="status-text">${esc(st.label)}</span>` +
      (pm?.unread ? `<span class="badge">${pm.unread > 99 ? "99+" : pm.unread}</span>` : "") +
      `<span class="close" title="Remove from Friends">×</span>`;
    d.querySelector(".close").onclick = (e) => { e.stopPropagation(); removeFriend(nick); };
    d.insertBefore(profileButton(nick), d.querySelector(".close"));
    d.onclick = () => openPm(nick);
    el.appendChild(d);
  }
  const adding = $("friendAdd").style.display !== "none";   // the add form replaces the hint
  $("friendsEmpty").style.display = list.length || adding ? "none" : "";
  const online = list.filter((n) => statusOf(n).state !== "offline" && statusOf(n).state !== "unknown").length;
  $("friendsCount").textContent = list.length ? ` (${online}/${list.length})` : "";
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
    if (this.muted) return;
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
  $("btnSound").title = m ? "Turn sounds on" : "Turn sounds off";
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
  if (!S.notifyOk) return;
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
    notify(`${m.who}`, m.txt, key);
  } else if (c.kind === "room" && mentionsMe(m.txt)) {
    Sound.play("mention");
    notify(`${m.who} in ${roomName(c.name)}`, m.txt, key);
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
  if (S.selfAccount) { S.link = "linked"; return; }          // already identified (soju SASL)
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
    return;
  }
  S.claiming = c.name;
  serviceQueue([`PRIVMSG ChanServ :REGISTER ${c.name}`]);
}

function onChanServ(text) {
  const t = text.toLowerCase();
  const room = S.claiming;
  if (!room) return;
  if (t.includes("is now registered to")) {
    S.claiming = null;
    serviceQueue([`PRIVMSG ChanServ :SET ${room} GUARD ON`, `PRIVMSG ChanServ :SET ${room} KEEPTOPIC ON`]);
    sys(`🎉 You created ${roomName(room)} — it's your room now. It stays even when everyone leaves, ` +
        `and you can change its topic with ✏️ Topic.`, "system", room);
  } else if (t.includes("too many") || t.includes("maximum")) {
    S.claiming = null;
    sys(`You already own the maximum number of rooms, so ${roomName(room)} will disappear when everyone leaves.`, "tip", room);
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
    const sym = { o: "@", v: "+", q: "~", a: "&", h: "%" }[m];
    if (sym) {
      const nick = args[i++];
      if (!nick || !c.members.has(nick)) continue;
      const pre = c.members.get(nick).replace(sym, "");
      c.members.set(nick, add ? sym + pre : pre);
    } else if ("beIqkfjl".includes(m) && (add || m !== "l")) i++;     // modes that take an argument
  }
  if (keyOf(target) === S.current) refreshSide();
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
}

function pwFail(message) {
  clearTimeout(S.pwChange?.timer);
  S.pwChange = null;
  $("pwSave").disabled = false; $("pwSave").textContent = "Change Password";
  pwMsg(message, "error");
}

/* ---------- room browser ---------- */

function openRoomBrowser() {
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
    .sort((a, b) => b.users - a.users || a.name.localeCompare(b.name));
  el.innerHTML = `<div class="rb-row rb-head"><span>Room</span><span>People</span><span>Topic</span><span></span></div>`;
  if (!list.length) {
    el.insertAdjacentHTML("beforeend", `<div class="rb-empty">${q ? "No rooms match your search." : "No rooms yet — start one below!"}</div>`);
    return;
  }
  for (const r of list) {
    const row = document.createElement("div");
    row.className = "rb-row";
    const joined = conv(keyOf(r.name))?.kind === "room";
    row.innerHTML = `<span class="rname" title="${esc(r.name)}">${esc(roomName(r.name))}</span>` +
      `<span class="rcount">${r.users} ${r.users === 1 ? "person" : "people"}</span>` +
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
  $("cfTitle").textContent = room ? "Invite to Conference" : "Start a Conference";
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
  if (room) { inviteToConference(room, picked); return; }
  const code = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const name = `${CONF_PREFIX}${S.me.toLowerCase()}-${code}`;
  S.pendingConf = { key: keyOf(name), invitees: picked };
  send(`JOIN ${name}`);
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
  $("pfStatus").textContent = st.state === "unknown" ? "" : st.label;
  $("pfDot").className = `pf-dot st-${st.state}`;
  $("pfView").style.display = mine ? "none" : "";
  $("pfEdit").style.display = mine ? "" : "none";
  $("pfAddFriend").style.display = mine || isFriend(nick) ? "none" : "";
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
}

function profileButton(nick) {
  const b = document.createElement("span");
  b.className = "profile-btn";
  b.textContent = "👤";
  b.title = keyOf(nick) === keyOf(S.me) ? "Edit your profile" : `See ${nick}'s profile`;
  b.onclick = (e) => { e.stopPropagation(); openProfile(nick); };
  return b;
}

/* ---------- actions ---------- */

async function doSignIn() {
  const u = $("buser").value.trim();
  if (!u || !$("bpass").value) { setPhase("offline", "Please enter your ID and password.", true); return; }
  S.authFailed = false;
  S.account = u.toLowerCase();
  S.pw = $("bpass").value;          // memory only: used to link the NickServ account
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

function joinOrSwitch(name) {
  name = name.trim().replace(/\s+/g, "-");
  if (!name) return;
  if (!isChannel(name)) name = "#" + name;
  if (conv(keyOf(name))?.kind === "room") switchTo(name);
  else send(`JOIN ${name}`);
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
  // Without echo-message the server won't send our own message back.
  if (!has("echo-message")) addMsg(target, { who: S.me, txt: body, cls: "me", others: false });
}

function sendChat() {
  const text = $("input").value.trim();
  if (!text) return;
  $("input").value = "";
  // Power-user shortcuts still work, but nothing on screen relies on them.
  if (text.startsWith("/join ")) { joinOrSwitch(text.slice(6)); return; }
  if (text.startsWith("/part ")) { send(`PART ${text.slice(6).trim()}`); return; }
  if (text.startsWith("/msg ")) {
    const i = text.indexOf(" ", 5);
    if (i > 0) { const nick = text.slice(5, i).trim(); openPm(nick); sendTo(nick, text.slice(i + 1)); }
    return;
  }
  const c = S.current && conv(S.current);
  if (!c || c.kind === "status") { sys("Join a room first, then say hi!", "tip"); return; }
  sendTo(c.name, text);
}

async function doCreateAccount() {
  const username = $("cuser").value.trim().toLowerCase();
  const password = $("cpass").value;
  if (!username || !password) { showMsg("createMsg", "Please choose an ID and a password.", "error"); return; }
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
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      showMsg("createMsg", data.error || "Couldn't create the account right now. Please try again later.", "error");
      return;
    }
    // Account ready: carry the credentials over and sign straight in.
    $("buser").value = data.username || username;
    $("bpass").value = password;
    $("cuser").value = $("cpass").value = $("cpass2").value = "";
    showCreate(false);
    showMsg("signinMsg", "Account created! Signing you in…", "ok");
    doSignIn();
  } catch {
    showMsg("createMsg", "Can't reach a09f right now. Please try again later.", "error");
  } finally {
    btn.disabled = false; btn.textContent = "Create Account";
  }
}

/* ---------- wiring ---------- */

$("signinForm").addEventListener("submit", (e) => { e.preventDefault(); doSignIn(); });
$("createForm").addEventListener("submit", (e) => { e.preventDefault(); doCreateAccount(); });
$("toCreate").onclick = () => showCreate(true);
$("toSignIn").onclick = () => showCreate(false);
$("btnConnect").onclick = () => doDisconnect("You've signed out.");
$("btnSend").onclick = sendChat;
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
$("btnJoin").onclick = () => { joinOrSwitch($("newChan").value); $("newChan").value = ""; };
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
  const b = e.target.closest(".invite-join");
  if (b) joinOrSwitch(b.dataset.room);
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
  joinOrSwitch(name);
  closeRoomBrowser();
};
$("rbNew").addEventListener("keydown", (e) => { if (e.key === "Enter") $("rbCreate").click(); });
$("roomBrowser").addEventListener("keydown", (e) => { if (e.key === "Escape") closeRoomBrowser(); });
$("friendAddCancel").onclick = () => toggleAddFriend(false);
$("friendAddOk").onclick = () => { if (addFriend($("friendAddName").value)) toggleAddFriend(false); };
$("friendAddName").addEventListener("input", () => showAddMsg(""));
$("friendAddName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("friendAddOk").click();
  if (e.key === "Escape") toggleAddFriend(false);
});

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
$("btnSound").onclick = () => setMuted(!Sound.muted);
setMuted(Sound.muted);

setPhase("offline");
$("buser").focus();
