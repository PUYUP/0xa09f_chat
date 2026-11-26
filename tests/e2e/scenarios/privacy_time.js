// Privacy & time: "only friends" (+g), ignore, far-timezone warning for a
// stranger, send later, active hours. Peer: privacy_time.peer.py (frank,
// who is not alice's friend and lives in New York for this test).
check("signed in", await signIn("alice"));
const F = "frank";
const CTRL = "bob";     // the peer takes commands through bob (see privacy_time.peer.py)

openPrivacy(); $("pvFriendsOnly").checked = true; await onFriendsOnlyToggle(); closePrivacy();
// The app first reads the server's ACCEPT list (removing ex-friends), then
// sets +g; our lines are paced by soju, so this takes a few seconds.
check("ACCEPT list read and synced to friends", await until(() => S.accepted && S.callerId, 45000),
  { accepted: S.accepted && [...S.accepted], callerId: S.callerId });
// +g reaches the server after our queued lines: let frank retry until blocked.
let blocked = false;
const tries = [];
for (let i = 0; i < 10 && !blocked; i++) {
  const r = await ask("pmcheck", CTRL);
  tries.push(r); blocked = r === "blocked";
  if (!blocked) await wait(2000);
}
check("only friends: frank's message is refused (716)", blocked, tries);
check("…and we get a tip once (718)", await until(() =>
  [...S.convs.values()].some((c) => c.msgs.some((m) => /frank tried to message you/.test(m.txt))), 15000));
openPrivacy(); $("pvFriendsOnly").checked = false; await onFriendsOnlyToggle(); closePrivacy();

await ignoreUser(F, true);
const hello = `hello from frank ${Date.now().toString(36)}`;
peer(`pm ${hello}`, CTRL);
await wait(5000);
check("ignored: frank's message isn't shown", !conv(F)?.msgs.some((m) => m.others && m.txt === hello));
await ignoreUser(F, false);

check("frank's timezone set to New York (peer)", (await ask("tz -300", CTRL)) === "tz set");
S.tz?.delete(F); tzOf(F);
await until(() => S.tz?.get(F) === -300, 10000);
openPm(F);
const c = conv(F);
$("input").value = "hi frank, far away?"; sendChat();
check("far stranger: confirm bar before sending", await until(() => $("composerBar").style.display === "" && $("tzSend"), 5000),
  $("composerBarText").textContent);
$("tzSend").click();
check("Send anyway sends it", await until(() => c.msgs.some((m) => !m.others && m.txt === "hi frank, far away?"), 15000));

await scheduleMessage(c, "scheduled hello", Math.floor(Date.now() / 1000) + 40);
check("send later: queued above the composer", await until(() => $("schedBar").textContent.includes("scheduled hello"), 8000));
check("send later: delivered (~40 s)", await until(() => c.msgs.some((m) => !m.others && m.txt === "scheduled hello"), 90000));

await ask("active-off-now", CTRL);
S.tz?.delete(F); S.active?.delete(F); tzOf(F);
await until(() => S.active?.has(F), 10000);
check("outside their active hours → 😴", isAsleep(F), { active: S.active?.get(F), tz: S.tz?.get(F), theirs: theirMinutes(F) });
c.tzOk = false;
$("input").value = "are you awake?"; sendChat();
check("…and a confirm offering “Send at their …”", await until(() => /active hours/.test($("composerBarText").textContent) && $("tzLater"), 5000),
  $("composerBarText").textContent);
clearComposerBar(); $("input").value = "";
peer("bye", CTRL);
finish();
