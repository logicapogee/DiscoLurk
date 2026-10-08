use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_window_state::StateFlags;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_POLL: Duration = Duration::from_millis(200);

fn health_once(addr: SocketAddr) -> Option<String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (head, body) = response.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.1 200").then(|| body.to_string())
}

/// Polls the sidecar's /health for up to 10 s, then shows the main window either way (§10.4).
/// It runs here rather than in the page because WKWebView suspends timers and network loads of a
/// window that has never been shown, so a page-side poll would stall until the window appeared.
#[tauri::command]
async fn await_sidecar(window: tauri::WebviewWindow, port: u16) -> Result<String, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let result = tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(body) = health_once(addr) {
                return Ok(body);
            }
            std::thread::sleep(HEALTH_POLL);
        }
        Err(format!("sidecar did not answer /health within {} s", HEALTH_TIMEOUT.as_secs()))
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = window.show();
    result
}

pub fn run() {
    tauri::Builder::default()
        // Registered first so a second launch only wakes the existing window (§9.2).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Visibility is left to the UI, which shows the window only after the sidecar is healthy (§10.4).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .invoke_handler(tauri::generate_handler![await_sidecar])
        .run(tauri::generate_context!())
        .expect("error while running DiscoLurk");
}
