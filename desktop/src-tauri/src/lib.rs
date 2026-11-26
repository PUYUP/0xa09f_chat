use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const KEYCHAIN_SERVICE: &str = "a09f";
const AUTOSTART_ARG: &str = "--autostart";

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
    // IRC requires CRLF line endings; writeln! would only send \n.
    s.write_all(format!("{line}\r\n").as_bytes())
        .map_err(|e| e.to_string())?;
    s.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn disconnect(state: State<IrcState>) {
    *state.stream.lock().unwrap() = None;
}

/* ---------- "Remember my password" (OS keychain) ---------- */

fn keychain(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| e.to_string())
}

#[tauri::command]
fn cred_save(account: String, password: String) -> Result<(), String> {
    keychain(&account)?.set_password(&password).map_err(|e| e.to_string())
}

#[tauri::command]
fn cred_load(account: String) -> Option<String> {
    keychain(&account).ok()?.get_password().ok()
}

#[tauri::command]
fn cred_clear(account: String) {
    if let Ok(e) = keychain(&account) {
        let _ = e.delete_credential();
    }
}

/// True when the OS started us at login (autostart passes AUTOSTART_ARG).
#[tauri::command]
fn launched_at_login() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

/* ---------- tray icon: closing the window keeps a09f running ---------- */

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open a09f", true, None::<&str>)?;
    let signout = MenuItem::with_id(app, "signout", "Sign Out", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit a09f", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &signout, &sep, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("a09f")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "signout" => {
                show_main(app);
                let _ = app.emit("tray-signout", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .manage(IrcState {
            stream: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            connect, send, disconnect, cred_save, cred_load, cred_clear, launched_at_login
        ])
        .setup(|app| {
            build_tray(app.handle())?;
            // Started at login: stay in the tray (auto sign-in still runs).
            if launched_at_login() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // The close button hides the window; a09f keeps running in the tray
            // so messages, BUZZes and notifications still arrive.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running a09f");

    app.run(|app, event| {
        // macOS: clicking the Dock icon brings the hidden window back.
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main(app);
        }
        let _ = (app, &event);
    });
}
