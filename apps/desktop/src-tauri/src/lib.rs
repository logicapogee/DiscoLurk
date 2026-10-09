use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::async_runtime::Receiver;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_window_state::StateFlags;
use tokio::sync::{oneshot, watch};

/// Covers reclaiming the Profiles and browsers a dead sidecar left behind, which precedes ready.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// The sidecar writes an `alive` line every 10 s; this much silence means its event loop is stuck.
const SILENCE_LIMIT: Duration = Duration::from_secs(35);
const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_RESTARTS: usize = 3;
/// A replacement sidecar that has run this long clears the restart history.
const HEALTHY_AFTER: Duration = Duration::from_secs(5 * 60);
/// The sidecar's own cleanup budget is 15 s; after that it is killed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(15);
const OUTPUT_LINES: usize = 200;
const TRAY_ID: &str = "main";
const TRAY_IDLE: &[u8] = include_bytes!("../icons/tray-idle.png");
const TRAY_RUNNING: &[u8] = include_bytes!("../icons/tray-running.png");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarConnection {
    base_url: String,
    token: String,
    version: String,
    /// The sidecar's log directory, `<appData>/disco-lurk/logs`.
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

/// Lines the shell writes to the sidecar's stdin.
#[derive(Clone, Copy, Serialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
enum ShellCommand {
    Start,
    Stop,
    Shutdown,
}

/// Lines the sidecar writes to its stdout; anything else there is plain output.
#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
enum SidecarLine {
    Starting,
    Ready {
        port: u16,
        token: String,
        version: String,
    },
    Alive,
    Runs {
        active: u32,
    },
    Token {
        token: String,
    },
    Notify {
        title: String,
        body: String,
    },
    Result {
        cmd: String,
        ok: bool,
        #[serde(default)]
        message: Option<String>,
    },
}

struct Ready {
    port: u16,
    token: String,
    version: String,
}

/// One spawned sidecar. Its exit is recorded once, by the task draining its output.
struct Process {
    /// Holding the child keeps the write end of the sidecar's stdin open. However the shell ends,
    /// even by SIGKILL, that pipe closes and the sidecar runs its shutdown cleanup.
    child: Mutex<Option<CommandChild>>,
    exited: watch::Sender<bool>,
    /// Set when this process reported ready; only such a process is restarted when it exits.
    supervised: AtomicBool,
    exit_status: Mutex<Option<String>>,
}

impl Process {
    fn new(child: CommandChild) -> Self {
        Self {
            child: Mutex::new(Some(child)),
            exited: watch::channel(false).0,
            supervised: AtomicBool::new(false),
            exit_status: Mutex::new(None),
        }
    }

    fn has_exited(&self) -> bool {
        *self.exited.borrow()
    }

    fn send(&self, command: ShellCommand) -> bool {
        let mut child = self.child.lock().unwrap();
        let Some(child) = child.as_mut() else { return false };
        let mut line = serde_json::to_vec(&command).expect("commands serialize");
        line.push(b'\n');
        child.write(&line).is_ok()
    }

    fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }

    fn abandon(&self) {
        self.kill();
        self.exited.send_replace(true);
    }
}

struct Sidecar {
    outcome: watch::Sender<Outcome>,
    current: Mutex<Option<Arc<Process>>>,
    restarts: Mutex<VecDeque<Instant>>,
    exiting: AtomicBool,
    exit_ready: AtomicBool,
    output: Mutex<VecDeque<String>>,
    log_dir: OnceLock<PathBuf>,
}

impl Sidecar {
    fn new() -> Self {
        Self {
            outcome: watch::channel(None).0,
            current: Mutex::new(None),
            restarts: Mutex::new(VecDeque::new()),
            exiting: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
            output: Mutex::new(VecDeque::new()),
            log_dir: OnceLock::new(),
        }
    }

    /// Kept only for the start-up failure page; the sidecar writes its own log files.
    fn push_line(&self, bytes: &[u8]) {
        let line = String::from_utf8_lossy(bytes).trim_end().to_string();
        let mut lines = self.output.lock().unwrap();
        lines.push_back(line);
        if lines.len() > OUTPUT_LINES {
            lines.pop_front();
        }
    }

    fn log_dir(&self) -> String {
        self.log_dir.get().map(|p| p.display().to_string()).unwrap_or_default()
    }

    fn failure(&self, message: String) -> SidecarFailure {
        SidecarFailure {
            message,
            output: self.output.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n"),
            log_path: self.log_dir(),
        }
    }

