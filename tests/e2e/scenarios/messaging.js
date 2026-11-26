// Private messaging with bob: text style, /me, reply, edit, reaction from
// the other side, delete, link preview, "Seen", search, saved + jump.
// Peer: messaging.peer.py (bob).
check("signed in", await signIn("alice"));
openPm("bob");
const c = conv("bob");
const stamp = Date.now().toString(36);
const mine = (txt) => until(() => c.msgs.find((m) => !m.others && m.txt === txt), 15000);

setStyle({ b: true, color: 4 });
$("input").value = `styled ${stamp}`; sendChat();
setStyle({ b: false, color: null });
const styled = await until(() => c.msgs.find((m) => !m.others && stripIrc(m.txt) === `styled ${stamp}`), 15000);
check("bold + color sent as IRC codes", styled && /\x02/.test(styled.txt) && /\x0304/.test(styled.txt), styled?.txt);
check("…and rendered", !![...logEl.querySelectorAll(".msg .txt .f-b.f-c4")].length);

$("input").value = `/me waves ${stamp}`; sendChat();
check("/me sends an action", await until(() => c.msgs.find((m) => m.cls.includes("action") && m.txt === `waves ${stamp}`), 15000));

const first = await (async () => { $("input").value = `quote me ${stamp}`; sendChat(); return mine(`quote me ${stamp}`); })();
startReply(first); $("input").value = "replying"; sendChat();
check("reply carries a quote", await until(() => c.msgs.find((m) => m.txt.startsWith(`↪ alice: “quote me ${stamp}”`)), 15000));
check("reply renders as a quote block", await until(() => [...logEl.querySelectorAll(".quote")].some((q) => q.textContent.includes(`quote me ${stamp}`))));

startEdit(c, first); $("input").value = `quote me ${stamp} (fixed)`; sendChat();
check("edit shows with (edited)", await until(() => [...logEl.querySelectorAll(".msg")].some((e) => e.textContent.includes(`quote me ${stamp} (fixed)`) && e.querySelector(".edited")), 10000));

const ans = await ask(`react ${first.time} quote me ${stamp}`, "bob");
check("bob reacts (peer)", ans === "reacted", ans);
check("reaction chip appears live", await until(() => [...logEl.querySelectorAll(".rchip")].some((r) => r.textContent.startsWith("👍")), 10000));

$("input").value = `delete me ${stamp}`; sendChat();
const del = await mine(`delete me ${stamp}`);
await deleteMessage(del);
check("deleted for everyone", await until(() => [...logEl.querySelectorAll(".msg.deleted")].length, 10000));

$("input").value = "see https://example.com"; sendChat();
check("link is clickable", await until(() => logEl.querySelector('a.link[data-url="https://example.com"]'), 10000));
check("link preview card", await until(() => [...logEl.querySelectorAll(".lp .lp-title")].some((e) => e.textContent === "Example Domain"), 20000));

peer("read", "bob");
check("bob reads → “✓ Seen”", await until(() => logEl.querySelector(".seen"), 15000));

openSearch(); $("srQuery").value = `quote me ${stamp}`; $("srIn").value = "bob"; doSearch();
check("search finds the message", await until(() => document.querySelectorAll(".sr-row").length, 10000));
closeSearch();

toggleSave(c, first);
check("saved", await until(() => S.saved?.some((s) => s.time === first.time), 10000));
switchTo("#lobby"); await wait(500);
await jumpToMessage("bob", msgKeyOf(c, first));
const el = logEl.querySelector(`.msg[data-key="${CSS.escape(msgKeyOf(c, first))}"]`);
check("jump to the saved message (flash)", S.current === "bob" && el?.classList.contains("flash"));
toggleSave(c, first);
peer("bye", "bob");
finish();
