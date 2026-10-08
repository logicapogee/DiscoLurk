use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::Receiver;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_window_state::StateFlags;
use tokio::sync::watch;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_POLL: Duration = Duration::from_millis(200);
const HEARTBEAT: Duration = Duration::from_secs(5);
/// A sidecar that misses this many heartbeats in a row is treated as hung and restarted.
const HEARTBEAT_MISSES: u32 = 3;
const MAX_RESTARTS: u32 = 3;
/// The sidecar's own cleanup budget is 15 s; after that it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(15);
const OUTPUT_LINES: usize = 200;
const TRAY_ID: &str = "main";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarConnection {
    base_url: String,
    token: String,
    version: String,
    log_path: String,
    updater: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarFailure {
    message: String,
    output: String,
    log_path: String,
}

type Outcome = Option<Result<SidecarConnection, SidecarFailure>>;

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

/// Lines the sidecar writes to its stdout for the shell, besides the ready line.
#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum ShellLine {
    Notify { title: String, body: String },
    #[serde(rename_all = "camelCase")]
    Settings { close_to_tray: bool },
    Token { token: String },
    Runs { active: u32 },
}

struct Sidecar {
    outcome: watch::Sender<Outcome>,
    /// Holding the child keeps the write end of the sidecar's stdin open. However the shell ends,
    /// even by SIGKILL, that pipe closes and the sidecar runs its shutdown cleanup.
    child: Mutex<Option<CommandChild>>,
    alive: watch::Sender<bool>,
    /// Bumped per spawn, so a late exit event of an earlier sidecar is not taken for the current one.
    generation: AtomicU64,
    restarts: AtomicU32,
    exiting: AtomicBool,
    exit_ready: AtomicBool,
    close_to_tray: AtomicBool,
    output: Arc<Mutex<VecDeque<String>>>,
    log: Arc<Mutex<Option<File>>>,
    log_path: PathBuf,
}

impl Sidecar {
    fn new(log_path: PathBuf) -> Self {
        if let Some(dir) = log_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let log = OpenOptions::new().create(true).append(true).open(&log_path).ok();
        Self {
            outcome: watch::channel(None).0,
            child: Mutex::new(None),
            alive: watch::channel(false).0,
            generation: AtomicU64::new(0),
            restarts: AtomicU32::new(0),
            exiting: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
            close_to_tray: AtomicBool::new(true),
            output: Arc::new(Mutex::new(VecDeque::new())),
            log: Arc::new(Mutex::new(log)),
            log_path,
        }
    }

    /// Kept for the error page and appended to the log file the error page points to.
    fn push_line(&self, bytes: &[u8]) {
        let line = String::from_utf8_lossy(bytes).trim_end().to_string();
        if let Some(file) = self.log.lock().unwrap().as_mut() {
            let _ = writeln!(file, "{line}");
        }
        let mut lines = self.output.lock().unwrap();
        lines.push_back(line);
        if lines.len() > OUTPUT_LINES {
            lines.pop_front();
        }
    }

    fn failure(&self, message: String) -> SidecarFailure {
        SidecarFailure {
            message,
            output: self.output.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n"),
            log_path: self.log_path.display().to_string(),
        }
    }

    fn connection(&self) -> Option<SidecarConnection> {
        match &*self.outcome.borrow() {
            Some(Ok(conn)) => Some(conn.clone()),
            _ => None,
        }
    }

    fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

/// One HTTP/1.1 request over a plain socket; the sidecar only ever listens on loopback.
fn request(base_url: &str, method: &str, path: &str, token: Option<&str>) -> Option<(u16, String)> {
    let addr: SocketAddr = base_url.strip_prefix("http://")?.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{auth}Content-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let (head, body) = response.split_once("\r\n\r\n")?;
    let status = head.split(' ').nth(1)?.parse().ok()?;
    Some((status, body.to_string()))
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

fn handle_shell_line(app: &AppHandle, sidecar: &Sidecar, line: ShellLine) {
    match line {
        ShellLine::Notify { title, body } => notify(app, &title, &body),
        ShellLine::Settings { close_to_tray } => sidecar.close_to_tray.store(close_to_tray, Ordering::SeqCst),
        ShellLine::Token { token } => sidecar.outcome.send_modify(|o| {
            if let Some(Ok(conn)) = o {
                conn.token = token;
            }
        }),
        ShellLine::Runs { active } => {
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let tip = if active > 0 { format!("DiscoLurk · 运行中 {active}") } else { "DiscoLurk · 空闲".to_string() };
                let _ = tray.set_tooltip(Some(tip));
            }
        }
    }
}

/// The event channel is bounded, so output is drained for the sidecar's whole life or its writes
/// would eventually stall. An exit nobody asked for restarts the sidecar.
fn drain(app: AppHandle, mut rx: Receiver<CommandEvent>, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let sidecar = app.state::<Sidecar>();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => match serde_json::from_slice::<ShellLine>(&line) {
                    Ok(shell_line) => handle_shell_line(&app, &sidecar, shell_line),
                    Err(_) => sidecar.push_line(&line),
                },
                CommandEvent::Stderr(line) => sidecar.push_line(&line),
                CommandEvent::Terminated(t) => {
                    sidecar.push_line(format!("sidecar exited: code {:?}, signal {:?}", t.code, t.signal).as_bytes());
                    if sidecar.generation.load(Ordering::SeqCst) == generation {
                        sidecar.alive.send_replace(false);
                        if !sidecar.exiting.load(Ordering::SeqCst) {
                            restart(app.clone());
                        }
                    }
                }
                _ => {}
            }
        }
    });
}

