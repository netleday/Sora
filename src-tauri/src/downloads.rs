//! Beatmap sets from the internet: links to set IDs, and `.osz` downloads from mirrors.
//!
//! osu!'s own API doesn't let third-party apps download sets (that route is lazer's alone), and
//! nothing here ever fetches a file from osu!'s servers: sets come from community mirrors.
//! Downloads share a [`Mirrors`] pool that spreads them over the mirrors, so no single one sees
//! a whole import, and that pauses a mirror when it says "too many requests" (for as long as its
//! `Retry-After` asks) instead of failing sets. Every request to a mirror, from here, the search
//! and the chart files, goes through one budget per mirror (see [`UNITS_PER_MINUTE`]), plus the
//! limits a mirror publishes for itself ([`caps`]: osu.direct's downloads an hour and requests a
//! minute), so Fumen stays under the mirrors' rate limits instead of running into them. What a
//! mirror's answers say is left of its limits counts too ([`note_limits`]). fumen.dertesti.dev can
//! slow a mirror down or turn it off for every Fumen without a release ([`follow_rules`]).
//! Beatmap links (`/b/<id>`, `/beatmaps/<id>`) are
//! turned into their set by the mirrors' beatmap lookups too.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};

/// Mirrors want a user agent that names the app (catboy.best turns away ones with a URL in it).
pub const USER_AGENT: &str = concat!("Fumen/", env!("CARGO_PKG_VERSION"), " (osu! library manager)");

pub struct Mirror {
    pub name: &'static str,
    /// Only for sets the others don't have, or while they all rest: slow, but it has sets
    /// nobody else keeps.
    pub last_resort: bool,
    /// the download URL for a set, without video where the mirror has that
    url: fn(u32) -> String,
}

/// The mirrors, best first: when all of them are equally busy, the first ones get the next set.
pub const MIRRORS: [Mirror; 6] = [
    Mirror { name: "osu.direct", last_resort: false, url: |id| format!("https://osu.direct/api/d/{id}") },
    Mirror { name: "nekoha.moe", last_resort: false, url: |id| format!("https://mirror.nekoha.moe/api4/download/{id}") },
    Mirror { name: "catboy.best", last_resort: false, url: |id| format!("https://catboy.best/d/{id}n") },
    Mirror { name: "beatconnect.io", last_resort: false, url: |id| format!("https://beatconnect.io/b/{id}/") },
    Mirror { name: "nerinyan.moe", last_resort: false, url: |id| format!("https://api.nerinyan.moe/d/{id}?nv=1") },
    // under 1 MB/s where the others manage 4 to 20
    Mirror { name: "sayobot.cn", last_resort: true, url: |id| format!("https://dl.sayobot.cn/beatmaps/download/novideo/{id}") },
];

/// Beatmap lookups (beatmap ID → set) that answer osu!-API-style JSON with `beatmapset_id`.
const LOOKUPS: [(&str, fn(u32) -> String); 3] = [
    ("osu.direct", |id| format!("https://osu.direct/api/v2/b/{id}")),
    ("nekoha.moe", |id| format!("https://mirror.nekoha.moe/api4/beatmap/{id}")),
    ("catboy.best", |id| format!("https://catboy.best/api/v2/b/{id}")),
];

/// What Fumen asks of one mirror a minute at most, in the units of catboy.best's limit (1200 a
/// minute, a download costs 20 and any other request 1; an IP that keeps going past it gets
/// banned). Two thirds of that, for every mirror: 40 downloads a minute.
const UNITS_PER_MINUTE: u32 = 800;
const WINDOW: Duration = Duration::from_secs(60);
/// What a set or chart file download costs of the budget.
pub const DOWNLOAD: u32 = 20;
/// What a lookup or search costs.
pub const REQUEST: u32 = 1;

/** What a request to a mirror is, for its limits. */
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ask {
    /// a whole set (`.osz`)
    Set,
    /// a difficulty's `.osu` file
    File,
    /// a lookup or a search
    Request,
}

impl Ask {
    fn units(self) -> u32 {
        match self {
            Ask::Request => REQUEST,
            Ask::Set | Ask::File => DOWNLOAD,
        }
    }
}

/// A limit a mirror publishes for each computer: at most `max` within `span`, of set downloads
/// only or of every request.
struct Cap {
    span: Duration,
    max: u32,
    sets_only: bool,
}

/// osu.direct's published limits (osu.direct/api/docs), with some room: 200 set downloads an hour
/// (/api/d), 120 requests a minute and 25 in 5 seconds (everything under /api, downloads too).
const OSU_DIRECT: [Cap; 3] = [
    Cap { span: Duration::from_secs(3600), max: 180, sets_only: true },
    Cap { span: Duration::from_secs(60), max: 100, sets_only: false },
    Cap { span: Duration::from_secs(5), max: 20, sets_only: false },
];
/// the longest span of any cap: what a budget remembers
const LONGEST_CAP: Duration = Duration::from_secs(3600);

/// The limits `mirror` publishes, on top of the budget every mirror has.
fn caps(mirror: &str) -> &'static [Cap] {
    match mirror {
        "osu.direct" => &OSU_DIRECT,
        _ => &[],
    }
}

#[derive(Default)]
struct Budget {
    spent: VecDeque<(Instant, u32)>,
    /// every request of the last hour, for the caps
    log: VecDeque<(Instant, Ask)>,
    /// after "too many requests": nothing goes to the mirror until then
    rest_until: Option<Instant>,
}

impl Budget {
    /// When a request costing `units` fits under `limit` units a minute.
    fn free_at(&self, units: u32, limit: u32, now: Instant) -> Instant {
        let rest = self.rest_until.filter(|&t| t > now).unwrap_or(now);
        let mut used: u32 = self.spent.iter().map(|(_, u)| u).sum();
        if used + units <= limit {
            return rest;
        }
        for (t, u) in &self.spent {
            used -= u;
            if used + units <= limit {
                return rest.max(*t + WINDOW);
            }
        }
        rest
    }

