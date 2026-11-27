// size: 1000x600
// Creating a new room: the "does it exist?" probe (LIST #room) is answered by
// solanum with 401 for a room that doesn't exist yet. That must not show
// "There's no snailog user with the ID ..." (regression); then the Create
// Room dialog opens. A 401 for some other room says "room", not "user".
// Throwing here fails the demo (promise rejections too, see below).
window.addEventListener("unhandledrejection", (e) =>
  document.documentElement.setAttribute("data-err", "unhandled rejection: " + (e.reason && e.reason.message || e.reason)));
S.me = "alice"; S.account = "alice"; setPhase("online");
const probe = roomExists("#thinkpaders");
onNumeric(401, ["alice", "#thinkpaders"], "No such nick/channel");
if (S.lastError) throw new Error("LIST probe 401 shown as an error: " + S.lastError.text);
onNumeric(323, ["alice"], "End of /LIST");
probe.then((exists) => {
  if (exists) throw new Error("roomExists() said a missing room exists");
  openCreateRoom("#thinkpaders");
});
onNumeric(401, ["alice", "#gone"], "No such nick/channel");
if (!/room/.test(S.lastError?.text || "") || /user/.test(S.lastError.text))
  throw new Error("401 for a room should talk about a room: " + (S.lastError && S.lastError.text));
onNumeric(401, ["alice", "nobody"], "No such nick/channel");
if (!/no snailog user/.test(S.lastError?.text || "")) throw new Error("401 for a nick should still say no such user");
