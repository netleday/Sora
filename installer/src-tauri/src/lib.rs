use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const PAYLOAD_ZIP: &[u8] = include_bytes!("../payload.zip");
const WEBVIEW2_SETUP: &[u8] = include_bytes!("../MicrosoftEdgeWebview2Setup.exe");

#[cfg(windows)]
fn has_webview2_reg_key(key: &str) -> bool {
    let Ok(out) = std::process::Command::new("reg.exe")
        .args(["query", key, "/v", "pv"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("pv") {
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if let Some(ver) = parts.last() {
                if !ver.is_empty() && *ver != "0.0.0.0" && *ver != "REG_SZ" {
                    return true;
                }
            }
        }
    }
    false
}

pub fn is_webview2_installed() -> bool {
    #[cfg(windows)]
    {
        return has_webview2_reg_key(
            r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        ) || has_webview2_reg_key(
            r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        ) || has_webview2_reg_key(
            r"HKCU\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        );
    }
    #[cfg(not(windows))]
    true
}

pub fn install_webview2_if_needed() -> Result<(), String> {
    if is_webview2_installed() {
        return Ok(());
    }
    let temp_exe = std::env::temp_dir().join("MicrosoftEdgeWebview2Setup.exe");
    std::fs::write(&temp_exe, WEBVIEW2_SETUP)
        .map_err(|e| format!("Не удалось распаковать WebView2Setup: {e}"))?;

    let mut cmd = std::process::Command::new(&temp_exe);
    cmd.args(["/silent", "/install"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let status = cmd
        .status()
        .map_err(|e| format!("Не удалось запустить установщик WebView2: {e}"))?;
    let _ = std::fs::remove_file(&temp_exe);

    if !status.success() && !is_webview2_installed() {
        return Err(format!("Ошибка установки WebView2 (код {:?})", status.code()));
    }
    Ok(())
}

/// Runs before Tauri creates any WebView2 window so bare Windows 10 systems never crash with
/// "Could not find the WebView2 Runtime".
pub fn ensure_webview2_before_gui() {
    if !is_webview2_installed() {
        let _ = install_webview2_if_needed();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitInfo {
    default_path: String,
    is_uninstall: bool,
    uninstall_dir: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    percent: u32,
    status: String,
}

fn emit_progress(app: &AppHandle, percent: u32, status: &str) {
    let _ = app.emit(
        "install-progress",
        ProgressEvent {
            percent,
            status: status.to_string(),
        },
    );
}

#[tauri::command]
fn get_init_info() -> InitInfo {
    let local_app = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let default_path = local_app.join("Sora").to_string_lossy().into_owned();
    let is_uninstall = std::env::args().any(|a| a == "--uninstall");
    let uninstall_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
        .unwrap_or_else(|| default_path.clone());
    InitInfo {
        default_path,
        is_uninstall,
        uninstall_dir,
    }
}

#[tauri::command]
async fn pick_install_dir(app: AppHandle, current: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Выберите папку установки Sora v2.2");
        let cur = PathBuf::from(&current);
        if cur.is_dir() {
            dialog = dialog.set_directory(&cur);
        } else if let Some(parent) = cur.parent().filter(|p| p.is_dir()) {
            dialog = dialog.set_directory(parent);
        }
        dialog
            .blocking_pick_folder()
            .and_then(|fp| fp.into_path().ok())
            .map(|p| {
                if p.file_name().and_then(|n| n.to_str()).map(|s| s.eq_ignore_ascii_case("Sora")) == Some(true) {
                    p.to_string_lossy().into_owned()
                } else {
                    p.join("Sora").to_string_lossy().into_owned()
                }
            })
    })
    .await
    .ok()
    .flatten()
}

#[cfg(windows)]
fn run_hidden_ps(script: &str) -> Result<(), String> {
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("PowerShell error: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Shortcut error: {err}"));
    }
    Ok(())
}

#[cfg(windows)]
fn ps_escape(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(windows)]
fn create_shortcut(lnk_path: &Path, target: &Path, work_dir: &Path, args: &str, icon: &Path) -> Result<(), String> {
    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $sc = $ws.CreateShortcut('{}'); \
         $sc.TargetPath = '{}'; \
         $sc.WorkingDirectory = '{}'; \
         $sc.Arguments = '{}'; \
         $sc.IconLocation = '{}'; \
         $sc.Save()",
        ps_escape(&lnk_path.to_string_lossy()),
        ps_escape(&target.to_string_lossy()),
        ps_escape(&work_dir.to_string_lossy()),
        ps_escape(args),
        ps_escape(&icon.to_string_lossy()),
    );
    run_hidden_ps(&script)
}

#[cfg(windows)]
fn special_folder(kind: &str) -> Result<PathBuf, String> {
    let script = format!("[Environment]::GetFolderPath('{kind}')");
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Folder lookup failed: {e}"))?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() {
        return Err(format!("Empty special folder for {kind}"));
    }
    Ok(PathBuf::from(p))
}

