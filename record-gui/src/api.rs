use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

pub const SIDECAR_ORIGIN: &str = "http://127.0.0.1:4317";
const SIDECAR_ADDR: &str = "127.0.0.1:4317";

#[derive(Debug, Clone, Deserialize)]
pub struct Step {
    pub index: usize,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    /// Human label of the target element; the "element" half of a step.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub ms: Option<f64>,
    #[serde(rename = "valueParam", default)]
    pub value_param: Option<String>,
    #[serde(default)]
    pub edited: bool,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    /// The locator the last replay actually resolved on. A value different
    /// from the first candidate means the primary locator no longer works.
    #[serde(rename = "resolvedLocator", default)]
    pub resolved_locator: Option<Candidate>,
    /// How long the replay waited for that locator to appear, in milliseconds.
    #[serde(rename = "locatorWaitMs", default)]
    pub locator_wait_ms: Option<f64>,
    /// 'locator-timeout' when every stored locator was given its full wait and
    /// none matched; 'action-failed' when one resolved but the action did not
    /// go through. The two need different fixes, so they are told apart.
    #[serde(rename = "failureKind", default)]
    pub failure_kind: Option<String>,
    /// A password field. Its `value` is only a mask; `secret_stored` says
    /// whether a real value is kept behind it, encrypted, for replay.
    #[serde(default)]
    pub secret: bool,
    #[serde(rename = "secretStored", default)]
    pub secret_stored: bool,
    /// What an upload step hands the file input.
    #[serde(default)]
    pub file: Option<UploadSpec>,
    /// How native alert/confirm/prompt dialogs raised by this step are answered.
    #[serde(default)]
    pub dialog: Option<Vec<DialogAnswer>>,
    /// Which tab the step acts in: 0 the main window, 1 the first popup, …
    #[serde(default)]
    pub page: usize,
    /// The iframe chain the step acts in, outermost first.
    #[serde(default)]
    pub frame: Option<Vec<FrameHop>>,
}

/// Where an upload step's file comes from.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UploadSpec {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub files: Vec<StoredFile>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub sample: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct StoredFile {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub missing: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct DialogAnswer {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub accept: bool,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FrameHop {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub index: Option<i64>,
}

impl FrameHop {
    fn describe(&self) -> String {
        if let Some(id) = self.id.as_deref().filter(|s| !s.is_empty()) {
            format!("#{id}")
        } else if let Some(n) = self.name.as_deref().filter(|s| !s.is_empty()) {
            format!("[name={n}]")
        } else if let Some(t) = self.title.as_deref().filter(|s| !s.is_empty()) {
            format!("\"{t}\"")
        } else {
            format!("frame {}", self.index.unwrap_or(0))
        }
    }
}

impl UploadSpec {
    /// What will be uploaded, as one line.
    pub fn describe(&self) -> String {
        match self.source.as_str() {
            "path" => format!("from disk: {}", self.paths.join(", ")),
            "sample" => format!(
                "generated sample {} ({})",
                self.name.clone().unwrap_or_default(),
                self.sample.clone().unwrap_or_else(|| "pdf".into())
            ),
            _ => {
                let names: Vec<String> = self
                    .files
                    .iter()
                    .map(|f| {
                        if f.missing {
                            format!("{} (contents not kept — attach it)", f.name)
                        } else {
                            format!("{} ({} KB)", f.name, (f.size + 1023) / 1024)
                        }
                    })
                    .collect();
                format!("stored with the flow: {}", names.join(", "))
            }
        }
    }
}

impl Step {
    /// Where the step acts, when that is not simply the main page: a popup, an
    /// iframe, or both. Empty for the common case.
    pub fn scope_note(&self) -> String {
        let mut parts = Vec::new();
        if self.page > 0 {
            parts.push(format!("in popup {}", self.page));
        }
        if let Some(frame) = self.frame.as_ref().filter(|f| !f.is_empty()) {
            let chain: Vec<String> = frame.iter().map(|h| h.describe()).collect();
            parts.push(format!("inside iframe {}", chain.join(" › ")));
        }
        parts.join(", ")
    }