    fn current(&self) -> Option<Arc<Process>> {
        self.current.lock().unwrap().clone()
    }

    /// Records a restart attempt unless three already happened within the last ten minutes.
    fn allow_restart(&self) -> bool {
        let now = Instant::now();
        let mut restarts = self.restarts.lock().unwrap();
        while restarts.front().is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW) {
            restarts.pop_front();
        }
        if restarts.len() >= MAX_RESTARTS {
            return false;
        }
        restarts.push_back(now);
        true
    }

    /// Asks the sidecar to cancel runs, close every browser (sign-in windows included) and flush
    /// its logs, waits up to 15 s for it to exit, and kills it after that. Blocks the caller, so it
    /// also serves the main thread at process exit and the updater's synchronous exit hook.
    fn stop_blocking(&self) {
        let Some(process) = self.current() else { return };
        if process.has_exited() {
            return;
        }
        if process.send(ShellCommand::Shutdown) {
            let deadline = Instant::now() + SHUTDOWN_GRACE;
            while !process.has_exited() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            if !process.has_exited() {
                self.push_line(b"shell: sidecar did not exit within 15 s; killing it");
            }
        }
        process.kill();
    }
}

fn sidecar_of(app: &AppHandle) -> Arc<Sidecar> {
    app.state::<Arc<Sidecar>>().inner().clone()
}

async fn stop_sidecar(sidecar: Arc<Sidecar>) {
    let _ = tauri::async_runtime::spawn_blocking(move || sidecar.stop_blocking()).await;
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Posted to the main thread without waiting: tray calls block until the main thread runs them,
/// and at exit the main thread is busy waiting for the sidecar.
fn show_run_state(app: &AppHandle, active: u32) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = handle.tray_by_id(TRAY_ID) else { return };
        let (icon, tip) = if active > 0 {
            (TRAY_RUNNING, format!("DiscoLurk · 运行中 {active}"))
        } else {
            (TRAY_IDLE, "DiscoLurk · 空闲".to_string())
        };
        let _ = tray.set_icon(Image::from_bytes(icon).ok());
        let _ = tray.set_tooltip(Some(tip));
    });
}

fn handle_line(app: &AppHandle, sidecar: &Sidecar, line: SidecarLine) {
    if sidecar.exiting.load(Ordering::SeqCst) {
        return;
    }
    match line {
        SidecarLine::Starting => sidecar.push_line(b"sidecar: starting"),
        SidecarLine::Ready { .. } | SidecarLine::Alive => {}
        SidecarLine::Runs { active } => show_run_state(app, active),
        // A reloaded page asks for the connection again and needs the token in force now.
        SidecarLine::Token { token } => sidecar.outcome.send_modify(|o| {
            if let Some(Ok(conn)) = o {
                conn.token = token;
            }
        }),
        SidecarLine::Notify { title, body } => notify(app, &title, &body),
        SidecarLine::Result { cmd, ok: false, message } => {
            let title = if cmd == "start" { "无法开始运行" } else { "无法停止运行" };
            notify(app, title, message.as_deref().unwrap_or("后台服务拒绝了这个操作"));
        }
        SidecarLine::Result { .. } => {}
    }
}

