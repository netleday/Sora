//! Scores in the cloud (1.5, opt-in): the player's own plays from lazer and stable with lazer's
//! replays, and the library's map list (osu! set ids), kept on fumen.dertesti.dev under their osu!
//! login, up to 1 GB. Only what the cloud doesn't have yet goes up.
//!
//! On a new install or another PC they come back: the plays go into `cloud_scores`, which a library
//! scan never touches, and from there into History and the skills (osu_scores::merge leaves out the
//! ones this library has itself). A replay comes down when it's opened, and the map list says which
//! sets to download again. Nothing is taken out of the cloud except by deleting all of it.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::db;
use crate::downloads::USER_AGENT;
use crate::error::{Error, Result};
use crate::osu_auth::{self, Endpoints};
use crate::osu_scores::{Player, RULESETS};

/// what the cloud keeps (site/server.mjs keeps to the same)
pub const MAX_SCORES: usize = 200_000;
const MAX_REPLAY: u64 = 16 * 1024 * 1024;
/// scores per upload, and the replays' bytes per upload (base64 makes them a third bigger)
const SCORES_PER_POST: usize = 5_000;
const REPLAY_BYTES_PER_POST: u64 = 6 * 1024 * 1024;
/// the cloud's map list isn't replaced by a library with fewer sets than this share of it (a new
/// PC before its maps are back)
const SHRINK: f64 = 0.8;
/// where replays from the cloud are kept on this PC
const CACHE: &str = "cloud-replays";
/// meta: when the scores in `cloud_scores` were saved in the cloud
const PULLED: &str = "cloud.pulled";

/// A play as the cloud keeps it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CloudScore {
    /// "r" and the replay's SHA-256, or "s" and the SHA-256 of the score's id
    pub k: String,
    pub md5: String,
    pub ruleset: String,
    /// unix ms
    pub date: i64,
    pub acc: f64,
    /// lazer's ScoreRank: -1 F, 0 D … 7 XH
    pub rank: i64,
    pub score: i64,
    pub combo: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pp: Option<f64>,
    /// lazer's mods JSON
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mods: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<Map<String, Value>>,
    /// osu!'s score id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online: Option<i64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// the replay's SHA-256 (its file in lazer's files/ is named by it)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<String>,
}

/// What this PC has to offer the cloud: its own plays, their replays' files, its map list.
pub struct Local {
    pub scores: Vec<CloudScore>,
    pub replays: Vec<(String, PathBuf)>,
    pub sets: Vec<i64>,
}

/// What the cloud has for this login (GET /api/cloud).
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Summary {
    scores: Vec<String>,
    replays: Vec<String>,
    maps: usize,
    scores_saved: Option<i64>,
    bytes: u64,
    limit: u64,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    /// plays and replays sent this time
    pub added: usize,
    pub replays_added: usize,
    /// what the cloud has now
    pub scores: usize,
    pub replays: usize,
    pub sets: usize,
    pub bytes: u64,
    pub limit: u64,
    /// plays from the cloud this library doesn't have (another PC's, or from before a new install)
    pub restored: usize,
    /// the cloud got full on the way
    pub full: bool,
    /// the plays from the cloud here changed (History reads them again)
    pub pulled: bool,
}

/// The table the cloud's plays come into (a library scan never touches it). Safe to run every time.
pub fn ensure_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cloud_scores (
            key                TEXT PRIMARY KEY,
            md5                TEXT NOT NULL,
            ruleset            TEXT NOT NULL,
            date               INTEGER NOT NULL,
            accuracy           REAL NOT NULL,
            rank               INTEGER NOT NULL,
            score              INTEGER NOT NULL,
            combo              INTEGER NOT NULL,
            pp                 REAL,
            mods               TEXT,
            statistics         TEXT NOT NULL DEFAULT '{}',
            maximum_statistics TEXT NOT NULL DEFAULT '{}',
            online_id          INTEGER,
            stable             INTEGER NOT NULL DEFAULT 0,
            user               TEXT,
            replay             TEXT
        );
        CREATE INDEX IF NOT EXISTS cloud_scores_md5 ON cloud_scores(md5);",
    )?;
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A play's key in the cloud: its replay's hash when it has one (the same play from any PC), else
/// a hash of its own id.
fn key_of(replay: Option<&str>, id: &str) -> String {
    match replay.filter(|h| is_hash(h)) {
        Some(h) => format!("r{h}"),
        None => format!("s{}", sha256_hex(id.as_bytes())),
    }
}

