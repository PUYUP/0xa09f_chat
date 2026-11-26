// size: 1000x620
// variants: create-room room-settings events conference
// Dialogs.
S.me = "alice"; S.account = "alice"; setPhase("online"); S.link = "linked";
const c = getConv("#games", "room"); c.members.set("alice", "@"); c.members.set("bob", ""); roomState(c);
switchTo("#games");
const v = location.hash.slice(1);
if (v === "create-room") openCreateRoom("#new-room");
if (v === "room-settings") { openRoomDialog(c); c.registered = true; c.founders = ["alice"]; c.infoLoaded = true; c.mods = [{ nick: "alice", founder: true }]; renderRoomDialog(); }
if (v === "events") { S.eventsRoom = "#games"; $("eventsDialog").style.display = ""; $("evList").innerHTML = ""; }
if (v === "conference") { S.friends = ["bob", "carol"]; openConfDialog(null); }
