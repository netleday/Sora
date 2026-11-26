//! Fumen's random id for this install: made on the first start, tied to nothing. It goes along
//! with the block check (online.rs), which also counts a release build's start with it, so a
//! person counts once however often they start Fumen. (Fumen used to send it on its own, as the
//! start ping; the site still takes that from older versions.)

use std::path::Path;

/// The random id, made on the first start: 32 hex digits, tied to nothing.
pub(crate) fn install_id(data_dir: &Path) -> Option<String> {
    let path = data_dir.join("install-id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if is_id(&id) {
            return Some(id);
        }
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::create_dir_all(data_dir).ok()?;
    std::fs::write(&path, &id).ok()?;
    Some(id)
}

fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_id_is_made_once_and_kept() {
        let dir = std::env::temp_dir().join(format!("fumen-ping-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = install_id(&dir).unwrap();
        assert!(is_id(&a));
        assert_eq!(install_id(&dir).unwrap(), a);
        // a broken file gets a new one
        std::fs::write(dir.join("install-id"), "nope").unwrap();
        let b = install_id(&dir).unwrap();
        assert!(is_id(&b) && b != a);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
