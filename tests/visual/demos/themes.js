// size: 760x420
// variants: beach night rain love space forest snow sunset
// Chat themes (IMVironments) in a private chat.
S.me = "alice"; S.account = "alice"; setPhase("online");
const t = Date.now();
addMsg("bob", { who: "bob", txt: "Look at this view 🌅", cls: "", others: true, time: t - 60000 });
addMsg("bob", { who: "alice", txt: "Wow, gorgeous!", cls: "me", others: false, time: t - 30000 });
switchTo("bob");
S.imv = new Map([["bob", location.hash.slice(1) || "night"]]); applyImv();
