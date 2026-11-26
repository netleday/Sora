//! lazer's skins, for the playfield preview.
//!
//! The skins themselves come with the library import (the sidecar exports every skin with its
//! files). Two more things live outside the database:
//!   - which skin is selected: `Skin = <id>` in lazer's `game.ini`, read fresh each time;
//!   - the built-in "classic" and "retro" textures and the argon / triangles hit sounds, embedded
//!     in the installed lazer's `osu.Game.Resources.dll`. The sidecar extracts them into Fumen's
//!     cache once per lazer version; they're served as `fumen://localhost/skin/<skin>/<file>`.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use crate::error::Result;
use crate::lazer;
use crate::paths::LazerInstall;

/// What a skin renders like, from its lazer type (`InstantiationInfo`), mirroring
/// `SkinInfo.CreateInstance`: no type means a legacy skin imported before types were stored, and
/// the old name of the triangles skin was `DefaultSkin`.
pub fn kind_of(instantiation: Option<&str>) -> &'static str {
    let Some(info) = instantiation.filter(|s| !s.trim().is_empty()) else { return "legacy" };
    let ty = info.split(',').next().unwrap_or("").trim();
    let name = ty.rsplit('.').next().unwrap_or(ty);
    match name {
        "DefaultLegacySkin" => "classic",
        "RetroSkin" => "retro",
        "LegacySkin" => "legacy",
        "TrianglesSkin" | "DefaultSkin" => "triangles",
        "ArgonProSkin" => "argon-pro",
        "ArgonSkin" => "argon",
        _ => "legacy",
    }
}

/// The skin lazer has selected (`Skin = <guid>` in `game.ini`), lowercased.
pub fn selected(install: &LazerInstall) -> Option<String> {
    // game.ini moves with the rest of lazer's data; look where the data is first
    [&install.storage, &install.path].iter().find_map(|dir| {
        let text = std::fs::read_to_string(Path::new(dir).join("game.ini")).ok()?;
        parse_selected(&text)
    })
}

fn parse_selected(ini: &str) -> Option<String> {
    ini.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        let value = value.trim();
        (key.trim() == "Skin" && !value.is_empty()).then(|| value.to_ascii_lowercase())
    })
}

// ── Built-in textures and sounds ────────────────────────────────────────────

/// Folders of the extraction: classic / retro textures (and classic's sounds), the hit sounds of
/// lazer's other built-in skins.
const BUILTIN: [&str; 5] = ["classic", "retro", "triangles", "argon", "argon-pro"];

/// Bumped when the extraction takes more out of the resources (2: hit sounds, 3: osu!taiko's
/// default drum and argon's taiko drums, 4: osu! and osu!catch textures, the cursor trail, spinner
/// and banana sounds).
const EXTRACT_VERSION: u32 = 4;

/// The installed lazer's resources assembly.
fn resources_dll() -> Option<PathBuf> {
    let dll = crate::lazer_import::installed()?.dir.join("osu.Game.Resources.dll");
    dll.is_file().then_some(dll)
}

pub fn builtin_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("lazer-skins")
}

/// Extracts the built-in skin textures if lazer's resources changed since the last time (or were
/// never extracted). Errors leave the previous extraction in place.
pub fn refresh_builtin(cache_dir: &Path) -> Result<()> {
    // the import and the skin list may both ask at once
    static BUSY: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
    let Some(dll) = resources_dll() else { return Ok(()) };
    let meta = std::fs::metadata(&dll)?;
    let stamp = format!("v{EXTRACT_VERSION} {} {}", meta.len(), crate::paths::modified_ms(&meta));
    let dir = builtin_dir(cache_dir);
    if std::fs::read_to_string(dir.join("stamp")).ok().as_deref() == Some(stamp.as_str()) {
        return Ok(());
    }
    let tmp = cache_dir.join("lazer-skins.part");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    lazer::run_skin_resources(&dll, &tmp)?;
    std::fs::write(tmp.join("stamp"), &stamp)?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&tmp, &dir)?;
    Ok(())
}

/// A built-in texture's or sound's path, or `None` for names that could leave the folder.
pub fn builtin_file(cache_dir: &Path, skin: &str, name: &str) -> Option<PathBuf> {
    if !BUILTIN.contains(&skin) {
        return None;
    }
    let ok = !name.is_empty()
        && name != "stamp"
        && !name.starts_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'@'));
    ok.then(|| builtin_dir(cache_dir).join(skin).join(name))
}

