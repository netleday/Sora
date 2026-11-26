//! vibro.rs — osu!mania charts, or parts of them, that no hand plays as written.
//!
//! Some charts are "vibro": jacks, trills, walls or rolls past what fingers can do, so they get
//! mashed rather than read, and MinaCalc rates them as if every note were hit. Those are the
//! charts that get farmed. This finds them from the notes alone, at the rate played (never from
//! titles, mappers or star ratings), and says what a pass there is worth for the skills:
//!
//! - clean: rated as is;
//! - adjusted: the parts past a human hand are a small share, so they're cut out (no time
//!   stitching) and the rest is rated, with all the accuracy lost put on what's left
//!   (`kept_accuracy`);
//! - excluded: too much of it, the pass doesn't count;
//! - unrateable: built from what the calculator can't follow at all (jumptrills, notes stacked on
//!   one column, chords written as notes a few ms apart), doesn't count either.
//!
//! A port of mania-tracker's vibro detection (github.com/Manolo-dl/mania-hub,
//! `algorithms/vibro/sections.ts`, `motion.ts`, `detection.ts` at VIBRO_SECTION_VERSION 11, and
//! the stacked-head rule of `classification/dan-eligibility.ts`; MIT, © 2026 aleju03; see
//! THIRD_PARTY.md). Every threshold is theirs, measured on their corpus. Times are the file's ms;
//! gaps are compared against limits scaled by the rate (a gap of g at 1.5× lasts g / 1.5).
//! Where Fumen differs: the wide-keymode jumptrill rule also runs on 6K and 7K (mania-tracker
//! rates those with its own calculator), and charts outside the section scan (4K with many holds,
//! 5K and up) get the rate check at every rate, where mania-tracker trusts ranked charts at 1×.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::chart::{Chart, Kind};

/// Bump when the verdicts can come out differently (osu_scores.rs reworks the SSRs then).
pub const VERSION: i64 = 11_01;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum Reason {
    RepeatedWall,
    SustainedJack,
    RepeatedJackStream,
    RepeatedChord,
    RapidJackBurst,
    IsolatedJack,
    FastRoll,
    ExtremeDensity,
    SplitHandDouble,
    FingerRateCeiling,
    HandActionCeiling,
    FourKeyCycle,
    LockedHands,
    FastTrill,
    Jumptrill,
    StackedHeads,
    FlamChords,
    SustainedDensity,
}

/// Reasons that make a chart unrateable rather than vibro.
const UNRATEABLE: [Reason; 3] = [Reason::Jumptrill, Reason::StackedHeads, Reason::FlamChords];

#[derive(Debug, Clone)]
struct Section {
    start: f64,
    end: f64,
    reasons: Vec<Reason>,
}

impl Section {
    fn new(start: f64, end: f64, reason: Reason) -> Section {
        Section { start, end, reasons: vec![reason] }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Status {
    Clean,
    Adjusted,
    Excluded,
}

#[derive(Debug, Clone)]
struct Analysis {
    status: Status,
    sections: Vec<Section>,
    excluded_ms: f64,
    active_ms: f64,
    time_share: f64,
    note_share: f64,
    judgement_share: f64,
    remaining: i64,
    repeat_share: f64,
    shares: BTreeMap<Reason, f64>,
}

impl Analysis {
    fn clean(notes: usize) -> Analysis {
        Analysis {
            status: Status::Clean,
            sections: Vec::new(),
            excluded_ms: 0.0,
            active_ms: 0.0,
            time_share: 0.0,
            note_share: 0.0,
            judgement_share: 0.0,
            remaining: notes as i64,
            repeat_share: 0.0,
            shares: BTreeMap::new(),
        }
    }

    /// The whole chart out for one reason.
    fn whole(active_ms: f64, start: f64, end: f64, reason: Reason) -> Analysis {
        Analysis {
            status: Status::Excluded,
            sections: vec![Section::new(start, end, reason)],
            excluded_ms: active_ms,
            active_ms,
            time_share: 1.0,
            note_share: 1.0,
            judgement_share: 1.0,
            remaining: 0,
            repeat_share: 0.0,
            shares: BTreeMap::from([(reason, 1.0)]),
        }
    }

    fn unrateable(&self) -> bool {
        self.status == Status::Excluded && !self.shares.is_empty() && self.shares.keys().all(|r| UNRATEABLE.contains(r))
    }
}

/// What a pass at a rate is worth for the skills.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Clean,
    /// a small share past a human hand: these spans (file ms) are cut, the rest is rated with the
    /// accuracy lost on `judgement_share` of the judgements put on the rest
    Adjusted { sections: Vec<(f64, f64)>, judgement_share: f64 },
    /// vibro: doesn't count
    Excluded,
    /// nothing a hand can't do, the calculator just can't follow it: doesn't count
    Unrateable,
}

impl Verdict {
    /// As stored with a play's SSR: 0 clean, 1 adjusted, 2 vibro, 3 unrateable.
    pub fn code(&self) -> u8 {
        match self {
            Verdict::Clean => 0,
            Verdict::Adjusted { .. } => 1,
            Verdict::Excluded => 2,
            Verdict::Unrateable => 3,
        }
    }

    /// What the frontend calls a code (`code`); None for clean.
    pub fn label(code: u8) -> Option<&'static str> {
        match code {
            1 => Some("adjusted"),
            2 => Some("vibro"),
            3 => Some("unrateable"),
            _ => None,
        }
    }
}

/* ---------- the chart as notes ---------- */

#[derive(Debug, Clone, Copy)]
struct Note {
    time: f64,
    end: f64,
    col: usize,
    hold: bool,
}

struct Map {
    keys: usize,
    notes: Vec<Note>,
}

impl Map {
    fn of(chart: &Chart) -> Option<Map> {
        if chart.mode != 3 || chart.keys < 4 || chart.keys > 18 {
            return None;
        }
        let keys = chart.keys as usize;
        let mut notes: Vec<Note> = chart
            .objects
            .iter()
            .map(|o| {
                let hold = o.kind == Kind::Hold;
                Note { time: o.time as f64, end: if hold { o.end.max(o.time) as f64 } else { o.time as f64 }, col: (o.lane as usize).min(keys - 1), hold }
            })
            .collect();
        notes.sort_by(|a, b| a.time.total_cmp(&b.time));
        (!notes.is_empty()).then_some(Map { keys, notes })
    }

    fn holds(&self) -> usize {
        self.notes.iter().filter(|n| n.hold).count()
    }
}

/// The rows: each moment with a note, the columns that start there, and the notes before each.
#[derive(Clone)]
struct Scan {
    times: Vec<f64>,
    rows: Vec<u32>,
    prefix: Vec<usize>,
    rate: f64,
}

impl Scan {
    fn of<'a>(notes: impl Iterator<Item = &'a Note>, rate: f64) -> Scan {
        let mut masks: BTreeMap<i64, u32> = BTreeMap::new();
        for n in notes {
            *masks.entry(n.time as i64).or_insert(0) |= 1 << n.col.min(31);
        }
        let times: Vec<f64> = masks.keys().map(|&t| t as f64).collect();
        let rows: Vec<u32> = masks.values().copied().collect();
        let mut prefix = Vec::with_capacity(rows.len() + 1);
        prefix.push(0);
        for m in &rows {
            prefix.push(prefix.last().unwrap() + pc(*m));
        }
        Scan { times, rows, prefix, rate }
    }

    fn total(&self) -> usize {
        *self.prefix.last().unwrap_or(&0)
    }

    fn len(&self) -> usize {
        self.times.len()
    }

    /// The rows column `col` has a note in.
    fn column(&self, col: usize) -> Vec<usize> {
        (0..self.len()).filter(|&i| self.rows[i] & (1 << col) != 0).collect()
    }
}

/// What the scans find: sections past a human hand, and short repetitions that only count when
/// they keep coming back (`recurring_repetitions`).
#[derive(Default)]
struct Found {
    intervals: Vec<Section>,
    bursts: Vec<Section>,
}

impl Found {
    fn add(&mut self, start: f64, end: f64, reason: Reason) {
        if end > start {
            self.intervals.push(Section::new(start, end, reason));
        }
    }
}

fn pc(mask: u32) -> usize {
    mask.count_ones() as usize
}

fn lower_bound(values: &[f64], target: f64) -> usize {
    values.partition_point(|&v| v < target)
}

/// Time with notes going on, in real ms: gaps count at most a second.
fn active_ms(s: &Scan) -> f64 {
    (1..s.len()).map(|i| (s.times[i] - s.times[i - 1]).min(1000.0 * s.rate) / s.rate).sum()
}