/// The sidecar binds 127.0.0.1:0 and mints its token itself, announcing both in one stdout
/// line, so the token never passes through argv, the environment or a file. The ready line is
/// consumed here and never copied into the kept output or the log.
async fn start(app: &AppHandle) -> Result<SidecarConnection, String> {
    let sidecar = app.state::<Sidecar>();
    let (mut rx, child) = app
        .shell()
        .sidecar("lurk")
        .map_err(|e| e.to_string())?
        .arg("sidecar")
        .spawn()
        .map_err(|e| e.to_string())?;
    let generation = sidecar.generation.fetch_add(1, Ordering::SeqCst) + 1;
    *sidecar.child.lock().unwrap() = Some(child);
    sidecar.alive.send_replace(true);
    let deadline = Instant::now() + STARTUP_TIMEOUT;

    let ready = loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Err(_) => return Err(format!("sidecar reported no ready line within {} s", STARTUP_TIMEOUT.as_secs())),
            Ok(None) => return Err("sidecar output closed before it was ready".into()),
            Ok(Some(CommandEvent::Stdout(line))) => match serde_json::from_slice::<ReadyLine>(&line) {
                Ok(ready) if ready.event == "ready" => break ready,
                _ => match serde_json::from_slice::<ShellLine>(&line) {
                    Ok(shell_line) => handle_shell_line(app, &sidecar, shell_line),
                    Err(_) => sidecar.push_line(&line),
                },
            },
            Ok(Some(CommandEvent::Stderr(line))) => sidecar.push_line(&line),
            Ok(Some(CommandEvent::Terminated(t))) => {
                sidecar.alive.send_replace(false);
                return Err(format!("sidecar exited before it was ready: code {:?}, signal {:?}", t.code, t.signal));
            }
            Ok(Some(_)) => {}
        }
    };
    drain(app.clone(), rx, generation);

    let base_url = format!("http://127.0.0.1:{}", ready.port);
    let health_url = base_url.clone();
    let body = tauri::async_runtime::spawn_blocking(move || {
        while Instant::now() < deadline {
            if let Some((200, body)) = request(&health_url, "GET", "/health", None) {
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
        base_url,
        token: ready.token,
        version: health.version,
        log_path: sidecar.log_path.display().to_string(),
        updater: cfg!(not(target_os = "macos")),
    })
}

async fn launch(app: &AppHandle) {
    let result = start(app).await;
    let sidecar = app.state::<Sidecar>();
    let outcome = result.map_err(|message| {
        sidecar.kill();
        sidecar.failure(message)
    });
    sidecar.outcome.send_replace(Some(outcome));
}

/// A crashed or hung sidecar is replaced up to three times. The new one reclaims the Profile locks
/// and browsers the old one left behind before it serves anything; runs that were in progress are
/// lost and show as failed in the page, which rebuilds itself on the restart event.
fn restart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let sidecar = app.state::<Sidecar>();
        sidecar.kill();
        let attempt = sidecar.restarts.fetch_add(1, Ordering::SeqCst) + 1;
        if attempt > MAX_RESTARTS {
            let failure = sidecar.failure(format!("sidecar stopped {attempt} times; not restarting again"));
            sidecar.outcome.send_replace(Some(Err(failure)));
            notify(&app, "DiscoLurk 后台服务异常", "后台服务多次退出，已停止重启。请查看日志后重新打开应用。");
        } else {
            sidecar.outcome.send_replace(None);
            notify(&app, "DiscoLurk 后台服务已重启", "后台服务意外退出，已自动重启；进行中的运行已中断。");
            launch(&app).await;
        }
        let _ = app.emit("sidecar-restarted", ());
    });
}

/// Every 5 s; a sidecar that stops answering is killed, and its exit leads to a restart.
fn heartbeat(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut misses = 0;
        loop {
            tokio::time::sleep(HEARTBEAT).await;
            let sidecar = app.state::<Sidecar>();
            if sidecar.exiting.load(Ordering::SeqCst) {
                return;
            }
            let Some(conn) = sidecar.connection() else {
                misses = 0;
                continue;
            };
            let ok = tauri::async_runtime::spawn_blocking(move || matches!(request(&conn.base_url, "GET", "/health", None), Some((200, _))))
                .await
                .unwrap_or(false);
            misses = if ok { 0 } else { misses + 1 };
            if misses >= HEARTBEAT_MISSES {
                misses = 0;
                sidecar.push_line(b"shell: sidecar missed its heartbeats; killing it");
                sidecar.kill();
            }
        }
    });
}

