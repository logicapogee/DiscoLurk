// Keeps a console window from opening alongside the app in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's compositing mode renders a blank window on the proprietary NVIDIA driver.
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/proc/driver/nvidia/version").exists() && std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    disco_lurk_lib::run()
}
