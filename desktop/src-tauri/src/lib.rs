use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};

/// Thin TCP bridge to the Soju bouncer. All IRC protocol logic lives in the
/// frontend (ui/app.js) — Rust only moves raw lines back and forth.
struct IrcState {
    stream: Mutex<Option<Arc<Mutex<TcpStream>>>>,
}

#[tauri::command]
fn connect(addr: String, state: State<IrcState>, app: AppHandle) -> Result<(), String> {
    // Close any previous connection first.
    *state.stream.lock().unwrap() = None;

    let stream = TcpStream::connect(&addr).map_err(|e| format!("connect {addr}: {e}"))?;
    stream.set_nodelay(true).ok();
    let stream = Arc::new(Mutex::new(stream));

    let reader = stream
        .lock()
        .unwrap()
        .try_clone()
        .map_err(|e| e.to_string())?;
    let app2 = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            match line {
                Ok(l) => {
                    if app2.emit("irc-line", l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app2.emit("irc-closed", ());
    });

    *state.stream.lock().unwrap() = Some(stream);
    Ok(())
}

#[tauri::command]
fn send(line: String, state: State<IrcState>) -> Result<(), String> {
    let guard = state.stream.lock().unwrap();
    let Some(stream) = guard.as_ref() else {
        return Err("not connected".to_string());
    };
    let mut s = stream.lock().unwrap();
    writeln!(s, "{line}").map_err(|e| e.to_string())?;
    s.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn disconnect(state: State<IrcState>) {
    *state.stream.lock().unwrap() = None;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(IrcState {
            stream: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![connect, send, disconnect])
        .run(tauri::generate_context!())
        .expect("error while running SolNet");
}