fn merge(mut sections: Vec<Section>, touching: bool) -> Vec<Section> {
    sections.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut out: Vec<Section> = Vec::new();
    for s in sections {
        match out.last_mut() {
            Some(p) if s.start < p.end || (touching && s.start == p.end) => {
                p.end = p.end.max(s.end);
                for r in s.reasons {
                    if !p.reasons.contains(&r) {
                        p.reasons.push(r);
                    }
                }
            }
            _ => out.push(s),
        }
    }
    out
}

fn shares(intervals: &[Section], rate: f64, active: f64) -> BTreeMap<Reason, f64> {
    let mut out = BTreeMap::new();
    if active <= 0.0 {
        return out;
    }
    let mut by: BTreeMap<Reason, Vec<Section>> = BTreeMap::new();
    for s in intervals {
        for r in &s.reasons {
            by.entry(*r).or_default().push(s.clone());
        }
    }
    for (r, group) in by {
        let covered: f64 = merge(group, true).iter().map(|m| (m.end - m.start) / rate).sum();
        out.insert(r, covered / active);
    }
    out
}

fn overlaps(start: f64, end: f64, sections: &[Section]) -> bool {
    let low = sections.partition_point(|s| s.end < start);
    low < sections.len() && sections[low].start <= end
}

/* ---------- unrateable charts ---------- */

/// osu!mania can't tell this many notes on one column at one moment apart (mania-tracker's dan
/// eligibility rule).
const STACKED_HEAD_MIN: usize = 8;

fn stacked_heads(map: &Map, rate: f64) -> Option<Analysis> {
    let mut heads: HashMap<(usize, i64), usize> = HashMap::new();
    for n in &map.notes {
        *heads.entry((n.col, n.time as i64)).or_insert(0) += 1;
    }
    if heads.values().copied().max().unwrap_or(0) < STACKED_HEAD_MIN {
        return None;
    }
    let active = active_ms(&Scan::of(map.notes.iter(), rate));
    let first = map.notes.iter().map(|n| n.time).fold(f64::INFINITY, f64::min);
    let last = map.notes.iter().map(|n| n.time).fold(f64::NEG_INFINITY, f64::max);
    Some(Analysis::whole(active, first, last, Reason::StackedHeads))
}

const FLAM_PRESS_MS: f64 = 40.0;
const FLAM_FINGER_FREE_MS: f64 = 100.0;
const FLAM_CHART_SHARE: f64 = 0.3;

/// 4K: chords written as rows a few ms apart that a player strikes together, holding a large
/// share of the notes.
fn collapsed_notes(map: &Map, rate: f64) -> Option<Analysis> {
    if map.keys != 4 {
        return None;
    }
    let taps = Scan::of(map.notes.iter().filter(|n| !n.hold), rate);
    if taps.len() == 0 || (flam_chord_notes(&taps) as f64) < map.notes.len() as f64 * FLAM_CHART_SHARE {
        return None;
    }
    let s = Scan::of(map.notes.iter(), rate);
    Some(Analysis::whole(active_ms(&s), s.times[0], *s.times.last().unwrap(), Reason::FlamChords))
}

fn flam_chord_notes(s: &Scan) -> usize {
    let (times, rows, prefix, rate) = (&s.times, &s.rows, &s.prefix, s.rate);
    let n = times.len();
    let mut next_on = vec![f64::INFINITY; n];
    let mut next_col = [f64::INFINITY; 4];
    for i in (0..n).rev() {
        let mut next = f64::INFINITY;
        for (c, at) in next_col.iter_mut().enumerate() {
            if rows[i] & (1 << c) == 0 {
                continue;
            }
            next = next.min(*at);
            *at = times[i];
        }
        next_on[i] = next;
    }
    let mut flam = 0;
    let mut start = 0;
    let mut mask = rows[0];
    let close = |start: usize, end: usize, flam: &mut usize| {
        if end - start < 2 {
            return;
        }
        if (start..end).any(|k| prefix[k + 1] - prefix[k] < 2) {
            return;
        }
        *flam += prefix[end] - prefix[start];
    };
    for i in 1..n {
        let mut joins = times[i] - times[start] <= FLAM_PRESS_MS * rate && rows[i] & mask == 0;
        let mut k = start;
        while joins && k < i {
            joins = next_on[k] - times[i] >= FLAM_FINGER_FREE_MS * rate;
            k += 1;
        }
        if joins {
            mask |= rows[i];
            continue;
        }
        close(start, i, &mut flam);
        start = i;
        mask = rows[i];
    }
    close(start, n, &mut flam);
    flam
}

/// The section scan's charts: 4K with at most 10% holds.
fn uses_sections(map: &Map) -> bool {
    map.keys == 4 && map.holds() as f64 / map.notes.len() as f64 <= 0.1
}

/* ---------- the section scan (4K rice) ---------- */

fn analyze_sections(map: &Map, rate: f64) -> Analysis {
    let mut r = Analysis::clean(map.notes.len());
    if !uses_sections(map) {
        return r;
    }
    if let Some(u) = stacked_heads(map, rate).or_else(|| collapsed_notes(map, rate)) {
        return u;
    }
    let s = Scan::of(map.notes.iter(), rate);
    r.active_ms = active_ms(&s);
    let mut f = Found::default();
    for (start, end, reason) in motion(map, &s) {
        f.add(start, end, reason);
    }
    repeated_rows(&s, &mut f);
    quad_body(&s, &mut f);
    locked_hands(&s, &mut f);
    fast_trills(&s, &mut f);
    jumptrills(&s, &mut f);
    hammered_chords(&s, &mut f);
    one_finger_body(&s, &mut f);
    repeated_jack_streams(&s, &mut f);
    repeated_pairs(&s, &mut f);
    fixed_finger_windows(&s, &mut f);
    isolated_jacks(&s, &mut f);
    let returns = fast_finger_returns(&s, 70.0);
    fast_rolls(&s, &mut f, &returns);
    extreme_density(&s, &mut f);
    sustained_density(&s, &mut f);
    recurring_repetitions(&s, &mut f);
    r.shares = shares(&f.intervals, rate, r.active_ms);
    r.sections = merge(f.intervals, true);
    if !r.sections.is_empty() {
        coverage(&mut r, map, &s);
    }
    r
}

/// Rows `matches` links to the one before, in runs of at least `min` links.
fn consecutive(s: &Scan, f: &mut Found, min: usize, reason: Reason, matches: impl Fn(usize) -> bool) {
    let n = s.len();
    let mut start = 1;
    for i in 1..=n {
        if i < n && matches(i) {
            continue;
        }
        if i >= start && i - start >= min {
            f.add(s.times[start - 1], s.times[i - 1], reason);
        }
        start = i + 1;
    }
}

const REPEATED_QUAD_GAP_MS: f64 = 95.0;
const SLOW_QUAD_MIN_ROWS: usize = 24;
const REPEATED_ROW_GAP_MS: f64 = 92.0;
const SLOW_QUAD_GAP_MS: f64 = 105.0;
const RECURRING_REPETITION_GAP_MS: f64 = 80.0;

fn repeated_row_gap(mask: u32) -> f64 {
    if mask == 15 { REPEATED_QUAD_GAP_MS } else { REPEATED_ROW_GAP_MS }
}

fn idle_quad_walls(s: &Scan, f: &mut Found) {
    let (times, rows, rate, n) = (&s.times, &s.rows, s.rate, s.len());
    let mut idle: Vec<(f64, f64)> = Vec::new();
    let mut start: Option<usize> = None;
    for i in 0..=n {
        let quad = i < n && rows[i] == 15;
        if quad && start.is_some() && times[i] - times[i - 1] <= SLOW_QUAD_GAP_MS * rate {
            continue;
        }
        if let Some(st) = start {
            if i - st >= 12 {
                let (mut active, mut context) = (0, 0);
                let mut count = |k: usize| {
                    context += 1;
                    if pc(rows[k]) >= 2 && rows[k] != rows[k - 1] {
                        active += 1;
                    }
                };
                for k in st.saturating_sub(16).max(1)..st {
                    count(k);
                }
                for k in i..n.min(i + 16) {
                    count(k);
                }
                if context > 0 && (active as f64) / (context as f64) < 0.4 {
                    idle.push((times[st], times[i - 1]));
                }
            }
        }
        start = quad.then_some(i);
    }
    if idle.len() < 2 {
        return;
    }
    for (a, b) in idle {
        f.add(a, b, Reason::RepeatedWall);
    }
}

fn repeated_rows(s: &Scan, f: &mut Found) {
    let (times, rows, rate) = (&s.times, &s.rows, s.rate);
    consecutive(s, f, 11, Reason::RepeatedWall, |i| {
        rows[i] == rows[i - 1] && pc(rows[i]) >= 2 && times[i] - times[i - 1] <= repeated_row_gap(rows[i]) * rate
    });
    consecutive(s, f, SLOW_QUAD_MIN_ROWS - 1, Reason::RepeatedWall, |i| {
        rows[i] == 15 && rows[i - 1] == 15 && times[i] - times[i - 1] <= SLOW_QUAD_GAP_MS * rate
    });
    idle_quad_walls(s, f);
    consecutive(s, f, 24, Reason::SustainedJack, |i| rows[i] == rows[i - 1] && times[i] - times[i - 1] <= 92.0 * rate);
}