    /// When `ask` fits under every cap (`now` when it does already).
    fn caps_free_at(&self, ask: Ask, caps: &[Cap], now: Instant) -> Instant {
        let mut at = now;
        for c in caps {
            if c.sets_only && ask != Ask::Set {
                continue;
            }
            let inside: Vec<Instant> =
                self.log.iter().filter(|(t, a)| now.duration_since(*t) < c.span && (!c.sets_only || *a == Ask::Set)).map(|(t, _)| *t).collect();
            if inside.len() as u32 >= c.max {
                // the oldest ones have to drop out of the span first
                let k = inside.len() + 1 - c.max as usize;
                at = at.max(inside[k - 1] + c.span);
            }
        }
        at
    }

    /// When `ask` fits `limit` units a minute, the caps and any rest.
    fn ask_free_at(&self, ask: Ask, limit: u32, caps: &[Cap], now: Instant) -> Instant {
        self.free_at(ask.units(), limit, now).max(self.caps_free_at(ask, caps, now))
    }
}

/// Where Fumen asks what to do with the mirrors.
const RULES_URL: &str = "https://fumen.dertesti.dev/api/mirrors";
/// How often a running Fumen asks again.
const RULES_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// What fumen.dertesti.dev says about one mirror. It can only hold Fumen back: a mirror turned
/// off, fewer downloads a minute than built in, or a mirror only as a last resort. It can't add a
/// mirror or point one elsewhere.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rule {
    #[serde(default)]
    off: bool,
    /// downloads a minute
    per_minute: Option<u32>,
    last_resort: Option<bool>,
}

#[derive(serde::Deserialize)]
struct Rules {
    #[serde(default)]
    mirrors: std::collections::HashMap<String, Rule>,
}

static RULES: Mutex<Vec<(String, Rule)>> = Mutex::new(Vec::new());

fn parse_rules(text: &str) -> Option<Vec<(String, Rule)>> {
    let rules: Rules = serde_json::from_str(text).ok()?;
    Some(rules.mirrors.into_iter().collect())
}

fn rule(mirror: &str) -> Rule {
    RULES.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(n, _)| n == mirror).map(|(_, r)| *r).unwrap_or_default()
}

/// Whether fumen.dertesti.dev turned `mirror` off.
pub fn off(mirror: &str) -> bool {
    rule(mirror).off
}

/// Units a minute for `mirror`: what's built in, or less when the site says so.
fn limit(mirror: &str) -> u32 {
    rule(mirror).per_minute.map_or(UNITS_PER_MINUTE, |n| (n.max(1) * DOWNLOAD).min(UNITS_PER_MINUTE))
}

fn last_resort(i: usize) -> bool {
    rule(MIRRORS[i].name).last_resort.unwrap_or(MIRRORS[i].last_resort)
}

/// Follows fumen.dertesti.dev's rules for the mirrors: the last ones it said (kept in `file`)
/// right away, then what it says now and every few hours. Without an answer the last ones hold.
pub fn follow_rules(file: PathBuf) {
    if let Some(r) = std::fs::read_to_string(&file).ok().and_then(|t| parse_rules(&t)) {
        *RULES.lock().unwrap_or_else(|e| e.into_inner()) = r;
    }
    std::thread::spawn(move || {
        let agent = agent(Duration::from_secs(15));
        loop {
            if let Ok(mut res) = agent.get(RULES_URL).call() {
                if res.status() == 200 {
                    if let Some(text) = res.body_mut().with_config().limit(64 * 1024).read_to_string().ok() {
                        if let Some(r) = parse_rules(&text) {
                            *RULES.lock().unwrap_or_else(|e| e.into_inner()) = r;
                            let _ = std::fs::write(&file, text);
                        }
                    }
                }
            }
            std::thread::sleep(RULES_EVERY);
        }
    });
}

