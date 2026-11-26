// Long conversations: a room with 2,500 messages (seeded straight into
// soju's database by the peer). Opens with 100, keeps a 1,000-message
// sliding window, reaches the first message, jumps back to the latest, and
// jumps ~2,500 messages back to one message. Peer: long_history.peer.py.
check("signed in", await signIn("alice"));
const R = "#zz-e2e-big";
joinRoom(R);
const c = await until(() => conv(keyOf(R)) && conv(keyOf(R)).historyDone && conv(keyOf(R)), 20000);
check("joined the test room", !!c);
check("peer seeded 2,500 messages", (await ask(`seed ${R}`)) === "seeded");
jumpToLatest(c);
await until(() => c.historyDone, 15000); await wait(800);
check("opens with the latest 100", c.msgs.filter(isConvMsg).length <= 101 && /history line 2500/.test(c.msgs.filter(isConvMsg).at(-1)?.txt || ""),
  c.msgs.filter(isConvMsg).at(-1)?.txt);
check("hover toolbars are built lazily", logEl.querySelectorAll(".mtools").length === 0);

for (let i = 0; i < 12; i++) { loadOlder(c); await until(() => !c.loadingOlder, 20000); }
check("window stays at 1,000 messages", c.msgs.length <= 1000, c.msgs.length);
check("newest dropped → “Jump to latest” bar", c.hasNewer && !!logEl.querySelector(".newer"));
for (let i = 0; i < 20 && !c.noMore; i++) { loadOlder(c); await until(() => !c.loadingOlder, 20000); }
check("scrolled back to the very first message", c.noMore && c.msgs.find(isConvMsg)?.txt === "history line 1");
const five = c.msgs.find((m) => m.txt === "history line 5");
const key = msgKeyOf(c, five);

jumpToLatest(c);
await until(() => c.historyDone, 15000);
check("jump to latest", !c.hasNewer && /history line 2500/.test(c.msgs.filter(isConvMsg).at(-1)?.txt || ""));
const t0 = Date.now();
await jumpToMessage(R, key);
const el = logEl.querySelector(`.msg[data-key="${CSS.escape(key)}"]`);
check("jump ~2,500 messages back finds it", !!el && el.classList.contains("flash"));
check("…in under 30 s", Date.now() - t0 < 30000, `${Math.round((Date.now() - t0) / 1000)} s`);
peer(`unseed ${R}`);
leaveRoom(c);
await wait(1500);
finish();