    /// The dialog answers, one per line, as a reader would say them.
    pub fn dialog_notes(&self) -> Vec<String> {
        self.dialog
            .iter()
            .flatten()
            .map(|d| {
                let msg: String = d.message.chars().take(60).collect();
                match (d.kind.as_str(), d.accept) {
                    ("prompt", true) => format!("prompt \"{msg}\" → answer \"{}\"", d.text.clone().unwrap_or_default()),
                    ("prompt", false) => format!("prompt \"{msg}\" → cancel"),
                    ("confirm", true) => format!("confirm \"{msg}\" → OK"),
                    ("confirm", false) => format!("confirm \"{msg}\" → Cancel"),
                    (_, _) => format!("alert \"{msg}\" → OK"),
                }
            })
            .collect()
    }
}

impl Step {
    /// The target element, as a person would name it.
    pub fn target(&self) -> String {
        if let Some(label) = self.label.as_ref().filter(|l| !l.trim().is_empty()) {
            return label.trim().to_string();
        }
        self.candidates
            .first()
            .map(|c| c.describe())
            .unwrap_or_else(|| "element".to_string())
    }

    /// The literal value behind the step, ignoring any dataset parameter.
    /// This is what an editor seeds from: writing the rendered `${PARAM}` back
    /// into the step would turn a display placeholder into recorded data.
    pub fn literal_value(&self) -> String {
        match self.kind.as_str() {
            "press" => self.key.clone().unwrap_or_default(),
            "navigate" => self.url.clone().unwrap_or_default(),
            _ => self.value.as_ref().map(|v| v.as_text()).unwrap_or_default(),
        }
    }

    /// The value as the user sees it: the parameter name when one is set, the
    /// literal otherwise.
    pub fn raw_value(&self) -> String {
        match self.param_name() {
            name if !name.is_empty() => format!("${{{name}}}"),
            _ => self.literal_value(),
        }
    }

    pub fn param_name(&self) -> String {
        self.value_param.clone().unwrap_or_default()
    }

    pub fn is_param(&self) -> bool {
        self.value_param.as_ref().map(|p| !p.trim().is_empty()).unwrap_or(false)
    }

    /// A ready-made parameter name derived from the target, so promoting a
    /// value to a dataset column is one keystroke.
    pub fn suggested_param(&self) -> String {
        let words: Vec<String> = self
            .target()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .take(3)
            .map(|w| w.to_uppercase())
            .collect();
        let base = words.join("_");
        match self.kind.as_str() {
            "fill" => format!("{}_VALUE", if base.is_empty() { "TEXT".to_string() } else { base }),
            "select" => format!("{}_OPTION", if base.is_empty() { "OPTION".to_string() } else { base }),
            "press" => format!("{}_KEY", if base.is_empty() { "KEY".to_string() } else { base }),
            _ => {
                if base.is_empty() { "VALUE".to_string() } else { base }
            }
        }
    }

    /// The step as one sentence, in the phrasing Robot Framework uses: an
    /// action, its value, and the element it applies to.
    pub fn phrase(&self) -> String {
        let target = self.target();
        let value = self.raw_value();
        match self.kind.as_str() {
            "click" => format!("Click {target}"),
            "fill" if self.secret => format!("Enter password into {target}"),
            "fill" => format!("Enter {} into {target}", quote(&value)),
            "upload" => format!("Upload {} to {target}", quote(&value)),
            "select" => format!("Select {} in {target}", quote(&value)),
            "press" => format!("Press {value} on {target}"),
            "assertVisible" => format!("{target} is visible"),
            "navigate" => format!("Open {value}"),
            "wait" => format!("Wait {} ms", self.ms.unwrap_or(0.0)),
            other => format!("{other} {}", quote(&value)).trim().to_string(),
        }
    }
}

fn quote(s: &str) -> String {
    if s.starts_with("${") { s.to_string() } else { format!("\"{s}\"") }
}

/// A step value is a string in practice, but `select` records an array.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Text(String),
    List(Vec<String>),
}

