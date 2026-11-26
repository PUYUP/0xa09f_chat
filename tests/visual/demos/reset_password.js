// size: 760x760
// Forgot password, step 2 (code + new password).
$("ruser").value = "alice"; showScreen("reset");
$("resetStep2").style.display = ""; $("btnSendCode").textContent = "Send a New Code";
showMsg("resetMsg", "We emailed a 6-digit code to a***@example.com. It works for 15 minutes.", "ok");
