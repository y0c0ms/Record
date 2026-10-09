//! Starts the Node sidecar when the GUI opens and finds none running, and stops
//! it again when the GUI closes.
//!
//! A sidecar that was already running — started by hand, by the CLI, or by
//! another GUI — is used as it is and left running: this process did not start
//! it, so it does not own it. Only a sidecar spawned here is stopped on exit.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::api;

/// The sidecar this GUI started, if any. Held so it can be stopped on exit.
static OWNED: Mutex<Option<Child>> = Mutex::new(None);

/// How long a freshly started sidecar is given to answer its health check.
/// Node and the server load in about a second; the margin covers a cold disk.
const READY_WITHIN: Duration = Duration::from_secs(20);

/// The project root: the directory holding `server/index.js`. `RECORD_HOME`
/// wins when set; otherwise the exe's own ancestors are searched, which finds
/// the project from `record-slint/target/release/` or from an install
/// directory that ships the sidecar beside the exe.
pub fn project_root() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("RECORD_HOME") {
        let home = PathBuf::from(home);
        if is_root(&home) {
            return Some(home);
        }
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().skip(1).find(|dir| is_root(dir)).map(Path::to_path_buf)
}

fn is_root(dir: &Path) -> bool {
    dir.join("server").join("index.js").is_file()
}

/// Makes sure a sidecar is answering, starting one if needed. Blocking: run it
/// on a worker thread. Returns the health of the sidecar that answered.
pub fn ensure_running() -> Result<api::Health, String> {
    if let Ok(health) = api::health() {
        return Ok(health);
    }
    let root = project_root().ok_or_else(|| {
        "no sidecar is running and the Record project (server/index.js) was not found next to this program; set RECORD_HOME to the project folder".to_string()
    })?;
    let mut command = Command::new(node_exe());
    command
        .arg(root.join("server").join("index.js"))
        .current_dir(&root)
        .stdin(Stdio::null())
        // The sidecar logs to stderr; with no console there is nobody to read
        // it, so it goes to a file a person can open when something is wrong.
        .stdout(log_file(&root).map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(log_file(&root).map(Stdio::from).unwrap_or_else(Stdio::null));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window: the GUI is the only window the user should see.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|e| format!("could not start the sidecar with node: {e}"))?;
    *OWNED.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);

    let started = Instant::now();
    loop {
        if let Ok(health) = api::health() {
            return Ok(health);
        }
        // A sidecar that exited (a port already taken by something else, a
        // syntax error) will never answer; say so now rather than after 20s.
        if let Some(status) = OWNED
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
            .and_then(|c| c.try_wait().ok().flatten())
        {
            OWNED.lock().unwrap_or_else(|p| p.into_inner()).take();
            return Err(format!(
                "the sidecar exited at startup ({status}); see {}",
                root.join("data").join("sidecar.log").display()
            ));
        }
        if started.elapsed() > READY_WITHIN {
            return Err(format!("the sidecar did not answer within {}s", READY_WITHIN.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Stops the sidecar if this GUI started it. Called when the window closes.
pub fn stop_owned() {
    if let Some(mut child) = OWNED.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// `node` from PATH. A GUI started from the Start menu or a shortcut inherits
/// the user's PATH, so this is the same node `npm start` would use.
fn node_exe() -> PathBuf {
    std::env::var_os("RECORD_NODE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("node"))
}

fn log_file(root: &Path) -> Option<std::fs::File> {
    let dir = root.join("data");
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new().create(true).append(true).open(dir.join("sidecar.log")).ok()
}
