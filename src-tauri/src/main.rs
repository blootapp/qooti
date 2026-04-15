// No extra console window on Windows (debug or release). Logs go to file + devtools via tauri-plugin-log.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
