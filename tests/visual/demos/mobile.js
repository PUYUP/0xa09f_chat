// size: 390x844
// variants: list chat people pm dialog signin
// Phone layout: the conversation list, the open chat (back + people buttons),
// the member drawer, a private chat, a full-width dialog, and sign-in.
const v = location.hash.slice(1);
if (v !== "signin") {
  S.me = "alice"; S.account = "alice"; setPhase("online");
  S.friends = ["bob", "carol", "dave"]; S.friendGroups = new Map();
  for (const n of S.friends) S.presence.set(n, { away: false, exists: true });
  const c = getConv("#lobby", "room");
  for (const n of ["alice", "bob", "carol"]) c.members.set(n, "");
  addMsg("#lobby", { who: "bob", txt: "hey @alice are you coming tonight?", cls: "", others: true });
  addMsg("#lobby", { who: "carol", txt: "a longer message so we can see how the text wraps on a narrow phone screen", cls: "", others: true });
  addMsg("bob", { who: "bob", txt: "private hello", cls: "", others: true });
  // rooms rejoined at sign-in must not open a chat on a phone
  switchTo("#lobby", false);
  if (v === "chat" || v === "people") switchTo("#lobby");
  if (v === "people") $("btnPeopleM").click();
  if (v === "pm") switchTo("bob");
  if (v === "dialog") openCreateRoom("#new-room");
}
