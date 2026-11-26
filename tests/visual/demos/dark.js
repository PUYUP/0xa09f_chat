// size: 1000x560
// variants: plain beach
// Dark mode, with and without a chat theme.
S.me = "alice"; S.account = "alice"; setPhase("online");
S.friends = ["bob", "carol"]; S.presence.set("bob", { away: false, exists: true }); S.presence.set("carol", { away: true, exists: true });
addMsg("bob", { who: "bob", txt: "dark mode check", cls: "", others: true });
addMsg("bob", { who: "alice", txt: "looks good", cls: "me", others: false });
getConv("#lobby", "room");
switchTo("bob");
if (location.hash === "#beach") { S.imv = new Map([["bob", "beach"]]); applyImv(); }
setDark(true);
