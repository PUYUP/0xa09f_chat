/* SolNet desktop client — IRC protocol logic over the Soju bouncer.
 * Rust side (src-tauri) is a raw TCP bridge: invoke('send', line) and
 * events 'irc-line' / 'irc-closed'.
 */

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const logEl = $("log"), chanEl = $("channels"), usersEl = $("users");
const statusEl = $("statusbar"), dotEl = $("dot"), whoEl = $("who");

const S = {
  connected: false,
  me: null,               // my nick on the network (e.g. soluser)
  current: null,          // current channel
  channels: new Map(),    // name -> Map(nick -> prefix)
  away: false,
};

/* ---------- helpers ---------- */

function send(line) { invoke("send", { line }).catch((e) => sys(`send failed: ${e}`)); }

function setStatus(t) { statusEl.textContent = t; }

function sys(text, cls = "service") {
  addMsg({ who: "solnet", txt: text, cls });
}

function addMsg({ who, txt, cls = "", chan = null }) {
  if (chan && chan !== S.current) return;      // only show current channel
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.innerHTML = `<span class="who">${esc(who)}:</span> <span class="txt">${esc(txt)}</span>`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Parse an IRC line into {prefix, cmd, params[], trailing} */
function parse(line) {
  let prefix = null, rest = line;
  if (rest.startsWith(":")) {
    const i = rest.indexOf(" ");
    prefix = rest.slice(1, i);
    rest = rest.slice(i + 1);
  }
  const ti = rest.indexOf(" :");
  let trailing = null, head = rest;
  if (ti !== -1) { trailing = rest.slice(ti + 2); head = rest.slice(0, ti); }
  const parts = head.split(" ");
  return { prefix, cmd: parts.shift(), params: parts, trailing };
}

/* nick!user@host from a prefix like nick!user@host or server.name */
function nickOf(prefix) {
  if (!prefix) return "";
  const bang = prefix.indexOf("!");
  return bang === -1 ? prefix : prefix.slice(0, bang);
}

/* ---------- channel / user tracking ---------- */

function chanMap(name) {
  if (!S.channels.has(name)) S.channels.set(name, new Map());
  return S.channels.get(name);
}

function renderChannels() {
  chanEl.innerHTML = "";
  for (const name of S.channels.keys()) {
    const d = document.createElement("div");
    d.className = "chan" + (name === S.current ? " active" : "");
    d.textContent = name;
    d.onclick = () => { send(`JOIN ${name}`); };
    chanEl.appendChild(d);
  }
}

function renderUsers() {
  usersEl.innerHTML = "";
  $("usersTitle").textContent = S.current ? `Users — ${S.current}` : "Users";
  const m = S.current ? S.channels.get(S.current) : null;
  if (!m) return;
  for (const [nick, prefix] of [...m.entries()].sort()) {
    const d = document.createElement("div");
    d.className = "user";
    d.textContent = (prefix || "") + nick;
    d.title = "message " + nick;
    d.onclick = () => { $("input").value = `@${nick} `; $("input").focus(); }
    usersEl.appendChild(d);
  }
}

function refreshSide() { renderChannels(); renderUsers(); }

/* ---------- IRC event handling ---------- */

function onJoin(fromNick, channel) {
  const m = chanMap(channel);
  if (!m.has(fromNick)) m.set(fromNick, "");
  if (fromNick === S.me) {
    S.current = channel;
    send(`NAMES ${channel}`);
    addMsg({ who: "solnet", txt: `joined ${channel}`, cls: "action" });
  } else {
    addMsg({ who: fromNick, txt: `joined ${channel}`, cls: "action", chan: channel });
  }
  refreshSide();
}

function onPart(fromNick, channel) {
  S.channels.get(channel)?.delete(fromNick);
  addMsg({ who: fromNick, txt: `left ${channel}`, cls: "action", chan: channel });
  refreshSide();
}

function onQuit(fromNick) {
  for (const [ch, m] of S.channels) {
    if (m.delete(fromNick)) {
      addMsg({ who: fromNick, txt: `quit`, cls: "action", chan: ch });
    }
  }
  refreshSide();
}

function onNick(oldNick, newNick) {
  for (const m of S.channels.values()) {
    if (m.has(oldNick)) { m.set(newNick, m.get(oldNick)); m.delete(oldNick); }
  }
  refreshSide();
}

function onNames(num, params, trailing) {
  if (num === 353) {
    const eq = params.indexOf("=");
    const channel = params[eq + 1];
    const m = chanMap(channel);
    const nicks = (trailing || "").split(/\s+/).filter(Boolean);
    m.clear();
    for (const tok of nicks) {
      const p = tok.match(/^([@+~&]?)()?(.*)$/);
      m.set(p[3], p[1] || "");
    }
    if (channel === S.current) renderUsers();
  }
  // 366 = end of NAMES, nothing needed
}

function onPrivmsg(fromNick, params, trailing) {
  const target = params[0];
  const isChan = target.startsWith("#") || target.startsWith("&");
  const text = trailing || "";
  if (isChan) {
    addMsg({ who: fromNick, txt: text, cls: fromNick === S.me ? "me" : "", chan: target });
  } else if (fromNick === "NickServ" || fromNick.endsWith("Serv") || fromNick === "BouncerServ") {
    sys(`[${fromNick}] ${text}`);
  } else {
    addMsg({ who: fromNick, txt: `→ you: ${text}`, cls: fromNick === S.me ? "me" : "" });
  }
}

function onNumeric(num, params, trailing, line) {
  if (num === 001) {
    S.me = params[0];
    S.connected = true;
    dotEl.classList.add("on");
    whoEl.textContent = S.me;
    setStatus(`connected as ${S.me} via ${$("addr").value}`);
    for (const id of ["input", "btnSend", "btnJoin", "btnAway", "btnRegister", "btnConnect"]) $(id).disabled = false;
    $("btnConnect").textContent = "Disconnect";
    sys(`connected — nick ${S.me}`);
    return;
  }
  if (num === 422) { sys("registration burst complete"); return; }
  if (num === 353 || num === 366) { onNames(num, params, trailing); return; }
  if (num === 305) { S.away = true; $("btnAway").textContent = "Clear away"; sys("away set"); return; }
  if (num === 306) { S.away = false; $("btnAway").textContent = "Set away"; sys("away cleared"); return; }
  if (num === 311 || num === 312 || num === 317 || num === 318 || num === 319) return; // WHOIS replies, unused
  if (num === 433) { sys("nickname already in use", "error"); return; }
  if (num >= 400 && num < 500) { sys(`server numeric ${num}: ${trailing || line}`, "error"); return; }
  if (num === 900 || num === 903) { sys("NickServ: identified"); return; }
  if (num === 904 || num === 907) { sys(`NickServ: ${trailing}`, "error"); return; }
  // 01xx-04xx informational burst: show 372 MOTD lines lightly
  if (num === 372) { addMsg({ who: "motd", txt: trailing || "", cls: "service" }); }
}

function handleLine(line) {
  const { prefix, cmd, params, trailing } = parse(line);
  const fromNick = nickOf(prefix);

  // Server->client numerics and CAP/AUTHENTICATE have cmd = number or keyword
  if (/^\d+$/.test(cmd)) { onNumeric(parseInt(cmd, 10), params, trailing, line); return; }

  switch (cmd) {
    case "CAP": {
      const sub = params[1];
      if (sub === "LS") send("CAP REQ :sasl");
      else if (sub === "ACK" && params.join(" ").includes("sasl")) send("AUTHENTICATE PLAIN");
      else if (sub === "NEW") { /* ignore unsolicited caps */ }
      return;
    }
    case "AUTHENTICATE":
      if (params[0] === "+") {
        const u = $("buser").value, p = $("bpass").value;
        send("AUTHENTICATE " + btoa("\0" + u + "\0" + p));
      }
      return;
    case "JOIN": {
      const channel = params[0] || trailing || "";
      if (channel.startsWith("#") || channel.startsWith("&")) onJoin(fromNick, channel);
      return;
    }
    case "PART": onPart(fromNick, params[0]); return;
    case "QUIT": onQuit(fromNick); return;
    case "NICK": {
      if (params.length >= 2) onNick(params[0], params[1]);
      else if (trailing) onNick(fromNick, trailing);
      return;
    }
    case "PRIVMSG": onPrivmsg(fromNick, params, trailing); return;
    case "NOTICE":
      if (fromNick === "NickServ" || fromNick.endsWith("Serv")) sys(`[${fromNick}] ${trailing || params.join(" ")}`);
      else addMsg({ who: fromNick, txt: trailing || params.join(" "), cls: "service" });
      return;
    case "PING": send(`PONG :${trailing || params[0]}`); return;
    case "ERROR": sys(`connection error: ${trailing || line}`, "error"); return;
    default: return; // ignore everything else
  }
}

/* ---------- UI wiring ---------- */

async function doConnect() {
  const addr = $("addr").value.trim();
  try {
    await invoke("connect", { addr });
    sys(`tcp connected to ${addr}, negotiating SASL...`);
    const u = $("buser").value, n = $("bnet").value;
    send("CAP LS 302");
    send(`NICK ${u}/${n}`);
    send(`USER ${u}/${n} 0 * :SolNet Desktop`);
  } catch (e) {
    sys(`connect failed: ${e}`, "error");
  }
}

function doDisconnect() {
  invoke("disconnect");
  S.connected = false; S.me = null; S.current = null;
  S.channels.clear(); S.away = false;
  dotEl.classList.remove("on"); whoEl.textContent = "";
  for (const id of ["input", "btnSend", "btnJoin", "btnAway", "btnRegister"]) $(id).disabled = true;
  $("btnConnect").textContent = "Connect";
  $("btnAway").textContent = "Set away";
  refreshSide();
  setStatus("disconnected");
}

function sendChat() {
  const text = $("input").value.trim();
  if (!text) return;
  $("input").value = "";
  if (text.startsWith("/join ")) { send(`JOIN ${text.slice(6).trim()}`); return; }
  if (text.startsWith("/part ")) { send(`PART ${text.slice(6).trim()}`); return; }
  if (text.startsWith("/msg ")) {                       // /msg nick text
    const i = text.indexOf(" ", 5);
    if (i > 0) { send(`PRIVMSG ${text.slice(5, i).trim()} :${text.slice(i + 1)}`); }
    return;
  }
  const target = text.startsWith("@") ? text.slice(1).split(/\s/)[0] : S.current;
  const body = text.startsWith("@") ? text.replace(/^@\S+\s*/, "") : text;
  if (!target) { sys("no channel selected — join one first or use /msg nick text", "error"); return; }
  // optimistic echo (bouncer doesn't echo own messages without echo-message cap)
  addMsg({ who: S.me, txt: body, cls: "me", chan: target.startsWith("#") || target.startsWith("&") ? target : null });
  send(`PRIVMSG ${target} :${body}`);
}

$("btnConnect").onclick = () => (S.connected ? doDisconnect() : doConnect());
$("btnSend").onclick = sendChat;
$("input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
$("btnJoin").onclick = () => {
  const c = $("newChan").value.trim();
  if (c) send(`JOIN ${c}`);
};
$("btnRegister").onclick = () => {
  const p = $("nsPass").value, e = $("nsEmail").value.trim();
  if (!p || !e) { sys("register needs password + email", "error"); return; }
  send(`PRIVMSG NickServ :REGISTER ${p} ${e}`);
};
$("btnAway").onclick = () => {
  send(S.away ? "AWAY" : "AWAY :away (SolNet desktop)");
};

listen("irc-line", (e) => handleLine(e.payload));
listen("irc-closed", () => {
  sys("connection closed by server", "error");
  doDisconnect();
});

setStatus("ready — click Connect");
