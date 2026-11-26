//! Heart rate straps over Bluetooth LE: the standard Heart Rate Service that Moofit's straps, most
//! chest straps and watches sharing their pulse speak. Fumen finds them, connects to the one picked
//! (again after a drop, for as long as it's wanted) and hands every reading on: the window keeps it
//! with each try at a map, the OBS pages show it (`heart` part). Nothing goes anywhere else.
//!
//! A strap talks to one app at a time (some to two): with a phone app connected, Fumen may not
//! find it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use btleplug::api::bleuuid::uuid_from_u16;
use btleplug::api::{Central, CharPropFlags, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use serde::Serialize;
use uuid::Uuid;

use crate::error::{Error, Result};

const HEART_RATE_SERVICE: Uuid = uuid_from_u16(0x180D);
const HEART_RATE_MEASUREMENT: Uuid = uuid_from_u16(0x2A37);
const BATTERY_LEVEL: Uuid = uuid_from_u16(0x2A19);
/// how long a search listens
const SCAN_FOR: Duration = Duration::from_secs(5);
/// how long connecting looks for the strap before trying again
const FIND_FOR: Duration = Duration::from_secs(15);
/// no reading for this long: the strap is gone (straps send about once a second)
const QUIET: Duration = Duration::from_secs(8);
/// between tries to get a lost strap back
const RETRY: Duration = Duration::from_secs(4);

/// A strap found by a search.
#[derive(Debug, Clone, Serialize)]
pub struct Device {
    /// btleplug's id for it (the Bluetooth address on Windows and Linux)
    pub id: String,
    pub name: String,
    /// signal strength, dBm
    pub rssi: Option<i16>,
}

/// One reading: beats per minute, whether the strap touches skin (when it says) and the times
/// between the beats since the reading before, in milliseconds (when it sends them; a try keeps
/// them for its HRV).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reading {
    pub bpm: u16,
    pub contact: Option<bool>,
    pub rr: Vec<u16>,
}

/// How the connection goes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "off", "connecting", "on" or "lost"
    pub state: &'static str,
    pub name: Option<String>,
    /// battery, percent (when the strap says)
    pub battery: Option<u8>,
    /// why it's not on, in words
    pub message: Option<String>,
}

/// The Heart Rate Measurement characteristic (Bluetooth's Heart Rate Service 1.0): flags, then the
/// rate as one byte or (flag bit 0) two, little endian. Bits 1–2: skin contact, when supported.
/// Bit 3: two bytes of energy expended follow. Bit 4: RR intervals follow, two bytes each, in
/// 1/1024 s.
pub fn parse(data: &[u8]) -> Option<Reading> {
    let flags = *data.first()?;
    let (bpm, mut at) = if flags & 1 == 0 { (u16::from(*data.get(1)?), 2) } else { (u16::from_le_bytes([*data.get(1)?, *data.get(2)?]), 3) };
    let contact = (flags & 0b100 != 0).then_some(flags & 0b10 != 0);
    if flags & 0b1000 != 0 {
        at += 2;
    }
    let mut rr = Vec::new();
    if flags & 0b1_0000 != 0 {
        while let (Some(lo), Some(hi)) = (data.get(at), data.get(at + 1)) {
            rr.push((u32::from(u16::from_le_bytes([*lo, *hi])) * 1000 / 1024) as u16);
            at += 2;
        }
    }
    Some(Reading { bpm, contact, rr })
}

async fn adapter() -> Result<Adapter> {
    let fail = |e: btleplug::Error| Error::known("heart-bluetooth", format!("Bluetooth isn't available: {e}"));
    let manager = Manager::new().await.map_err(fail)?;
    manager
        .adapters()
        .await
        .map_err(fail)?
        .into_iter()
        .next()
        .ok_or_else(|| Error::known("heart-bluetooth", "This PC has no Bluetooth (or it's switched off)."))
}