/// Runs of quads at most `gap` ms apart and at least `min_rows` long: (first row, last row).
fn quad_walls(s: &Scan, gap: f64, min_rows: usize) -> Vec<(usize, usize)> {
    let (times, rows, n) = (&s.times, &s.rows, s.len());
    let mut walls = Vec::new();
    let mut start: Option<usize> = None;
    for i in 0..=n {
        let quad = i < n && rows[i] == 15;
        if quad && start.is_some() && times[i] - times[i - 1] <= gap * s.rate {
            continue;
        }
        if let Some(st) = start {
            if i - st >= min_rows {
                walls.push((st, i - 1));
            }
        }
        start = quad.then_some(i);
    }
    walls
}

fn quad_body(s: &Scan, f: &mut Found) {
    for (gap, min_rows, share) in [(125.0, 12, 0.25), (100.0, 3, 0.3)] {
        let walls = quad_walls(s, gap, min_rows);
        let notes: usize = walls.iter().map(|(a, b)| (b - a + 1) * 4).sum();
        if (notes as f64) < s.total() as f64 * share {
            continue;
        }
        for (a, b) in walls {
            f.add(s.times[a], s.times[b], Reason::RepeatedWall);
        }
    }
}

fn locked_hands(s: &Scan, f: &mut Found) {
    let (times, rows, prefix, rate, n) = (&s.times, &s.rows, &s.prefix, s.rate, s.len());
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut run_notes = 0;
    let mut start: Option<usize> = None;
    for i in 0..=n {
        let locked = i < n && (rows[i] == 3 || rows[i] == 12 || rows[i] == 15);
        if locked && start.is_some() && rows[i] & rows[i - 1] != 0 && times[i] - times[i - 1] <= 95.0 * rate {
            continue;
        }
        if let Some(st) = start {
            if i - st >= 24 {
                let left = (st..i).any(|k| rows[k] == 3);
                let right = (st..i).any(|k| rows[k] == 12);
                if left && right {
                    runs.push((st, i - 1));
                    run_notes += prefix[i] - prefix[st];
                }
            }
        }
        start = locked.then_some(i);
    }
    let body = run_notes as f64 >= s.total() as f64 * 0.4;
    for (a, b) in runs {
        if body || b - a + 1 >= 64 {
            f.add(times[a], times[b], Reason::LockedHands);
        }
    }
}

fn fast_trills(s: &Scan, f: &mut Found) {
    let (times, rows, rate, n) = (&s.times, &s.rows, s.rate, s.len());
    let single = |m: u32| m != 0 && m & (m - 1) == 0;
    let mut start = 0;
    let mut returns = 0;
    for i in 1..=n {
        if i < n && single(rows[i]) && single(rows[i - 1]) && rows[i] != rows[i - 1] && times[i] - times[i - 1] <= 45.0 * rate {
            if i - start >= 2 && rows[i] == rows[i - 2] {
                returns += 1;
            }
            continue;
        }
        let length = i - start;
        if length >= 48 && returns as f64 >= (length as f64 - 2.0) * 0.8 {
            f.add(times[start], times[i - 1], Reason::FastTrill);
        }
        start = i;
        returns = 0;
    }
}

const JUMPTRILL_PRESS_MS: f64 = 30.0;
const JUMPTRILL_GAP_MS: f64 = 65.0;
const JUMPTRILL_CHART_SHARE: f64 = 0.3;

fn jumptrills(s: &Scan, f: &mut Found) {
    let (bursts, notes) = jumptrill_bursts(s, [0b0011, 0b1100], None, JUMPTRILL_GAP_MS);
    if notes as f64 >= s.total() as f64 * JUMPTRILL_CHART_SHARE {
        f.intervals.extend(bursts);
    }
}

/// Runs of presses alternating between the hands (`hands`: each hand's columns; an odd keymode's
/// middle column joins the hand it's pressed with), mostly with the whole hand.
fn jumptrill_bursts(s: &Scan, hands: [u32; 2], middle: Option<usize>, gap: f64) -> (Vec<Section>, usize) {
    struct Press {
        start: f64,
        end: f64,
        hand: usize,
        mask: u32,
    }
    let (times, rows, rate) = (&s.times, &s.rows, s.rate);
    let mid = middle.map_or(0, |c| 1u32 << c);
    let mut presses: Vec<Press> = Vec::new();
    let mut open: [Option<usize>; 2] = [None, None];
    for i in 0..s.len() {
        let mut sides = [rows[i] & hands[0], rows[i] & hands[1]];
        if rows[i] & mid != 0 {
            if sides[0] != 0 && sides[1] == 0 {
                sides[0] |= mid;
            } else if sides[1] != 0 && sides[0] == 0 {
                sides[1] |= mid;
            } else if sides[0] == 0 && sides[1] == 0 {
                let hand = (0..2).find(|&h| open[h].is_some_and(|p| times[i] - presses[p].start <= JUMPTRILL_PRESS_MS * rate && presses[p].mask & mid == 0));
                if let Some(h) = hand {
                    sides[h] |= mid;
                }
            }
        }
        for (hand, &bits) in sides.iter().enumerate() {
            if bits == 0 {
                continue;
            }
            if let Some(p) = open[hand] {
                let press = &mut presses[p];
                if times[i] - press.start <= JUMPTRILL_PRESS_MS * rate && press.mask & bits == 0 {
                    press.mask |= bits;
                    press.end = times[i];
                    continue;
                }
            }
            presses.push(Press { start: times[i], end: times[i], hand, mask: bits });
            open[hand] = Some(presses.len() - 1);
        }
    }
    let mut bursts = Vec::new();
    let mut notes = 0;
    let mut start = 0;
    let full = |p: &Press| p.mask & hands[p.hand] == hands[p.hand];
    for i in 1..=presses.len() {
        if i < presses.len() && presses[i].hand != presses[i - 1].hand && presses[i].start - presses[i - 1].start <= gap * rate {
            continue;
        }
        let run = &presses[start..i];
        if run.len() >= 8 && run.iter().filter(|&p| full(p)).count() as f64 >= run.len() as f64 * 0.75 {
            bursts.push(Section::new(run[0].start, run[run.len() - 1].end, Reason::Jumptrill));
            notes += run.iter().map(|p| pc(p.mask)).sum::<usize>();
        }
        start = i;
    }
    (bursts, notes)
}

fn hammered_chords(s: &Scan, f: &mut Found) {
    let (times, rows, rate, n) = (&s.times, &s.rows, s.rate, s.len());
    let mut start = 0;
    for i in 1..=n {
        if i < n && pc(rows[i]) >= 3 && pc(rows[i - 1]) >= 3 && times[i] - times[i - 1] <= 92.0 * rate {
            continue;
        }
        if i - start >= 24 && pc(rows[start]) >= 3 {
            let mut in_runs = 0;
            let mut run_start = start;
            for k in start + 1..=i {
                if k < i && rows[k] == rows[k - 1] {
                    continue;
                }
                if k - run_start >= 4 && pc(rows[run_start]) == 3 {
                    in_runs += k - run_start;
                }
                run_start = k;
            }
            if in_runs as f64 >= (i - start) as f64 * 0.66 {
                f.add(times[start], times[i - 1], Reason::RepeatedChord);
            }
        }
        start = i;
    }
}

fn one_finger_body(s: &Scan, f: &mut Found) {
    let (times, prefix, rate, n) = (&s.times, &s.prefix, s.rate, s.len());
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut covered = vec![false; n];
    for col in 0..4 {
        let idx = s.column(col);
        let mut start = 0;
        for i in 1..=idx.len() {
            if i < idx.len() && times[idx[i]] - times[idx[i - 1]] <= 90.0 * rate {
                continue;
            }
            let count = (i - start) as f64;
            let (first, last) = (idx[start], idx[i - 1]);
            if count >= 7.0 && count / (last - first + 1) as f64 >= 0.9 && count / (prefix[last + 1] - prefix[first]) as f64 >= 0.4 {
                runs.push((first, last));
                covered[first..=last].fill(true);
            }
            start = i;
        }
    }
    let notes: usize = (0..n).filter(|&i| covered[i]).map(|i| prefix[i + 1] - prefix[i]).sum();
    if (notes as f64) < s.total() as f64 * 0.25 {
        return;
    }
    for (a, b) in runs {
        f.add(times[a], times[b], Reason::IsolatedJack);
    }
}