/// The only reader of the sidecar's output, for its whole life: the event channel is bounded, so
/// unread output would eventually stall the sidecar's writes. It hands the ready line to `start`,
/// records the exit, and restarts a supervised sidecar that exits unasked.
fn drain(app: AppHandle, mut rx: Receiver<CommandEvent>, process: Arc<Process>, ready: oneshot::Sender<Ready>) {
    tauri::async_runtime::spawn(async move {
        let sidecar = sidecar_of(&app);
        let mut ready = Some(ready);
        loop {
            let event = match tokio::time::timeout(SILENCE_LIMIT, rx.recv()).await {
                Ok(Some(event)) => event,
                Ok(None) => break,
                Err(_) => {
                    // Before ready, `start`'s own timeout decides.
                    if process.supervised.load(Ordering::SeqCst) {
                        sidecar.push_line(b"shell: no alive line from the sidecar for 35 s; killing it");
                        process.kill();
                    }
                    continue;
                }
            };
            match event {
                CommandEvent::Stdout(line) => match serde_json::from_slice::<SidecarLine>(&line) {
                    Ok(SidecarLine::Ready { port, token, version }) => {
                        if let Some(tx) = ready.take() {
                            // The ready line never reaches the kept output: it carries the token.
                            if tx.send(Ready { port, token, version }).is_ok() {
                                process.supervised.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                    Ok(line) => handle_line(&app, &sidecar, line),
                    Err(_) => sidecar.push_line(&line),
                },
                CommandEvent::Stderr(line) => sidecar.push_line(&line),
                CommandEvent::Terminated(t) => {
                    let status = format!("sidecar exited: code {:?}, signal {:?}", t.code, t.signal);
                    sidecar.push_line(status.as_bytes());
                    *process.exit_status.lock().unwrap() = Some(status);
                    break;
                }
                _ => {}
            }
        }
        drop(ready);
        process.child.lock().unwrap().take();
        process.exited.send_replace(true);
        if process.supervised.load(Ordering::SeqCst) && !sidecar.exiting.load(Ordering::SeqCst) {
            restart(app);
        }
    });
}

/// The sidecar binds 127.0.0.1:0 and mints its token itself, announcing both in one stdout line,
/// so the token never passes through argv, the environment or a file.
async fn start(app: &AppHandle, sidecar: &Sidecar) -> Result<SidecarConnection, String> {
    let (rx, child) = app
        .shell()
        .sidecar("lurk")
        .map_err(|e| e.to_string())?
        .arg("sidecar")
        .spawn()
        .map_err(|e| e.to_string())?;
    let process = Arc::new(Process::new(child));
    *sidecar.current.lock().unwrap() = Some(process.clone());
    let (tx, ready_rx) = oneshot::channel();
    drain(app.clone(), rx, process.clone(), tx);
    let ready = match tokio::time::timeout(STARTUP_TIMEOUT, ready_rx).await {
        Ok(Ok(ready)) => ready,
        Ok(Err(_)) => {
            process.abandon();
            let status = process.exit_status.lock().unwrap().clone();
            return Err(status.map_or("sidecar output closed before it was ready".into(), |s| format!("{s} before it was ready")));
        }
        Err(_) => {
            process.abandon();
            return Err(format!("sidecar reported no ready line within {} s", STARTUP_TIMEOUT.as_secs()));
        }
    };
    clear_restarts_when_healthy(sidecar_of(app), process);
    Ok(SidecarConnection {
        base_url: format!("http://127.0.0.1:{}", ready.port),
        token: ready.token,
        version: ready.version,
        log_path: sidecar.log_dir(),
        updater: cfg!(not(target_os = "macos")),
    })
}

fn clear_restarts_when_healthy(sidecar: Arc<Sidecar>, process: Arc<Process>) {
    tauri::async_runtime::spawn(async move {
        let mut exited = process.exited.subscribe();
        if tokio::time::timeout(HEALTHY_AFTER, exited.wait_for(|e| *e)).await.is_err() {
            sidecar.restarts.lock().unwrap().clear();
        }
    });
}

async fn launch(app: &AppHandle) -> bool {
    let sidecar = sidecar_of(app);
    let outcome = start(app, &sidecar).await.map_err(|message| sidecar.failure(message));
    let ok = outcome.is_ok();
    sidecar.outcome.send_replace(Some(outcome));
    ok
}

/// A crashed or hung sidecar is replaced at most three times within ten minutes. The new one
/// reclaims the Profile locks and browsers the old one left behind before it serves anything;
/// runs that were in progress are lost and show as failed in the page, which rebuilds itself on
/// the restart event.
fn restart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let sidecar = sidecar_of(&app);
        sidecar.outcome.send_replace(None);
        loop {
            if sidecar.exiting.load(Ordering::SeqCst) {
                return;
            }
            if !sidecar.allow_restart() {
                let failure = sidecar.failure(format!("sidecar stopped {} times within 10 minutes; not restarting again", MAX_RESTARTS + 1));
                sidecar.outcome.send_replace(Some(Err(failure)));
                notify(&app, "DiscoLurk 后台服务异常", "后台服务多次退出，已停止重启。请查看日志后重新打开应用。");
                break;
            }
            if launch(&app).await {
                notify(&app, "DiscoLurk 后台服务已重启", "后台服务意外退出，已自动重启；进行中的运行已中断。");
                break;
            }
        }
        let _ = app.emit("sidecar-restarted", ());
    });
}

