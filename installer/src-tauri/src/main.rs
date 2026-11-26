#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sora_setup::ensure_webview2_before_gui();
    sora_setup::run()
}