impl Value {
    pub fn as_text(&self) -> String {
        match self {
            Value::Text(s) => s.clone(),
            Value::List(items) => items.join(", "),
        }
    }
}

// The code-independent vocabulary shared with the web UI and the recorder, in
// src/steps.js. Kept in sync by hand: it is seven entries, and a cross-process
// fetch on every dropdown open would be slower and more fragile than this.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Action {
    pub id: &'static str,
    pub label: &'static str,
    pub value_label: &'static str,
    pub needs_value: bool,
    pub needs_target: bool,
}

pub const ACTIONS: &[Action] = &[
    // Navigation is an action like any other. It used to be dictated by the
    // recording, but then the start URL was a separate field that was not part
    // of the flow at all — so the flow could not be re-pointed at a different
    // URL without discarding the recording. As step 1 it is edited, reordered
    // and replayed like everything else.
    Action { id: "navigate", label: "Open URL", value_label: "URL", needs_value: true, needs_target: false },
    Action { id: "click", label: "Click", value_label: "—", needs_value: false, needs_target: true },
    Action { id: "fill", label: "Enter text", value_label: "Text", needs_value: true, needs_target: true },
    Action { id: "select", label: "Select option", value_label: "Option", needs_value: true, needs_target: true },
    Action { id: "press", label: "Press key", value_label: "Key", needs_value: true, needs_target: true },
    // The file is chosen in the step panel — stored with the flow, picked from
    // disk, or generated — not typed, so there is no value box.
    Action { id: "upload", label: "Upload file", value_label: "File", needs_value: false, needs_target: true },
    Action { id: "assertVisible", label: "Assert visible", value_label: "—", needs_value: false, needs_target: true },
    Action { id: "wait", label: "Wait", value_label: "Milliseconds", needs_value: true, needs_target: false },
    // A picture the flow asks for on purpose. The per-step snapshots are taken
    // anyway to explain a failure; this one is a claim about the page, so it is
    // named by whoever wrote the step.
    Action { id: "screenshot", label: "Take screenshot", value_label: "Name", needs_value: true, needs_target: false },
];

// A step the user may edit. Everything in `ACTIONS` qualifies, including
// navigation: the whole point of moving the start URL into step 1 is that it is
// part of the flow rather than a property of the session.
pub fn is_editable(kind: &str) -> bool {
    ACTIONS.iter().any(|a| a.id == kind)
}

pub fn action_for(kind: &str) -> Option<&'static Action> {
    ACTIONS.iter().find(|a| a.id == kind)
}

