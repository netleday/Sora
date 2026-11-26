//! Discord Rich Presence (1.4 Live): Fumen's status in Discord, over Discord's local IPC (a named
//! pipe on Windows, a Unix socket elsewhere), without a crate: a frame is its opcode and length
//! (u32, little-endian) and then JSON. The window builds the activity (src/lib/discord.ts); this
//! keeps the connection, sends the newest activity at most once every few seconds (Discord takes
//! five updates in 20 s) and connects again when Discord comes back. Closing Fumen closes the pipe,
//! and Discord drops the status by itself.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Fumen's application in Discord's developer portal; its name is what Discord shows after
/// "Playing". Empty: not set up, and the status stays off.
pub const CLIENT_ID: &str = "1571535832924295269";
/// the least time between two updates (five in 20 s, with room)
const GAP: Duration = Duration::from_millis(4500);
/// how long to wait before looking for Discord again
const RETRY: Duration = Duration::from_secs(15);
/// a frame from Discord can't be bigger than this
const MAX_FRAME: usize = 1 << 20;

static TX: OnceLock<Mutex<Sender<Option<Value>>>> = OnceLock::new();
static CONNECTED: AtomicBool = AtomicBool::new(false);

/// Whether Fumen has a Discord application to show itself as.
pub fn configured() -> bool {
    !CLIENT_ID.is_empty()
}

/// Whether Discord is there right now.
pub fn connected() -> bool {
    CONNECTED.load(Ordering::Relaxed)
}

/// The status to show (None: none). Only the newest one counts; it goes out when Discord allows.
pub fn set(activity: Option<Value>) {
    if !configured() {
        return;
    }
    let tx = TX.get_or_init(|| {
        let (tx, rx) = channel();
        std::thread::Builder::new()
            .name("discord".into())
            .spawn(move || run(rx))
            .expect("discord thread");
        Mutex::new(tx)
    });
    if let Ok(tx) = tx.lock() {
        let _ = tx.send(activity);
    }
}

#[cfg(windows)]
type Pipe = std::fs::File;
#[cfg(unix)]
type Pipe = std::os::unix::net::UnixStream;

struct Conn {
    pipe: Pipe,
}

