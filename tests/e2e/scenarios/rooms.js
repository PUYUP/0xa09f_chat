// Rooms: create a new room through the Create Room dialog (settings applied
// kept by Ergo for registered rooms), moderate bob (moderator, mute, ban, kick), welcome
// message, poll, pin, event with RSVP, "Seen by", invite link button, then
// delete the room. Peer: rooms.peer.py (bob).
check("signed in", await signIn("alice"));
const R = `#zz-e2e-${Date.now().toString(36).slice(-4)}`;

$("newChan").value = R.slice(1); $("btnJoin").click();
check("new room → Create Room dialog first", await until(() => $("createRoomDialog").style.display === "", 10000));
check("…and it isn't created yet", !conv(keyOf(R)));
$("crTopic").value = "e2e topic"; $("crKey").value = "pw123"; $("crLimit").value = "9"; $("crWelcome").value = "Hello from e2e";
$("crCreate").click();
const c = await until(() => conv(keyOf(R)), 10000);
check("created and registered to us", await until(() => c.msgs.some((m) => /it's your room now/.test(m.txt)), 20000));
check("settings applied (key + limit)", await until(() => c.key === "pw123" && c.limit === 9, 20000), [c.key, c.limit]);
check("topic set", await until(() => c.topic === "e2e topic", 10000));

openRoomDialog(c); await until(() => c.infoLoaded, 15000);
$("rdKey").value = ""; $("rdLimit").value = ""; S.roomFormDirty = true;
await saveRoomSettings();
closeRoomDialog();
check("owner removes key + limit", await until(() => !c.key && !c.limit, 15000),
  { registered: c.registered, key: c.key, limit: c.limit });

check("bob joins (peer)", (await ask(`join ${R}`)) === "joined" && await until(() => c.members.has("bob"), 10000));
check("welcome message kept for the room", (await ask(`welcome? ${R}`)) === "welcome yes");
await setModerator(c, "bob", true);
check("make bob moderator", await until(() => /@/.test(c.members.get("bob") || ""), 10000));
await setModerator(c, "bob", false);
muteUser(c, "bob", true);
check("mute: bob can't talk", (await ask(`say ${R}`)) === "say blocked");
muteUser(c, "bob", false);
banUser(c, "bob");
check("ban: bob is out and can't rejoin", await until(() => !c.members.has("bob"), 10000) && (await ask(`join ${R}`)) === "join banned");
unbanUser(c, "bob");

const pid = await (async () => { $("input").value = "/poll Lunch? | Bakso | Sate"; sendChat(); return +(await until(() => logEl.querySelector(".poll")?.dataset.poll, 15000)); })();
check("poll card", pid > 0);
$("input").value = "pin this one"; sendChat();
const pm = await until(() => c.msgs.find((m) => !m.others && m.txt === "pin this one"), 15000);
await pinMessage(c, pm, true);
check("pinned bar", await until(() => $("pinBar").textContent.includes("pin this one"), 10000));

openRoomEvents(c); $("evName").value = "e2e party";
const d = new Date(Date.now() + 3 * 3600e3); $("evWhen").value = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
await createEvent(); closeRoomEvents();
check("event card in the room", await until(() => [...logEl.querySelectorAll(".evc")].some((e) => e.textContent.includes("e2e party")), 15000));

check("bob rejoins after unban", (await ask(`join ${R}`)) === "joined");
$("input").value = "did you read this?"; sendChat();
await until(() => c.msgs.some((m) => !m.others && m.txt === "did you read this?"), 15000);
check("“Seen by bob”", (await ask(`roomread ${R}`)) === "read" && await until(() => /Seen by bob/.test(logEl.querySelector(".seen")?.textContent || ""), 10000));

openPm("bob");
$("input").value = `come to ${inviteUrl(R)}`; sendChat();
check("invite link becomes a Join button", await until(() => [...logEl.querySelectorAll(".invite-join")].some((b) => b.dataset.room.toLowerCase() === keyOf(R)), 10000));

switchTo(R);
openRoomDialog(c); await until(() => c.infoLoaded, 15000);
$("rdDelete").click(); await deleteRoom();
check("room deleted (unregistered)", c.msgs.some((m) => /isn't yours any more/.test(m.txt)));
peer(`part ${R}`); leaveRoom(c);
peer("bye");
finish();
