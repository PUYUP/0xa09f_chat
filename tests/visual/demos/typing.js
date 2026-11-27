// size: 1000x600
// variants: conference room
// "is typing…" in a conference (members only) and in a public room.
// Checks (throwing fails the demo):
//  - typing from a member shows; from someone not in the room it's dropped;
//  - what the app sends to /typing: the member list for a conference (so only
//    they get it), none for a public room (every app gets it).
S.me = "alice"; S.account = "alice"; S.token = "x"; setPhase("online");
const sent = [];
socialApi = async (path, body) => { sent.push({ path, body }); return {}; };   // capture, no network

const v = location.hash.slice(1) || "conference";
const name = v === "conference" ? "#conf-alice-ab12" : "#lobby";
const c = getConv(name, "room");
for (const n of ["alice", "bob", "carol", "ChanServ"]) c.members.set(n, n === "alice" ? "@" : "");
switchTo(name);
addMsg(name, { who: "bob", txt: "so, friday?", cls: "", others: true });

onRoomTyping({ room: name, from: "mallory", active: true });
if ($("typing").textContent) throw new Error("typing from a non-member was shown: " + $("typing").textContent);
onRoomTyping({ room: name, from: "bob", active: true });
if ($("typing").textContent !== "bob is typing…") throw new Error("member typing not shown: " + $("typing").textContent);

$("input").value = "sounds good";
onComposerInput();
const t = sent.find((s) => s.path === "/typing");
if (!t) throw new Error("nothing sent to /typing");
if (v === "conference") {
  const m = (t.body.members || []).slice().sort().join(",");
  if (m !== "alice,bob,carol") throw new Error("conference typing should name the members (no services): " + m);
} else if ("members" in t.body) {
  throw new Error("public room typing shouldn't carry a member list");
}
