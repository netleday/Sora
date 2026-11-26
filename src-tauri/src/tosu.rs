//! tosu (tosu.app): a separate app that reads osu! while it runs and tells what it sees on
//! ws://127.0.0.1:24050 (the frontend listens there, src/lib/tosu-follow.ts). Fumen only finds it,
//! remembers where it is and starts it when asked; it never reads the game itself.
//!
//! On Windows tosu turns Fumen's window away until it's on tosu's ALLOWED_IPS (see `WINDOW_HOST`),
//! so Fumen puts it there in tosu.env, and starts tosu again once if a running one doesn't take it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TosuStatus {
    pub running: bool,
    /// where tosu is: the one picked or seen running, else a guess; None when it wasn't found
    pub path: Option<String>,
}

/// Only an app called tosu is ever started (`tosu.exe`, or `tosu` on Linux).
pub fn is_tosu(path: &Path) -> bool {
    let stem_ok = path.file_stem().is_some_and(|s| s.eq_ignore_ascii_case("tosu"));
    let ext_ok = match path.extension() {
        Some(e) => cfg!(windows) && e.eq_ignore_ascii_case("exe"),
        None => !cfg!(windows),
    };
    stem_ok && ext_ok && path.is_file()
}

/// The running tosu's program file, if it runs.
pub fn running() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        windows_running()
    }
    #[cfg(target_os = "linux")]
    {
        let procs = std::fs::read_dir("/proc").ok()?;
        procs
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
            .filter(|e| std::fs::read_to_string(e.path().join("comm")).is_ok_and(|c| c.trim() == "tosu"))
            .find_map(|e| std::fs::read_link(e.path().join("exe")).ok())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        None
    }
}

#[cfg(windows)]
fn windows_running() -> Option<PathBuf> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    let mut found = None;
    // SAFETY: plain Win32 calls on handles opened and closed here; buffers sized as documented
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok && found.is_none() {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case("tosu.exe") {
                let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !proc.is_null() {
                    let mut buf = [0u16; 1024];
                    let mut size = buf.len() as u32;
                    if QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size) != 0 {
                        found = Some(PathBuf::from(String::from_utf16_lossy(&buf[..size as usize])));
                    }
                    CloseHandle(proc);
                }
            }
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    found
}

/// Where people tend to leave tosu: unzipped into Downloads, on the desktop, in Documents, or in
/// a tosu folder of its own. The newest of those found.
pub fn guess() -> Option<PathBuf> {
    let home = dirs_home()?;
    let mut roots = vec![home.join("Downloads"), home.join("Desktop"), home.join("Documents"), home.join("tosu")];
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        roots.push(local.join("tosu"));
        roots.push(local.join("Programs").join("tosu"));
    }
    let name = if cfg!(windows) { "tosu.exe" } else { "tosu" };
    let mut found: Vec<PathBuf> = Vec::new();
    for root in roots {
        found.push(root.join(name));
        // one level down: "tosu-windows-v4.26.3/tosu.exe"
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
                found.push(e.path().join(name));
            }
        }
    }
    found
        .into_iter()
        .filter(|p| is_tosu(p))
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Starts tosu on its own, in its folder (it keeps its settings there), without a console window.
pub fn start(path: &Path) -> Result<()> {
    if !is_tosu(path) {
        return Err(Error::known("tosu-not-found", "That isn't tosu."));
    }
    let mut cmd = Command::new(path);
    if let Some(dir) = path.parent() {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NO_WINDOW: no console, and it lives on without Fumen
        cmd.creation_flags(0x0000_0008 | 0x0800_0000);
    }
    cmd.spawn().map(drop).map_err(|e| Error::known("launch-failed", format!("tosu couldn't be started: {e}")))
}

// ── letting Fumen's window in ───────────────────────────────────────────

/// What Fumen's window is to tosu on Windows: its pages come from http://tauri.localhost, and tosu
/// only lets in the names on its ALLOWED_IPS (127.0.0.1, localhost and "absolute" unless changed),
/// turning the rest away with a 403. Elsewhere the window is tauri://localhost, which passes.
pub const WINDOW_HOST: &str = "tauri.localhost";
const ALLOWED: &str = "ALLOWED_IPS";
const DEFAULT_ALLOWED: &str = "127.0.0.1,localhost,absolute";

/// tosu's settings file for the tosu at `exe`: next to it (on Linux ~/.config/tosu).
pub fn env_path(exe: &Path) -> Option<PathBuf> {
    if cfg!(target_os = "linux") {
        let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| dirs_home().map(|h| h.join(".config")))?;
        return Some(base.join("tosu").join("tosu.env"));
    }
    Some(exe.parent()?.join("tosu.env"))
}