/// Asks the sidecar to cancel runs, close every browser (sign-in windows included) and flush its
/// logs, waits up to 15 s for it to exit, and kills it after that.
async fn shutdown_sidecar(app: &AppHandle) {
    let sidecar = app.state::<Sidecar>();
    sidecar.exiting.store(true, Ordering::SeqCst);
    if let Some(conn) = sidecar.connection() {
        let _ = tauri::async_runtime::spawn_blocking(move || request(&conn.base_url, "POST", "/shutdown", Some(&conn.token))).await;
    }
    let mut alive = sidecar.alive.subscribe();
    let exited = tokio::time::timeout(SHUTDOWN_GRACE, alive.wait_for(|a| !*a)).await;
    if exited.is_err() {
        sidecar.push_line(b"shell: sidecar did not exit within 15 s; killing it");
    }
    sidecar.kill();
}

fn quit(app: AppHandle) {
    if app.state::<Sidecar>().exiting.swap(true, Ordering::SeqCst) {
        return;
    }
    app.state::<Sidecar>().push_line(b"shell: quitting; shutting the sidecar down");
    tauri::async_runtime::spawn(async move {
        shutdown_sidecar(&app).await;
        app.state::<Sidecar>().exit_ready.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

/// Start-up result for the page: waits until the sidecar is up (or has failed) and returns the
/// connection, token included. The page asks for it rather than receiving it in a URL or file.
#[tauri::command]
async fn connect_sidecar(sidecar: State<'_, Sidecar>) -> Result<SidecarConnection, SidecarFailure> {
    let mut rx = sidecar.outcome.subscribe();
    let outcome = rx.wait_for(|o| o.is_some()).await.map_err(|e| sidecar.failure(e.to_string()))?;
    outcome.clone().expect("waited for Some")
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "没有可用的更新".to_string())?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    shutdown_sidecar(&app).await;
    app.restart();
}

/// macOS builds are unsigned, so they never self-update; the page links to the release instead.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn install_update() -> Result<(), String> {
    Err("macOS 版本不支持自动更新".into())
}

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

/// Tray actions go straight to the sidecar over HTTP: a hidden window's page may be suspended.
fn tray_post(app: &AppHandle, path: &'static str, failed_title: &'static str) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(conn) = app.state::<Sidecar>().connection() else { return };
        let reply = tauri::async_runtime::spawn_blocking(move || request(&conn.base_url, "POST", path, Some(&conn.token)))
            .await
            .ok()
            .flatten();
        match reply {
            Some((status, _)) if status < 300 => {}
            Some((_, body)) => {
                let message = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
                    .unwrap_or(body);
                notify(&app, failed_title, &message);
            }
            None => notify(&app, failed_title, "后台服务没有响应"),
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示/隐藏窗口", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "开始当前预设", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "停止所有运行", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 DiscoLurk", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &start, &stop, &separator, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("DiscoLurk · 空闲")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_window(app),
            "start" => tray_post(app, "/runs/current", "无法开始运行"),
            "stop" => tray_post(app, "/runs/stop", "无法停止运行"),
            "quit" => quit(app.clone()),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    // Autostart launches with --hidden: the tray and the scheduler run, the window stays closed.
    let hidden = std::env::args().any(|a| a == "--hidden");
    let builder = tauri::Builder::default()
        // Registered first so a second launch only wakes the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Visibility is left to start-up, which shows the window only once the sidecar has settled.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])));
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .setup(move |app| {
            let log_path = app.path().app_log_dir()?.join("sidecar.log");
            app.manage(Sidecar::new(log_path));
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            // Started from Rust rather than the page: WKWebView suspends timers and network loads of a
            // window that has never been shown, and with --hidden the window is not shown at all.
            tauri::async_runtime::spawn(async move {
                launch(&handle).await;
                heartbeat(handle.clone());
                if !hidden {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().state::<Sidecar>().close_to_tray.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![connect_sidecar, install_update])
        .build(tauri::generate_context!())
        .expect("error while building DiscoLurk")
        .run(|app, event| match event {
            // Quit from the tray, closing the last window, or app.exit(): the sidecar is shut down
            // first, then the app exits for real.
            RunEvent::ExitRequested { api, .. } => {
                if !app.state::<Sidecar>().exit_ready.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    quit(app.clone());
                }
            }
            // macOS ⌘Q, the Dock's Quit, logout and shutdown terminate without ExitRequested. The
            // process is about to end, so the same shutdown runs here, blocking for up to 15 s.
            RunEvent::Exit => {
                let sidecar = app.state::<Sidecar>();
                if !sidecar.exit_ready.load(Ordering::SeqCst) && !sidecar.exiting.swap(true, Ordering::SeqCst) {
                    sidecar.push_line(b"shell: terminating; shutting the sidecar down");
                    tauri::async_runtime::block_on(shutdown_sidecar(app));
                }
            }
            _ => {}
        });
}