// One entry in a step's fallback ladder, most reliable first. The GUI shows
// these so a user can see how resilient a step is before replaying it, and
// writes them back so the ladder can be hand-corrected when the recording got
// it wrong.
#[derive(Debug, Clone, Default, Deserialize, serde::Serialize)]
pub struct Candidate {
    pub strategy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Candidate {
    /// Whether this rung carries nothing that could find an element.
    ///
    /// A rung that is empty does not sit in the ladder harmlessly: replay waits
    /// out its full share of the budget on it before moving on, so saving one
    /// costs a run real seconds and can still fail on the rungs that were fine.
    /// A role rung counts as filled when either half identifies the element —
    /// an unnamed "any button" is a legitimate way to say "the only one".
    pub fn is_empty(&self) -> bool {
        let value = self.value.as_deref().unwrap_or_default().trim();
        if !value.is_empty() {
            return false;
        }
        if self.strategy == "role" {
            let role = self.role.as_deref().unwrap_or_default().trim();
            let name = self.name.as_deref().unwrap_or_default().trim();
            return role.is_empty() && name.is_empty();
        }
        true
    }
}


impl PartialEq for Candidate {
    /// Two candidates that describe the same element resolve identically, so
    /// identity is the description and nothing else. Comparing only
    /// `strategy` would call `css=a` and `role=link "a"` the same rung.
    fn eq(&self, other: &Self) -> bool {
        self.describe() == other.describe()
    }
}

impl Candidate {
    pub fn describe(&self) -> String {
        match self.strategy.as_str() {
            "role" => format!(
                "role={} \"{}\"",
                self.role.clone().unwrap_or_default(),
                self.name.clone().unwrap_or_default()
            ),
            _ => format!("{}={}", self.strategy, self.value.clone().unwrap_or_default()),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Replay {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub passed: usize,
    #[serde(default)]
    pub failed: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub replay: Option<Replay>,
    /// Past runs, newest first.
    #[serde(default)]
    pub runs: Vec<Run>,
    /// Which folder this flow is filed under.
    #[serde(default)]
    pub folder: Option<String>,
}

/// A dataset parameter: its name and the value recorded against it.
#[derive(Debug, Clone)]
pub struct Param {
    pub name: String,
    pub recorded: String,
}

impl Session {
    /// Every dataset parameter this flow uses, in the order first referenced.
    /// A run is described by these, so the GUI offers exactly the fields a
    /// dataset can hold.
    pub fn params(&self) -> Vec<Param> {
        let mut seen: Vec<Param> = Vec::new();
        for s in &self.steps {
            if let Some(name) = &s.value_param {
                if !name.trim().is_empty() && !seen.iter().any(|p| &p.name == name) {
                    seen.push(Param {
                        name: name.clone(),
                        recorded: s.literal_value(),
                    });
                }
            }
        }
        seen
    }
}

#[derive(Debug, Deserialize)]
struct SessionEnvelope {
    session: Session,
}

// The sidecar emits camelCase (`demoUrl`); the GUI only ever reads the value.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    #[serde(default)]
    pub demo_url: String,
    #[serde(default)]
    pub browser: String,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(300))
        .timeout_write(Duration::from_secs(30))
        .build()
}

fn body_string(res: ureq::Response) -> Result<String, String> {
    res.into_string().map_err(|e| e.to_string())
}

pub fn health() -> Result<Health, String> {
    let res = agent()
        .get(&format!("{SIDECAR_ORIGIN}/api/health"))
        .call()
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str(&body).map_err(|e| format!("{e}"))
}

/// Body for `POST /api/sessions`. Built with serde rather than by hand:
/// string-splicing JSON is how a missing brace silently drops every field after
/// the first, and the sidecar parses a malformed body as `{}` without
/// complaining.
#[derive(Debug, Default, serde::Serialize)]
struct CreateSessionBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(rename = "startUrl", skip_serializing_if = "Option::is_none")]
    start_url: Option<&'a str>,
}

pub fn create_session(name: Option<&str>, start_url: Option<&str>) -> Result<Session, String> {
    // Empty inputs are dropped so the sidecar applies its own defaults: a
    // generated name, and about:blank for the user to navigate from.
    let body = CreateSessionBody {
        name: name.map(str::trim).filter(|n| !n.is_empty()),
        start_url: start_url.map(str::trim).filter(|u| !u.is_empty()),
    };
    let payload = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/sessions"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| format!("{e}"))
}

/// Step fields the editor sends back. `param` non-empty promotes the value to
/// a dataset parameter; empty means the literal value is authoritative.
///
/// Owns its strings rather than borrowing so it can cross a thread boundary
/// into the worker that performs the request.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct StepEdit {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// Where a navigate step goes. A separate field from `value` because the
    /// replayer reads `step.url`, and sending the URL as `value` would leave
    /// the step pointing at wherever it was recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub param: Option<String>,
    /// A hand-corrected locator ladder. The server replaces the step's whole
    /// chain and makes the first entry the primary, so the order here is the
    /// order replay tries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<Candidate>>,
    /// A new password for a secret step. Sealed by the sidecar on arrival; the
    /// GUI never receives the stored one back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// An upload step's file choice.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<FileChoice>,
}

/// How an upload step should get its file — see `applyFile` in the sidecar.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct FileChoice {
    pub source: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attach: Vec<Attachment>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Attachment {
    pub name: String,
    #[serde(rename = "type")]
    pub mime: String,
    /// File bytes, base64.
    pub data: String,
}

