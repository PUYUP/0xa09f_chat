// size: 768x1024
// Tablet / narrow browser window: list + chat side by side, members behind the People button.
S.me = "alice"; S.account = "alice"; setPhase("online");
S.friends = ["bob", "carol"]; S.friendGroups = new Map();
for (const n of S.friends) S.presence.set(n, { away: false, exists: true });
const c = getConv("#lobby", "room");
for (const n of ["alice", "bob", "carol"]) c.members.set(n, "");
addMsg("#lobby", { who: "bob", txt: "hey @alice are you coming tonight?", cls: "", others: true });
switchTo("#lobby");