async fn is_strap(p: &Peripheral) -> Option<Device> {
    let props = p.properties().await.ok()??;
    // the search asks for the service; a strap that doesn't name it in its advertising still has a name
    if !props.services.contains(&HEART_RATE_SERVICE) && props.local_name.is_none() {
        return None;
    }
    Some(Device { id: p.id().to_string(), name: props.local_name.unwrap_or_else(|| "Heart rate monitor".into()), rssi: props.rssi })
}

/// Straps in reach (those advertising the Heart Rate Service), strongest first; Kodou first when
/// it's open and sharing (then even without Bluetooth here).
pub async fn scan() -> Result<Vec<Device>> {
    let kodou = kodou::find().await;
    let adapter = match adapter().await {
        Ok(a) => a,
        Err(_) if kodou.is_some() => return Ok(kodou.into_iter().collect()),
        Err(e) => return Err(e),
    };
    adapter
        .start_scan(ScanFilter { services: vec![HEART_RATE_SERVICE] })
        .await
        .map_err(|e| Error::known("heart-bluetooth", format!("Couldn't search: {e}")))?;
    tokio::time::sleep(SCAN_FOR).await;
    let found = adapter.peripherals().await.unwrap_or_default();
    let _ = adapter.stop_scan().await;
    let mut out = Vec::new();
    for p in found {
        if let Some(d) = is_strap(&p).await {
            out.push(d);
        }
    }
    out.sort_by_key(|d| std::cmp::Reverse(d.rssi.unwrap_or(i16::MIN)));
    if let Some(k) = kodou {
        out.insert(0, k);
    }
    Ok(out)
}

/// The connection wanted now: set to false, it ends.
static WANTED: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Ends the connection (if any).
pub fn disconnect() {
    if let Some(w) = WANTED.lock().unwrap_or_else(|e| e.into_inner()).take() {
        w.store(false, Ordering::SeqCst);
    }
}

/// Connects to the strap `id` (`name` for the words until it's there) and keeps it: `status` hears
/// how it goes, `reading` gets every reading. Replaces any connection before.
pub fn connect(id: String, name: String, status: impl Fn(Status) + Send + Sync + 'static, reading: impl Fn(Reading) + Send + Sync + 'static) {
    let wanted = Arc::new(AtomicBool::new(true));
    if let Some(old) = WANTED.lock().unwrap_or_else(|e| e.into_inner()).replace(wanted.clone()) {
        old.store(false, Ordering::SeqCst);
    }
    tauri::async_runtime::spawn(async move {
        let say = |state: &'static str, battery: Option<u8>, message: Option<String>| status(Status { state, name: Some(name.clone()), battery, message });
        while wanted.load(Ordering::SeqCst) {
            say("connecting", None, None);
            let on = |battery| say("on", battery, None);
            let result = if id == kodou::ID { kodou::run(&wanted, &on, &reading).await } else { run(&id, &wanted, &on, &reading).await };
            let why = match result {
                Ok(()) => None,
                Err(e) => Some(e.to_string()),
            };
            if !wanted.load(Ordering::SeqCst) {
                break;
            }
            say("lost", None, why);
            tokio::time::sleep(RETRY).await;
        }
        status(Status { state: "off", name: None, battery: None, message: None });
    });
}

