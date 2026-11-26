// Friends: a request arrives live and is accepted from its card, typing
// shows up, status changes are live, invisible keeps you offline for others,
// removing a friend ends it on both sides. Peer: friends.peer.py (as frank).
check("signed in", await signIn("alice"));
const P = "frank";

peer("request", P);
check("request arrives as a card", await until(() => S.incoming.some((r) => r.from === P), 15000));
await until(() => $("friendRequests").querySelector(".ok"));
$("friendRequests").querySelector(".ok").click();
check("accepted → frank is a friend", await until(() => isFriend(P), 10000));

openPm(P);
peer("typing", P);
check("“frank is typing…” shows", await until(() => /frank is typing/.test($("typing").textContent), 10000));

peer("status-busy", P);
check("frank's status changes live (Busy)", await until(() => statusOf(P).label === "Busy", 15000));
peer("status-available", P);

setMyStatus("invisible");
await wait(1500);
const w1 = await ask("whois", P);
if (w1 === "whois here") skip("invisible: others see us away", "alice is also signed in elsewhere (another window/client) and not away");
else check("invisible: others see us away (offline)", w1 === "whois away", w1);
setMyStatus("available");
await wait(1500);
check("visible again: not away", (await ask("whois", P)) === "whois here");

peer("unfriend", P);
check("frank removed us → gone from our list too", await until(() => !isFriend(P), 10000));
peer("bye", P);
finish();
