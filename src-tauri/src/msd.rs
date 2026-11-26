//! MSD: Etterna's difficulty rating for osu!mania charts, from its own calculator (MinaCalc 527,
//! compiled in from `minacalc/`, see build.rs): an overall number and one per skillset (stream,
//! jumpstream, handstream, stamina, jackspeed, chordjack, technical), at any rate.
//!
//! MinaCalc reads rows: the columns pressed at a moment and when. Long notes count by their
//! heads, as when Etterna rates an osu! chart. It's made for 4K; Fumen rates 4K to 7K with it
//! (MinaCalc has its own logic for 5K, 6K and 7K) and nothing else.

use std::ffi::{c_float, c_int, c_uint, c_void};

use serde::Serialize;

use crate::chart::Chart;

#[repr(C)]
#[derive(Clone, Copy)]
struct NoteInfo {
    notes: c_uint,
    row_time: c_float,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct Ssr {
    overall: c_float,
    stream: c_float,
    jumpstream: c_float,
    handstream: c_float,
    stamina: c_float,
    jackspeed: c_float,
    chordjack: c_float,
    technical: c_float,
}

extern "C" {
    #[cfg(test)]
    fn calc_version() -> c_int;
    fn create_calc() -> *mut c_void;
    fn destroy_calc(calc: *mut c_void);
    // MinaCalc only through minacalc/Guarded.cpp: it catches every C++ exception (MinaCalc throws
    // std::out_of_range on some charts) and answers 0 when done, else a code with `out` untouched.
    // An exception that reached Rust would abort the whole app, on every start.
    /// mode 0: MSD (the chart's difficulty), 1: SSR (a score's rating)
    fn guarded_calc_at_rate(
        calc: *mut c_void,
        rows: *const NoteInfo,
        num_rows: usize,
        music_rate: c_float,
        score_goal: c_float,
        keycount: c_uint,
        mode: c_int,
        out: *mut Ssr,
    ) -> c_int;
    #[cfg(test)]
    fn guarded_selftest() -> c_int;
    fn guarded_calc_all_rates(calc: *mut c_void, rows: *const NoteInfo, num_rows: usize, keycount: c_uint, mode: c_int, out: *mut AllRates) -> c_int;
}

/// MinaCalc's MSD at 0.7× to 2.0×, a tenth apart
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct AllRates {
    msds: [Ssr; 14],
}

/// A chart's MSD at a rate.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Msd {
    pub overall: f32,
    pub stream: f32,
    pub jumpstream: f32,
    pub handstream: f32,
    pub stamina: f32,
    pub jackspeed: f32,
    pub chordjack: f32,
    pub technical: f32,
}

impl Msd {
    pub const SKILLS: [&'static str; 7] = ["stream", "jumpstream", "handstream", "stamina", "jackspeed", "chordjack", "technical"];

    fn skills(&self) -> [f32; 7] {
        [self.stream, self.jumpstream, self.handstream, self.stamina, self.jackspeed, self.chordjack, self.technical]
    }

    /// The skillset the chart asks most of.
    pub fn top_skill(&self) -> &'static str {
        let s = self.skills();
        let mut best = 0;
        for i in 1..s.len() {
            if s[i] > s[best] {
                best = i;
            }
        }
        Self::SKILLS[best]
    }
}

/// One calculator per thread (it keeps state between calls and isn't shared).
struct Calc(*mut c_void);

impl Drop for Calc {
    fn drop(&mut self) {
        // SAFETY: made by create_calc, dropped once
        unsafe { destroy_calc(self.0) }
    }
}

thread_local! {
    static CALC: Calc = Calc(unsafe { create_calc() });
}

/// MinaCalc's version (527).
#[cfg(test)]
pub fn version() -> i32 {
    // SAFETY: no arguments, no state
    unsafe { calc_version() }
}

/// The chart's rows for MinaCalc: the columns whose notes (or long note heads) start at each
/// moment, seconds.
fn rows(chart: &Chart) -> Vec<NoteInfo> {
    let mut out: Vec<NoteInfo> = Vec::new();
    let mut last = i32::MIN;
    let mut heads: Vec<(i32, u8)> = chart.objects.iter().map(|o| (o.time, o.lane)).collect();
    heads.sort_unstable();
    for (time, lane) in heads {
        let bit = 1u32 << lane.min(31);
        match out.last_mut() {
            Some(row) if time == last => row.notes |= bit,
            _ => {
                out.push(NoteInfo { notes: bit, row_time: time as f32 / 1000.0 });
                last = time;
            }
        }
    }
    out
}

