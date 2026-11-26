//! A difficulty's storyboard for the visualizer: its .osu (the [Events] sprites), the set's .osb,
//! and the set's images by name, as addresses under `fumen://localhost/`. The webview reads and
//! plays it (src/lib/vis/storyboard.ts).
//!
//! lazer keeps every file of a set by hash (`file/<hash>`). stable's scan only keys what the
//! library needs, so a storyboard's images (often in subfolders) are served from the set's folder
//! by name: `sb/<chart key>/<name as hex>` (see `served`).

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::error::Result;
use crate::hitsounds::SetFiles;
use crate::paths;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storyboard {
    /// the difficulty's .osu, whole
    pub osu: String,
    /// the set's .osb, if it has one
    pub osb: Option<String>,
    /// the set's images: [name as in the set, address under fumen://localhost/]
    pub files: Vec<(String, String)>,
}

const IMAGES: &[&str] = &["png", "jpg", "jpeg", "bmp", "gif", "webp"];
/// how deep and how many files a stable set's folder is read
const MAX_DEPTH: usize = 5;
const MAX_FILES: usize = 20_000;

fn is_image(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, ext)| IMAGES.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Whether a storyboard text has anything to show: a sprite or an animation in its [Events]
/// (an .osb has nothing but events, `whole`).
pub fn has_elements(text: &str, whole: bool) -> bool {
    let mut events = whole;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let t = line.trim_end();
        if t.starts_with('[') {
            events = whole || t == "[Events]";
            continue;
        }
        if !events || t.starts_with(' ') || t.starts_with('_') {
            continue;
        }
        if t.starts_with("Sprite,") || t.starts_with("Animation,") || t.starts_with("4,") || t.starts_with("6,") {
            return true;
        }
    }
    false
}

/// A library difficulty's storyboard, or None when it has nothing to show.
pub fn for_map(conn: &Connection, files: &paths::Files, id: &str) -> Result<Option<Storyboard>> {
    let row: Option<(Option<String>, String, String)> = conn
        .query_row("SELECT m.hash, s.source, s.files FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()?;
    let Some((Some(hash), source, set_files)) = row else { return Ok(None) };
    let Some(bytes) = files.read(&hash) else { return Ok(None) };
    let osu = String::from_utf8_lossy(&bytes).into_owned();
    let read = |p: &Path| std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned());

    let (osb, list) = if source == "stable" {
        let Some(dir) = files.path(&hash).and_then(|p| p.parent().map(Path::to_path_buf)) else { return Ok(None) };
        let mut names = Vec::new();
        walk(&dir, "", 0, &mut names);
        names.sort_by_key(|n| n.to_lowercase());
        // stable reads the .osb at the folder's top
        let osb = names.iter().find(|n| !n.contains('/') && n.to_lowercase().ends_with(".osb")).and_then(|n| read(&dir.join(n)));
        let list = names.into_iter().filter(|n| is_image(n)).map(|n| {
            let addr = format!("sb/{hash}/{}", hex(&n));
            (n, addr)
        });
        (osb, list.collect::<Vec<_>>())
    } else {
        let pairs: Vec<(String, String)> = serde_json::from_str(&set_files).unwrap_or_default();
        let osb = SetFiles::new(pairs.clone()).storyboard().and_then(|h| files.read(h)).map(|b| String::from_utf8_lossy(&b).into_owned());
        let list = pairs.into_iter().filter(|(n, _)| is_image(n)).map(|(n, h)| (n, format!("file/{h}")));
        (osb, list.collect())
    };
    if !has_elements(&osu, false) && !osb.as_deref().is_some_and(|o| has_elements(o, true)) {
        return Ok(None);
    }
    Ok(Some(Storyboard { osu, osb, files: list }))
}

/// The files under `dir` (names with `/`), a few levels down.
fn walk(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let Ok(name) = e.file_name().into_string() else { continue };
        let Ok(kind) = e.file_type() else { continue };
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if kind.is_dir() {
            if depth < MAX_DEPTH {
                walk(&e.path(), &rel, depth + 1, out);
            }
        } else if kind.is_file() {
            out.push(rel);
        }
    }
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<String> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect();
    String::from_utf8(bytes?).ok()
}

/// The file behind `sb/<chart key>/<hex name>`: the name inside the chart's own folder, never
/// outside it.
pub fn served(files: &paths::Files, key: &str, hex_name: &str) -> Option<PathBuf> {
    let rel = files.stable.keys.get(key)?;
    let dir = files.stable.songs.join(rel).parent()?.to_path_buf();
    let name = unhex(hex_name)?;
    let mut path = dir;
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(['\\', ':']) {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_elements_only_in_events() {
        let osu = "osu file format v14\n[Events]\n0,0,\"bg.jpg\",0,0\nSprite,Background,Centre,\"sb/a.png\",320,240\n F,0,0,1000,1\n";
        assert!(has_elements(osu, false));
        // a hit object at x = 4 isn't a sprite
        assert!(!has_elements("[Events]\n0,0,\"bg.jpg\",0,0\n[HitObjects]\n4,192,1000,1,0\n", false));
        assert!(has_elements("[Events]\n6,0,1,\"a.png\",0,0,4,50,LoopForever\n", false));
        assert!(has_elements("[Variables]\n$a=1\n[Events]\nSprite,Foreground,Centre,\"x.png\",0,0\n", true));
        assert!(!has_elements("[Events]\n//Storyboard Layer 0 (Background)\n", true));
    }

    #[test]
    fn names_go_there_and_back() {
        let name = "SB/Kanji ä/1.png";
        assert_eq!(unhex(&hex(name)).as_deref(), Some(name));
        assert_eq!(unhex("zz"), None);
        assert_eq!(unhex("abc"), None);
    }

    #[test]
    fn served_stays_in_the_folder() {
        let mut keys = std::collections::HashMap::new();
        keys.insert("k".to_string(), "Set A/diff.osu".to_string());
        let files = paths::Files {
            lazer: None,
            stable: std::sync::Arc::new(paths::StableFiles { songs: PathBuf::from("/songs"), keys }),
        };
        assert_eq!(served(&files, "k", &hex("sb/x.png")), Some(PathBuf::from("/songs/Set A/sb/x.png")));
        assert_eq!(served(&files, "k", &hex("../other/x.png")), None);
        assert_eq!(served(&files, "k", &hex("/abs.png")), None);
        assert_eq!(served(&files, "k", &hex("C:/x.png")), None);
        assert_eq!(served(&files, "nope", &hex("x.png")), None);
    }
}