pub fn edit_step(id: &str, index: usize, edit: &StepEdit) -> Result<Session, String> {
    let payload = serde_json::to_string(edit).map_err(|e| e.to_string())?;
    let res = agent()
        .request("PATCH", &format!("{SIDECAR_ORIGIN}/api/sessions/{id}/step/{index}"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| format!("{e}"))
}

pub fn delete_step(id: &str, index: usize) -> Result<Session, String> {
    let res = agent()
        .delete(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/step/{index}"))
        .call()
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| format!("{e}"))
}

pub fn stop_recording(id: &str) -> Result<Session, String> {
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/stop"))
        .send_string("")
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| e.to_string())
}

/// Pauses or resumes an in-progress recording. The browser stays open either
/// way: pausing only stops collecting steps.
pub fn pause_recording(id: &str, resume: bool) -> Result<Session, String> {
    let verb = if resume { "resume" } else { "pause" };
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/{verb}"))
        .send_string("")
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| e.to_string())
}

/// Pauses or resumes a running replay. `Ok(false)` means there was no replay
/// to control, which is an answer rather than a failure: the caller is a
/// button that has to decide whether the press was meant for a replay or a
/// recording, and its own view of which is live can be a moment out of date.
pub fn pause_replay(id: &str, resume: bool) -> Result<bool, String> {
    let verb = if resume { "replay-resume" } else { "replay-pause" };
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/{verb}"))
        .send_string("")
        .map_err(|e| e.to_string())?;
    control_result(res)
}

/// Ends a running replay, keeping the run's record and screenshots. `Ok(false)`
/// means there was no run to end.
pub fn interrupt_replay(id: &str) -> Result<bool, String> {
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/replay-interrupt"))
        .send_string("")
        .map_err(|e| e.to_string())?;
    control_result(res)
}

/// Whether a control request found a run to act on.
fn control_result(res: ureq::Response) -> Result<bool, String> {
    let body = body_string(res)?;
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(parsed.get("running").and_then(|v| v.as_bool()).unwrap_or(false))
}

/// Adds a step at `at`, shifting the rest down. The server decides the resulting
/// indexes, since inserting renumbers every step after it.
pub fn insert_step(
    id: &str,
    at: usize,
    action: &str,
    label: &str,
    value: &str,
    param: &str,
) -> Result<Session, String> {
    let payload = serde_json::json!({
        "at": at,
        "type": action,
        "label": label,
        "value": value,
        "param": param,
    });
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/steps"))
        .send_string(&payload.to_string())
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| e.to_string())
}

/// Moves the step at `from` to position `to`. Both are 1-based indexes the user
/// can see; the server renumbers everything, so the returned session is the
/// authoritative order rather than a guess made locally.
pub fn reorder_step(id: &str, from: usize, to: usize) -> Result<Session, String> {
    let payload = serde_json::json!({ "from": from, "to": to }).to_string();
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/steps/reorder"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| e.to_string())
}

/// Records one action in the browser and inserts it at `at`. Blocks until the
/// user acts, closes the window, or cancels, so the caller cannot assume the
/// step exists on return.
pub fn capture_step(id: &str, at: usize) -> Result<Session, String> {
    let payload = serde_json::json!({ "at": at }).to_string();
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/capture"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| e.to_string())
}

/// Abandons a capture whose browser is still open. Needed because the blocking
/// call above cannot be cancelled from the thread that is drawing the form.
pub fn cancel_capture(id: &str) -> Result<(), String> {
    let res = agent()
        .delete(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/capture"))
        .call()
        .map_err(|e| e.to_string())?;
    if res.status() == 200 {
        Ok(())
    } else {
        Err(body_string(res).unwrap_or_default())
    }
}

/// A stored recording, for the history list. Fewer fields than `Session`: the
/// list only needs enough to name and identify each entry.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub step_count: usize,
    #[serde(default)]
    pub created_at: i64,
    /// Which folder it is filed under, so the sidebar can filter by it.
    #[serde(default)]
    pub folder: Option<String>,
    /// How many times this flow has been replayed.
    #[serde(default)]
    pub run_count: usize,
}

