// size: 1000x600
// Main window: friends with presence & custom status, rooms (one with an
// @mention badge), a conference, members with a moderator, a mention.
S.me = "alice"; S.account = "alice"; setPhase("online");
S.friends = ["bob", "carol", "dave", "erin"]; S.friendGroups = new Map([["dave", "Family"]]);
const set = (n, p, st) => { S.presence.set(n, p); if (st) S.statuses.set(n, st); };
set("bob", { away: false, exists: true }, { code: "custom", text: "maybe around" });
set("carol", { away: false, exists: true }, { code: "available" });
set("dave", { away: false, exists: true }, { code: "busy" });
set("erin", { away: true, exists: true });
const c = getConv("#lobby", "room");
for (const n of ["alice", "bob", "carol", "dave"]) c.members.set(n, n === "carol" ? "@" : "");
addMsg("#lobby", { who: "bob", txt: "hey @alice are you coming tonight?", cls: "", others: true });
addMsg("#lobby", { who: "carol", txt: "\x02bold\x02 and \x0312blue\x0f text, see https://example.com", cls: "", others: true });
getConv("#conf-alice-x7k2", "room").members.set("alice", "@");
addMsg("#games", { who: "bob", txt: "alice check this", cls: "", others: true });
switchTo("#lobby");