fn repeated_jack_streams(s: &Scan, f: &mut Found) {
    const WINDOW: usize = 64;
    let (times, rows, rate, n) = (&s.times, &s.rows, s.rate, s.len());
    let mut burst_rows = vec![0i32; n];
    let mut burst_shapes = vec![0usize; n];
    let mut repeat_start = 0;
    let mut max_gap: f64 = 0.0;
    for i in 1..=n {
        if i < n && rows[i] == rows[i - 1] && times[i] - times[i - 1] <= 100.0 * rate {
            max_gap = max_gap.max(times[i] - times[i - 1]);
            continue;
        }
        let count = i - repeat_start;
        if (3..12).contains(&count) && max_gap <= repeated_row_gap(rows[repeat_start]) * rate {
            burst_rows[repeat_start..i].fill(1);
            burst_shapes[repeat_start..i].fill(rows[repeat_start] as usize & 15);
        }
        repeat_start = i;
        max_gap = 0.0;
    }
    let chord = |i: usize| (burst_rows[i] == 1 && pc(rows[i]) >= 2) as i32;
    let mut fast_start = 0;
    let (mut repeated, mut chords) = (0, 0);
    let mut shape_counts = [0i32; 16];
    let mut distinct = 0;
    for i in 0..n {
        if i > 0 && times[i] - times[i - 1] > 100.0 * rate {
            fast_start = i;
        }
        repeated += burst_rows[i];
        chords += chord(i);
        if burst_shapes[i] != 0 {
            if shape_counts[burst_shapes[i]] == 0 {
                distinct += 1;
            }
            shape_counts[burst_shapes[i]] += 1;
        }
        if i >= WINDOW {
            let o = i - WINDOW;
            repeated -= burst_rows[o];
            chords -= chord(o);
            if burst_shapes[o] != 0 {
                shape_counts[burst_shapes[o]] -= 1;
                if shape_counts[burst_shapes[o]] == 0 {
                    distinct -= 1;
                }
            }
        }
        if i + 1 >= fast_start + WINDOW && repeated as f64 / WINDOW as f64 >= 0.7 && chords as f64 / WINDOW as f64 >= 0.35 && distinct >= 2 {
            f.add(times[i + 1 - WINDOW], times[i], Reason::RepeatedJackStream);
        }
    }
}

fn repeated_pairs(s: &Scan, f: &mut Found) {
    let (times, rows, rate) = (&s.times, &s.rows, s.rate);
    for pair in [3u32, 5, 6, 9, 10, 12] {
        consecutive(s, f, 11, Reason::RepeatedChord, |i| rows[i] & pair == pair && rows[i - 1] & pair == pair && times[i] - times[i - 1] <= 70.0 * rate);
    }
}

struct Band {
    gap: f64,
    average: f64,
    min_hits: usize,
    min_share: f64,
    reason: Reason,
}

const SINGLE_FINGER_BANDS: [Band; 2] = [
    Band { gap: 30.0, average: 30.0, min_hits: 4, min_share: 0.0, reason: Reason::RapidJackBurst },
    Band { gap: 85.0, average: 55.0, min_hits: 9, min_share: 0.0, reason: Reason::RapidJackBurst },
];
const PAIR_BANDS: [Band; 3] = [
    Band { gap: 55.0, average: 55.0, min_hits: 4, min_share: 0.0, reason: Reason::RapidJackBurst },
    Band { gap: 60.0, average: 60.0, min_hits: 6, min_share: 0.0, reason: Reason::RapidJackBurst },
    Band { gap: 92.0, average: 92.0, min_hits: 12, min_share: 0.7, reason: Reason::RepeatedChord },
];
const QUAD_BANDS: [Band; 1] = [Band { gap: 92.0, average: 92.0, min_hits: 8, min_share: 0.0, reason: Reason::RepeatedWall }];
const PAIR_LOCK_GAP_MS: f64 = 85.0;

fn fixed_finger_windows(s: &Scan, f: &mut Found) {
    let (times, rows, prefix, rate) = (&s.times, &s.rows, &s.prefix, s.rate);
    for mask in [1u32, 2, 4, 8, 3, 5, 6, 9, 10, 12, 15] {
        let fingers = pc(mask);
        let idx: Vec<usize> = (0..s.len()).filter(|&i| rows[i] & mask == mask).collect();
        let bands: &[Band] = match fingers {
            1 => &SINGLE_FINGER_BANDS,
            4 => &QUAD_BANDS,
            _ => &PAIR_BANDS,
        };
        for band in bands {
            let pairish = fingers == 2 && band.min_share > 0.0;
            let mut phrase_start = 0;
            let mut phrase_end = 0;
            for i in 0..idx.len() {
                if i > 0 && times[idx[i]] - times[idx[i - 1]] > band.gap * rate {
                    phrase_start = i;
                }
                if pairish && i == phrase_start {
                    phrase_end = i;
                    while phrase_end + 1 < idx.len() && times[idx[phrase_end + 1]] - times[idx[phrase_end]] <= band.gap * rate {
                        phrase_end += 1;
                    }
                }
                if i + 1 < band.min_hits || i + 1 - band.min_hits < phrase_start {
                    continue;
                }
                let (first, last) = (idx[i + 1 - band.min_hits], idx[i]);
                if times[last] - times[first] > (band.min_hits - 1) as f64 * band.average * rate {
                    continue;
                }
                let local = (prefix[last + 1] - prefix[first]) as f64;
                if pairish {
                    let locked = (times[last] - times[first]) / (last - first) as f64 <= PAIR_LOCK_GAP_MS * rate;
                    let held = (first..=last).filter(|&r| if locked { rows[r] & mask == mask } else { rows[r] == mask }).count();
                    let phrase_hits = phrase_end - phrase_start + 1;
                    let phrase_notes = (prefix[idx[phrase_end] + 1] - prefix[idx[phrase_start]]) as f64;
                    let sustained = phrase_hits >= 25 && (phrase_hits * fingers) as f64 / phrase_notes >= band.min_share;
                    if !sustained && (held as f64) / ((last - first + 1) as f64) < 2.0 / 3.0 {
                        continue;
                    }
                }
                if (band.min_hits * fingers) as f64 / local >= band.min_share {
                    f.add(times[first], times[last], band.reason);
                }
            }
        }
        short_repetitions(s, f, &idx, fingers);
    }
}

fn short_repetitions(s: &Scan, f: &mut Found, idx: &[usize], fingers: usize) {
    let (times, prefix, rate) = (&s.times, &s.prefix, s.rate);
    let min_hits = if fingers == 1 { 6 } else { 4 };
    let max_hits = match fingers {
        1 => 24,
        2 => 11,
        _ => 7,
    };
    let reason = match fingers {
        1 => Reason::IsolatedJack,
        2 => Reason::RepeatedChord,
        _ => Reason::RepeatedWall,
    };
    let mut start = 0;
    for end in 1..=idx.len() {
        if end < idx.len() && times[idx[end]] - times[idx[end - 1]] <= 100.0 * rate {
            continue;
        }
        let hits = end - start;
        if (min_hits..=max_hits).contains(&hits) {
            for i in start + min_hits - 1..end {
                let (first, last) = (idx[i + 1 - min_hits], idx[i]);
                if times[last] - times[first] > (min_hits - 1) as f64 * RECURRING_REPETITION_GAP_MS * rate {
                    continue;
                }
                let share = (min_hits * fingers) as f64 / (prefix[last + 1] - prefix[first]) as f64;
                let skip = if fingers == 1 { share <= 0.5 || (min_hits as f64) / ((last - first + 1) as f64) < 0.9 } else { fingers == 2 && share < 2.0 / 3.0 };
                if !skip {
                    f.bursts.push(Section::new(times[first], times[last], reason));
                }
            }
        }
        start = end;
    }
}