/// "just now" / "12m ago" / "3d ago". Long flows accumulate over days, and a
/// bare timestamp is more work to read than a relative one. The sidecar sends
/// milliseconds since the epoch.
pub fn relative_time(created_at_ms: i64) -> String {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(created_at_ms);
    let secs = (now_ms - created_at_ms) / 1000;
    if secs < 60 {
        "just now".to_string()
    } else if secs < 3600 {
        format!("{}m ago", secs / 60)
    } else if secs < 86_400 {
        format!("{}h ago", secs / 3600)
    } else {
        format!("{}d ago", secs / 86_400)
    }
}

#[derive(Debug, Deserialize)]
struct ListEnvelope {
    sessions: Vec<Summary>,
}

pub fn list_sessions() -> Result<Vec<Summary>, String> {
    let res = agent()
        .get(&format!("{SIDECAR_ORIGIN}/api/sessions"))
        .call()
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<ListEnvelope>(&body)
        .map(|e| e.sessions)
        .map_err(|e| format!("{e}"))
}

pub fn get_session(id: &str) -> Result<Session, String> {
    let res = agent()
        .get(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}"))
        .call()
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| format!("{e}"))
}

/// The generated Playwright spec, or `None` when the flow has not been
/// exported yet.
pub fn get_spec(id: &str) -> Result<Option<String>, String> {
    let res = agent()
        .get(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/spec"))
        .call()
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("{e}"))?;
    Ok(parsed
        .get("spec")
        .and_then(|s| s.get("code"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string()))
}

pub fn delete_session(id: &str) -> Result<(), String> {
    agent()
        .delete(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}"))
        .call()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Live event feed for one session. Yields the raw JSON of each SSE `data:`
/// payload; the caller parses what it needs. Hand-rolled because SSE never ends
/// and ureq buffers the whole response body.
pub fn subscribe(session_id: &str) -> Result<Receiver<String>, String> {
    let mut stream = TcpStream::connect(SIDECAR_ADDR).map_err(|e| e.to_string())?;
    let request = format!(
        "GET /api/sessions/{session_id}/events HTTP/1.1\r\nHost: {SIDECAR_ADDR}\r\nAccept: text/event-stream\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        let mut past_headers = false;

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if !past_headers {
                if line.trim().is_empty() {
                    past_headers = true;
                }
                continue;
            }
            if let Some(payload) = line.trim_start().strip_prefix("data:") {
                if tx.send(payload.trim().to_string()).is_err() {
                    break;
                }
            }
        }
    });

    Ok(rx)
}

/// A folder recordings are filed under. `system` folders are built in and
/// cannot be renamed or deleted.
#[derive(Debug, Clone, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub system: bool,
    #[serde(default)]
    pub count: usize,
    /// The folder this one nests under, when it is a sub-folder. Absent for
    /// top-level folders, including the built-in one.
    #[serde(default)]
    pub parent: Option<String>,
    /// Folders nested under this one. Empty for the built-in folder and for any
    /// folder at the leaf of the tree.
    #[serde(default)]
    pub children: Vec<Folder>,
}

/// A reusable group of steps. The steps themselves are not sent to the GUI: it
/// needs the name and the count to offer and describe the subflow, and asking
/// for the full list would mean transferring every recorded locator just to
/// draw a menu entry.
#[derive(Debug, Clone, Deserialize)]
pub struct Subflow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub step_count: usize,
    #[serde(default)]
    pub created_at: i64,
}

/// One past run of a flow. Kept because a green run followed by a red one is
/// evidence: without history only the latest outcome survives.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub status: String,
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    #[serde(default)]
    pub started_at: Option<f64>,
    #[serde(default)]
    pub finished_at: Option<f64>,
    /// NAME -> value actually used, each flagged when it came from the caller.
    #[serde(default)]
    pub dataset: Vec<DatasetEntry>,
    #[serde(default)]
    pub steps: Vec<RunStep>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DatasetEntry {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub overridden: bool,
}

