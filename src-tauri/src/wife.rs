//! An osu!mania play's accuracy as Etterna would count it (Wife3), from its judgement counts, so
//! MinaCalc can rate the play (its SSR, see msd.rs).
//!
//! osu! only keeps how many notes landed in each judgement window, not how far off each one was.
//! So the hits are taken to spread around the note like a bell curve (a normal distribution of
//! timing errors): its width is the one that best explains the counts in the windows at the
//! chart's OD (Perfect, Great, Good, Ok, Meh), and every hit is worth what Wife3 gives on average
//! along that curve. A miss costs what it does in Etterna. This is how a Perfect:Great ratio turns
//! into a Wife%: 95% osu! accuracy with mostly Perfects is worth more than with mostly Greats.
//!
//! Windows are lazer's ManiaHitWindows in real time (rates don't change them), over 1.4 with Hard
//! Rock and times 1.4 with Easy; osu!stable's and lazer's Classic ones where the play used them.

/// Wife3 at Etterna's default judge (J4)
const MAX_POINTS: f64 = 2.0;
const MISS_WEIGHT: f64 = -5.5;
const RIDIC: f64 = 5.0;
const MAX_BOO: f64 = 180.0;
const ZERO: f64 = 65.0;
const DEV: f64 = 22.7;

/// Wife3's points for a hit `ms` off (Etterna's `wife3`, judge 4).
pub fn wife3(ms: f64) -> f64 {
    let ms = ms.abs();
    if ms <= RIDIC {
        MAX_POINTS
    } else if ms <= ZERO {
        MAX_POINTS * erf((ZERO - ms) / DEV)
    } else if ms <= MAX_BOO {
        (ms - ZERO) * MISS_WEIGHT / (MAX_BOO - ZERO)
    } else {
        MISS_WEIGHT
    }
}

/// The error function (Abramowitz and Stegun 7.1.26, good to 1.5e-7).
fn erf(x: f64) -> f64 {
    let sign = x.signum();
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-x * x).exp();
    sign * y
}

/// DifficultyRange: the value at OD 0, 5 and 10, on a line in between.
fn range(od: f64, (min, mid, max): (f64, f64, f64)) -> f64 {
    if od > 5.0 {
        mid + (max - mid) * (od - 5.0) / 5.0
    } else if od < 5.0 {
        mid + (mid - min) * (od - 5.0) / 5.0
    } else {
        mid
    }
}

/// The windows of Perfect, Great, Good, Ok and Meh, ms each way, in real time.
pub fn windows(od: f64, mods: &[String], classic: bool) -> [f64; 5] {
    let has = |m: &str| mods.iter().any(|x| x == m);
    let k = if has("HR") {
        1.0 / 1.4
    } else if has("EZ") {
        1.4
    } else {
        1.0
    };
    let w = if classic || has("CL") {
        let inv = (10.0 - od).clamp(0.0, 10.0);
        [16.0, 34.0 + 3.0 * inv, 67.0 + 3.0 * inv, 97.0 + 3.0 * inv, 121.0 + 3.0 * inv]
    } else {
        [
            range(od, (22.4, 19.4, 13.9)),
            range(od, (64.0, 49.0, 34.0)),
            range(od, (97.0, 82.0, 67.0)),
            range(od, (127.0, 112.0, 97.0)),
            range(od, (151.0, 136.0, 121.0)),
        ]
    };
    w.map(|v| (v * k).floor() + 0.5)
}

/// Share of a half-normal of width `sigma` within `w` ms.
fn within(w: f64, sigma: f64) -> f64 {
    erf(w / (sigma * std::f64::consts::SQRT_2))
}

/// How well a width explains the counts per window (log-likelihood, hits only).
fn likelihood(counts: &[f64; 5], w: &[f64; 5], sigma: f64) -> f64 {
    let total = within(w[4], sigma).max(1e-300);
    let mut prev = 0.0;
    let mut sum = 0.0;
    for i in 0..5 {
        let cur = within(w[i], sigma);
        if counts[i] > 0.0 {
            sum += counts[i] * ((cur - prev).max(1e-300) / total).ln();
        }
        prev = cur;
    }
    sum
}

/// The width (ms) that explains the counts best.
pub fn fit_sigma(counts: &[f64; 5], w: &[f64; 5]) -> f64 {
    // golden-section search over ln σ
    let (mut a, mut b) = (0.5f64.ln(), 300f64.ln());
    let g = (5f64.sqrt() - 1.0) / 2.0;
    let mut c = b - g * (b - a);
    let mut d = a + g * (b - a);
    let f = |x: f64| likelihood(counts, w, x.exp());
    let (mut fc, mut fd) = (f(c), f(d));
    for _ in 0..80 {
        if fc > fd {
            b = d;
            d = c;
            fd = fc;
            c = b - g * (b - a);
            fc = f(c);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + g * (b - a);
            fd = f(d);
        }
    }
    ((a + b) / 2.0).exp()
}

/// Wife3's average for a hit, the hits spread by `sigma` and cut off at `limit` ms.
fn mean_wife(sigma: f64, limit: f64) -> f64 {
    const STEPS: usize = 400;
    let h = limit / STEPS as f64;
    let pdf = |x: f64| (-(x * x) / (2.0 * sigma * sigma)).exp();
    let (mut num, mut den) = (0.0, 0.0);
    for i in 0..=STEPS {
        let x = i as f64 * h;
        // Simpson's weights
        let k = if i == 0 || i == STEPS { 1.0 } else if i % 2 == 1 { 4.0 } else { 2.0 };
        num += k * pdf(x) * wife3(x);
        den += k * pdf(x);
    }
    if den > 0.0 { num / den } else { MAX_POINTS }
}

