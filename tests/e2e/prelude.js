/* Prepended to every e2e scenario by tests/e2e/run.py. It runs inside the
 * real app (debug build), next to app.js, so scenarios can drive the UI and
 * read app state (S, conv(), …) directly.
 *
 *   check(name, ok, detail)   one assertion
 *   skip(name, why)           not run (e.g. a server rate limit)
 *   until(fn, ms)             wait until fn() is truthy (returns its value or false)
 *   signIn(user)              sign in through the real Sign In form
 *   peer(cmd)                 tell the scenario's peer script to do something
 *   finish()                  end the scenario (always call it)
 */
const T = {
  log: (o) => invoke("test_log", { line: JSON.stringify(o) }).catch(() => {}),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};
const check = (name, ok, detail) => T.log({ type: "check", name, ok: !!ok, detail: ok ? undefined : detail });
const skip = (name, why) => T.log({ type: "skip", name, why });
const note = (text) => T.log({ type: "note", text });
const wait = T.wait;
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = fn(); if (v) return v; } catch {}
    await wait(200);
  }
  return false;
}
async function signIn(user, password = "demo-1234") {
  localStorage.setItem("a09f.autoSignIn", "0");
  if (S.phase !== "offline") { doDisconnect(""); await wait(500); }
  $("buser").value = user; $("bpass").value = password;
  doSignIn();
  // Wait for the sign-in burst to drain too: soju/solanum pace our lines, and
  // the self-WHOIS behind them resolving (S.link) shows the queue is through.
  return until(() => S.burstDone && S.token && S.events && ["linked", "unavailable", "failed"].includes(S.link), 60000);
}
/* The peer script watches IRC for "PRIVMSG <peer> :cmd:<...>" from us and
 * may answer "re:<text>". ask() sends a command and waits for the answer
 * (only answers newer than the command count: old ones are in the history). */
const peer = (cmd, to = "bob") => send(`PRIVMSG ${to} :cmd:${cmd}`);
async function ask(cmd, to = "bob", ms = 20000) {
  const seen = new Set(conv(keyOf(to))?.msgs || []);           // answers already there don't count
  peer(cmd, to);
  const m = await until(() => conv(keyOf(to))?.msgs.find((x) => x.others && !seen.has(x) && /^re:/.test(x.txt)), ms);
  return m ? m.txt.slice(3) : null;
}
const finish = () => T.log({ type: "done" });
window.addEventListener("error", (e) => T.log({ type: "error", text: String(e.message) }));
