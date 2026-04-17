// No extra console window on Windows in release. Debug builds attach to the parent console so
// `cargo run` / `tauri dev` can show `eprintln!` and Rust diagnostics (GUI subsystem otherwise drops stderr).
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(all(windows, debug_assertions))]
fn attach_parent_console_for_stderr() {
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
    }
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

fn main() {
    #[cfg(all(windows, debug_assertions))]
    attach_parent_console_for_stderr();
    app_lib::run();
}