/// The play's Wife%, 0–1, from its judgement counts (lazer's names: perfect … miss); None
/// without any.
pub fn estimate(hits: &serde_json::Map<String, serde_json::Value>, od: f64, mods: &[String], classic: bool) -> Option<f64> {
    let n = |k: &str| hits.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0);
    let counts = [n("perfect"), n("great"), n("good"), n("ok"), n("meh")];
    let miss = n("miss");
    let hit: f64 = counts.iter().sum();
    if hit + miss <= 0.0 || hit <= 0.0 {
        return None;
    }
    let w = windows(od, mods, classic);
    let sigma = fit_sigma(&counts, &w);
    let points = hit * mean_wife(sigma, w[4]) + miss * MISS_WEIGHT;
    Some((points / (MAX_POINTS * (hit + miss))).clamp(0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hits(v: &[(&str, f64)]) -> serde_json::Map<String, serde_json::Value> {
        v.iter().map(|(k, n)| (k.to_string(), serde_json::json!(n))).collect()
    }

    /// Wife% next to osu!'s accuracy for the real library's osu!mania plays:
    /// `FUMEN_TEST_DB=<library.db> cargo test wife::tests::real_plays -- --ignored --nocapture`
    #[test]
    #[ignore = "reads a real library"]
    fn real_plays() {
        let Some(path) = std::env::var_os("FUMEN_TEST_DB") else { return };
        let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut st = conn
            .prepare("SELECT s.statistics, s.accuracy, s.mods, m.od FROM scores s JOIN maps m ON m.md5 = s.map_md5 WHERE s.ruleset = 'mania' AND m.od IS NOT NULL LIMIT 4000")
            .unwrap();
        let rows: Vec<(String, f64, String, f64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(|r| r.unwrap()).collect();
        let mut pairs = Vec::new();
        for (stats, acc, mods, od) in &rows {
            let hits: serde_json::Map<String, serde_json::Value> = serde_json::from_str(stats).unwrap_or_default();
            let mods: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(mods).unwrap_or_default().iter().filter_map(|m| m["acronym"].as_str().map(str::to_string)).collect();
            if let Some(w) = estimate(&hits, *od, &mods, false) {
                pairs.push((*acc, w));
            }
        }
        pairs.sort_by(|a, b| a.0.total_cmp(&b.0));
        for q in [0.05, 0.25, 0.5, 0.75, 0.95] {
            let (acc, w) = pairs[((pairs.len() - 1) as f64 * q) as usize];
            eprintln!("osu! {:.2}%  wife {:.2}%", acc * 100.0, w * 100.0);
        }
        eprintln!("{} plays", pairs.len());
    }

    #[test]
    fn wife3_as_etterna_has_it() {
        assert_eq!(wife3(0.0), 2.0);
        assert_eq!(wife3(5.0), 2.0);
        assert!((wife3(65.0)).abs() < 1e-6);
        assert!((wife3(180.0) + 5.5).abs() < 1e-9);
        assert_eq!(wife3(500.0), -5.5);
        assert!(wife3(-20.0) > 1.9);
    }

    #[test]
    fn windows_at_od() {
        let none: Vec<String> = vec![];
        assert_eq!(windows(8.0, &none, true), [16.5, 40.5, 73.5, 103.5, 127.5]);
        assert_eq!(windows(5.0, &none, false), [19.5, 49.5, 82.5, 112.5, 136.5]);
        let hr = vec!["HR".to_string()];
        assert!(windows(8.0, &hr, true)[1] < 30.0);
    }

    #[test]
    fn the_width_comes_back() {
        // counts drawn from a 20 ms curve come back as about 20 ms
        let w = windows(8.0, &[], true);
        let sigma: f64 = 20.0;
        let mut prev = 0.0;
        let mut counts = [0.0; 5];
        for i in 0..5 {
            let cur = within(w[i], sigma);
            counts[i] = (cur - prev) * 10_000.0;
            prev = cur;
        }
        assert!((fit_sigma(&counts, &w) - sigma).abs() < 0.5, "{}", fit_sigma(&counts, &w));
    }

    #[test]
    fn perfects_are_worth_more_than_greats() {
        let none: Vec<String> = vec![];
        let tight = estimate(&hits(&[("perfect", 900.0), ("great", 100.0)]), 8.0, &none, false).unwrap();
        let loose = estimate(&hits(&[("perfect", 300.0), ("great", 700.0)]), 8.0, &none, false).unwrap();
        assert!(tight > 0.97 && tight <= 1.0, "{tight}");
        assert!(loose < tight - 0.02, "{loose} {tight}");
        let missed = estimate(&hits(&[("perfect", 900.0), ("great", 100.0), ("miss", 20.0)]), 8.0, &none, false).unwrap();
        assert!(missed < tight - 0.05, "{missed}");
        assert!(estimate(&hits(&[("miss", 5.0)]), 8.0, &none, false).is_none());
        assert!(estimate(&hits(&[]), 8.0, &none, false).is_none());
    }
}