/// What a chart's notes are, whatever its speed: the key count and the notes row by row (which
/// columns start at each moment), as 16 hex digits of FNV-1a. Rate edits ("1.1x", "1.05x" …) and
/// the same chart uploaded twice come out the same, so the skills count them as one chart.
pub fn notes_key(chart: &Chart) -> Option<String> {
    if chart.mode != 3 || chart.keys == 0 || chart.objects.is_empty() {
        return None;
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut put = |v: u32| {
        for b in v.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    put(chart.keys as u32);
    for r in rows(chart) {
        put(r.notes);
    }
    Some(format!("{h:016x}"))
}

/// The rows of a chart MinaCalc can rate: osu!mania, 4K to 7K, two rows or more.
fn rateable(chart: &Chart) -> Option<Vec<NoteInfo>> {
    if chart.mode != 3 || !(4..=7).contains(&chart.keys) {
        return None;
    }
    let rows = rows(chart);
    (rows.len() >= 2).then_some(rows)
}

impl From<Ssr> for Msd {
    fn from(s: Ssr) -> Msd {
        let r2 = |v: f32| if v.is_finite() { (v * 100.0).round() / 100.0 } else { 0.0 };
        Msd {
            overall: r2(s.overall),
            stream: r2(s.stream),
            jumpstream: r2(s.jumpstream),
            handstream: r2(s.handstream),
            stamina: r2(s.stamina),
            jackspeed: r2(s.jackspeed),
            chordjack: r2(s.chordjack),
            technical: r2(s.technical),
        }
    }
}

impl Msd {
    /// Overall, then the skillsets in `SKILLS`' order.
    pub fn to_array(self) -> [f32; 8] {
        [self.overall, self.stream, self.jumpstream, self.handstream, self.stamina, self.jackspeed, self.chordjack, self.technical]
    }
}

/// MinaCalc at one rate: MSD (`ssr` off) or a score's SSR at `goal` (Wife%, 0–1).
fn at_rate(chart: &Chart, rate: f64, goal: f64, ssr: bool) -> Option<Msd> {
    let rows = rateable(chart)?;
    let mut out = Ssr::default();
    let code = CALC.with(|c| {
        // SAFETY: the rows and `out` live through the call, the calculator is this thread's own
        unsafe {
            guarded_calc_at_rate(c.0, rows.as_ptr(), rows.len(), rate.clamp(0.5, 3.0) as f32, goal.clamp(0.0, 1.0) as f32, chart.keys as c_uint, ssr as c_int, &mut out)
        }
    });
    if code != 0 {
        return None;
    }
    let msd = Msd::from(out);
    (msd.overall > 0.0).then_some(msd)
}

/// A mania chart's MSD at `rate` (0.7 to 2.0 is what Etterna lists); None for other modes, key
/// counts outside 4K to 7K and charts too short to rate.
pub fn rate(chart: &Chart, rate: f64) -> Option<Msd> {
    at_rate(chart, rate, 0.93, false)
}

/// What a play scores in Etterna's eyes (its SSR): the chart at the rate played, rated for the
/// Wife% it got (`wife`, 0–1; above 96.5% counts as 96.5%, as in Etterna).
pub fn ssr(chart: &Chart, rate: f64, wife: f64) -> Option<Msd> {
    at_rate(chart, rate, wife, true)
}

/// The MSD at every rate from 0.7× to 2.0×, a tenth apart, in one go.
pub fn all_rates(chart: &Chart) -> Option<Vec<Msd>> {
    let rows = rateable(chart)?;
    let mut all = AllRates::default();
    let code = CALC.with(|c| {
        // SAFETY: as above
        unsafe { guarded_calc_all_rates(c.0, rows.as_ptr(), rows.len(), chart.keys as c_uint, 0, &mut all) }
    });
    if code != 0 {
        return None;
    }
    let out: Vec<Msd> = all.msds.iter().map(|s| Msd::from(*s)).collect();
    out.iter().any(|m| m.overall > 0.0).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::parse;

    fn chart(keys: u8, notes: &[(i32, u8)]) -> Chart {
        let width = 512 / keys as i32;
        let objects: String = notes.iter().map(|&(t, lane)| format!("{},192,{t},1,0,0:0:0:0:\n", lane as i32 * width + width / 2)).collect();
        parse(&format!("osu file format v14\n\n[General]\nMode: 3\n\n[Difficulty]\nCircleSize:{keys}\nOverallDifficulty:8\n\n[TimingPoints]\n0,250,4,2,0,100,1,0\n\n[HitObjects]\n{objects}"))
    }

    /// The guard's try survives the compiler: an exception thrown inside it comes back as a code,
    /// not as a crash of the whole app.
    #[test]
    fn exceptions_stay_in_cpp() {
        assert_eq!(unsafe { guarded_selftest() }, 1);
    }

    #[test]
    fn version_is_527() {
        assert_eq!(version(), 527);
    }

    #[test]
    fn rate_edits_share_their_notes_key() {
        let notes: Vec<(i32, u8)> = (0..200).map(|i| (1000 + i * 120, ((i * 7) % 4) as u8)).collect();
        let base = chart(4, &notes);
        // the same at 1.1×: every time over 1.1, rounded to the ms
        let fast = chart(4, &notes.iter().map(|&(t, l)| ((t as f64 / 1.1).round() as i32, l)).collect::<Vec<_>>());
        assert_eq!(notes_key(&base), notes_key(&fast));
        let mut other = notes.clone();
        other[50].1 = (other[50].1 + 1) % 4;
        assert_ne!(notes_key(&base), notes_key(&chart(4, &other)));
        assert_ne!(notes_key(&base), notes_key(&chart(5, &notes)));
    }

    #[test]
    fn rows_join_notes_at_one_moment() {
        let c = chart(4, &[(0, 0), (0, 2), (125, 1), (250, 3)]);
        let r = rows(&c);
        assert_eq!(r.iter().map(|r| r.notes).collect::<Vec<_>>(), vec![0b0101, 0b0010, 0b1000]);
        assert_eq!(r[1].row_time, 0.125);
    }

    #[test]
    fn all_rates_and_ssr_agree_with_one_rate() {
        let notes: Vec<(i32, u8)> = (0..720).flat_map(|i| {
            let t = i * 83;
            let a = (i % 4) as u8;
            if i % 2 == 0 { vec![(t, a), (t, (a + 2) % 4)] } else { vec![(t, a)] }
        }).collect();
        let c = chart(4, &notes);
        let all = all_rates(&c).unwrap();
        assert_eq!(all.len(), 14);
        let one = rate(&c, 1.0).unwrap();
        assert!((all[3].overall - one.overall).abs() < 0.05, "{} {}", all[3].overall, one.overall);
        assert!(all[13].overall > all[3].overall);
        // a 96.5% play is worth the MSD at 93% and more; a worse one less
        let good = ssr(&c, 1.0, 0.965).unwrap();
        let poor = ssr(&c, 1.0, 0.85).unwrap();
        assert!(good.overall > one.overall, "{good:?} {one:?}");
        assert!(poor.overall < good.overall);
        // above the cap counts as the cap
        assert_eq!(ssr(&c, 1.0, 0.99).unwrap(), good);
    }

    #[test]
    fn faster_is_harder() {
        // a minute of 1/4 jumpstream at 180 BPM
        let notes: Vec<(i32, u8)> = (0..720)
            .flat_map(|i| {
                let t = i * 83;
                let a = (i % 4) as u8;
                if i % 2 == 0 { vec![(t, a), (t, (a + 2) % 4)] } else { vec![(t, a)] }
            })
            .collect();
        let c = chart(4, &notes);
        let one = rate(&c, 1.0).expect("rated");
        let fast = rate(&c, 1.5).expect("rated");
        assert!(one.overall > 5.0 && one.overall < 40.0, "{one:?}");
        assert!(fast.overall > one.overall * 1.2, "{one:?} {fast:?}");
        assert!(rate(&chart(4, &[(0, 0)]), 1.0).is_none());
        assert!(rate(&chart(9, &notes.iter().map(|&(t, l)| (t, l)).collect::<Vec<_>>()), 1.0).is_none());
    }

    /// Fumen's MSD against a reference build of the same sources (mania-ai's DLL), on real charts:
    /// `FUMEN_MSD_REF=<json: [{"p": .osu path, "m": overall at 1×}]> cargo test msd::tests::matches_reference -- --ignored`
    #[test]
    #[ignore = "needs real charts and reference values"]
    fn matches_reference() {
        let Some(path) = std::env::var_os("FUMEN_MSD_REF") else { return };
        let refs: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        for r in refs {
            let text = std::fs::read_to_string(r["p"].as_str().unwrap()).unwrap();
            let got = rate(&parse(&text), 1.0).map_or(0.0, |m| m.overall);
            let want = r["m"].as_f64().unwrap() as f32;
            eprintln!("{got:6.2} {want:6.2}");
            assert!((got - want).abs() < 0.02, "{got} vs {want}");
        }
    }
}