/// A step's outcome within one run: what it was, how long it took, which
/// locator resolved, and the screenshot taken after it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStep {
    pub index: usize,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub shot: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<f64>,
    /// The rung that actually resolved. Absent for a step that does not use a
    /// locator — a navigation, a wait, a screenshot.
    #[serde(default)]
    pub locator: Option<Candidate>,
    /// Which rung of the ladder it was: 0 is the locator the recording chose,
    /// higher numbers are fallbacks. Recorded because "passed" and "passed on
    /// the last thing it tried" are very different states for a test to be in.
    #[serde(default)]
    pub locator_rung: Option<i64>,
    #[serde(default)]
    pub locator_count: usize,
    #[serde(default)]
    pub locator_wait_ms: Option<f64>,
    /// The files an upload step sent in this run, "name (N bytes)".
    #[serde(default)]
    pub uploaded: Option<Vec<String>>,
}

impl RunStep {
    /// What to call this step in a report. The recorded title, falling back to
    /// the action and its target so a row is never just a number.
    pub fn name(&self) -> String {
        if !self.title.trim().is_empty() {
            return self.title.clone();
        }
        match self.label.as_deref().map(str::trim).filter(|l| !l.is_empty()) {
            Some(label) => label.to_string(),
            None => self.kind.clone(),
        }
    }

    /// How this step's locator turned out, in the words a reader wants:
    /// nothing for a step that has no locator, "the one recorded" when the
    /// primary rung worked, and "fell back to N of M" when it did not.
    pub fn locator_note(&self) -> String {
        // The position fallback is the rung one past the ladder. It is named
        // as what it is, because "fell back to 6 of 5" would read as a bug and
        // hide the one fact that matters: no locator matched, and the click was
        // made by where the element used to be — verified, but weaker.
        if self.locator.as_ref().is_some_and(|c| c.strategy == "position") {
            return "no locator matched — clicked by recorded position (verified)".to_string();
        }
        match self.locator_rung {
            Some(rung) if rung < 0 => String::new(),
            Some(0) => "locator as recorded".to_string(),
            Some(rung) => format!(
                "fell back to {} of {}",
                rung + 1,
                self.locator_count
            ),
            None => String::new(),
        }
    }

    /// The rung that resolved, as Playwright source.
    pub fn locator_source(&self) -> String {
        self.locator.as_ref().map(|c| c.describe()).unwrap_or_default()
    }

    /// Whether this step carries a picture the reader asked for. A `screenshot`
    /// step is one the flow was told to take; the snapshot written after every
    /// other step is not one of these.
    pub fn is_asked_for_shot(&self) -> bool {
        self.kind == "screenshot" && self.shot.is_some()
    }

}

impl Run {
    /// How long the run took, in whole seconds.
    pub fn duration_s(&self) -> u64 {
        match (self.started_at, self.finished_at) {
            (Some(a), Some(b)) if b >= a => ((b - a) / 1000.0).round() as u64,
            _ => 0,
        }
    }

    /// The pictures the flow asked for, in step order.
    ///
    /// Only `screenshot` steps qualify. Every step gets an automatic snapshot
    /// after it runs, so filtering on "has a picture" matched all of them and
    /// the viewer paged through a dozen pages of "click" to reach the two
    /// pictures anyone had actually asked for. Those snapshots still exist, and
    /// are still what a failed step is diagnosed from — they are just not what
    /// this list is for.
    pub fn shots(&self) -> Vec<&RunStep> {
        self.steps
            .iter()
            .filter(|s| s.kind == "screenshot" && s.shot.is_some())
            .collect()
    }
}

#[derive(Deserialize)]
struct FolderList {
    folders: Vec<Folder>,
}

#[derive(Deserialize)]
struct FolderOne {
    folder: Folder,
}

#[derive(Deserialize)]
struct SubflowList {
    subflows: Vec<Subflow>,
}

#[derive(Deserialize)]
struct SubflowOne {
    subflow: Subflow,
}