fn builtin_names(cache_dir: &Path, skin: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(builtin_dir(cache_dir).join(skin)) else { return Vec::new() };
    let mut names: Vec<String> = entries.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
    names.sort();
    names
}

// ── For the UI ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    id: String,
    name: String,
    creator: String,
    kind: String,
    protected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinList {
    skins: Vec<SkinInfo>,
    /// lazer's selected skin
    selected: Option<String>,
    /// file names of the built-in classic / retro textures (empty without a lazer install)
    classic: Vec<String>,
    retro: Vec<String>,
    /// file names of the built-in hit sounds of triangles, argon and argon pro
    triangles: Vec<String>,
    argon: Vec<String>,
    argon_pro: Vec<String>,
}

pub fn list(conn: &Connection, install: Option<&LazerInstall>, cache_dir: &Path) -> Result<SkinList> {
    let mut stmt = conn.prepare("SELECT id, name, creator, kind, protected FROM skins ORDER BY position")?;
    let skins = stmt
        .query_map([], |r| {
            Ok(SkinInfo { id: r.get(0)?, name: r.get(1)?, creator: r.get(2)?, kind: r.get(3)?, protected: r.get(4)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(SkinList {
        skins,
        selected: install.and_then(selected),
        classic: builtin_names(cache_dir, "classic"),
        retro: builtin_names(cache_dir, "retro"),
        triangles: builtin_names(cache_dir, "triangles"),
        argon: builtin_names(cache_dir, "argon"),
        argon_pro: builtin_names(cache_dir, "argon-pro"),
    })
}

/// One skin's files as stored (JSON `[[filename, sha256], …]`).
pub fn files(conn: &Connection, id: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn.query_row("SELECT files FROM skins WHERE id = ?1", [id], |r| r.get(0)).optional()?)
}

/// Downloads an `.osk` from `url` into `cache_dir/catalog-skins` and imports it into the active osu! client.
pub fn install_from_url(url: &str, name: &str, target: &str, cache_dir: &Path, stable_dir: Option<&Path>) -> Result<String> {
    use std::io::Read;
    if url.contains("osuskins.net/skin/") || url.contains("osuskinner.com/skin/") {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
        }
        return Ok(format!("Страница скина «{name}» открыта в браузере — скачайте .osk и откройте его в osu!"));
    }

    let safe_name: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect();
    let dir = cache_dir.join("catalog-skins");
    std::fs::create_dir_all(&dir)?;
    let osk_path = dir.join(format!("{}.osk", safe_name.trim()));

    let mut resp = ureq::get(url)
        .header("User-Agent", UA)
        .call()
        .map_err(|e| crate::error::Error::known("skin-download", format!("Не удалось скачать скин: {e}")))?;
    let ctype = resp
        .headers()
        .get("Content-Type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if ctype.contains("text/html") {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
        }
        return Ok(format!("Страница скина «{name}» открыта в браузере — скачайте .osk и откройте его в osu!"));
    }

    let mut bytes = Vec::new();
    resp.body_mut().as_reader().take(256 * 1024 * 1024).read_to_end(&mut bytes)?;
    if bytes.len() < 128 || !bytes.starts_with(b"PK") {
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
        }
        return Ok(format!("Страница скина «{name}» открыта в браузере — скачайте .osk и откройте его в osu!"));
    }
    std::fs::write(&osk_path, &bytes)?;

    if target == "stable" {
        if let Some(sdir) = stable_dir {
            let skins_dir = sdir.join("Skins").join(safe_name.trim());
            std::fs::create_dir_all(&skins_dir)?;
            let file = std::fs::File::open(&osk_path)?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|e| crate::error::Error::known("skin-zip", format!("Ошибка распаковки .osk: {e}")))?;
            archive.extract(&skins_dir)
                .map_err(|e| crate::error::Error::known("skin-zip", format!("Ошибка распаковки .osk: {e}")))?;
            return Ok(format!("Скин «{name}» распакован в osu!stable/Skins"));
        }
    }

    #[cfg(windows)]
    {
        let root = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("osulazer");
        let exe = [root.join("osu!.exe"), root.join("current").join("osu!.exe")].into_iter().find(|p| p.is_file());
        if let Some(exe) = exe {
            let _ = std::process::Command::new(&exe).arg(&osk_path).spawn();
            return Ok(format!("Скин «{name}» передан на импорт в osu!(lazer)"));
        }
        let _ = std::process::Command::new("cmd").args(["/C", "start", "", &osk_path.to_string_lossy()]).spawn();
    }
    Ok(format!("Скин «{name}» скачан для импорта в osu!"))
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSkinEntry {
    pub id: String,
    pub name: String,
    pub author: String,
    pub source: String,
    pub thumb_url: String,
    pub images: Vec<String>,
    pub detail_url: String,
    pub download_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinGalleryInfo {
    pub images: Vec<String>,
    pub download_url: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkinElements {
    pub cursor: Option<String>,
    pub hitcircle: Option<String>,
    pub hitcircleoverlay: Option<String>,
    pub approachcircle: Option<String>,
    pub sliderb: Option<String>,
    pub menu_bg: Option<String>,
    pub ranking_panel: Option<String>,
    pub selection_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkinPreview {
    pub id: String,
    pub name: String,
    pub creator: String,
    pub kind: String,
    pub source: String,
    pub selected: bool,
    pub cover_data_url: Option<String>,
    pub elements: LocalSkinElements,
    pub folder_path: Option<String>,
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn is_invalid_skin_name(name: &str) -> bool {
    let low = name.trim().to_lowercase();
    low.is_empty() || low == "unnamed skin" || low == "unnamed" || low.starts_with("unnamed ")
}

fn parse_osuskins_detail(detail_url: &str, fallback_thumb: &str) -> (String, Vec<String>, String) {
    use std::io::Read;
    let mut author = String::from("osu! community");
    let mut images: Vec<String> = Vec::new();
    if !fallback_thumb.is_empty() && fallback_thumb.contains("/screenshots/") {
        images.push(fallback_thumb.to_string());
    }
    let dl = detail_url.to_string();

    if let Ok(mut resp) = ureq::get(detail_url)
        .header("User-Agent", UA)
        .header("Referer", "https://osuskins.net/")
        .call()
    {
        let mut html = String::new();
        let _ = resp.body_mut().as_reader().take(512 * 1024).read_to_string(&mut html);
        if let Some(c_pos) = html.find("<h3>Creator</h3>") {
            let slice = &html[c_pos..html.len().min(c_pos + 600)];
            if let Some(a_pos) = slice.find("<a ") {
                if let Some(gt) = slice[a_pos..].find('>') {
                    if let Some(end) = slice[a_pos + gt + 1..].find("</a>") {
                        let a = strip_tags(&slice[a_pos + gt + 1..a_pos + gt + 1 + end]);
                        if !a.is_empty() {
                            author = a;
                        }
                    }
                }
            }
        }
        for token in html.split('"') {
            if token.starts_with("https://cdn.osuskins.net/screenshots/")
                && (token.ends_with(".webp") || token.ends_with(".png") || token.ends_with(".jpg") || token.ends_with(".jpeg"))
                && !images.contains(&token.to_string())
            {
                images.push(token.to_string());
                if images.len() >= 8 {
                    break;
                }
            }
        }
    }
    (author, images, dl)
}

/// Fetches real osu! skins with verified 16:9 gameplay screenshots from `osuskins.net` (cached in `cache_dir`).
pub fn fetch_online_catalog(cache_dir: &Path) -> Result<Vec<CatalogSkinEntry>> {
    use std::io::Read;
    let cache_file = cache_dir.join("skins_catalog_v4.json");
    if let Ok(meta) = std::fs::metadata(&cache_file) {
        if meta.modified().ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e.as_secs() < 3600) {
            if let Ok(raw) = std::fs::read_to_string(&cache_file) {
                if let Ok(list) = serde_json::from_str::<Vec<CatalogSkinEntry>>(&raw) {
                    if !list.is_empty() {
                        return Ok(list);
                    }
                }
            }
        }
    }

    let mut raw_items: Vec<(String, String, String, String)> = Vec::new();
    let mut seen_names = std::collections::HashSet::new();
    let mut seen_ids = std::collections::HashSet::new();

    for page in 1..=2 {
        let url = format!("https://osuskins.net/?sortby=downloads&p={page}");
        let Ok(mut resp) = ureq::get(&url).header("User-Agent", UA).call() else { continue };
        let mut html = String::new();
        let _ = resp.body_mut().as_reader().take(1024 * 1024).read_to_string(&mut html);

        let mut pos = 0;
        let marker = "<script type=\"application/ld+json\">";
        while let Some(idx) = html[pos..].find(marker) {
            let start = pos + idx + marker.len();
            let Some(end) = html[start..].find("</script>") else { break };
            let json_str = &html[start..start + end];
            pos = start + end;

            let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) else { continue };
            if val.get("@type").and_then(|v| v.as_str()) != Some("ItemList") {
                continue;
            }
            let Some(arr) = val.get("itemListElement").and_then(|v| v.as_array()) else { continue };
            for el in arr {
                let Some(item) = el.get("item") else { continue };
                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                let detail_url = item.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                let thumb = item.get("image").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                if is_invalid_skin_name(&name)
                    || !detail_url.starts_with("https://osuskins.net/skin/")
                    || !thumb.starts_with("https://cdn.osuskins.net/screenshots/")
                {
                    continue;
                }
                let norm = name.to_lowercase();
                let id = detail_url.trim_start_matches("https://osuskins.net/skin/").to_string();
                if seen_names.insert(norm) && seen_ids.insert(id.clone()) {
                    raw_items.push((id, name, detail_url, thumb));
                }
                if raw_items.len() >= 36 {
                    break;
                }
            }
        }
        if raw_items.len() >= 36 {
            break;
        }
    }

    let results: std::sync::Mutex<Vec<(usize, CatalogSkinEntry)>> = std::sync::Mutex::new(Vec::new());
    let next_idx = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..6 {
            s.spawn(|| loop {
                let idx = next_idx.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some((id, name, detail_url, thumb)) = raw_items.get(idx).cloned() else { break };
                let (author, images, dl) = parse_osuskins_detail(&detail_url, &thumb);
                if images.is_empty() {
                    continue;
                }
                let entry = CatalogSkinEntry {
                    id,
                    name,
                    author,
                    source: "osu!".into(),
                    thumb_url: images[0].clone(),
                    images,
                    detail_url,
                    download_url: dl,
                };
                if let Ok(mut guard) = results.lock() {
                    guard.push((idx, entry));
                }
            });
        }
    });

    let mut indexed = results.into_inner().unwrap_or_default();
    indexed.sort_by_key(|(idx, _)| *idx);
    let out: Vec<CatalogSkinEntry> = indexed.into_iter().map(|(_, e)| e).collect();

    if !out.is_empty() {
        if let Ok(json_val) = serde_json::to_string(&out) {
            let _ = std::fs::create_dir_all(cache_dir);
            let _ = std::fs::write(&cache_file, json_val);
        }
    }
    Ok(out)
}