fn object(json: Option<String>) -> Option<Map<String, Value>> {
    match serde_json::from_str(&json?).ok()? {
        Value::Object(m) if !m.is_empty() => Some(m),
        _ => None,
    }
}

/// lazer's rank names, F first (the number is the index − 1)
const RANK_NAMES: [&str; 9] = ["F", "D", "C", "B", "A", "S", "SH", "X", "XH"];

/// lazer's mods JSON for a play Fumen saw happen (live.rs keeps the acronyms and the rate apart).
fn live_mods(json: &str, rate: Option<f64>) -> String {
    let list: Vec<String> = serde_json::from_str(json).unwrap_or_default();
    let out: Vec<Value> = list
        .iter()
        .map(|a| match (a.as_str(), rate) {
            ("DT" | "NC" | "HT" | "DC", Some(r)) => serde_json::json!({ "acronym": a, "settings": { "speed_change": r } }),
            _ => serde_json::json!({ "acronym": a }),
        })
        .collect();
    Value::Array(out).to_string()
}

/// The player's own plays on this PC (lazer's and stable's, and plays Fumen saw happen that lazer's
/// scores don't have yet), their replays' files, and the library's osu! set ids.
pub fn gather(conn: &Connection, storage: Option<&Path>) -> Result<Local> {
    let player = Player::detect(conn)?;
    let mut scores = Vec::new();
    let mut replays = Vec::new();
    let mut seen = HashSet::new();
    let mut st = conn.prepare(&format!(
        "SELECT id, map_md5, ruleset, total_score, accuracy, max_combo, rank, pp, date, mods, statistics, maximum_statistics,
                online_id, id LIKE 'st-%', user, replay
         FROM scores WHERE {} AND map_md5 IS NOT NULL AND date IS NOT NULL AND NOT (id LIKE 'st-%' AND EXISTS (
             SELECT 1 FROM scores l WHERE l.id NOT LIKE 'st-%' AND l.map_md5 = scores.map_md5 AND ABS(l.date - scores.date) <= 2000))
         ORDER BY date",
        player.sql()
    ))?;
    let mut rows = st.query([player.param()])?;
    while let Some(r) = rows.next()? {
        let id: String = r.get(0)?;
        let md5: String = r.get::<_, String>(1)?.to_ascii_lowercase();
        let replay: Option<String> = r.get::<_, Option<String>>(15)?.filter(|h| is_hash(h));
        let k = key_of(replay.as_deref(), &id);
        if md5.len() != 32 || !seen.insert(k.clone()) {
            continue;
        }
        if let (Some(h), Some(storage)) = (&replay, storage) {
            if let Some(path) = crate::paths::lazer_file(storage, h) {
                replays.push((h.clone(), path));
            }
        }
        scores.push(CloudScore {
            k,
            md5,
            ruleset: r.get::<_, Option<String>>(2)?.unwrap_or_else(|| "osu".into()),
            date: r.get(8)?,
            acc: r.get::<_, Option<f64>>(4)?.unwrap_or(0.0).clamp(0.0, 1.0),
            rank: r.get::<_, Option<i64>>(6)?.unwrap_or(-1),
            score: r.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0),
            combo: r.get::<_, Option<i64>>(5)?.unwrap_or(0).max(0),
            pp: r.get(7)?,
            mods: r.get(9)?,
            stats: object(r.get(10)?),
            max: object(r.get(11)?),
            online: r.get::<_, Option<i64>>(12)?.filter(|v| *v > 0),
            stable: r.get(13)?,
            user: r.get(14)?,
            replay,
        });
    }

    // plays Fumen saw happen that lazer's scores don't have yet (live.rs): their id is the replay's hash
    let name: Option<String> = match &player {
        Player::Id(id) => conn.query_row("SELECT user FROM scores WHERE user_id = ?1 ORDER BY date DESC LIMIT 1", [id], |r| r.get(0)).optional()?.flatten(),
        Player::Name(n) => Some(n.clone()),
        Player::Anyone => None,
    };
    let mut st = conn.prepare(
        "SELECT id, md5, mode, player, date, accuracy, rank, score, combo, mods, rate, statistics, maximum_statistics FROM live_plays
         WHERE id NOT IN (SELECT replay FROM scores WHERE replay IS NOT NULL) ORDER BY date",
    )?;
    let mut rows = st.query([])?;
    while let Some(r) = rows.next()? {
        let id: String = r.get(0)?;
        let who: String = r.get(3)?;
        if !is_hash(&id) || name.as_ref().is_some_and(|n| !n.eq_ignore_ascii_case(&who)) || !seen.insert(format!("r{id}")) {
            continue;
        }
        let mode: i64 = r.get(2)?;
        let rank = r.get::<_, Option<String>>(6)?.and_then(|n| RANK_NAMES.iter().position(|x| *x == n)).map_or(-1, |i| i as i64 - 1);
        if let Some(path) = storage.and_then(|s| crate::paths::lazer_file(s, &id)) {
            replays.push((id.clone(), path));
        }
        scores.push(CloudScore {
            k: format!("r{id}"),
            md5: r.get::<_, String>(1)?.to_ascii_lowercase(),
            ruleset: RULESETS.get(mode as usize).unwrap_or(&"osu").to_string(),
            date: r.get(4)?,
            acc: r.get::<_, f64>(5)?.clamp(0.0, 1.0),
            rank,
            score: r.get::<_, i64>(7)?.max(0),
            combo: r.get::<_, i64>(8)?.max(0),
            pp: None,
            mods: Some(live_mods(&r.get::<_, String>(9)?, r.get(10)?)),
            stats: object(r.get(11)?),
            max: object(r.get(12)?),
            online: None,
            stable: false,
            user: Some(who).filter(|w| !w.is_empty()),
            replay: Some(id),
        });
    }
    scores.truncate(MAX_SCORES);

    let mut st = conn.prepare("SELECT DISTINCT online_id FROM sets WHERE online_id > 0 ORDER BY online_id")?;
    let sets = st.query_map([], |r| r.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Local { scores, replays, sets })
}

