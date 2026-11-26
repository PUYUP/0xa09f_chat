// size: 1000x600
// Someone's profile (view) with local time and a private note.
S.me = "alice"; S.account = "alice"; setPhase("online");
S.friends = ["bob"]; S.presence.set("bob", { away: false, exists: true });
S.tz = new Map([["bob", -300]]); S.notes = new Map([["bob", "met at the seminar, likes coffee"]]);
openProfile("bob");
showProfile("bob", { registered: true, since: "Nov 24, 2026", props: { name: "Bob Builder", location: "New York", about: "Can we fix it? :D" } });
