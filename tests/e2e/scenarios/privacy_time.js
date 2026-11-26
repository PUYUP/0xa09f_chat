// Privacy & time: "only friends" (both directions), ignore, far-timezone warning for a
// stranger, send later, active hours. Peer: privacy_time.peer.py (frank,
// who is not alice's friend and lives in New York for this test).
check("signed in", await signIn("alice"));
const F = "frank";
const CTRL = "bob";     // the peer takes commands through bob (see privacy_time.peer.py)

openPrivacy(); $("pvFriendsOnly").checked = true; await onFriendsOnlyToggle(); closePrivacy();
check("only friends: setting saved", S.prefs.friendsOnly === true);
// Ergo has no caller-id: this app hides a stranger's private messages and
// says so once. (grace: alice never wrote to her, so she can't "answer".)
const knock1 = `only friends test ${Date.now().toString(36)}`;
await ask(`pmfrom grace ${knock1}`, CTRL);
check("only friends: a stranger's message isn't shown", await until(() =>
  [...S.convs.values()].some((c) => c.msgs.some((m) => /grace tried to message you/.test(m.txt))), 15000)
  && !conv("grace")?.msgs.some((m) => m.txt === knock1));
openPrivacy(); $("pvFriendsOnly").checked = false; await onFriendsOnlyToggle(); closePrivacy();
// The other way round: frank takes messages from friends only, so our app
// doesn't send and tells us why.
check("frank turns on only friends (peer)", (await ask("friendsonly on", CTRL)) === "friendsonly on");
S.canPm?.delete(F);
sendTo(F, "can I message you?");
check("only friends: we're told frank only takes friends' messages", await until(() =>
  [...S.convs.values()].some((c) => c.msgs.some((m) => /frank only accepts messages from friends/.test(m.txt))), 10000));
await ask("friendsonly off", CTRL);
S.canPm?.delete(F);
for (const x of S.convs.values()) x.msgs = x.msgs.filter((m) => !/(grace tried to message you|frank only accepts)/.test(m.txt));

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