fn isolated_jacks(s: &Scan, f: &mut Found) {
    let (times, prefix, rate) = (&s.times, &s.prefix, s.rate);
    let mut bursts: Vec<Section> = Vec::new();
    let mut slower: Vec<(Section, usize)> = Vec::new();
    let mut burst_notes = 0;
    for col in 0..4 {
        let idx = s.column(col);
        let mut start = 0;
        for i in 1..=idx.len() {
            if i < idx.len() && times[idx[i]] - times[idx[i - 1]] <= 100.0 * rate {
                continue;
            }
            let count = i - start;
            if count >= 9 {
                let (first, last) = (idx[start], idx[i - 1]);
                let c = count as f64;
                let local = (prefix[last + 1] - prefix[first]) as f64;
                let rows_spanned = (last - first + 1) as f64;
                let dominant = c / local >= 0.65;
                let average = (times[last] - times[first]) / (c - 1.0);
                let long_run = count >= 25 && average <= 92.0 * rate;
                let accompanied = long_run && c / local > 0.5 && c / rows_spanned >= 0.9;
                if !long_run && count >= 25 && average <= 100.0 * rate && c / local > 0.5 && c / rows_spanned >= 0.9 {
                    slower.push((Section::new(times[first], times[last], Reason::IsolatedJack), col));
                }
                if dominant || accompanied {
                    let section = Section::new(times[first], times[last], Reason::IsolatedJack);
                    if dominant {
                        bursts.push(section.clone());
                        burst_notes += count;
                    }
                    if long_run {
                        f.intervals.push(section);
                    }
                }
            }
            start = i;
        }
    }
    if bursts.len() >= 4 && burst_notes as f64 / s.total() as f64 >= 0.2 {
        f.intervals.extend(bursts);
    }
    let walls: Vec<Section> = merge(
        f.intervals.iter().filter(|x| x.reasons.contains(&Reason::RepeatedWall) || x.reasons.contains(&Reason::RepeatedChord)).cloned().collect(),
        true,
    )
    .into_iter()
    .filter(|w| w.end - w.start >= 1000.0 * rate)
    .collect();
    slower.sort_by(|a, b| a.0.start.total_cmp(&b.0.start));
    let mut start = 0;
    for end in 1..=slower.len() {
        if end < slower.len() && slower[end].0.start - slower[end - 1].0.end <= 2000.0 * rate {
            continue;
        }
        let phrase = &slower[start..end];
        let columns: HashSet<usize> = phrase.iter().map(|p| p.1).collect();
        let (from, to) = (phrase[0].0.start, phrase[phrase.len() - 1].0.end);
        if columns.len() >= 2 && walls.iter().any(|w| w.start <= to + 2000.0 * rate && w.end >= from - 2000.0 * rate) {
            f.intervals.extend(phrase.iter().map(|p| p.0.clone()));
        }
        start = end;
    }
}

/// Per row, the fingers that hit again within `gap` ms.
fn fast_finger_returns(s: &Scan, gap: f64) -> Vec<usize> {
    let mut last = [f64::NEG_INFINITY; 4];
    (0..s.len())
        .map(|i| {
            let mut fast = 0;
            for (c, at) in last.iter_mut().enumerate() {
                if s.rows[i] & (1 << c) == 0 {
                    continue;
                }
                if s.times[i] - *at <= gap * s.rate {
                    fast += 1;
                }
                *at = s.times[i];
            }
            fast
        })
        .collect()
}

fn fast_rolls(s: &Scan, f: &mut Found, returns: &[usize]) {
    let (times, rows, prefix, rate, n) = (&s.times, &s.rows, &s.prefix, s.rate, s.len());
    let mut roll_start = 1;
    let mut rolls: Vec<Section> = Vec::new();
    let mut roll_notes = 0;
    for i in 1..=n {
        if i < n && rows[i] & rows[i - 1] == 0 && times[i] - times[i - 1] <= 25.0 * rate {
            continue;
        }
        if i >= roll_start && i - roll_start >= 8 {
            let fast: usize = returns[roll_start..i].iter().sum();
            let notes = prefix[i] - prefix[roll_start];
            let mut last = [f64::NEG_INFINITY; 4];
            let mut context = 0;
            for row in roll_start - 1..i {
                for (c, at) in last.iter_mut().enumerate() {
                    if rows[row] & (1 << c) == 0 {
                        continue;
                    }
                    if times[row] - *at <= RECURRING_REPETITION_GAP_MS * rate {
                        context += 1;
                    }
                    *at = times[row];
                }
            }
            let section = Section::new(times[roll_start - 1], times[i - 1], Reason::FastRoll);
            if context as f64 / notes as f64 >= 0.25 {
                f.bursts.push(section.clone());
            }
            if fast as f64 / notes as f64 >= 0.25 {
                if i - roll_start >= 24 {
                    f.intervals.push(section.clone());
                }
                rolls.push(section);
                roll_notes += notes;
            }
        }
        roll_start = i + 1;
    }
    if rolls.len() >= 4 && roll_notes as f64 / s.total() as f64 >= 0.2 {
        f.intervals.extend(rolls);
    }
}

fn alternating_chords(s: &Scan, f: &mut Found) {
    let (times, rows, rate, n) = (&s.times, &s.rows, s.rate, s.len());
    let mut start = 0;
    for i in 1..=n {
        if i < n
            && pc(rows[i]) == 2
            && pc(rows[i - 1]) == 2
            && rows[i] & rows[i - 1] == 0
            && times[i] - times[i - 1] <= 50.0 * rate
            && (i == start + 1 || (i >= 2 && rows[i] == rows[i - 2] && times[i] - times[i - 2] <= RECURRING_REPETITION_GAP_MS * rate))
        {
            continue;
        }
        if i - start >= 8 {
            f.bursts.push(Section::new(times[start], times[i - 1], Reason::RepeatedChord));
        }
        start = i;
    }
}

/// Short repetitions that keep coming back: several bursts covering most of a phrase.
fn recurring_repetitions(s: &Scan, f: &mut Found) {
    alternating_chords(s, f);
    let bursts = merge(f.bursts.clone(), false);
    if bursts.len() < 3 {
        return;
    }
    let index: HashMap<i64, usize> = s.times.iter().enumerate().map(|(i, &t)| (t as i64, i)).collect();
    let at = |t: f64| index.get(&(t as i64)).copied().unwrap_or(0) as i64;
    let (mut dur, mut rows, mut jacks) = (vec![0.0], vec![0i64], vec![0i64]);
    for (i, b) in bursts.iter().enumerate() {
        dur.push(dur[i] + b.end - b.start);
        let shared = i > 0 && bursts[i - 1].end == b.start;
        rows.push(rows[i] + at(b.end) - at(b.start) + if shared { 0 } else { 1 });
        jacks.push(jacks[i] + b.reasons.iter().any(|r| *r != Reason::FastRoll) as i64);
    }
    let mut included = vec![0i32; bursts.len() + 1];
    let mut phrase_start = 0;
    for end in 0..bursts.len() {
        if end > 0 && bursts[end].start - bursts[end - 1].end > 1000.0 * s.rate {
            phrase_start = end;
        }
        let mut start = end as isize - 2;
        while start >= phrase_start as isize {
            let st = start as usize;
            let span = bursts[end].end - bursts[st].start;
            if span > 6400.0 * s.rate {
                break;
            }
            let duration = dur[end + 1] - dur[st];
            let shared_first = st > 0 && bursts[st - 1].end == bursts[st].start;
            let n_rows = rows[end + 1] - rows[st] + shared_first as i64;
            let n_jacks = jacks[end + 1] - jacks[st];
            if n_jacks >= 2 && n_rows >= 24 && span > 0.0 && duration / span >= 0.7 {
                included[st] += 1;
                included[end + 1] -= 1;
            }
            start -= 1;
        }
    }
    let mut support = 0;
    for (i, b) in bursts.iter().enumerate() {
        support += included[i];
        if support > 0 {
            f.intervals.push(b.clone());
        }
    }
}

fn extreme_density(s: &Scan, f: &mut Found) {
    let mut ws = 0;
    for i in 0..s.len() {
        while s.times[i] - s.times[ws] > 1000.0 * s.rate {
            ws += 1;
        }
        if i - ws + 1 >= 65 {
            f.add(s.times[ws], s.times[i], Reason::ExtremeDensity);
        }
    }
}

/// Ten seconds of four fingers each past 12.2 hits a second.
fn sustained_density(s: &Scan, f: &mut Found) {
    let min_notes = 12.2 * 4.0 * 10.0;
    let mut ws = 0;
    for i in 0..s.len() {
        while (s.times[i] - s.times[ws]) / s.rate > 10_000.0 + 1e-6 {
            ws += 1;
        }
        if (s.prefix[i + 1] - s.prefix[ws]) as f64 >= min_notes {
            f.add(s.times[ws], s.times[i], Reason::SustainedDensity);
        }
    }
}