#[cfg(windows)]
fn reg_add_sz(key: &str, name: &str, val: &str) -> Result<(), String> {
    let out = std::process::Command::new("reg.exe")
        .args(["add", key, "/v", name, "/t", "REG_SZ", "/d", val, "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("reg.exe failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

#[cfg(windows)]
fn reg_add_dword(key: &str, name: &str, val: &str) -> Result<(), String> {
    let out = std::process::Command::new("reg.exe")
        .args(["add", key, "/v", name, "/t", "REG_DWORD", "/d", val, "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("reg.exe failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

#[cfg(windows)]
fn kill_running_sora() {
    for exe in ["sora.exe", "sora-realm.exe"] {
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/F", "/IM", exe])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
}

#[tauri::command]
async fn start_install(
    app: AppHandle,
    install_dir: String,
    desktop_shortcut: bool,
    start_menu_shortcut: bool,
) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target_dir = PathBuf::from(install_dir.trim());
        if target_dir.as_os_str().is_empty() {
            return Err("Укажите корректный путь установки.".to_string());
        }

        emit_progress(&handle, 4, "Подготовка папки установки...");
        #[cfg(windows)]
        kill_running_sora();

        std::fs::create_dir_all(&target_dir)
            .map_err(|e| format!("Не удалось создать папку установки: {e}"))?;

        emit_progress(&handle, 10, "Распаковка файлов Sora v2.2...");
        let mut archive = zip::ZipArchive::new(Cursor::new(PAYLOAD_ZIP))
            .map_err(|e| format!("Ошибка чтения встроенного архива: {e}"))?;

        let mut total_uncompressed: u64 = 0;
        for i in 0..archive.len() {
            if let Ok(f) = archive.by_index(i) {
                total_uncompressed = total_uncompressed.saturating_add(f.size());
            }
        }
        let total_uncompressed = total_uncompressed.max(1);
        let mut written_total: u64 = 0;
        let mut buf = [0u8; 65536];

        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("Ошибка извлечения файла: {e}"))?;
            let Some(rel_path) = file.enclosed_name().map(|p| p.to_path_buf()) else {
                continue;
            };
            let out_path = target_dir.join(rel_path);
            if file.is_dir() {
                std::fs::create_dir_all(&out_path)
                    .map_err(|e| format!("Ошибка создания папки: {e}"))?;
                continue;
            }
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Ошибка создания папки: {e}"))?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("Не удалось записать {}: {e}", out_path.display()))?;
            loop {
                let n = file
                    .read(&mut buf)
                    .map_err(|e| format!("Ошибка чтения архива: {e}"))?;
                if n == 0 {
                    break;
                }
                out_file
                    .write_all(&buf[..n])
                    .map_err(|e| format!("Ошибка записи файла: {e}"))?;
                written_total += n as u64;
                let pct = 10 + ((written_total * 65) / total_uncompressed) as u32;
                emit_progress(&handle, pct.min(75), "Распаковка файлов Sora v2.2...");
            }
        }

        if !is_webview2_installed() {
            emit_progress(&handle, 77, "Установка компонентов WebView2...");
            install_webview2_if_needed()?;
        }

        emit_progress(&handle, 80, "Сохранение деинсталлятора...");
        let uninstall_exe = target_dir.join("uninstall.exe");
        if let Ok(cur_exe) = std::env::current_exe() {
            if cur_exe != uninstall_exe {
                let _ = std::fs::copy(&cur_exe, &uninstall_exe);
            }
        }

        let sora_exe = target_dir.join("sora.exe");

        #[cfg(windows)]
        {
            if desktop_shortcut {
                emit_progress(&handle, 86, "Создание ярлыка на Рабочем столе...");
                if let Ok(desktop) = special_folder("Desktop") {
                    let lnk = desktop.join("Sora.lnk");
                    create_shortcut(&lnk, &sora_exe, &target_dir, "", &sora_exe)?;
                }
            }

            if start_menu_shortcut {
                emit_progress(&handle, 91, "Создание папки в меню «Пуск»...");
                if let Ok(programs) = special_folder("Programs") {
                    let sm_dir = programs.join("Sora");
                    let _ = std::fs::create_dir_all(&sm_dir);
                    create_shortcut(&sm_dir.join("Sora.lnk"), &sora_exe, &target_dir, "", &sora_exe)?;
                    create_shortcut(
                        &sm_dir.join("Удалить Sora.lnk"),
                        &uninstall_exe,
                        &target_dir,
                        "--uninstall",
                        &sora_exe,
                    )?;
                }
            }

            emit_progress(&handle, 96, "Регистрация Sora v2.2 в Windows...");
            let reg_key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Sora";
            let uninst_cmd = format!("\"{}\" --uninstall", uninstall_exe.to_string_lossy());
            reg_add_sz(reg_key, "DisplayName", "Sora v2.2")?;
            reg_add_sz(reg_key, "DisplayVersion", "2.2.0")?;
            reg_add_sz(reg_key, "Publisher", "netleday")?;
            reg_add_sz(reg_key, "InstallLocation", &target_dir.to_string_lossy())?;
            reg_add_sz(reg_key, "DisplayIcon", &sora_exe.to_string_lossy())?;
            reg_add_sz(reg_key, "UninstallString", &uninst_cmd)?;
            reg_add_dword(reg_key, "NoModify", "1")?;
            reg_add_dword(reg_key, "NoRepair", "1")?;
        }

        emit_progress(&handle, 100, "Установка Sora v2.2 успешно завершена!");
        Ok(())
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
fn launch_sora(app: AppHandle, install_dir: String) -> Result<(), String> {
    let exe = PathBuf::from(install_dir.trim()).join("sora.exe");
    if !exe.is_file() {
        return Err("Файл sora.exe не найден.".to_string());
    }
    std::process::Command::new(&exe)
        .current_dir(exe.parent().unwrap_or_else(|| Path::new(".")))
        .spawn()
        .map_err(|e| format!("Не удалось запустить Sora: {e}"))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn run_uninstall(app: AppHandle, install_dir: String) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let target_dir = PathBuf::from(install_dir.trim());
        emit_progress(&handle, 15, "Остановка процессов Sora...");
        #[cfg(windows)]
        kill_running_sora();

        emit_progress(&handle, 40, "Удаление ярлыков...");
        #[cfg(windows)]
        {
            if let Ok(desktop) = special_folder("Desktop") {
                let _ = std::fs::remove_file(desktop.join("Sora.lnk"));
            }
            if let Ok(programs) = special_folder("Programs") {
                let _ = std::fs::remove_dir_all(programs.join("Sora"));
            }
            emit_progress(&handle, 65, "Очистка реестра Windows...");
            let _ = std::process::Command::new("reg.exe")
                .args([
                    "delete",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Sora",
                    "/f",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }

        emit_progress(&handle, 85, "Удаление файлов Sora...");
        let _ = std::fs::remove_file(target_dir.join("sora.exe"));
        let _ = std::fs::remove_file(target_dir.join("sora-realm.exe"));

        emit_progress(&handle, 100, "Sora v2.2 удалена!");
        #[cfg(windows)]
        {
            let uninst = target_dir.join("uninstall.exe");
            let cmd_str = format!(
                "ping 127.0.0.1 -n 2 > nul & del /F /Q \"{}\" & rmdir \"{}\"",
                uninst.to_string_lossy(),
                target_dir.to_string_lossy()
            );
            let _ = std::process::Command::new("cmd.exe")
                .args(["/C", &cmd_str])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Uninstall error: {e}"))??;

    app.exit(0);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_init_info,
            pick_install_dir,
            start_install,
            launch_sora,
            run_uninstall
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sora Setup");
}
