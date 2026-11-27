#!/bin/sh
# tauri dev --runner shim: tauri appends `run <cargo args>` like it would
# to `cargo`. Build, then exec a copy named "Snailog IM" so macOS shows
# that name for the unbundled dev binary (crate names can't contain
# spaces, but the Dock/tooltip reads the executable filename).
set -e
cd "$(dirname "$0")/../src-tauri"
cargo build --no-default-features
cp -f target/debug/Snailog_IM "target/debug/Snailog IM"
exec "target/debug/Snailog IM"