/// How much the sections take, and whether cutting them leaves enough to rate.
fn coverage(r: &mut Analysis, map: &Map, s: &Scan) {
    let (times, rate) = (&s.times, s.rate);
    let (mut removed, mut weight) = (0i64, 0i64);
    for n in &map.notes {
        if overlaps(n.time, n.end, &r.sections) {
            removed += 1;
            weight += if n.hold { 2 } else { 1 };
        }
    }
    r.remaining -= removed;
    r.note_share = removed as f64 / map.notes.len() as f64;
    r.repeat_share = repeat_share(s, rate.min(1.0));
    r.judgement_share = weight as f64 / (weight + r.remaining) as f64;
    let mut si = 0;
    for i in 1..times.len() {
        while si < r.sections.len() && r.sections[si].end < times[i - 1] {
            si += 1;
        }
        let mut j = si;
        while j < r.sections.len() && r.sections[j].start < times[i] {
            let sec = &r.sections[j];
            let overlap = times[i].min(sec.end) - times[i - 1].max(sec.start);
            if overlap > 0.0 {
                r.excluded_ms += overlap.min(1000.0 * rate) / rate;
            }
            j += 1;
        }
    }
    r.time_share = if r.active_ms > 0.0 { r.excluded_ms / r.active_ms } else { 1.0 };
    let note_cap = if r.repeat_share >= 0.25 { 0.13 } else { 0.25 };
    let hammered = chord_run_share(s, rate.min(1.0)) >= 0.3;
    r.status = if !r.shares.contains_key(&Reason::SustainedDensity)
        && !hammered
        && r.time_share <= 0.15
        && r.note_share <= note_cap
        && r.remaining >= 300
        && r.active_ms - r.excluded_ms >= 20_000.0
    {
        Status::Adjusted
    } else {
        Status::Excluded
    };
}

/// The share of notes in runs of 4+ hits on one finger in consecutive rows (read at `rate`).
fn repeat_share(s: &Scan, rate: f64) -> f64 {
    let total = s.total();
    if total == 0 {
        return 0.0;
    }
    let mut covered = vec![false; s.len()];
    for col in 0..4 {
        let idx = s.column(col);
        let mut start = 0;
        for i in 1..=idx.len() {
            if i < idx.len() && idx[i] == idx[i - 1] + 1 && s.times[idx[i]] - s.times[idx[i - 1]] <= 95.0 * rate {
                continue;
            }
            if i - start >= 4 {
                for &k in &idx[start..i] {
                    covered[k] = true;
                }
            }
            start = i;
        }
    }
    let notes: usize = (0..s.len()).filter(|&i| covered[i]).map(|i| pc(s.rows[i])).sum();
    notes as f64 / total as f64
}

/// The share of notes in runs of 4+ of one chord (read at `rate`).
fn chord_run_share(s: &Scan, rate: f64) -> f64 {
    let total = s.total();
    if total == 0 {
        return 0.0;
    }
    let (rows, n) = (&s.rows, s.len());
    let mut notes = 0;
    let mut start = 0;
    for i in 1..=n {
        if i < n && rows[i] == rows[i - 1] && pc(rows[i]) >= 2 && s.times[i] - s.times[i - 1] <= 95.0 * rate {
            continue;
        }
        if i - start >= 4 && pc(rows[start]) >= 2 {
            notes += s.prefix[i] - s.prefix[start];
        }
        start = i;
    }
    notes as f64 / total as f64
}

/* ---------- motion: past a finger's or a hand's speed ---------- */

/// The motion scans' sections (4K): split-hand doubles, four-key cycles, a finger or a hand past
/// its ceiling.
fn motion(map: &Map, s: &Scan) -> Vec<(f64, f64, Reason)> {
    let mut out = split_hand_doubles(s);
    out.extend(four_key_cycles(map, s.rate));
    out.extend(finger_rate_ceiling(map, s));
    out.extend(hand_action_ceiling(map, s.rate));
    out
}

fn split_hand_doubles(s: &Scan) -> Vec<(f64, f64, Reason)> {
    let rate = s.rate;
    let mut out = Vec::new();
    for mask in [0b0011u32, 0b1100] {
        let mut actions: Vec<(f64, bool)> = Vec::new();
        for i in 0..s.len() {
            if s.rows[i] & mask == 0 {
                continue;
            }
            let t = s.times[i];
            match actions.last_mut() {
                Some(last) if (t - last.0) / rate <= 30.0 => last.1 = true,
                _ => actions.push((t, false)),
            }
        }
        let mut start: Option<usize> = None;
        let mut close = |end: Option<usize>, start: &mut Option<usize>| {
            let (Some(st), Some(end)) = (*start, end) else {
                *start = None;
                return;
            };
            let count = end - st + 1;
            let span = (actions[end].0 - actions[st].0) / rate / 1000.0;
            let cycle = if span > 0.0 { (count - 1) as f64 / span } else { 0.0 };
            if count >= 16 && cycle >= 12.0 {
                out.push((actions[st].0, actions[end].0, Reason::SplitHandDouble));
            }
            *start = None;
        };
        for i in 0..actions.len() {
            if !actions[i].1 {
                close(i.checked_sub(1), &mut start);
                continue;
            }
            if start.is_some() && (actions[i].0 - actions[i - 1].0) / rate > 250.0 {
                close(i.checked_sub(1), &mut start);
            }
            if start.is_none() {
                start = Some(i);
            }
        }
        close(actions.len().checked_sub(1), &mut start);
    }
    out
}

/// Spans of a sorted list of times where `count` within a second, over at least 0.9 of it, hits
/// `ceiling` a second (`anchored`: whether a window may use the anchor ceiling instead).
fn rate_ceiling(list: &[f64], rate: f64, ceiling: impl Fn(usize, usize) -> f64, reason: Reason, out: &mut Vec<(f64, f64, Reason)>) {
    let mut start = 0;
    let mut open: Option<(f64, f64)> = None;
    for i in 0..list.len() {
        while (list[i] - list[start]) / rate > 1000.0 {
            start += 1;
        }
        let span = (list[i] - list[start]) / rate;
        if span < 900.0 {
            continue;
        }
        if ((i - start) as f64) / (span / 1000.0) < ceiling(start, i) {
            continue;
        }
        match open {
            Some((from, to)) if list[start] <= to => open = Some((from, list[i])),
            Some((from, to)) => {
                out.push((from, to, reason));
                open = Some((list[start], list[i]));
            }
            None => open = Some((list[start], list[i])),
        }
    }
    if let Some((from, to)) = open {
        out.push((from, to, reason));
    }
}

fn finger_rate_ceiling(map: &Map, s: &Scan) -> Vec<(f64, f64, Reason)> {
    let rate = s.rate;
    let mut columns: Vec<Vec<f64>> = vec![Vec::new(); 4];
    for n in &map.notes {
        if n.col < 4 {
            columns[n.col].push(n.time);
        }
    }
    let (mut fast_rows, mut fast_quads) = (0, 0);
    for k in 1..s.len() {
        if (s.times[k] - s.times[k - 1]) / rate > REPEATED_QUAD_GAP_MS {
            continue;
        }
        fast_rows += 1;
        if s.rows[k] == 0b1111 {
            fast_quads += 1;
        }
    }
    let anchors = fast_rows > 0 && fast_quads as f64 / fast_rows as f64 >= 0.2;
    let mut out = Vec::new();
    for mut col in columns {
        col.sort_by(f64::total_cmp);
        let ceiling = |a: usize, b: usize| {
            let anchored = anchors && lower_bound(&s.times, col[b]) - lower_bound(&s.times, col[a]) == b - a;
            if anchored { 14.1 } else { 13.5 }
        };
        rate_ceiling(&col, rate, ceiling, Reason::FingerRateCeiling, &mut out);
    }
    out
}

fn hand_action_ceiling(map: &Map, rate: f64) -> Vec<(f64, f64, Reason)> {
    let mut out = Vec::new();
    for hand in [0b0011u32, 0b1100] {
        let mut times: Vec<f64> = map.notes.iter().filter(|n| hand & (1 << n.col.min(31)) != 0).map(|n| n.time).collect();
        times.sort_by(f64::total_cmp);
        times.dedup();
        rate_ceiling(&times, rate, |_, _| 23.0, Reason::HandActionCeiling, &mut out);
    }
    out
}

const CYCLE_TOLERANCE_MS: f64 = 43.0;
const CYCLE_PURITY: f64 = 0.98;
const CYCLE_MIN_PERIOD_MS: u32 = 55;
const CYCLE_MAX_PERIOD_MS: u32 = 105;
const CYCLE_MIN_PULSES: usize = 12;
const CYCLE_QUAD_SPREAD_MS: f64 = 10.0;
const CYCLE_BODY_SHARE: f64 = 0.12;

fn could_carry_cycle(columns: &[Vec<f64>], rate: f64) -> bool {
    let window = CYCLE_MIN_PULSES as f64 * CYCLE_MAX_PERIOD_MS as f64 * rate;
    if columns.iter().any(|c| c.len() < CYCLE_MIN_PULSES - 1) {
        return false;
    }
    columns[0].iter().any(|&anchor| {
        columns.iter().all(|c| {
            let from = lower_bound(c, anchor);
            c[from..].iter().take_while(|&&t| t <= anchor + window).count() >= CYCLE_MIN_PULSES - 1
        })
    })
}

