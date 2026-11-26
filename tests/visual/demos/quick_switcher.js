// size: 1000x520
// Cmd/Ctrl+K quick switcher.
S.me = "alice"; S.account = "alice"; setPhase("online");
S.friends = ["bob"]; getConv("#lobby", "room"); getConv("#games", "room"); getConv("bob", "pm");
switchTo("bob");
openSwitcher(); $("qsInput").value = "lo"; renderSwitcher();