type Budgets = Mutex<Vec<(&'static str, Budget)>>;

#[cfg(not(test))]
static BUDGETS: Budgets = Mutex::new(Vec::new());
// each test its own, so they don't use up each other's
#[cfg(test)]
thread_local! {
    static BUDGETS: Budgets = const { Mutex::new(Vec::new()) };
}

fn with_budget<T>(mirror: &'static str, f: impl FnOnce(&mut Budget, Instant) -> T) -> T {
    #[cfg(not(test))]
    return in_budget(&BUDGETS, mirror, f);
    #[cfg(test)]
    BUDGETS.with(|all| in_budget(all, mirror, f))
}

fn in_budget<T>(all: &Budgets, mirror: &'static str, f: impl FnOnce(&mut Budget, Instant) -> T) -> T {
    let mut all = all.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    let i = match all.iter().position(|(n, _)| *n == mirror) {
        Some(i) => i,
        None => {
            all.push((mirror, Budget::default()));
            all.len() - 1
        }
    };
    let b = &mut all[i].1;
    while b.spent.front().is_some_and(|(t, _)| now.duration_since(*t) >= WINDOW) {
        b.spent.pop_front();
    }
    while b.log.front().is_some_and(|(t, _)| now.duration_since(*t) >= LONGEST_CAP) {
        b.log.pop_front();
    }
    f(b, now)
}

/// When `mirror` can take `ask` (now or earlier: right away).
pub fn free_at(mirror: &'static str, ask: Ask) -> Instant {
    let limit = limit(mirror);
    with_budget(mirror, |b, now| b.ask_free_at(ask, limit, caps(mirror), now))
}

/// Whether `mirror` can take `ask` right now.
fn can_take(mirror: &'static str, ask: Ask) -> bool {
    free_at(mirror, ask) <= Instant::now()
}

/// Books `ask` with `mirror` if it fits right now.
pub fn try_book(mirror: &'static str, ask: Ask) -> bool {
    let limit = limit(mirror);
    with_budget(mirror, |b, now| {
        let fits = b.ask_free_at(ask, limit, caps(mirror), now) <= now;
        if fits {
            b.spent.push_back((now, ask.units()));
            b.log.push_back((now, ask));
        }
        fits
    })
}

/// Waits until `mirror` can take `ask` and books it; false (nothing booked) when that's
/// further off than `max` or the mirror is turned off.
pub fn book(mirror: &'static str, ask: Ask, max: Duration) -> bool {
    if off(mirror) {
        return false;
    }
    loop {
        let at = free_at(mirror, ask);
        let now = Instant::now();
        if at <= now {
            if try_book(mirror, ask) {
                return true;
            }
            continue;
        }
        if at - now > max {
            return false;
        }
        std::thread::sleep((at - now).min(Duration::from_millis(500)));
    }
}

/// `mirror` said "too many requests": nothing in Fumen asks it again for `d`.
pub fn rest(mirror: &'static str, d: Duration) {
    with_budget(mirror, |b, now| {
        let until = now + d.min(MAX_REST);
        b.rest_until = Some(b.rest_until.map_or(until, |t| t.max(until)));
    });
}

/// How long a mirror's limit headers ask it to be left alone, given `header` (a number header by
/// name) and the time in unix seconds: until a budget it counts for this computer refills, once
/// it's used up (osu.direct sends these on every /api answer). None: there's room left.
fn limits_wait(header: impl Fn(&str) -> Option<u64>, now_unix: u64) -> Option<Duration> {
    // resets come as seconds from now, or as a unix time
    let until = |reset: Option<u64>| reset.map(|r| Duration::from_secs(if r > 1_000_000_000 { r.saturating_sub(now_unix) } else { r }.max(1)));
    let mut wait: Option<Duration> = None;
    let mut more = |d: Option<Duration>| wait = wait.max(d);
    if header("x-download-budget-remaining") == Some(0) {
        more(until(header("x-download-budget-reset")));
    }
    // not enough for another big set today
    if header("x-download-budget-bytes-remaining").is_some_and(|b| b < 256 * 1024 * 1024) {
        more(until(header("x-download-budget-bytes-reset")));
    }
    if header("x-ratelimit-remaining") == Some(0) {
        more(until(header("x-ratelimit-reset")));
    }
    if header("x-ratelimit-burst-remaining") == Some(0) {
        more(until(header("x-ratelimit-burst-reset")));
    }
    wait
}

/// Rests `mirror` when its answer says a limit of its is used up for now.
pub fn note_limits(mirror: &'static str, res: &ureq::http::Response<ureq::Body>) {
    let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    if let Some(d) = limits_wait(header, now) {
        rest(mirror, d);
    }
}

fn resting(mirror: &'static str) -> bool {
    with_budget(mirror, |b, now| b.rest_until.is_some_and(|t| t > now))
}

/// Downloads from one mirror at once, at most.
const PER_MIRROR: u32 = 2;
/// Tries per set on a mirror that failed for other reasons than not having it.
const TRIES: u32 = 2;
/// A mirror that refuses or breaks rests this long, doubled per failure in a row.
const REST_AFTER_ERROR: Duration = Duration::from_secs(20);
const MAX_REST: Duration = Duration::from_secs(60 * 60);
/// "Too many requests" without a `Retry-After`: this long.
const REST_AFTER_429: Duration = Duration::from_secs(60);
/// A set waits this long at most for a resting mirror; longer and it fails (and can be tried
/// again later).
const MAX_WAIT: Duration = Duration::from_secs(20 * 60);
/// Refusals (403) in a row that make a mirror rest: a single one is "not here" (sayobot answers
/// a set it doesn't have like that).
const REFUSALS_TO_REST: u32 = 3;

#[derive(Default, Clone)]
struct MirrorState {
    rest_until: Option<Instant>,
    active: u32,
    /// downloads started (for spreading the sets)
    started: u32,
    errors_in_a_row: u32,
    refusals_in_a_row: u32,
}

/// The mirrors' state, shared by the downloads of an import.
pub struct Mirrors {
    state: Mutex<Vec<MirrorState>>,
}

impl Default for Mirrors {
    fn default() -> Self {
        Mirrors { state: Mutex::new(vec![MirrorState::default(); MIRRORS.len()]) }
    }
}

/// How a download goes along.
pub enum Progress {
    Bytes { done: u64, total: Option<u64> },
    /// every mirror that may have the set is busy with other sets, or resting after a rate limit
    /// until about then
    Waiting { until: Instant },
}

#[derive(Debug, PartialEq)]
enum Outcome {
    /// not on this mirror (404, refused once, or not an archive)
    Missing(String),
    /// "too many requests": the mirror rests this long
    Limited(Duration),
    /// broken connection, server error, …
    Failed(String),
    Cancelled,
}

#[derive(Clone, Copy, PartialEq)]
enum Tried {
    No,
    Missing,
    Failed(u32),
}

impl Mirrors {
    /// The mirror for the next try: of those not resting and not too busy that may still have the
    /// set, the least busy one, then the one that's had fewest sets, then the best. Last resort
    /// mirrors only when every other one that may have the set rests (busy ones are free soon).
    fn pick(&self, tried: &[Tried]) -> Option<usize> {
        let now = Instant::now();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let rests = |i: usize| state[i].rest_until.is_some_and(|t| t > now) || resting(MIRRORS[i].name);
        let others_left = (0..MIRRORS.len()).any(|i| !last_resort(i) && may_have(tried[i]) && !rests(i));
        let best = (0..MIRRORS.len())
            .filter(|&i| may_have(tried[i]) && !(last_resort(i) && others_left))
            .filter(|&i| !rests(i) && state[i].active < PER_MIRROR && can_take(MIRRORS[i].name, Ask::Set))
            .min_by_key(|&i| (matches!(tried[i], Tried::Failed(_)), state[i].active, state[i].started, i))?;
        if !try_book(MIRRORS[best].name, Ask::Set) {
            return None;
        }
        state[best].active += 1;
        state[best].started += 1;
        Some(best)
    }

    fn finished(&self, i: usize, outcome: Option<&Outcome>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let m = &mut state[i];
        m.active -= 1;
        let rest = |m: &mut MirrorState, d: Duration| {
            let until = Instant::now() + d.min(MAX_REST);
            m.rest_until = Some(m.rest_until.map_or(until, |t| t.max(until)));
        };
        match outcome {
            // delivered
            None => {
                m.errors_in_a_row = 0;
                m.refusals_in_a_row = 0;
            }
            Some(Outcome::Limited(d)) => {
                rest(m, *d);
                self::rest(MIRRORS[i].name, *d);
            }
            Some(Outcome::Failed(_)) => {
                m.errors_in_a_row += 1;
                let d = REST_AFTER_ERROR * 2u32.pow(m.errors_in_a_row.min(8) - 1);
                rest(m, d);
            }
            Some(Outcome::Missing(why)) if why.starts_with("HTTP 403") => {
                m.refusals_in_a_row += 1;
                if m.refusals_in_a_row >= REFUSALS_TO_REST {
                    m.refusals_in_a_row = 0;
                    rest(m, REST_AFTER_ERROR * 15);
                }
            }
            Some(Outcome::Missing(_)) => m.refusals_in_a_row = 0,
            Some(Outcome::Cancelled) => {}
        }
    }

    /// When the first mirror that may still have the set is free again (None: none may).
    fn next_free(&self, tried: &[Tried]) -> Option<Instant> {
        let now = Instant::now();
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        (0..MIRRORS.len())
            .filter(|&i| may_have(tried[i]))
            .map(|i| {
                // busy with other sets: soon
                let own = state[i].rest_until.filter(|&t| t > now).unwrap_or(now);
                own.max(free_at(MIRRORS[i].name, Ask::Set))
            })
            .min()
    }
}

/// Whether a mirror may still deliver a set after these tries.
fn may_have(tried: Tried) -> bool {
    matches!(tried, Tried::No) || matches!(tried, Tried::Failed(n) if n < TRIES)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Set(u32),
    Beatmap(u32),
}

/// What a pasted line points at: osu! set and beatmap links in their forms, `osu://s/…` /
/// `osu://b/…`, or a bare number (taken as a set ID, like the mirrors use).
pub fn parse_link(line: &str) -> Option<Target> {
    let s = line.trim().trim_matches(|c| c == '<' || c == '>' || c == '"');
    if s.is_empty() {
        return None;
    }
    if let Ok(id) = s.parse::<u32>() {
        return (id > 0).then_some(Target::Set(id));
    }
    let lower = s.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .map(|r| r.trim_start_matches("www.").strip_prefix("osu.ppy.sh"))
        .unwrap_or_else(|| lower.strip_prefix("osu:/"))?;
    let path = rest.split('#').next().unwrap_or(rest);
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let num = |p: Option<&&str>| p.and_then(|v| v.parse::<u32>().ok()).filter(|&v| v > 0);
    match parts.as_slice() {
        // a set link with a difficulty in the fragment still means the set
        ["beatmapsets", id, ..] | ["s", id, ..] => num(Some(id)).map(Target::Set),
        ["beatmaps", id, ..] | ["b", id, ..] => num(Some(id)).map(Target::Beatmap),
        ["p", "beatmap"] => query
            .split('&')
            .find_map(|kv| kv.strip_prefix("b="))
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&v| v > 0)
            .map(Target::Beatmap),
        ["dl", id] => num(Some(id)).map(Target::Set),
        _ => None,
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(timeout))
        // never down to plain http, where anyone on the way could swap the file
        .https_only(true)
        .max_redirects(5)
        .http_status_as_error(false)
        .build()
        .into()
}