/// tosu.env with Fumen's window on ALLOWED_IPS, the rest of it as it was; None when it's on there
/// already.
pub fn add_window(text: &str) -> Option<String> {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.split(nl).map(String::from).collect();
    let at = lines.iter().position(|l| {
        let t = l.trim_start();
        t.strip_prefix(ALLOWED).is_some_and(|rest| rest.trim_start().starts_with('='))
    });
    let Some(i) = at else {
        // no line for it: tosu's own list, and the window
        if lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines.push(format!("{ALLOWED}={DEFAULT_ALLOWED},{WINDOW_HOST}"));
        lines.push(String::new());
        return Some(lines.join(nl));
    };
    let line = &lines[i];
    let eq = line.find('=')?;
    let (head, value) = (&line[..=eq], line[eq + 1..].trim());
    // a quoted value keeps its quotes
    let (open, inner, close) = match value.chars().next() {
        Some(q @ ('"' | '\'')) if value.len() >= 2 && value.ends_with(q) => (q.to_string(), &value[1..value.len() - 1], q.to_string()),
        _ => (String::new(), value, String::new()),
    };
    if inner.split(',').any(|p| p.trim().eq_ignore_ascii_case(WINDOW_HOST)) {
        return None;
    }
    let list = if inner.trim().is_empty() { DEFAULT_ALLOWED.to_string() } else { inner.trim_end_matches(',').to_string() };
    lines[i] = format!("{head}{open}{list},{WINDOW_HOST}{close}");
    Some(lines.join(nl))
}

/// Puts Fumen's window on the ALLOWED_IPS in tosu's settings (the tosu at `exe`), written in place
/// so a running tosu reads it again. Ok(true) when it changed the file; Ok(false) when it was on
/// there already, or tosu hasn't made its settings yet (it does at its first start).
pub fn allow_window(exe: &Path) -> Result<bool> {
    let Some(file) = env_path(exe) else { return Ok(false) };
    let Ok(text) = std::fs::read_to_string(&file) else { return Ok(false) };
    match add_window(&text) {
        Some(next) => {
            std::fs::write(&file, next)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Whether tosu lets Fumen's window in now, asked over HTTP with the window's origin (tosu answers
/// a name it doesn't allow with 403). None when tosu doesn't answer.
pub fn lets_window_in() -> Option<bool> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(2)))
        .http_status_as_error(false)
        .build()
        .into();
    let res = agent.get("http://127.0.0.1:24050/json/v2").header("Origin", &format!("http://{WINDOW_HOST}")).call().ok()?;
    Some(res.status().as_u16() != 403)
}

/// Ends the running tosu (to start it again with its settings read anew).
pub fn stop() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
        };
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        let mut stopped = false;
        // SAFETY: plain Win32 calls on handles opened and closed here
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return false;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snap, &mut entry) != 0;
            while ok {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case("tosu.exe") {
                    let proc = OpenProcess(PROCESS_TERMINATE, 0, entry.th32ProcessID);
                    if !proc.is_null() {
                        stopped |= TerminateProcess(proc, 0) != 0;
                        CloseHandle(proc);
                    }
                }
                ok = Process32NextW(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
        }
        stopped
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tosu_is_tosu() {
        let dir = std::env::temp_dir().join(format!("fumen-tosu-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = if cfg!(windows) { "tosu.exe" } else { "tosu" };
        let other = if cfg!(windows) { "osu!.exe" } else { "osu" };
        std::fs::write(dir.join(name), b"x").unwrap();
        std::fs::write(dir.join(other), b"x").unwrap();
        assert!(is_tosu(&dir.join(name)));
        assert!(!is_tosu(&dir.join(other)));
        assert!(!is_tosu(&dir.join("missing").join(name)));
        assert!(start(&dir.join(other)).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn puts_the_window_on_tosus_list() {
        let env = "DEBUG_LOG=false\r\nSERVER_PORT=24050\r\nALLOWED_IPS=127.0.0.1,localhost,absolute\r\n\r\nSTATIC_FOLDER_PATH=./static\r\n";
        let out = add_window(env).unwrap();
        assert_eq!(out, env.replace("absolute\r\n", "absolute,tauri.localhost\r\n"));
        assert_eq!(add_window(&out), None, "once is enough");
        assert_eq!(add_window("ALLOWED_IPS = \"127.0.0.1, TAURI.localhost\"\n"), None);
        assert_eq!(add_window("ALLOWED_IPS=\"127.0.0.1,localhost,\"\n").unwrap(), "ALLOWED_IPS=\"127.0.0.1,localhost,tauri.localhost\"\n");
        assert_eq!(add_window("ALLOWED_IPS=\n").unwrap(), "ALLOWED_IPS=127.0.0.1,localhost,absolute,tauri.localhost\n");
        assert_eq!(add_window("POLL_RATE=100\n").unwrap(), "POLL_RATE=100\nALLOWED_IPS=127.0.0.1,localhost,absolute,tauri.localhost\n");
        // a setting that only starts like it is another one
        assert!(add_window("ALLOWED_IPS_OLD=x\n").unwrap().ends_with("ALLOWED_IPS=127.0.0.1,localhost,absolute,tauri.localhost\n"));
    }
}