pub fn list_subflows() -> Result<Vec<Subflow>, String> {
    let res = agent()
        .get(&format!("{SIDECAR_ORIGIN}/api/subflows"))
        .call()
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SubflowList>(&body)
        .map(|e| e.subflows)
        .map_err(|e| e.to_string())
}

/// Saves steps `from..=to` of a flow as a subflow. The steps stay in the flow:
/// saving a copy is what makes it reusable, and removing them would be a
/// separate, explicit action.
pub fn create_subflow(
    session_id: &str,
    name: &str,
    from: usize,
    to: usize,
) -> Result<Subflow, String> {
    let payload = serde_json::json!({
        "sessionId": session_id,
        "name": name,
        "from": from,
        "to": to,
    })
    .to_string();
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/subflows"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SubflowOne>(&body)
        .map(|e| e.subflow)
        .map_err(|e| e.to_string())
}

/// Drops a subflow's steps into a flow at `at`.
pub fn import_subflow(id: &str, session_id: &str, at: usize) -> Result<Session, String> {
    let payload = serde_json::json!({ "sessionId": session_id, "at": at }).to_string();
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/subflows/{id}/import"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<SessionEnvelope>(&body)
        .map(|e| e.session)
        .map_err(|e| e.to_string())
}

pub fn delete_subflow(id: &str) -> Result<(), String> {
    agent()
        .delete(&format!("{SIDECAR_ORIGIN}/api/subflows/{id}"))
        .call()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn list_folders() -> Result<Vec<Folder>, String> {
    let res = agent()
        .get(&format!("{SIDECAR_ORIGIN}/api/folders"))
        .call()
        .map_err(|e| e.to_string())?;
    let body = body_string(res)?;
    serde_json::from_str::<FolderList>(&body)
        .map(|e| e.folders)
        .map_err(|e| e.to_string())
}

pub fn create_folder(name: &str, parent: Option<&str>) -> Result<Folder, String> {
    let payload = serde_json::json!({ "name": name, "parent": parent }).to_string();
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/folders"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    serde_json::from_str::<FolderOne>(&body_string(res)?)
        .map(|e| e.folder)
        .map_err(|e| e.to_string())
}

pub fn rename_folder(id: &str, name: &str) -> Result<Folder, String> {
    let payload = serde_json::json!({ "name": name }).to_string();
    let res = agent()
        .request("PATCH", &format!("{SIDECAR_ORIGIN}/api/folders/{id}"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    serde_json::from_str::<FolderOne>(&body_string(res)?)
        .map(|e| e.folder)
        .map_err(|e| e.to_string())
}

pub fn delete_folder(id: &str) -> Result<(), String> {
    agent()
        .delete(&format!("{SIDECAR_ORIGIN}/api/folders/{id}"))
        .call()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub fn move_to_folder(session_id: &str, folder_id: Option<&str>) -> Result<Session, String> {
    let payload = serde_json::json!({ "folder": folder_id }).to_string();
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/folders/move/{session_id}"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    serde_json::from_str::<SessionEnvelope>(&body_string(res)?)
        .map(|e| e.session)
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct ReplayOne {
    replay: Replay,
}

/// Starts a replay, optionally with values for the flow's parameters.
pub fn start_replay_with(id: &str, dataset: &[(String, String)]) -> Result<Replay, String> {
    let map: serde_json::Map<String, serde_json::Value> =
        dataset.iter().map(|(k, v)| (k.clone(), serde_json::json!(v))).collect();
    let payload = serde_json::json!({ "dataset": map }).to_string();
    let res = agent()
        .post(&format!("{SIDECAR_ORIGIN}/api/sessions/{id}/replay"))
        .send_string(&payload)
        .map_err(|e| e.to_string())?;
    serde_json::from_str::<ReplayOne>(&body_string(res)?)
        .map(|e| e.replay)
        .map_err(|e| e.to_string())
}

/// URL of a step screenshot, served by the sidecar.
pub fn shot_url(session_id: &str, file: &str) -> String {
    format!("{SIDECAR_ORIGIN}/api/sessions/{session_id}/shot/{file}")
}