/// The agent for set downloads: like `agent`, but redirects are followed in `fetch`.
fn download_agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(timeout))
        .https_only(true)
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into()
}

/// The set a beatmap belongs to, asked of the mirrors' beatmap lookups in turn.
pub fn set_of_beatmap(beatmap: u32) -> Result<u32> {
    crate::online::ensure()?;
    let agent = agent(Duration::from_secs(15));
    let mut failures = Vec::new();
    for (name, url) in LOOKUPS {
        if !book(name, Ask::Request, Duration::from_secs(10)) {
            failures.push(format!("{name} resting"));
            continue;
        }
        let answer = agent.get(&url(beatmap)).call();
        if let Ok(res) = &answer {
            note_limits(name, res);
        }
        match answer {
            Ok(res) if res.status() == 429 => {
                rest(name, retry_after(&res));
                failures.push(format!("{name} 429"));
            }
            Ok(mut res) if res.status() == 200 => {
                let set = res
                    .body_mut()
                    .read_to_string()
                    .ok()
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                    .and_then(|v| v["beatmapset_id"].as_u64())
                    .and_then(|v| u32::try_from(v).ok())
                    .filter(|&v| v > 0);
                match set {
                    Some(set) => return Ok(set),
                    None => failures.push(format!("{name} answered something else")),
                }
            }
            Ok(res) if res.status() == 404 => failures.push(format!("{name} 404")),
            Ok(res) => failures.push(format!("{name} {}", res.status().as_u16())),
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    if failures.iter().all(|f| f.ends_with(" 404")) {
        return Err(Error::known("not-found", format!("Beatmap {beatmap} wasn't found on the mirrors")));
    }
    Err(Error::known("download-failed", format!("Couldn't find beatmap {beatmap}'s set ({})", failures.join(", "))))
}

/// Downloads a set into `dir` as `<id>.osz` from whichever mirror has it, sharing `mirrors` with
/// the other downloads running. `progress` hears how it goes and says whether to go on (false:
/// the download stops with a "cancelled" error). Returns the file and the mirror that delivered
/// it.
pub fn download_set(set: u32, dir: &Path, mirrors: &Mirrors, mut progress: impl FnMut(Progress) -> bool) -> Result<(PathBuf, &'static str)> {
    crate::online::ensure()?;
    std::fs::create_dir_all(dir)?;
    let target = dir.join(format!("{set}.osz"));
    let part = dir.join(format!("{set}.osz.part"));
    let agent = download_agent(Duration::from_secs(300));
    let mut tried = [Tried::No; MIRRORS.len()];
    let mut why: Vec<String> = vec![String::new(); MIRRORS.len()];
    // turned off on fumen.dertesti.dev: as if they didn't have it
    for (i, m) in MIRRORS.iter().enumerate() {
        if off(m.name) {
            tried[i] = Tried::Missing;
        }
    }
    let mut waited_since: Option<Instant> = None;
    loop {
        let Some(i) = mirrors.pick(&tried) else {
            // every mirror said no, or the ones left are resting or busy
            let Some(free) = mirrors.next_free(&tried) else { break };
            let since = *waited_since.get_or_insert_with(Instant::now);
            if free.saturating_duration_since(since) > MAX_WAIT {
                return Err(Error::known(
                    "rate-limited",
                    format!("The mirrors are busy for a while (rate limits); try this set again later ({})", reasons(&why)),
                ));
            }
            if !progress(Progress::Waiting { until: free }) {
                return Err(Error::known("cancelled", "Cancelled"));
            }
            std::thread::sleep(Duration::from_millis(250));
            continue;
        };
        waited_since = None;
        let mirror = &MIRRORS[i];
        let outcome = fetch(&agent, mirror.name, &(mirror.url)(set), &part, &mut progress);
        match outcome {
            Ok(()) => {
                mirrors.finished(i, None);
                // what the mirror sent has to be the set asked for, and a sane archive
                match crate::archive::check_set(&part, set) {
                    Ok(()) => {
                        std::fs::rename(&part, &target)?;
                        return Ok((target, mirror.name));
                    }
                    Err(w) => {
                        let _ = std::fs::remove_file(&part);
                        tried[i] = Tried::Missing;
                        why[i] = format!("{} sent {w}", mirror.name);
                    }
                }
            }
            Err(outcome) => {
                let _ = std::fs::remove_file(&part);
                mirrors.finished(i, Some(&outcome));
                match outcome {
                    Outcome::Cancelled => return Err(Error::known("cancelled", "Cancelled")),
                    Outcome::Missing(w) => {
                        tried[i] = Tried::Missing;
                        why[i] = w;
                    }
                    Outcome::Limited(_) => why[i] = "429".into(),
                    Outcome::Failed(w) => {
                        tried[i] = Tried::Failed(match tried[i] {
                            Tried::Failed(n) => n + 1,
                            _ => 1,
                        });
                        why[i] = w;
                    }
                }
            }
        }
    }
    if tried.iter().all(|t| *t == Tried::Missing) && why.iter().filter(|w| !w.is_empty()).all(|w| w.starts_with("HTTP 404") || w.starts_with("HTTP 403") || w == NOT_ARCHIVE) {
        return Err(Error::known("not-found", format!("No download mirror has this set ({})", reasons(&why))));
    }
    Err(Error::known("download-failed", format!("No download mirror could deliver this set ({})", reasons(&why))))
}

/// How long a chart file waits at most for a mirror's budget.
const CHART_WAIT: Duration = Duration::from_secs(90);

/// Mirrors that serve a single difficulty's `.osu` file by osu!'s difficulty ID.
const CHART_MIRRORS: [(&str, fn(i64) -> String); 3] = [
    ("osu.direct", |id| format!("https://osu.direct/api/osu/{id}")),
    ("nekoha.moe", |id| format!("https://mirror.nekoha.moe/api4/osu/{id}")),
    ("catboy.best", |id| format!("https://catboy.best/osu/{id}")),
];

/// A difficulty's `.osu` file from the mirrors (never osu!'s servers), starting with mirror
/// `first` so parallel callers spread over them. Each mirror's budget holds: the next one in turn
/// that can take it now gets it, else this waits for the soonest (resting ones are skipped).
/// Ok(None): no mirror has it.
pub fn download_chart(agent: &ureq::Agent, beatmap: i64, first: usize) -> Result<Option<String>> {
    crate::online::ensure()?;
    let mut failures = Vec::new();
    let mut missing = 0;
    let mut left: Vec<usize> = (0..CHART_MIRRORS.len()).map(|k| (first + k) % CHART_MIRRORS.len()).filter(|&i| !off(CHART_MIRRORS[i].0)).collect();
    while !left.is_empty() {
        let k = match left.iter().position(|&i| can_take(CHART_MIRRORS[i].0, Ask::File)) {
            Some(k) => k,
            None => {
                let now = Instant::now();
                let soonest = left.iter().map(|&i| free_at(CHART_MIRRORS[i].0, Ask::File)).min().unwrap_or(now);
                if soonest.saturating_duration_since(now) > CHART_WAIT {
                    failures.extend(left.iter().map(|&i| format!("{} resting", CHART_MIRRORS[i].0)));
                    break;
                }
                std::thread::sleep(soonest.saturating_duration_since(now).clamp(Duration::from_millis(10), Duration::from_millis(500)));
                continue;
            }
        };
        let (name, url) = CHART_MIRRORS[left[k]];
        if !try_book(name, Ask::File) {
            continue;
        }
        left.remove(k);
        let answer = agent.get(&url(beatmap)).call();
        if let Ok(res) = &answer {
            note_limits(name, res);
        }
        match answer {
            Ok(res) if res.status() == 429 => {
                rest(name, retry_after(&res));
                failures.push(format!("{name} 429"));
            }
            Ok(mut res) if res.status() == 200 => {
                let text = res.body_mut().with_config().limit(32 * 1024 * 1024).read_to_string().unwrap_or_default();
                if text.trim_start_matches('\u{feff}').trim_start().starts_with("osu file format") {
                    return Ok(Some(text));
                }
                missing += 1;
            }
            Ok(res) if matches!(res.status().as_u16(), 404 | 410) => missing += 1,
            Ok(res) => failures.push(format!("{name} {}", res.status().as_u16())),
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    if missing == CHART_MIRRORS.len() || failures.is_empty() {
        return Ok(None);
    }
    Err(Error::known("download-failed", format!("Couldn't get difficulty {beatmap} ({})", failures.join(", "))))
}

/// An agent for many small requests to the mirrors.
pub fn chart_agent() -> ureq::Agent {
    agent(Duration::from_secs(30))
}

fn reasons(why: &[String]) -> String {
    MIRRORS
        .iter()
        .zip(why)
        .filter(|(_, w)| !w.is_empty())
        .map(|(m, w)| format!("{} {}", m.name, w.trim_start_matches("HTTP ")))
        .collect::<Vec<_>>()
        .join(", ")
}

const NOT_ARCHIVE: &str = "not a beatmap archive";

/// How long a "too many requests" answer asks to wait.
pub fn retry_after(res: &ureq::http::Response<ureq::Body>) -> Duration {
    let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    // seconds (an HTTP date is rare here; then the default)
    header("retry-after")
        .and_then(|v| v.parse::<u64>().ok())
        .or_else(|| header("x-ratelimit-reset").and_then(|v| v.parse::<u64>().ok()).filter(|&s| s <= 3600))
        .map(|s| Duration::from_secs(s.max(1)))
        .unwrap_or(REST_AFTER_429)
}

/// Where a redirect from `base` to `location` goes (https only).
fn redirect_target(base: &str, location: &str) -> Option<String> {
    let origin_end = base.find("://").map(|i| i + 3).and_then(|s| base[s..].find('/').map(|j| s + j)).unwrap_or(base.len());
    let target = if location.starts_with("https://") {
        location.to_string()
    } else if let Some(rest) = location.strip_prefix("//") {
        format!("https://{rest}")
    } else if location.starts_with('/') {
        format!("{}{location}", &base[..origin_end])
    } else if location.contains("://") {
        return None;
    } else {
        let path = &base[..base[..base.find('?').unwrap_or(base.len())].rfind('/').map_or(base.len(), |i| i + 1).max(origin_end)];
        format!("{}{}{location}", path, if path.ends_with('/') { "" } else { "/" })
    };
    target.starts_with("https://").then_some(target)
}

fn fetch(agent: &ureq::Agent, mirror: &'static str, url: &str, out: &Path, progress: &mut impl FnMut(Progress) -> bool) -> std::result::Result<(), Outcome> {
    // redirects by hand, so the mirror's own answer (with its limit headers) is seen, not only the
    // storage it sends the file from
    let mut at = url.to_string();
    let mut hops = 0;
    let mut res = loop {
        let res = agent.get(&at).call().map_err(|e| Outcome::Failed(e.to_string()))?;
        if hops == 0 {
            note_limits(mirror, &res);
        }
        if !res.status().is_redirection() {
            break res;
        }
        hops += 1;
        let next = res.headers().get("location").and_then(|v| v.to_str().ok()).and_then(|l| redirect_target(&at, l));
        match next {
            Some(n) if hops <= 5 => at = n,
            _ => return Err(Outcome::Failed(format!("HTTP {} without a usable redirect", res.status().as_u16()))),
        }
    };
    let status = res.status().as_u16();
    match status {
        200 => {}
        429 => return Err(Outcome::Limited(retry_after(&res))),
        404 | 403 | 410 | 451 => return Err(Outcome::Missing(format!("HTTP {status}"))),
        _ => return Err(Outcome::Failed(format!("HTTP {status}"))),
    }
    let total = res.body().content_length();
    if total.is_some_and(|t| t > crate::archive::MAX_DOWNLOAD) {
        return Err(Outcome::Missing(format!("{} MB, too big for a set", total.unwrap_or(0) / 1024 / 1024)));
    }
    let mut reader = res.body_mut().as_reader();
    let mut file = std::fs::File::create(out).map_err(|e| Outcome::Failed(e.to_string()))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    let mut head = [0u8; 4];
    loop {
        let n = reader.read(&mut buf).map_err(|e| Outcome::Failed(e.to_string()))?;
        if n == 0 {
            break;
        }
        if done < 4 {
            let take = (4 - done as usize).min(n);
            head[done as usize..done as usize + take].copy_from_slice(&buf[..take]);
        }
        file.write_all(&buf[..n]).map_err(|e| Outcome::Failed(e.to_string()))?;
        done += n as u64;
        if done > crate::archive::MAX_DOWNLOAD {
            return Err(Outcome::Missing("too big for a set".into()));
        }
        if !progress(Progress::Bytes { done, total }) {
            return Err(Outcome::Cancelled);
        }
    }
    file.flush().map_err(|e| Outcome::Failed(e.to_string()))?;
    if total.is_some_and(|t| t != done) {
        return Err(Outcome::Failed(format!("cut off after {done} of {} bytes", total.unwrap_or(0))));
    }
    // mirrors answer "not found" with JSON or HTML now and then, even with 200
    if &head != b"PK\x03\x04" || done < 1024 {
        return Err(Outcome::Missing(NOT_ARCHIVE.into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        use Target::*;
        let cases = [
            ("https://osu.ppy.sh/beatmapsets/1225016#mania/2549232", Some(Set(1225016))),
            ("https://osu.ppy.sh/beatmapsets/1225016", Some(Set(1225016))),
            ("http://osu.ppy.sh/s/39804", Some(Set(39804))),
            ("https://osu.ppy.sh/b/75", Some(Beatmap(75))),
            ("https://osu.ppy.sh/beatmaps/2549232?mode=mania", Some(Beatmap(2549232))),
            ("https://osu.ppy.sh/p/beatmap?b=75&m=0", Some(Beatmap(75))),
            ("osu://s/39804", Some(Set(39804))),
            ("osu://b/75", Some(Beatmap(75))),
            ("osu://dl/39804", Some(Set(39804))),
            ("  1225016  ", Some(Set(1225016))),
            ("<https://www.osu.ppy.sh/beatmapsets/7>", Some(Set(7))),
            ("https://example.com/beatmapsets/1", None),
            ("https://osu.ppy.sh.example.com/beatmapsets/1", None),
            ("https://osu.ppy.sh/users/2", None),
            ("https://osu.ppy.sh/p/beatmap?b=0", None),
            ("0", None),
            ("hello", None),
            ("", None),
        ];
        for (line, want) in cases {
            assert_eq!(parse_link(line), want, "{line}");
        }
    }

    #[test]
    fn spreads_over_mirrors_and_rests_them() {
        let m = Mirrors::default();
        let fresh = [Tried::No; MIRRORS.len()];
        // three downloads at once go to three mirrors, best first
        let a = m.pick(&fresh).unwrap();
        let b = m.pick(&fresh).unwrap();
        let c = m.pick(&fresh).unwrap();
        assert_eq!((a, b, c), (0, 1, 2));
        m.finished(a, None);
        // the next set goes where fewest sets went
        assert_eq!(m.pick(&fresh), Some(3));
        // a rate limit rests the mirror; sets go elsewhere meanwhile
        m.finished(b, Some(&Outcome::Limited(Duration::from_secs(30))));
        let mut seen = Vec::new();
        while let Some(i) = m.pick(&fresh) {
            seen.push(i);
        }
        assert!(!seen.contains(&1), "{seen:?}");
        // all busy: the next one is free about now; with the others ruled out, when mirror 1 rests
        // until
        assert!(m.next_free(&fresh).unwrap() <= Instant::now());
        let mut only_1 = [Tried::Missing; MIRRORS.len()];
        only_1[1] = Tried::No;
        let free = m.next_free(&only_1).unwrap();
        assert!(free > Instant::now() + Duration::from_secs(25));
        assert_eq!(m.next_free(&[Tried::Missing; MIRRORS.len()]), None);
        // a mirror that failed for a set twice isn't tried for it again
        let mut failed = [Tried::Missing; MIRRORS.len()];
        failed[0] = Tried::Failed(TRIES);
        assert_eq!(m.next_free(&failed), None);
    }

    #[test]
    fn budget_holds_a_mirror_under_its_limit() {
        let start = Instant::now();
        let mut b = Budget::default();
        // 40 downloads in a minute, the 41st waits for the first to drop out of the window
        for k in 0..40 {
            assert!(b.free_at(DOWNLOAD, UNITS_PER_MINUTE, start) <= start, "download {k}");
            b.spent.push_back((start + Duration::from_millis(k * 100), DOWNLOAD));
        }
        assert_eq!(b.free_at(DOWNLOAD, UNITS_PER_MINUTE, start), start + WINDOW);
        // a lookup still fits only when a download's units are free
        assert!(b.free_at(REQUEST, UNITS_PER_MINUTE, start) > start);
        // a lower limit stops earlier
        let mut b = Budget::default();
        b.spent.push_back((start, DOWNLOAD));
        assert_eq!(b.free_at(DOWNLOAD, DOWNLOAD, start), start + WINDOW);
        // a rest wins over a free budget
        let mut b = Budget::default();
        b.rest_until = Some(start + Duration::from_secs(90));
        assert_eq!(b.free_at(REQUEST, UNITS_PER_MINUTE, start), start + Duration::from_secs(90));
    }

    #[test]
    fn rules_from_the_site() {
        let r = parse_rules(r#"{"version":1,"mirrors":{"catboy.best":{"off":true},"nekoha.moe":{"perMinute":10,"lastResort":true},"x":{}}}"#).unwrap();
        let get = |n: &str| r.iter().find(|(m, _)| m == n).map(|(_, r)| *r).unwrap();
        assert_eq!(get("catboy.best"), Rule { off: true, per_minute: None, last_resort: None });
        assert_eq!(get("nekoha.moe"), Rule { off: false, per_minute: Some(10), last_resort: Some(true) });
        assert_eq!(parse_rules("{}").unwrap(), vec![]);
        assert!(parse_rules("not json").is_none());
        // nothing said: what's built in
        assert_eq!(limit("osu.direct"), UNITS_PER_MINUTE);
        assert!(!off("osu.direct"));
    }

    #[test]
    fn slow_mirrors_only_as_last_resort() {
        let slow = MIRRORS.iter().position(|m| m.last_resort).unwrap();
        let m = Mirrors::default();
        let fresh = [Tried::No; MIRRORS.len()];
        // the others all busy: the set waits for them
        let mut seen = Vec::new();
        while let Some(i) = m.pick(&fresh) {
            seen.push(i);
        }
        assert!(!seen.is_empty() && !seen.contains(&slow), "{seen:?}");
        // the others don't have the set: the slow one gets it
        let mut only_slow = [Tried::Missing; MIRRORS.len()];
        only_slow[slow] = Tried::No;
        assert_eq!(m.pick(&only_slow), Some(slow));
        // the others all rest: the slow one too
        let m = Mirrors::default();
        for (i, s) in m.state.lock().unwrap().iter_mut().enumerate() {
            if i != slow {
                s.rest_until = Some(Instant::now() + Duration::from_secs(60));
            }
        }
        assert_eq!(m.pick(&fresh), Some(slow));
    }

    #[test]
    fn refusals_rest_a_mirror_after_a_few() {
        let m = Mirrors::default();
        let only_0 = {
            let mut t = [Tried::Missing; MIRRORS.len()];
            t[0] = Tried::No;
            t
        };
        for _ in 0..REFUSALS_TO_REST - 1 {
            let i = m.pick(&only_0).unwrap();
            m.finished(i, Some(&Outcome::Missing("HTTP 403".into())));
        }
        assert_eq!(m.pick(&only_0), Some(0));
        m.finished(0, Some(&Outcome::Missing("HTTP 403".into())));
        assert_eq!(m.pick(&only_0), None, "three refusals in a row rest the mirror");
    }

    #[test]
    fn user_agent_names_the_app_without_a_url() {
        assert!(USER_AGENT.starts_with("Fumen/"));
        assert!(!USER_AGENT.contains("http") && !USER_AGENT.contains(".com"));
    }

    #[test]
    fn osu_direct_gets_its_own_limits() {
        let start = Instant::now();
        let mut b = Budget::default();
        // 20 requests in 5 s, then the next waits for the first to drop out
        for k in 0..20 {
            assert!(b.caps_free_at(Ask::Request, &OSU_DIRECT, start) <= start, "request {k}");
            b.log.push_back((start, Ask::Request));
        }
        assert_eq!(b.caps_free_at(Ask::Request, &OSU_DIRECT, start), start + Duration::from_secs(5));
        // 180 sets an hour: spread out, so only the hourly cap holds them back
        let mut b = Budget::default();
        for k in 0..180u64 {
            b.log.push_back((start + Duration::from_secs(k * 10), Ask::Set));
        }
        let now = start + Duration::from_secs(1800);
        assert_eq!(b.caps_free_at(Ask::Set, &OSU_DIRECT, now), start + Duration::from_secs(3600));
        // a request or a chart file isn't a set download
        assert!(b.caps_free_at(Ask::File, &OSU_DIRECT, now) <= now);
        // other mirrors only have the budget
        assert!(caps("nekoha.moe").is_empty());
        assert_eq!(caps("osu.direct").len(), 3);
    }

    #[test]
    fn rests_when_the_headers_say_a_limit_is_used_up() {
        let now = 1_795_640_000;
        let with = |pairs: &[(&str, u64)]| {
            let pairs: Vec<(String, u64)> = pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect();
            limits_wait(move |name| pairs.iter().find(|(k, _)| k == name).map(|(_, v)| *v), now)
        };
        // room left: no rest
        assert_eq!(with(&[("x-download-budget-remaining", 197), ("x-download-budget-reset", now + 600), ("x-ratelimit-remaining", 119), ("x-ratelimit-reset", 60)]), None);
        // the hour's downloads used up: until the reset (a unix time)
        assert_eq!(with(&[("x-download-budget-remaining", 0), ("x-download-budget-reset", now + 600)]), Some(Duration::from_secs(600)));
        // the minute's requests used up (seconds from now), and the burst (the longer one counts)
        assert_eq!(with(&[("x-ratelimit-remaining", 0), ("x-ratelimit-reset", 42), ("x-ratelimit-burst-remaining", 0), ("x-ratelimit-burst-reset", 5)]), Some(Duration::from_secs(42)));
        // under 256 MB left today: until the day is over
        assert_eq!(with(&[("x-download-budget-bytes-remaining", 1000), ("x-download-budget-bytes-reset", now + 7200)]), Some(Duration::from_secs(7200)));
    }

    #[test]
    fn redirects_stay_on_https() {
        let base = "https://osu.direct/api/d/39804";
        assert_eq!(redirect_target(base, "https://storage.osu.direct/a.osz?x=1").as_deref(), Some("https://storage.osu.direct/a.osz?x=1"));
        assert_eq!(redirect_target(base, "/d/39804").as_deref(), Some("https://osu.direct/d/39804"));
        assert_eq!(redirect_target(base, "//cdn.example/x").as_deref(), Some("https://cdn.example/x"));
        assert_eq!(redirect_target(base, "file.osz").as_deref(), Some("https://osu.direct/api/d/file.osz"));
        assert_eq!(redirect_target(base, "http://plain.example/x"), None);
    }

    /// The mirrors and lookups answer with this user agent (needs the internet).
    #[test]
    #[ignore]
    fn mirrors_answer() {
        assert_eq!(set_of_beatmap(75).unwrap(), 1);
        let dir = std::env::temp_dir().join(format!("fumen-mirrors-{}", std::process::id()));
        // FUMEN_MIRRORS=osu.direct,nekoha.moe: only those
        let only = std::env::var("FUMEN_MIRRORS").ok();
        for mirror in MIRRORS.iter().filter(|m| only.as_ref().is_none_or(|o| o.split(',').any(|n| n == m.name))) {
            let out = dir.join(format!("{}.part", mirror.name));
            std::fs::create_dir_all(&dir).unwrap();
            let r = fetch(&download_agent(Duration::from_secs(120)), mirror.name, &(mirror.url)(1), &out, &mut |_| true);
            println!("{}: {r:?}", mirror.name);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