/// A fixed-period cycle every column feeds, taking nearly every note in its span: rotating
/// chords, rolls or jumptrills that come down to one four-finger motion over and over.
fn four_key_cycles(map: &Map, rate: f64) -> Vec<(f64, f64, Reason)> {
    let mut columns: Vec<Vec<f64>> = vec![Vec::new(); 4];
    let mut all: Vec<f64> = Vec::new();
    for n in &map.notes {
        if n.col >= 4 {
            continue;
        }
        columns[n.col].push(n.time);
        all.push(n.time);
    }
    for c in &mut columns {
        c.sort_by(f64::total_cmp);
    }
    all.sort_by(f64::total_cmp);
    if all.is_empty() || !could_carry_cycle(&columns, rate) {
        return Vec::new();
    }
    let tolerance = CYCLE_TOLERANCE_MS * rate;
    let (first_note, last_note) = (all[0], all[all.len() - 1]);
    let inside = |from: f64, to: f64| lower_bound(&all, to + 1e-6) - lower_bound(&all, from);
    let mut found: Vec<(f64, f64, Reason)> = Vec::new();
    let mut step = CYCLE_MIN_PERIOD_MS;
    while step <= CYCLE_MAX_PERIOD_MS {
        let period = step as f64 * rate;
        let mut phase = 0.0;
        while phase < period {
            let mut cursor = [0usize; 4];
            let (mut from, mut to) = (f64::INFINITY, f64::NEG_INFINITY);
            let mut pulses = 0usize;
            let mut spread: f64 = 0.0;
            let mut close = |from: &mut f64, to: &mut f64, pulses: &mut usize, spread: &mut f64| {
                let slow_quads = *spread <= CYCLE_QUAD_SPREAD_MS * rate && (*to - *from) / (*pulses as f64 - 1.0).max(1.0) > REPEATED_QUAD_GAP_MS * rate;
                let min_pulses = if slow_quads { SLOW_QUAD_MIN_ROWS } else { CYCLE_MIN_PULSES };
                if *pulses >= min_pulses && (*pulses * 4) as f64 >= inside(*from, *to) as f64 * CYCLE_PURITY {
                    found.push((*from, *to, Reason::FourKeyCycle));
                }
                *from = f64::INFINITY;
                *to = f64::NEG_INFINITY;
                *pulses = 0;
                *spread = 0.0;
            };
            let mut time = first_note - tolerance + phase;
            while time <= last_note + tolerance {
                let mut take = [0usize; 4];
                let mut complete = true;
                for c in 0..4 {
                    let notes = &columns[c];
                    let mut i = cursor[c];
                    while i < notes.len() && notes[i] < time - tolerance {
                        i += 1;
                    }
                    if i < notes.len() && notes[i] <= time + tolerance {
                        take[c] = i + 1;
                    } else {
                        take[c] = i;
                        complete = false;
                    }
                }
                if !complete {
                    close(&mut from, &mut to, &mut pulses, &mut spread);
                    cursor = take;
                    time += period;
                    continue;
                }
                let (mut first, mut last) = (f64::INFINITY, f64::NEG_INFINITY);
                for c in 0..4 {
                    let t = columns[c][take[c] - 1];
                    first = first.min(t);
                    last = last.max(t);
                }
                cursor = take;
                from = from.min(first);
                to = to.max(last);
                spread = spread.max(last - first);
                pulses += 1;
                time += period;
            }
            close(&mut from, &mut to, &mut pulses, &mut spread);
            phase += period / 8.0;
        }
        step += 2;
    }
    if covers_enough(&found, &all) { found } else { Vec::new() }
}

