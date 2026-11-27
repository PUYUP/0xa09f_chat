"""Peer for app_settings.js: removes the exported test file afterwards."""
import os

from peer import Peer

p = Peer("bob")
DOWNLOADS = os.path.expanduser("~/Downloads")


@p.on("rm")
def _(path):
    path = os.path.realpath(path)
    name = os.path.basename(path)
    # Only ever delete an snailog export in Downloads.
    if os.path.dirname(path) == os.path.realpath(DOWNLOADS) and name.startswith("snailog-") and name.endswith(".json"):
        os.remove(path)
        print(f"[peer bob] removed {name}", flush=True)


p.run()