/// One connection, until it drops or isn't wanted any more.
async fn run(id: &str, wanted: &AtomicBool, on: &(dyn Fn(Option<u8>) + Sync), reading: &(dyn Fn(Reading) + Send + Sync)) -> Result<()> {
    let adapter = adapter().await?;
    let gone = |e: btleplug::Error| Error::known("heart-lost", format!("The heart rate monitor dropped out: {e}"));
    // it has to be seen first (a search) before it can be connected to
    let _ = adapter.start_scan(ScanFilter { services: vec![HEART_RATE_SERVICE] }).await;
    let started = tokio::time::Instant::now();
    let strap = loop {
        if !wanted.load(Ordering::SeqCst) {
            let _ = adapter.stop_scan().await;
            return Ok(());
        }
        let found = adapter.peripherals().await.unwrap_or_default();
        if let Some(p) = found.into_iter().find(|p| p.id().to_string() == id) {
            break p;
        }
        if started.elapsed() > FIND_FOR {
            let _ = adapter.stop_scan().await;
            return Err(Error::known("heart-lost", "The heart rate monitor isn't in reach. Is it on, and not connected to another app?"));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    };
    let _ = adapter.stop_scan().await;
    if !strap.is_connected().await.unwrap_or(false) {
        strap.connect().await.map_err(gone)?;
    }
    strap.discover_services().await.map_err(gone)?;
    let chars = strap.characteristics();
    let measure = chars
        .iter()
        .find(|c| c.uuid == HEART_RATE_MEASUREMENT && c.properties.contains(CharPropFlags::NOTIFY))
        .cloned()
        .ok_or_else(|| Error::known("heart-lost", "That device doesn't share a heart rate."))?;
    let battery = match chars.iter().find(|c| c.uuid == BATTERY_LEVEL && c.properties.contains(CharPropFlags::READ)) {
        Some(c) => strap.read(c).await.ok().and_then(|v| v.first().copied()).filter(|b| *b <= 100),
        None => None,
    };
    strap.subscribe(&measure).await.map_err(gone)?;
    let mut notes = strap.notifications().await.map_err(gone)?;
    on(battery);
    let mut heard = tokio::time::Instant::now();
    let result = loop {
        if !wanted.load(Ordering::SeqCst) {
            break Ok(());
        }
        match tokio::time::timeout(Duration::from_millis(500), notes.next()).await {
            Ok(Some(n)) if n.uuid == HEART_RATE_MEASUREMENT => {
                heard = tokio::time::Instant::now();
                if let Some(r) = parse(&n.value) {
                    reading(r);
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => break Err(Error::known("heart-lost", "The heart rate monitor dropped out.")),
            Err(_) => {}
        }
        // nothing for a while: still connected? (a strap without skin contact may just be quiet)
        if heard.elapsed() > QUIET {
            if !strap.is_connected().await.unwrap_or(false) {
                break Err(Error::known("heart-lost", "The heart rate monitor dropped out."));
            }
            heard = tokio::time::Instant::now();
        }
    };
    let _ = strap.unsubscribe(&measure).await;
    let _ = strap.disconnect().await;
    result
}

/// Kodou, a heart rate app: while it's open it keeps the strap and shares it on 127.0.0.1:47830,
/// one JSON object per line (`hello` with its status, then `status` and `reading`). Picked like a
/// strap, with the id `kodou`; the readings then come from there, RR intervals included, and
/// both apps show the pulse.
mod kodou {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, BufReader, Lines};
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    use super::{Device, Reading};
    use crate::error::{Error, Result};

    pub const ID: &str = "kodou";
    const PORT: u16 = 47830;
    /// a line longer than this isn't Kodou
    const LONGEST: usize = 64 * 1024;

    fn closed() -> Error {
        Error::known("heart-lost", "Kodou isn't open, or isn't sharing.")
    }

    async fn open() -> Result<Lines<BufReader<TcpStream>>> {
        let sock = timeout(Duration::from_millis(800), TcpStream::connect(("127.0.0.1", PORT))).await.map_err(|_| closed())?.map_err(|_| closed())?;
        let _ = sock.set_nodelay(true);
        Ok(BufReader::new(sock).lines())
    }

    /// The next message, None for nothing within `wait`; an error once Kodou is gone.
    async fn next(lines: &mut Lines<BufReader<TcpStream>>, wait: Duration) -> Result<Option<Value>> {
        match timeout(wait, lines.next_line()).await {
            Err(_) => Ok(None),
            Ok(Ok(Some(line))) if line.len() <= LONGEST => Ok(serde_json::from_str(&line).ok()),
            Ok(_) => Err(closed()),
        }
    }

    /// Kodou, when it's open and sharing: "Kodou (the strap it has)".
    pub async fn find() -> Option<Device> {
        let mut lines = open().await.ok()?;
        let hello = next(&mut lines, Duration::from_millis(800)).await.ok()??;
        if hello["type"] != "hello" || hello["app"] != "kodou" {
            return None;
        }
        let strap = hello["status"]["name"].as_str().filter(|_| hello["status"]["state"] == "on");
        let name = match strap {
            Some(s) => format!("Kodou ({s})"),
            None => "Kodou".to_string(),
        };
        Some(Device { id: ID.into(), name, rssi: None })
    }

    /// One connection to Kodou, until it closes, loses its strap or isn't wanted any more.
    pub async fn run(wanted: &AtomicBool, on: &(dyn Fn(Option<u8>) + Sync), reading: &(dyn Fn(Reading) + Send + Sync)) -> Result<()> {
        let mut lines = open().await?;
        let mut is_on = false;
        let mut battery = None;
        while wanted.load(Ordering::SeqCst) {
            let Some(msg) = next(&mut lines, Duration::from_millis(500)).await? else { continue };
            let kind = msg["type"].as_str().unwrap_or_default().to_string();
            let status = match kind.as_str() {
                "hello" => msg.get("status").cloned().filter(|s| !s.is_null()),
                "status" => Some(msg),
                "reading" if is_on => {
                    if let Some(r) = parse_reading(&msg) {
                        reading(r);
                    }
                    None
                }
                _ => None,
            };
            let Some(s) = status else { continue };
            if s["state"] == "on" {
                let b = s["battery"].as_u64().and_then(|b| u8::try_from(b).ok()).filter(|b| *b <= 100);
                if !is_on || b != battery {
                    is_on = true;
                    battery = b;
                    on(battery);
                }
            } else if is_on {
                return Err(Error::known("heart-lost", "Kodou lost its heart rate monitor."));
            }
        }
        Ok(())
    }

    pub(super) fn parse_reading(v: &Value) -> Option<Reading> {
        let bpm = u16::try_from(v["bpm"].as_u64()?).ok()?;
        let contact = v["contact"].as_bool();
        let rr = v["rr"].as_array().map(|a| a.iter().filter_map(|x| x.as_u64().and_then(|n| u16::try_from(n).ok())).collect()).unwrap_or_default();
        Some(Reading { bpm, contact, rr })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readings_as_the_service_sends_them() {
        let r = |bpm, contact, rr: &[u16]| Some(Reading { bpm, contact, rr: rr.to_vec() });
        // one byte, no contact info
        assert_eq!(parse(&[0x00, 72]), r(72, None, &[]));
        // two bytes
        assert_eq!(parse(&[0x01, 0x2C, 0x01]), r(300, None, &[]));
        // contact supported: detected, then not
        assert_eq!(parse(&[0x06, 95]), r(95, Some(true), &[]));
        assert_eq!(parse(&[0x04, 0]), r(0, Some(false), &[]));
        // with RR intervals after it: 512/1024 s, then also 1024/1024 s
        assert_eq!(parse(&[0x16, 120, 0x00, 0x02]), r(120, Some(true), &[500]));
        assert_eq!(parse(&[0x16, 60, 0x00, 0x02, 0x00, 0x04]), r(60, Some(true), &[500, 1000]));
        // energy expended before them
        assert_eq!(parse(&[0x18, 80, 0x10, 0x00, 0x00, 0x03]), r(80, None, &[750]));
        // as Kodou passes them on
        let k = |s: &str| kodou::parse_reading(&serde_json::from_str(s).unwrap());
        assert_eq!(k(r#"{"type":"reading","bpm":92,"contact":true,"rr":[652,648]}"#), r(92, Some(true), &[652, 648]));
        assert_eq!(k(r#"{"type":"reading","bpm":70,"contact":null,"rr":[]}"#), r(70, None, &[]));
        assert_eq!(k(r#"{"type":"reading","bpm":-3}"#), None);
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&[0x01, 80]), None);
    }
}