fn frame(op: u32, body: &Value) -> Vec<u8> {
    let data = body.to_string().into_bytes();
    let mut out = Vec::with_capacity(8 + data.len());
    out.extend_from_slice(&op.to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    out
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(u32, Value)> {
    let mut head = [0u8; 8];
    r.read_exact(&mut head)?;
    let op = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
    let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too big"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

/// Where Discord listens: discord-ipc-0 to -9, in the temp folders (and Flatpak's and Snap's).
#[cfg(unix)]
fn places() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .filter_map(|k| std::env::var_os(k).map(Into::into))
        .collect();
    dirs.push("/tmp".into());
    let mut out = Vec::new();
    for d in dirs {
        for sub in ["", "app/com.discordapp.Discord", "snap.discord", ".flatpak/dev.vencord.Vesktop/xdg-run"] {
            for i in 0..10 {
                out.push(d.join(sub).join(format!("discord-ipc-{i}")));
            }
        }
    }
    out
}

fn open_pipe() -> Option<Pipe> {
    #[cfg(windows)]
    {
        (0..10).find_map(|i| std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\.\pipe\discord-ipc-{i}")).ok())
    }
    #[cfg(unix)]
    {
        places().into_iter().find_map(|p| Pipe::connect(p).ok())
    }
}

impl Conn {
    /// Finds Discord and says hello; it answers with READY.
    fn open() -> Option<Conn> {
        let mut pipe = open_pipe()?;
        // a Discord that stops answering mustn't hold the status thread for good (Unix; Windows'
        // pipe has no timeout, and Discord answers every command)
        #[cfg(unix)]
        let _ = pipe.set_read_timeout(Some(Duration::from_secs(5)));
        pipe.write_all(&frame(0, &json!({ "v": 1, "client_id": CLIENT_ID }))).ok()?;
        let (op, msg) = read_frame(&mut pipe).ok()?;
        if op != 1 || msg.get("evt").and_then(Value::as_str) != Some("READY") {
            eprintln!("[discord] no hello: {msg}");
            return None;
        }
        Some(Conn { pipe })
    }

    /// Sends the status and reads Discord's answer to it. Both on this thread, one after the other:
    /// on Windows a pipe opened like this does one thing at a time, so a reader waiting on another
    /// thread would hold every write back (only the first update got through that way).
    fn send(&mut self, activity: &Option<Value>, nonce: u64) -> std::io::Result<()> {
        let mut args = json!({ "pid": std::process::id() });
        if let Some(a) = activity {
            args["activity"] = a.clone();
        }
        let nonce = nonce.to_string();
        let msg = json!({ "cmd": "SET_ACTIVITY", "args": args, "nonce": nonce });
        self.pipe.write_all(&frame(1, &msg))?;
        for _ in 0..16 {
            let (op, msg) = read_frame(&mut self.pipe)?;
            match op {
                // Discord closes: it says why
                2 => {
                    eprintln!("[discord] closed: {msg}");
                    return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Discord closed"));
                }
                // a ping wants its pong
                3 => self.pipe.write_all(&frame(4, &msg))?,
                _ if msg.get("nonce").and_then(Value::as_str) == Some(nonce.as_str()) => {
                    if msg.get("evt").and_then(Value::as_str) == Some("ERROR") {
                        eprintln!("[discord] {msg}");
                    }
                    return Ok(());
                }
                _ => {}
            }
        }
        Ok(())
    }
}

fn run(rx: Receiver<Option<Value>>) {
    let mut conn: Option<Conn> = None;
    // the status waiting to go out (Some(None): clear it)
    let mut pending: Option<Option<Value>> = None;
    let mut sent_at: Option<Instant> = None;
    let mut looked_at: Option<Instant> = None;
    let mut nonce = 0u64;
    loop {
        let now = Instant::now();
        let gap_left = sent_at.map_or(Duration::ZERO, |t| GAP.saturating_sub(now - t));
        let retry_left = if conn.is_none() { looked_at.map_or(Duration::ZERO, |t| RETRY.saturating_sub(now - t)) } else { Duration::ZERO };
        let wait = if pending.is_some() { gap_left.max(retry_left).max(Duration::from_millis(20)) } else { Duration::from_secs(60) };
        match rx.recv_timeout(wait) {
            Ok(a) => {
                pending = Some(a);
                continue;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let Some(activity) = pending.clone() else { continue };
        if sent_at.is_some_and(|t| t.elapsed() < GAP) {
            continue;
        }
        if conn.is_none() {
            // nothing to clear where nothing is shown
            if activity.is_none() {
                pending = None;
                continue;
            }
            if looked_at.is_some_and(|t| t.elapsed() < RETRY) {
                continue;
            }
            looked_at = Some(Instant::now());
            conn = Conn::open();
            CONNECTED.store(conn.is_some(), Ordering::Relaxed);
            if conn.is_none() {
                continue;
            }
        }
        nonce += 1;
        let ok = conn.as_mut().is_some_and(|c| c.send(&activity, nonce).is_ok());
        sent_at = Some(Instant::now());
        if ok {
            pending = None;
        } else {
            // Discord went: look for it again (soon, the status is still wanted)
            conn = None;
            CONNECTED.store(false, Ordering::Relaxed);
            looked_at = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_go_both_ways() {
        let body = json!({ "cmd": "SET_ACTIVITY", "nonce": "1" });
        let bytes = frame(1, &body);
        assert_eq!(&bytes[..4], &1u32.to_le_bytes());
        assert_eq!(u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize, bytes.len() - 8);
        let (op, back) = read_frame(&mut &bytes[..]).unwrap();
        assert_eq!(op, 1);
        assert_eq!(back, body);
    }

    #[test]
    fn a_frame_too_big_is_refused() {
        let mut bytes = 1u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(&((MAX_FRAME as u32) + 1).to_le_bytes());
        assert!(read_frame(&mut &bytes[..]).is_err());
    }
}

#[cfg(test)]
mod real {
    use super::*;

    /// Against the Discord running on this PC: three updates in a row and a clear, each answered.
    #[test]
    #[ignore]
    fn updates_keep_going_through() {
        let mut c = Conn::open().expect("Discord open?");
        for (i, s) in ["Test one", "Test two", "Test three"].iter().enumerate() {
            c.send(&Some(json!({ "type": 0, "details": s, "state": "Fumen check" })), i as u64 + 1).expect("sent and answered");
            std::thread::sleep(Duration::from_millis(1500));
        }
        c.send(&None, 9).expect("cleared");
    }
}
