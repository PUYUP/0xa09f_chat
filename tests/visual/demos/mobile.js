// size: 390x844
// variants: list chat
// Mobile layout: conversation list, or the open chat with the back button.
S.me = "alice"; S.account = "alice"; setPhase("online");
S.friends = ["bob", "carol", "dave"]; S.friendGroups = new Map();
for (const n of S.friends) S.presence.set(n, { away: false, exists: true });
const c = getConv("#lobby", "room");
for (const n of ["alice", "bob", "carol"]) c.members.set(n, "");
addMsg("#lobby", { who: "bob", txt: "hey @alice are you coming tonight?", cls: "", others: true });
addMsg("bob", { who: "bob", txt: "private hello", cls: "", others: true });
if (location.hash === "#chat") switchTo("#lobby");
