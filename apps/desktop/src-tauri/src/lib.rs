use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::Receiver;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_window_state::StateFlags;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_POLL: Duration = Duration::from_millis(200);
const OUTPUT_LINES: usize = 200;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarConnection {
    base_url: String,
    token: String,
    version: String,
}

#[derive(Clone, Serialize)]
struct SidecarFailure {
    message: String,
    output: String,
}

#[derive(Deserialize)]
struct ReadyLine {
    event: String,
    port: u16,
    token: String,
}

#[derive(Deserialize)]
struct Health {
    version: String,
}

#[derive(Default)]
struct Sidecar {
    outcome: tauri::async_runtime::Mutex<Option<Result<SidecarConnection, SidecarFailure>>>,
    /// Holding the child keeps the write end of the sidecar's stdin open. However the shell ends,
    /// even by SIGKILL, that pipe closes and the sidecar runs its shutdown cleanup (§10.4).
    child: Mutex<Option<CommandChild>>,
    output: Arc<Mutex<VecDeque<String>>>,
}

fn push_line(output: &Mutex<VecDeque<String>>, bytes: &[u8]) {
    let mut lines = output.lock().unwrap();
    lines.push_back(String::from_utf8_lossy(bytes).trim_end().to_string());
    if lines.len() > OUTPUT_LINES {
        lines.pop_front();
    }
}

/// The event channel is bounded, so output is drained for the sidecar's whole life or its writes
/// would eventually stall; the lines are kept for the error page.
fn drain(mut rx: Receiver<CommandEvent>, output: Arc<Mutex<VecDeque<String>>>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => push_line(&output, &line),
                CommandEvent::Terminated(t) => {
                    push_line(&output, format!("sidecar exited: code {:?}, signal {:?}", t.code, t.signal).as_bytes())
                }
                _ => {}
            }
        }
    });
}

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

/// §10.3: the sidecar binds 127.0.0.1:0 and mints its token itself, announcing both in one stdout
/// line, so the token never passes through argv, the environment or a file. The ready line is
/// consumed here and never copied into the kept output.
async fn start(app: &AppHandle, sidecar: &Sidecar) -> Result<SidecarConnection, String> {
    let (mut rx, child) = app
        .shell()
        .sidecar("lurk")
        .map_err(|e| e.to_string())?
        .arg("sidecar")
        .spawn()
        .map_err(|e| e.to_string())?;
    *sidecar.child.lock().unwrap() = Some(child);
    let deadline = Instant::now() + STARTUP_TIMEOUT;

    let ready = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Err(_) => return Err(format!("sidecar reported no ready line within {} s", STARTUP_TIMEOUT.as_secs())),
            Ok(None) => return Err("sidecar output closed before it was ready".into()),
            Ok(Some(CommandEvent::Stdout(line))) => match serde_json::from_slice::<ReadyLine>(&line) {
                Ok(ready) if ready.event == "ready" => break ready,
                _ => push_line(&sidecar.output, &line),
            },
            Ok(Some(CommandEvent::Stderr(line))) => push_line(&sidecar.output, &line),
            Ok(Some(CommandEvent::Terminated(t))) => {
                return Err(format!("sidecar exited before it was ready: code {:?}, signal {:?}", t.code, t.signal))
            }
            Ok(Some(_)) => {}
        }
    };
    drain(rx, sidecar.output.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], ready.port));
    let body = tauri::async_runtime::spawn_blocking(move || {
        while Instant::now() < deadline {
            if let Some(body) = health_once(addr) {
                return Ok(body);
            }
            std::thread::sleep(HEALTH_POLL);
        }
        Err(format!("sidecar did not answer /health within {} s", STARTUP_TIMEOUT.as_secs()))
    })
    .await
    .map_err(|e| e.to_string())??;
    let health: Health = serde_json::from_str(&body).map_err(|e| format!("unexpected /health body: {e}"))?;
    Ok(SidecarConnection {
        base_url: format!("http://127.0.0.1:{}", ready.port),
        token: ready.token,
        version: health.version,
    })
}

/// §10.4 start-up in one command: spawn the sidecar, read its ready line, poll /health for up to
/// 10 s, then show the window whatever the outcome. The connection, token included, stays in Rust
/// state and later calls return it. This runs here rather than in the page because WKWebView
/// suspends timers and network loads of a window that has never been shown.
#[tauri::command]
async fn connect_sidecar(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: State<'_, Sidecar>,
) -> Result<SidecarConnection, SidecarFailure> {
    let mut outcome = sidecar.outcome.lock().await;
    if outcome.is_none() {
        let result = start(&app, &sidecar).await.map_err(|message| {
            if let Some(child) = sidecar.child.lock().unwrap().take() {
                let _ = child.kill();
            }
            let output = sidecar.output.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
            SidecarFailure { message, output }
        });
        *outcome = Some(result);
        let _ = window.show();
    }
    outcome.clone().expect("outcome was just set")
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
        // Visibility is left to connect_sidecar, which shows the window only once start-up has settled (§10.4).
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
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![connect_sidecar])
        .run(tauri::generate_context!())
        .expect("error while running DiscoLurk");
}
