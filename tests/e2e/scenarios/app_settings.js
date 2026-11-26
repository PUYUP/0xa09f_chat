// App-level settings: dark mode, quick switcher (Cmd/Ctrl+K), Do Not
// Disturb, profile (NickServ properties), name color, recovery email,
// signed-in devices, export to JSON. Peer: app_settings.peer.py (cleanup).
check("signed in", await signIn("alice"));

setDark(true);
check("dark mode on", document.body.classList.contains("dark") && localStorage.getItem("a09f.dark") === "1");
setDark(false);

document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
check("Cmd+K opens the quick switcher", $("qsDialog").style.display === "");
$("qsInput").value = "lby"; $("qsInput").dispatchEvent(new Event("input"));
check("fuzzy match: lby → lobby", S.qsItems?.[0]?.label === "lobby", S.qsItems?.map((i) => i.label));
$("qsInput").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
check("Enter opens it", S.current === "#lobby");

setDnd({ until: Date.now() + 3600e3 });
check("Do Not Disturb: quiet", isQuiet() && /Quiet/.test($("btnSound").textContent));
setDnd({ until: 0 });
check("Do Not Disturb: off again", !isQuiet());

openProfile(S.me);
await until(() => !$("pfSave").disabled, 15000);
const before = $("pfLocation").value;
const loc = `E2E City ${Date.now() % 1000}`;
$("pfLocation").value = loc; $("pfSave").click();
check("profile saved to NickServ", await until(() => S.myProfile?.location === loc, 20000));
openProfile(S.me); await until(() => !$("pfSave").disabled, 15000);
$("pfLocation").value = before; $("pfSave").click();
await until(() => S.myProfile?.location === before, 20000);

openProfile(S.me); await wait(300);
document.querySelector('#pfColors .swatch[data-color="#16a085"]').click();
check("name color set", await until(() => S.nameColors.get("alice") === "#16a085", 10000));
document.querySelector("#pfColors .swatch.none").click();
check("name color reset", await until(() => S.nameColors.get("alice") === null, 10000));
closeProfile();

openPwDialog();
check("recovery email loads", await until(() => !$("pwEmail").disabled, 15000));
check("devices list shows this device", await until(() => /this device/.test($("devList").textContent), 10000));
closePwDialog();

switchTo("#lobby");
await exportConversation(conv("#lobby"));
const done = conv("#lobby").msgs.at(-1);
check("export to JSON in Downloads", /Exported \d+ messages to .*a09f-lobby-.*\.json/.test(done?.txt || ""), done?.txt);
if (done?.reveal) peer(`rm ${done.reveal}`);
await wait(1000);
finish();
