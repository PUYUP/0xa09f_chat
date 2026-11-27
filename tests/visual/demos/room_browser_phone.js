// size: 390x844
// Room browser on a phone.
S.me = "alice"; S.account = "alice"; setPhase("online"); S.token = "x";
S.roomList = [{ name: "#lobby", users: 7, topic: "Welcome!" }, { name: "#games", users: 3, topic: "Play" }, { name: "#nyc", users: 4, topic: "Hello from NYC" }];
S.trending = [{ room: "#lobby", msgs: 42 }, { room: "#games", msgs: 9 }];
S.roomInfo = new Map([["#lobby", { category: "hangout", lang: "id" }], ["#games", { category: "games", lang: "en" }], ["#nyc", null]]);
S.roomTz = new Map([["#lobby", -new Date().getTimezoneOffset()], ["#games", -new Date().getTimezoneOffset() + 120], ["#nyc", -300]]);
$("roomBrowser").style.display = ""; renderRoomBrowser();