fn quit(app: AppHandle) {
    let sidecar = sidecar_of(&app);
    if sidecar.exiting.swap(true, Ordering::SeqCst) {
        return;
    }
    sidecar.push_line(b"shell: quitting; shutting the sidecar down");
    tauri::async_runtime::spawn(async move {
        stop_sidecar(sidecar.clone()).await;
        sidecar.exit_ready.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

/// Start-up result for the page: waits until the sidecar is up (or has failed) and returns the
/// connection, token included. The page asks for it rather than receiving it in a URL or file.
#[tauri::command]
async fn connect_sidecar(sidecar: State<'_, Arc<Sidecar>>) -> Result<SidecarConnection, SidecarFailure> {
    let mut rx = sidecar.outcome.subscribe();
    let outcome = rx.wait_for(|o| o.is_some()).await.map_err(|e| sidecar.failure(e.to_string()))?;
    outcome.clone().expect("waited for Some")
}

/// Downloads while the sidecar keeps working, then stops it and installs. The Windows installer
/// ends this process from inside `install`, which is why the exit hook stops the sidecar too.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let sidecar = sidecar_of(&app);
    let hook_sidecar = sidecar.clone();
    let hook_app = app.clone();
    let update = app
        .updater_builder()
        .on_before_exit(move || {
            hook_sidecar.exiting.store(true, Ordering::SeqCst);
            hook_sidecar.stop_blocking();
            hook_app.cleanup_before_exit();
        })
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "没有可用的更新".to_string())?;
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    sidecar.exiting.store(true, Ordering::SeqCst);
    stop_sidecar(sidecar.clone()).await;
    if let Err(e) = update.install(bytes) {
        sidecar.exiting.store(false, Ordering::SeqCst);
        sidecar.outcome.send_replace(None);
        launch(&app).await;
        let _ = app.emit("sidecar-restarted", ());
        return Err(e.to_string());
    }
    sidecar.exit_ready.store(true, Ordering::SeqCst);
    app.restart();
}

/// macOS builds are unsigned, so they never self-update; the page links to the release instead.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn install_update() -> Result<(), String> {
    Err("macOS 版本不支持自动更新".into())
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_window(app);
        }
    }
}

/// Tray actions go to the sidecar's stdin: a hidden window's page may be suspended.
fn tray_command(app: &AppHandle, command: ShellCommand) {
    let running = sidecar_of(app).current().filter(|p| p.supervised.load(Ordering::SeqCst) && !p.has_exited());
    if !running.is_some_and(|p| p.send(command)) {
        notify(app, "DiscoLurk", "后台服务未在运行");
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "显示/隐藏窗口", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "开始当前预设", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "停止所有运行", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 DiscoLurk", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &start, &stop, &separator, &quit_item])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(TRAY_IDLE)?)
        .menu(&menu)
        .tooltip("DiscoLurk · 空闲")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_window(app),
            "start" => tray_command(app, ShellCommand::Start),
            "stop" => tray_command(app, ShellCommand::Stop),
            "quit" => quit(app.clone()),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    // Autostart launches with --hidden: the tray and the scheduler run, the window stays closed.
    let hidden = std::env::args().any(|a| a == "--hidden");
    let builder = tauri::Builder::default()
        // Registered first so a second launch only wakes the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
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
            let sidecar = Arc::new(Sidecar::new());
            // The same `<appData>/disco-lurk/logs` the sidecar derives from each platform's data root.
            let _ = sidecar.log_dir.set(app.path().data_dir()?.join("disco-lurk").join("logs"));
            app.manage(sidecar);
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            // Started from Rust rather than the page: WKWebView suspends timers and network loads of a
            // window that has never been shown, and with --hidden the window is not shown at all.
            tauri::async_runtime::spawn(async move {
                launch(&handle).await;
                if !hidden {
                    show_window(&handle);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // The app lives in the tray; only its Quit entry ends it.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![connect_sidecar, install_update])
        .build(tauri::generate_context!())
        .expect("error while building DiscoLurk")
        .run(|app, event| match event {
            // Quit from the tray or app.exit(): the sidecar is shut down first, then the app exits for real.
            RunEvent::ExitRequested { api, .. } => {
                if !sidecar_of(app).exit_ready.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    quit(app.clone());
                }
            }
            // macOS ⌘Q, the Dock's Quit, logout and shutdown terminate without ExitRequested. The
            // process is about to end, so the same shutdown runs here on the main thread, blocking
            // for up to 15 s; with `exiting` set, nothing the sidecar reports waits on this thread.
            RunEvent::Exit => {
                let sidecar = sidecar_of(app);
                if !sidecar.exit_ready.load(Ordering::SeqCst) && !sidecar.exiting.swap(true, Ordering::SeqCst) {
                    sidecar.push_line(b"shell: terminating; shutting the sidecar down");
                    sidecar.stop_blocking();
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows: false, .. } => show_window(app),
            _ => {}
        });
}