fn covers_enough(found: &[(f64, f64, Reason)], all: &[f64]) -> bool {
    if found.is_empty() || all.is_empty() {
        return false;
    }
    let mut spans: Vec<(f64, f64)> = found.iter().map(|&(a, b, _)| (a, b)).collect();
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (a, b) in spans {
        match merged.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    let covered: usize = merged.iter().map(|&(a, b)| lower_bound(all, b + 1e-6) - lower_bound(all, a)).sum();
    covered as f64 >= all.len() as f64 * CYCLE_BODY_SHARE
}

/* ---------- other charts (4K with holds, 5K and up) ---------- */

/// 4K past 10% holds: the motion scans on the note heads; only a chart they'd exclude counts.
fn hold_vibro(map: &Map, rate: f64) -> bool {
    if map.keys != 4 || uses_sections(map) {
        return false;
    }
    let s = Scan::of(map.notes.iter(), rate);
    let mut f = Found::default();
    for (a, b, reason) in motion(map, &s) {
        f.add(a, b, reason);
    }
    if f.intervals.is_empty() {
        return false;
    }
    let mut r = Analysis::clean(map.notes.len());
    r.active_ms = active_ms(&s);
    r.shares = shares(&f.intervals, rate, r.active_ms);
    r.sections = merge(f.intervals, true);
    coverage(&mut r, map, &s);
    r.status == Status::Excluded
}

/// Charts built from jumptrills, each hand being its half of the keys (an odd keymode's middle key
/// joins the hand it's pressed with): unrateable.
fn wide_jumptrill(map: &Map, rate: f64) -> Option<Analysis> {
    if map.keys == 4 && uses_sections(map) {
        return None;
    }
    let half = map.keys / 2;
    let middle = (map.keys % 2 == 1).then_some(half);
    let mut hands = [0u32; 2];
    for c in 0..map.keys.min(31) {
        if Some(c) != middle {
            hands[if c < half { 0 } else { 1 }] |= 1 << c;
        }
    }
    let s = Scan::of(map.notes.iter(), rate);
    let four = map.keys == 4;
    let taps;
    let read = if four {
        taps = Scan::of(map.notes.iter().filter(|n| !n.hold), rate);
        &taps
    } else {
        &s
    };
    let (bursts, notes) = jumptrill_bursts(read, hands, middle, if four { JUMPTRILL_GAP_MS } else { 75.0 });
    if (notes as f64) < map.notes.len() as f64 * JUMPTRILL_CHART_SHARE {
        return None;
    }
    let active = active_ms(&s);
    let sections = merge(bursts, true);
    let excluded: f64 = sections.iter().map(|x| (x.end - x.start) / rate).sum();
    let time_share = if active > 0.0 { (excluded / active).min(1.0) } else { 1.0 };
    let note_share = notes as f64 / map.notes.len() as f64;
    Some(Analysis {
        status: Status::Excluded,
        sections,
        excluded_ms: excluded,
        active_ms: active,
        time_share,
        note_share,
        judgement_share: note_share,
        remaining: map.notes.len() as i64 - notes as i64,
        repeat_share: 0.0,
        shares: BTreeMap::from([(Reason::Jumptrill, time_share)]),
    })
}

/// Per column, gaps at most `cutoff` ms: the share of them.
fn column_fast_share(map: &Map, cutoff: f64) -> f64 {
    let mut by: BTreeMap<usize, Vec<f64>> = BTreeMap::new();
    for n in &map.notes {
        by.entry(n.col).or_default().push(n.time);
    }
    let (mut fast, mut total) = (0, 0);
    for times in by.values_mut() {
        times.sort_by(f64::total_cmp);
        for w in times.windows(2) {
            let gap = w[1] - w[0];
            if gap <= 0.0 {
                continue;
            }
            total += 1;
            if gap <= cutoff {
                fast += 1;
            }
        }
    }
    if total > 0 { fast as f64 / total as f64 } else { 0.0 }
}

/// 4K: fast rolls, rows at most `cutoff` ms apart that share no finger, and fingers back quickly.
fn roll_vibro(map: &Map, rate: f64) -> bool {
    if map.keys != 4 || map.notes.len() < 300 || column_fast_share(map, 70.0 * rate) < 0.25 {
        return false;
    }
    let s = Scan::of(map.notes.iter(), rate);
    if s.len() < 2 {
        return false;
    }
    let fast = (1..s.len()).filter(|&i| s.times[i] - s.times[i - 1] <= 25.0 * rate && s.rows[i] & s.rows[i - 1] == 0).count();
    fast as f64 / (s.len() - 1) as f64 >= 0.3
}

/// The share of row gaps at most `cutoff` ms between chords of all keys but one or more.
fn chord_wall_ratio(map: &Map, cutoff: f64) -> f64 {
    let mut sizes: BTreeMap<i64, usize> = BTreeMap::new();
    for n in &map.notes {
        *sizes.entry(n.time as i64).or_insert(0) += 1;
    }
    let rows: Vec<(f64, usize)> = sizes.into_iter().map(|(t, n)| (t as f64, n)).collect();
    if rows.len() < 2 {
        return 0.0;
    }
    let min_chord = 2.max(map.keys - 1);
    let walls = rows.windows(2).filter(|w| w[1].0 - w[0].0 > 0.0 && w[1].0 - w[0].0 <= cutoff && w[0].1 >= min_chord && w[1].1 >= min_chord).count();
    walls as f64 / (rows.len() - 1) as f64
}

/* ---------- what Fumen asks ---------- */

/// What a pass on `chart` at `rate` is worth for the skills (osu!mania 4K and up).
pub fn check(chart: &Chart, rate: f64) -> Verdict {
    let Some(map) = Map::of(chart) else { return Verdict::Clean };
    if !rate.is_finite() || rate <= 0.0 {
        return Verdict::Clean;
    }
    let analysis = if uses_sections(&map) {
        Some(analyze_sections(&map, rate))
    } else {
        stacked_heads(&map, rate).or_else(|| wide_jumptrill(&map, rate)).or_else(|| collapsed_notes(&map, rate))
    };
    match analysis {
        Some(a) => match a.status {
            Status::Clean => Verdict::Clean,
            Status::Adjusted => Verdict::Adjusted { sections: a.sections.iter().map(|x| (x.start, x.end)).collect(), judgement_share: a.judgement_share },
            Status::Excluded if a.unrateable() => Verdict::Unrateable,
            Status::Excluded => Verdict::Excluded,
        },
        None if hold_vibro(&map, rate) || roll_vibro(&map, rate) || (map.notes.len() >= 200 && chord_wall_ratio(&map, 70.0 * rate) >= 0.5) => Verdict::Excluded,
        None => Verdict::Clean,
    }
}

/// The chart without the notes (heads to tails) in `sections`.
pub fn trimmed(chart: &Chart, sections: &[(f64, f64)]) -> Chart {
    let secs: Vec<Section> = sections.iter().map(|&(a, b)| Section::new(a, b, Reason::RepeatedWall)).collect();
    let mut out = chart.clone();
    out.objects.retain(|o| !overlaps(o.time as f64, o.end.max(o.time) as f64, &secs));
    out
}

/// The accuracy on what's left once `removed` of the judgements are cut, with all the accuracy
/// lost put on the rest (mania-tracker's `conservativeVibroAccuracy`).
pub fn kept_accuracy(accuracy: f64, removed: f64) -> f64 {
    if !accuracy.is_finite() || !removed.is_finite() || removed >= 1.0 {
        return 0.0;
    }
    (1.0 - (1.0 - accuracy) / (1.0 - removed.max(0.0))).clamp(0.0, 1.0)
}

/// A pass's SSR as the skills count it, given its chart's `check` at the rate: on what's left for
/// an adjusted chart, as is otherwise (it's still shown; vibro and unrateable passes just don't
/// count).
pub fn ssr(chart: &Chart, rate: f64, wife: f64, verdict: &Verdict) -> Option<[f32; 8]> {
    match verdict {
        Verdict::Adjusted { sections, judgement_share } => crate::msd::ssr(&trimmed(chart, sections), rate, kept_accuracy(wife, *judgement_share)),
        _ => crate::msd::ssr(chart, rate, wife),
    }
    .map(|m| m.to_array())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::parse;

    /// A 4K chart from (time, column) taps.
    fn chart(keys: u8, notes: &[(i32, u8)]) -> Chart {
        let width = 512 / keys as i32;
        let objects: String = notes.iter().map(|&(t, lane)| format!("{},192,{t},1,0,0:0:0:0:\n", lane as i32 * width + width / 2)).collect();
        parse(&format!("osu file format v14\n\n[General]\nMode: 3\n\n[Difficulty]\nCircleSize:{keys}\nOverallDifficulty:8\n\n[TimingPoints]\n0,250,4,2,0,100,1,0\n\n[HitObjects]\n{objects}"))
    }

    /// Streams a person can play: 16ths at 180 BPM (83 ms), a varied pattern, three minutes.
    fn stream(from: i32, rows: usize) -> Vec<(i32, u8)> {
        const PATTERN: [u8; 8] = [0, 2, 1, 3, 2, 0, 3, 1];
        (0..rows).map(|i| (from + (i as f64 * 83.3) as i32, PATTERN[i % 8])).collect()
    }

    #[test]
    fn plain_streams_are_clean() {
        let c = chart(4, &stream(1000, 2000));
        assert_eq!(check(&c, 1.0), Verdict::Clean);
        assert_eq!(check(&c, 1.2), Verdict::Clean);
    }

    #[test]
    fn a_wall_of_quads_past_a_hand_is_vibro() {
        // a minute of quads 40 ms apart: no hand hits that
        let notes: Vec<(i32, u8)> = (0..1500).flat_map(|i| (0..4).map(move |c| (1000 + i * 40, c))).collect();
        assert_eq!(check(&chart(4, &notes), 1.0), Verdict::Excluded);
    }

    #[test]
    fn a_short_burst_in_a_long_chart_is_cut_out() {
        // three minutes of stream with five seconds of one-finger jack at 30 ms in the middle
        let mut notes = stream(1000, 1100);
        let mid = notes.last().unwrap().0 + 100;
        notes.extend((0..160).map(|i| (mid + i * 30, 0)));
        notes.extend(stream(mid + 160 * 30 + 100, 1100));
        match check(&chart(4, &notes), 1.0) {
            Verdict::Adjusted { sections, judgement_share } => {
                assert!(sections.iter().any(|&(a, b)| a <= (mid + 100) as f64 && b >= (mid + 4000) as f64), "{sections:?}");
                assert!(judgement_share > 0.0 && judgement_share < 0.2, "{judgement_share}");
            }
            v => panic!("{v:?}"),
        }
    }

    #[test]
    fn rate_makes_it_faster() {
        // twenty hits on one finger 80 ms apart: fine at 1×, past a finger's ceiling at 1.3×
        let mut notes = stream(1000, 900);
        let mid = notes.last().unwrap().0 + 100;
        notes.extend((0..20).map(|i| (mid + i * 80, 0)));
        notes.extend(stream(mid + 20 * 80 + 100, 900));
        let c = chart(4, &notes);
        assert_eq!(check(&c, 1.0), Verdict::Clean);
        assert_ne!(check(&c, 1.3), Verdict::Clean);
    }

    #[test]
    fn stacked_notes_and_jumptrills_are_unrateable() {
        let mut notes = stream(1000, 600);
        notes.extend((0..9).map(|_| (60_000, 1)));
        assert_eq!(check(&chart(4, &notes), 1.0), Verdict::Unrateable);
        // 7K: a jumptrill between the hands all the way
        let jt: Vec<(i32, u8)> = (0..800).flat_map(|i| if i % 2 == 0 { vec![(1000 + i * 60, 0), (1000 + i * 60, 1), (1000 + i * 60, 2)] } else { vec![(1000 + i * 60, 4), (1000 + i * 60, 5), (1000 + i * 60, 6)] }).collect();
        assert_eq!(check(&chart(7, &jt), 1.0), Verdict::Unrateable);
    }

    #[test]
    fn cut_charts_keep_the_rest() {
        let c = chart(4, &[(0, 0), (100, 1), (200, 2), (300, 3)]);
        let t = trimmed(&c, &[(90.0, 210.0)]);
        assert_eq!(t.objects.iter().map(|o| o.time).collect::<Vec<_>>(), vec![0, 300]);
        assert!((kept_accuracy(0.95, 0.1) - (1.0 - 0.05 / 0.9)).abs() < 1e-9);
        assert_eq!(kept_accuracy(0.95, 1.0), 0.0);
    }
}

#[cfg(test)]
mod library_tests {
    /// Every osu!mania chart of a real library through `check` at 1× and 1.5×, timed, with the ones
    /// found listed: `FUMEN_TEST_DB=<copy of library.db> FUMEN_TEST_STORAGE=<lazer folder>
    /// cargo test --release vibro::library_tests -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a copy of a real library"]
    fn real_library() {
        let (Some(db), Some(storage)) = (std::env::var_os("FUMEN_TEST_DB"), std::env::var_os("FUMEN_TEST_STORAGE")) else { return };
        let conn = crate::db::open(std::path::Path::new(&db)).unwrap();
        let files = crate::paths::Files::lazer(storage);
        let mut st = conn
            .prepare("SELECT m.hash, s.artist || ' - ' || s.title || ' [' || m.version || ']' FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.ruleset_id = 3 AND m.hash IS NOT NULL")
            .unwrap();
        let maps: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(|r| r.ok()).collect();
        let t = std::time::Instant::now();
        let mut counts = std::collections::BTreeMap::new();
        for (hash, name) in &maps {
            let Ok(chart) = crate::charts::load(&files, hash) else { continue };
            for rate in [1.0, 1.5] {
                let v = super::check(&chart, rate);
                *counts.entry((rate.to_string(), v.code())).or_insert(0) += 1;
                if v.code() > 0 {
                    eprintln!("{rate}x {:?} {}K {name}", super::Verdict::label(v.code()), chart.keys);
                }
            }
        }
        eprintln!("{} charts in {:?}: {counts:?}", maps.len(), t.elapsed());
    }
}