// ── the server ──────────────────────────────────────────────────────────

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(Duration::from_secs(180)))
        .https_only(cfg!(not(test)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn failed(status: u16, body: &str) -> Error {
    let v = serde_json::from_str::<Value>(body).ok();
    let msg = v.as_ref().and_then(|v| v["message"].as_str().map(String::from));
    match (status, v.as_ref().and_then(|v| v["error"].as_str())) {
        (401, _) => Error::known("osu-logged-out", msg.unwrap_or_else(|| "osu! didn't accept the login. Log in again.".into())),
        (413, _) | (_, Some("full")) => Error::known("cloud-full", msg.unwrap_or_else(|| "Your space in the cloud is full (1 GB).".into())),
        _ => Error::known("cloud-failed", msg.unwrap_or_else(|| format!("Fumen's server answered {status}"))),
    }
}

fn unreachable(e: ureq::Error) -> Error {
    Error::known("cloud-failed", format!("Fumen's server didn't answer ({e})"))
}

/// A request to the cloud with the login and Fumen's build proof: the answer's status and body.
fn call(ep: &Endpoints, token: &str, method: &str, path: &str, body: Option<&str>, limit: u64) -> Result<(u16, Vec<u8>)> {
    let url = format!("{}{path}", ep.site);
    let auth = format!("Bearer {token}");
    let res = match (method, body) {
        ("GET", _) => crate::online::signed(agent().get(&url), "GET", path).header("Authorization", &auth).call(),
        ("DELETE", _) => crate::online::signed(agent().delete(&url), "DELETE", path).header("Authorization", &auth).call(),
        ("PUT", Some(b)) => crate::online::signed(agent().put(&url), "PUT", path).header("Authorization", &auth).header("Content-Type", "application/json").send(b),
        (_, b) => crate::online::signed(agent().post(&url), "POST", path)
            .header("Authorization", &auth)
            .header("Content-Type", "application/json")
            .send(b.unwrap_or("{}")),
    };
    let mut res = res.map_err(unreachable)?;
    let status = res.status().as_u16();
    let bytes = res.body_mut().with_config().limit(limit).read_to_vec().unwrap_or_default();
    Ok((status, bytes))
}

fn json_call<T: serde::de::DeserializeOwned>(ep: &Endpoints, token: &str, method: &str, path: &str, body: Option<&str>) -> Result<T> {
    let (status, bytes) = call(ep, token, method, path, body, 512 * 1024 * 1024)?;
    if status != 200 {
        return Err(failed(status, &String::from_utf8_lossy(&bytes)));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

/// Standard base64 (with padding), for replays in a JSON body.
fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Sends what the cloud doesn't have yet (plays, replays, the map list), then takes in the plays
/// saved from elsewhere when there are new ones (`fetch`: whatever there is). `progress(done, of)`
/// follows the replays going up.
pub fn sync(
    data_dir: &Path,
    ep: &Endpoints,
    conn: &std::sync::Mutex<Connection>,
    local: Local,
    fetch: bool,
    mut progress: impl FnMut(usize, usize),
) -> Result<SyncSummary> {
    osu_auth::with_token(data_dir, ep, |token| {
        let have: Summary = json_call(ep, token, "GET", "/api/cloud", None)?;
        let mut out = SyncSummary { limit: have.limit, bytes: have.bytes, ..Default::default() };
        let pulled = db::get_meta(&lock(conn), PULLED)?.and_then(|v| v.parse::<i64>().ok());
        // `cloud_scores` has everything from elsewhere: what this PC sends now is its own
        let in_step = !fetch && have.scores_saved.is_some() && have.scores_saved == pulled;
        let mut saved = have.scores_saved;

        let known: HashSet<&str> = have.scores.iter().map(String::as_str).collect();
        let fresh: Vec<&CloudScore> = local.scores.iter().filter(|s| !known.contains(s.k.as_str())).collect();
        let mut total = have.scores.len();
        for chunk in fresh.chunks(SCORES_PER_POST) {
            let body = serde_json::json!({ "scores": chunk }).to_string();
            let v: Value = match json_call(ep, token, "POST", "/api/cloud/scores", Some(&body)) {
                Err(e) if e.code() == "cloud-full" => {
                    out.full = true;
                    break;
                }
                r => r?,
            };
            out.added += v["added"].as_u64().unwrap_or(0) as usize;
            total = v["scores"].as_u64().map_or(total, |n| n as usize);
            saved = v["saved"].as_i64().or(saved);
        }
        out.scores = total;

        // replays, a few MB at a time
        let sent: HashSet<&str> = have.replays.iter().map(String::as_str).collect();
        let mut queued = HashSet::new();
        let todo: Vec<&(String, PathBuf)> = local.replays.iter().filter(|(h, _)| !sent.contains(h.as_str()) && queued.insert(h.as_str())).collect();
        let of = todo.len();
        out.replays = have.replays.len();
        let send = |batch: &mut Map<String, Value>, out: &mut SyncSummary| -> Result<()> {
            if batch.is_empty() {
                return Ok(());
            }
            let n = batch.len();
            let body = serde_json::json!({ "replays": std::mem::take(batch) }).to_string();
            let v: Value = json_call(ep, token, "POST", "/api/cloud/replays", Some(&body))?;
            let saved = (v["saved"].as_u64().unwrap_or(0) as usize).min(n);
            out.replays_added += saved;
            out.replays += saved;
            out.bytes = v["bytes"].as_u64().unwrap_or(out.bytes);
            Ok(())
        };
        let mut batch = Map::new();
        let mut size = 0u64;
        for (done, (hash, path)) in todo.into_iter().enumerate() {
            if out.full {
                break;
            }
            let Ok(bytes) = std::fs::read(path) else { continue };
            if bytes.is_empty() || bytes.len() as u64 > MAX_REPLAY || sha256_hex(&bytes) != *hash {
                continue;
            }
            if size + bytes.len() as u64 > REPLAY_BYTES_PER_POST {
                match send(&mut batch, &mut out) {
                    Err(e) if e.code() == "cloud-full" => out.full = true,
                    r => r?,
                }
                size = 0;
                progress(done, of);
            }
            size += bytes.len() as u64;
            batch.insert(hash.clone(), Value::String(base64(&bytes)));
        }
        if !out.full {
            match send(&mut batch, &mut out) {
                Err(e) if e.code() == "cloud-full" => out.full = true,
                r => r?,
            }
        }
        progress(of, of);

        // the map list, unless this library has far fewer sets than the cloud's list
        out.sets = have.maps;
        if !out.full && !local.sets.is_empty() && local.sets.len() != have.maps && local.sets.len() as f64 >= have.maps as f64 * SHRINK {
            let body = serde_json::json!({ "sets": local.sets }).to_string();
            let v: Value = json_call(ep, token, "PUT", "/api/cloud/maps", Some(&body))?;
            out.sets = v["sets"].as_u64().map_or(out.sets, |n| n as usize);
        }

        // the plays saved from elsewhere
        if in_step {
            if saved != pulled {
                db::set_meta(&lock(conn), PULLED, &saved.unwrap_or(0).to_string())?;
            }
        } else if total > 0 {
            #[derive(Deserialize)]
            struct All {
                saved: i64,
                scores: Vec<CloudScore>,
            }
            let all: All = json_call(ep, token, "GET", "/api/cloud/scores", None)?;
            let mut c = lock(conn);
            take_in(&mut c, &all.scores)?;
            db::set_meta(&c, PULLED, &all.saved.to_string())?;
            out.pulled = true;
        } else if restored(&lock(conn))? > 0 {
            forget_here(data_dir, &lock(conn))?;
            out.pulled = true;
        }
        out.restored = restored(&lock(conn))?;
        Ok(out)
    })
}

fn lock(conn: &std::sync::Mutex<Connection>) -> std::sync::MutexGuard<'_, Connection> {
    conn.lock().unwrap_or_else(|e| e.into_inner())
}

/// The cloud's plays as `cloud_scores` (replacing what was there).
pub fn take_in(conn: &mut Connection, scores: &[CloudScore]) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM cloud_scores", [])?;
    {
        let mut st = tx.prepare(
            "INSERT OR REPLACE INTO cloud_scores (key, md5, ruleset, date, accuracy, rank, score, combo, pp, mods, statistics,
                maximum_statistics, online_id, stable, user, replay) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        )?;
        for s in scores.iter().take(MAX_SCORES) {
            let stats = s.stats.as_ref().map_or_else(|| "{}".into(), |m| Value::Object(m.clone()).to_string());
            let max = s.max.as_ref().map_or_else(|| "{}".into(), |m| Value::Object(m.clone()).to_string());
            st.execute(params![
                s.k,
                s.md5.to_ascii_lowercase(),
                s.ruleset,
                s.date,
                s.acc,
                s.rank,
                s.score,
                s.combo,
                s.pp,
                s.mods,
                stats,
                max,
                s.online,
                s.stable,
                s.user,
                s.replay.as_deref().filter(|h| is_hash(h)),
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// The cloud's plays this library doesn't have itself.
pub fn restored(conn: &Connection) -> Result<usize> {
    Ok(conn.query_row(&format!("SELECT COUNT(*) FROM cloud_scores c WHERE {NOT_LOCAL}"), [], |r| r.get::<_, i64>(0))? as usize)
}

/// The condition on a `cloud_scores c` row for a play this library doesn't have itself: no score
/// of lazer's or stable's on the same difficulty within two seconds, and not a play Fumen saw
/// happen (by its replay).
pub const NOT_LOCAL: &str = "NOT EXISTS (SELECT 1 FROM scores l WHERE l.map_md5 = c.md5 AND ABS(l.date - c.date) <= 2000)
    AND NOT (c.replay IS NOT NULL AND EXISTS (SELECT 1 FROM live_plays v WHERE v.id = c.replay))";

/// The osu! set ids in the cloud's map list.
pub fn map_list(data_dir: &Path, ep: &Endpoints) -> Result<Vec<i64>> {
    #[derive(Deserialize)]
    struct Maps {
        sets: Vec<i64>,
    }
    osu_auth::with_token(data_dir, ep, |token| {
        let (status, bytes) = call(ep, token, "GET", "/api/cloud/maps", None, 64 * 1024 * 1024)?;
        match status {
            200 => Ok(serde_json::from_slice::<Maps>(&bytes)?.sets),
            404 => Ok(Vec::new()),
            _ => Err(failed(status, &String::from_utf8_lossy(&bytes))),
        }
    })
}

/// A replay of a play from the cloud: from this PC's cache or lazer's files when it's there,
/// else downloaded (and kept).
pub fn replay(data_dir: &Path, ep: &Endpoints, storage: Option<&Path>, hash: &str) -> Result<Vec<u8>> {
    if !is_hash(hash) {
        return Err(Error::known("replay-missing", "The cloud has no replay for this score."));
    }
    let cached = data_dir.join(CACHE).join(format!("{hash}.osr"));
    let local = storage.and_then(|s| crate::paths::lazer_file(s, hash));
    for path in [Some(cached.clone()), local].into_iter().flatten() {
        if let Ok(bytes) = std::fs::read(&path) {
            if sha256_hex(&bytes) == hash {
                return Ok(bytes);
            }
        }
    }
    let bytes = osu_auth::with_token(data_dir, ep, |token| {
        let (status, bytes) = call(ep, token, "GET", &format!("/api/cloud/replays/{hash}"), None, MAX_REPLAY)?;
        match status {
            200 => Ok(bytes),
            404 => Err(Error::known("replay-missing", "The cloud has no replay for this score.")),
            _ => Err(failed(status, &String::from_utf8_lossy(&bytes))),
        }
    })?;
    if sha256_hex(&bytes) != hash {
        return Err(Error::known("replay-unreadable", "The replay from the cloud wasn't the right one."));
    }
    std::fs::create_dir_all(cached.parent().unwrap())?;
    std::fs::write(&cached, &bytes)?;
    Ok(bytes)
}

/// Deletes everything of this login's in the cloud (scores, replays, map list and collections),
/// and the cloud's plays and replays kept on this PC.
pub fn delete_all(data_dir: &Path, ep: &Endpoints, conn: &std::sync::Mutex<Connection>) -> Result<()> {
    osu_auth::with_token(data_dir, ep, |token| {
        for path in ["/api/cloud", "/api/collections"] {
            let (status, bytes) = call(ep, token, "DELETE", path, None, 64 * 1024)?;
            if !matches!(status, 200 | 204 | 404) {
                return Err(failed(status, &String::from_utf8_lossy(&bytes)));
            }
        }
        Ok(())
    })?;
    forget_here(data_dir, &lock(conn))
}

/// The cloud's plays and replays kept on this PC, gone.
pub fn forget_here(data_dir: &Path, conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM cloud_scores", [])?;
    conn.execute("DELETE FROM meta WHERE key = ?1", [PULLED])?;
    let _ = std::fs::remove_dir_all(data_dir.join(CACHE));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00, 0x01]), "//4AAQ==");
    }

    #[test]
    fn keys_go_by_the_replay_or_the_id() {
        let h = "a".repeat(64);
        assert_eq!(key_of(Some(&h), "x"), format!("r{h}"));
        assert_eq!(key_of(Some("nope"), "x"), format!("s{}", sha256_hex(b"x")));
        assert_eq!(key_of(None, "st-1").len(), 65);
    }

    #[test]
    fn live_mods_keep_the_rate() {
        assert_eq!(live_mods(r#"["DT","HD"]"#, Some(1.2)), r#"[{"acronym":"DT","settings":{"speed_change":1.2}},{"acronym":"HD"}]"#);
        assert_eq!(crate::osu_scores::mods_of(&live_mods(r#"["HT"]"#, Some(0.8))), (vec!["HT".to_string()], Some(0.8)));
    }

    #[test]
    fn gathers_own_plays_and_takes_in_the_clouds() {
        let dir = std::env::temp_dir().join(format!("fumen-cloud-scores-{}", std::process::id()));
        let mut conn = crate::db::open(&dir.join("t.db")).unwrap();
        let h = "b".repeat(64);
        conn.execute_batch(&format!(
            "INSERT INTO meta (key, value) VALUES ('osu.user', '7');
             INSERT INTO scores (id, map_md5, ruleset, total_score, accuracy, max_combo, rank, date, mods, statistics, user, user_id, replay) VALUES
               ('mine', '{a}', 'mania', 900000, 0.97, 500, 4, 1000000, '[]', '{{\"great\":10}}', 'Me', 7, '{h}'),
               ('theirs', '{a}', 'mania', 800000, 0.9, 400, 3, 2000000, '[]', '{{}}', 'Other', 8, NULL),
               ('st-1', '{a}', 'mania', 700000, 0.8, 300, 2, 3000000, '[]', '{{}}', 'Me', NULL, NULL);
             INSERT INTO live_plays (id, md5, mode, player, date, accuracy, rank, score, combo, mods, rate) VALUES
               ('{c}', '{a}', 3, 'Me', 4000000, 0.99, 'S', 950000, 600, '[\"DT\"]', 1.3),
               ('{h}', '{a}', 3, 'Me', 1000000, 0.97, 'S', 900000, 500, '[]', NULL);",
            a = "a".repeat(32),
            c = "c".repeat(64),
        ))
        .unwrap();
        let local = gather(&conn, None).unwrap();
        let keys: Vec<&str> = local.scores.iter().map(|s| s.k.as_str()).collect();
        assert_eq!(keys.len(), 3, "mine, stable's and the live one, not the other player's: {keys:?}");
        assert_eq!(local.scores[0].k, format!("r{h}"));
        assert_eq!(local.scores[0].stats.as_ref().unwrap()["great"], 10);
        assert!(local.scores[1].stable && local.scores[1].k.starts_with('s'));
        assert_eq!((local.scores[2].rank, local.scores[2].ruleset.as_str()), (4, "mania"));

        // the cloud's plays: one this library has, one from another PC
        let mut other = local.scores[0].clone();
        other.k = format!("r{}", "d".repeat(64));
        other.date = 9_000_000;
        other.replay = Some("d".repeat(64));
        take_in(&mut conn, &[local.scores[0].clone(), other]).unwrap();
        assert_eq!(restored(&conn).unwrap(), 1);
        // the replay list takes the cloud's in too (its query, at least)
        assert!(crate::replay::list(&conn, "none").unwrap().is_empty());
        let history = String::from_utf8(crate::osu_scores::history_json(&conn, None, None).unwrap()).unwrap();
        assert!(history.contains("9000000"), "the other PC's play is in the history");
        assert_eq!(history.matches("1000000,").count(), 1, "this PC's own play only once");
        forget_here(&dir, &conn).unwrap();
        assert_eq!(restored(&conn).unwrap(), 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