/// Fetches gallery screenshot URLs & download link from a skin detail page.
pub fn fetch_skin_gallery(detail_url: &str, fallback_thumb: &str, fallback_dl: &str) -> SkinGalleryInfo {
    let (_, mut images, dl) = parse_osuskins_detail(detail_url, fallback_thumb);
    if images.is_empty() && !fallback_thumb.is_empty() {
        images.push(fallback_thumb.to_string());
    }
    SkinGalleryInfo {
        images,
        download_url: if dl.is_empty() { fallback_dl.to_string() } else { dl },
    }
}

/// Downloads an image via Rust, validates it is a horizontal screenshot (`width >= 400 && width > height`),
/// and returns a `data:image/...;base64,...` URI.
pub fn fetch_image_data_url(url: &str) -> Result<String> {
    use std::io::Read;
    let mut resp = ureq::get(url)
        .header("User-Agent", UA)
        .header("Referer", "https://osuskins.net/")
        .call()
        .map_err(|e| crate::error::Error::known("skin-img", e.to_string()))?;
    if resp.status().as_u16() >= 400 {
        return Err(crate::error::Error::known("skin-img", "Image HTTP error"));
    }
    let mime = resp
        .headers()
        .get("Content-Type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/webp")
        .split(';')
        .next()
        .unwrap_or("image/webp")
        .to_string();
    let mut bytes = Vec::new();
    resp.body_mut().as_reader().take(8 * 1024 * 1024).read_to_end(&mut bytes)?;
    if bytes.len() < 400 {
        return Err(crate::error::Error::known("skin-img", "Empty image"));
    }
    let img = image::load_from_memory(&bytes)
        .map_err(|_| crate::error::Error::known("skin-img", "Invalid image data"))?;
    let w = img.width();
    let h = img.height();
    if w < 400 || w <= h || (w as f32 / h as f32) < 1.25 {
        return Err(crate::error::Error::known("skin-img", "Rejected non-landscape texture"));
    }
    let b64 = base64_encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

fn read_image_data_url_from_path(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() < 32 || meta.len() > 6 * 1024 * 1024 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    Some(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

fn find_lazer_skin_asset(
    file_map: &std::collections::HashMap<String, PathBuf>,
    candidates: &[&str],
) -> Option<String> {
    for &c in candidates {
        if let Some(p) = file_map.get(c) {
            if let Some(uri) = read_image_data_url_from_path(p) {
                return Some(uri);
            }
        }
    }
    None
}

fn find_folder_skin_asset(dir: &Path, candidates: &[&str]) -> Option<String> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut by_lower = std::collections::HashMap::new();
    for ent in entries.flatten() {
        let p = ent.path();
        if p.is_file() {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                by_lower.insert(name.to_ascii_lowercase(), p);
            }
        }
    }
    for &c in candidates {
        if let Some(p) = by_lower.get(c) {
            if let Some(uri) = read_image_data_url_from_path(p) {
                return Some(uri);
            }
        }
    }
    None
}

fn collect_elements_from_lazer(map: &std::collections::HashMap<String, PathBuf>) -> (Option<String>, LocalSkinElements) {
    let cover = find_lazer_skin_asset(
        map,
        &[
            "menu-background.jpg",
            "menu-background.png",
            "selection-mode@2x.png",
            "selection-mode.png",
            "ranking-panel@2x.png",
            "ranking-panel.png",
            "pause-overlay@2x.png",
            "pause-overlay.png",
            "welcome_text.png",
        ],
    );
    let elements = LocalSkinElements {
        cursor: find_lazer_skin_asset(map, &["cursor@2x.png", "cursor.png"]),
        hitcircle: find_lazer_skin_asset(map, &["hitcircle@2x.png", "hitcircle.png"]),
        hitcircleoverlay: find_lazer_skin_asset(map, &["hitcircleoverlay@2x.png", "hitcircleoverlay.png"]),
        approachcircle: find_lazer_skin_asset(map, &["approachcircle@2x.png", "approachcircle.png"]),
        sliderb: find_lazer_skin_asset(map, &["sliderb0@2x.png", "sliderb0.png", "sliderb@2x.png", "sliderb.png"]),
        menu_bg: find_lazer_skin_asset(map, &["menu-background.jpg", "menu-background.png"]),
        ranking_panel: find_lazer_skin_asset(map, &["ranking-panel@2x.png", "ranking-panel.png"]),
        selection_mode: find_lazer_skin_asset(map, &["selection-mode@2x.png", "selection-mode.png"]),
    };
    (cover, elements)
}

fn collect_elements_from_folder(dir: &Path) -> (Option<String>, LocalSkinElements) {
    let cover = find_folder_skin_asset(
        dir,
        &[
            "menu-background.jpg",
            "menu-background.png",
            "selection-mode@2x.png",
            "selection-mode.png",
            "ranking-panel@2x.png",
            "ranking-panel.png",
            "pause-overlay@2x.png",
            "pause-overlay.png",
            "welcome_text.png",
        ],
    );
    let elements = LocalSkinElements {
        cursor: find_folder_skin_asset(dir, &["cursor@2x.png", "cursor.png"]),
        hitcircle: find_folder_skin_asset(dir, &["hitcircle@2x.png", "hitcircle.png"]),
        hitcircleoverlay: find_folder_skin_asset(dir, &["hitcircleoverlay@2x.png", "hitcircleoverlay.png"]),
        approachcircle: find_folder_skin_asset(dir, &["approachcircle@2x.png", "approachcircle.png"]),
        sliderb: find_folder_skin_asset(dir, &["sliderb0@2x.png", "sliderb0.png", "sliderb@2x.png", "sliderb.png"]),
        menu_bg: find_folder_skin_asset(dir, &["menu-background.jpg", "menu-background.png"]),
        ranking_panel: find_folder_skin_asset(dir, &["ranking-panel@2x.png", "ranking-panel.png"]),
        selection_mode: find_folder_skin_asset(dir, &["selection-mode@2x.png", "selection-mode.png"]),
    };
    (cover, elements)
}

/// Lists local osu!lazer and osu!stable skins with real preview covers & UI elements from disk.
pub fn list_local_skin_previews(
    conn: &Connection,
    install: Option<&LazerInstall>,
    cache_dir: &Path,
    stable_dir: Option<&Path>,
) -> Result<Vec<LocalSkinPreview>> {
    let mut out = Vec::new();
    let sel = install.and_then(selected);
    let storage_path = install.map(|i| PathBuf::from(&i.storage));

    let mut stmt = conn.prepare("SELECT id, name, creator, kind, files FROM skins ORDER BY position")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;

    for row in rows.flatten() {
        let (id, name, creator, kind, files_json) = row;
        let mut map = std::collections::HashMap::new();
        if let Some(sp) = storage_path.as_ref() {
            if let Ok(pairs) = serde_json::from_str::<Vec<[String; 2]>>(&files_json) {
                for [fname, sha] in pairs {
                    let base = fname.rsplit('/').next().unwrap_or(&fname).to_ascii_lowercase();
                    if let Some(p) = crate::paths::lazer_file(sp, &sha) {
                        if p.is_file() {
                            map.entry(base).or_insert(p);
                        }
                    }
                }
            }
        }
        let (mut cover, mut elements) = collect_elements_from_lazer(&map);
        if cover.is_none() && elements.hitcircle.is_none() && BUILTIN.contains(&kind.as_str()) {
            let bdir = builtin_dir(cache_dir).join(&kind);
            if bdir.is_dir() {
                let (bc, be) = collect_elements_from_folder(&bdir);
                cover = bc;
                elements = be;
            }
        }
        out.push(LocalSkinPreview {
            selected: sel.as_deref() == Some(id.as_str()),
            id,
            name,
            creator: if creator.trim().is_empty() { "osu!lazer".into() } else { creator },
            kind,
            source: "lazer".into(),
            cover_data_url: cover,
            elements,
            folder_path: None,
        });
    }

    if let Some(sdir) = stable_dir {
        let skins_root = sdir.join("Skins");
        if let Ok(entries) = std::fs::read_dir(&skins_root) {
            for ent in entries.flatten() {
                let p = ent.path();
                if !p.is_dir() {
                    continue;
                }
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").trim().to_string();
                if name.is_empty() || name.starts_with('.') {
                    continue;
                }
                let (cover, elements) = collect_elements_from_folder(&p);
                out.push(LocalSkinPreview {
                    id: format!("stable:{name}"),
                    name,
                    creator: "osu!stable".into(),
                    kind: "stable".into(),
                    source: "stable".into(),
                    selected: false,
                    cover_data_url: cover,
                    elements,
                    folder_path: Some(p.to_string_lossy().into_owned()),
                });
            }
        }
    }

    Ok(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of(Some("osu.Game.Skinning.LegacySkin, osu.Game")), "legacy");
        assert_eq!(kind_of(Some("osu.Game.Skinning.DefaultLegacySkin, osu.Game")), "classic");
        assert_eq!(kind_of(Some("osu.Game.Skinning.ArgonProSkin, osu.Game")), "argon-pro");
        assert_eq!(kind_of(Some("osu.Game.Skinning.ArgonSkin, osu.Game")), "argon");
        assert_eq!(kind_of(Some("osu.Game.Skinning.TrianglesSkin, osu.Game")), "triangles");
        assert_eq!(kind_of(Some("osu.Game.Skinning.DefaultSkin, osu.Game")), "triangles");
        assert_eq!(kind_of(Some("osu.Game.Skinning.RetroSkin, osu.Game")), "retro");
        assert_eq!(kind_of(None), "legacy");
        assert_eq!(kind_of(Some("  ")), "legacy");
    }

    #[test]
    fn game_ini() {
        let ini = "Ruleset = mania\r\nSkin = 92F313AE-a16f-4629-9d98-1302fdec6ba8\r\nSkinEditor = 1\r\n";
        assert_eq!(parse_selected(ini).as_deref(), Some("92f313ae-a16f-4629-9d98-1302fdec6ba8"));
        assert_eq!(parse_selected("Skin =\n"), None);
        assert_eq!(parse_selected("Volume = 1\n"), None);
    }

    #[test]
    fn builtin_names_stay_inside() {
        let c = Path::new("C");
        assert!(builtin_file(c, "classic", "mania-key1@2x.png").is_some());
        assert!(builtin_file(c, "classic", "../x.png").is_none());
        assert!(builtin_file(c, "classic", "a/b.png").is_none());
        assert!(builtin_file(c, "classic", "stamp").is_none());
        assert!(builtin_file(c, "argon-pro", "soft-hitclap.wav").is_some());
        assert!(builtin_file(c, "other", "a.png").is_none());
    }
}
