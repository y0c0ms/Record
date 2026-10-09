// The app's data: what the sidecar told us, what the user is editing, and which
// view is on screen. No rendering lives here — `present.rs` turns this into the
// view models the Slint UI draws, so the two can change independently.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::Sender;

use serde::Deserialize;

use crate::api;

/// One message from the sidecar's event stream.
#[derive(Debug, Deserialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub session: Option<api::Session>,
    #[serde(default)]
    pub step: Option<api::Step>,
    #[serde(default)]
    pub replay: Option<api::Replay>,
    /// Emitted once a run finishes. Without it the run history stays empty
    /// however many replays were made, because nothing else carries a finished
    /// run to the client.
    #[serde(default)]
    pub run: Option<api::Run>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    /// No-code editor: action dropdown plus value and element.
    Steps,
    /// Generated Playwright spec.
    Code,
    /// Past runs: outcome, dataset used, and the screenshots to review.
    Runs,
    /// Parameters for this flow and what to feed them on the next run.
    Dataset,
}

impl View {
    pub fn index(self) -> i32 {
        match self {
            View::Steps => 0,
            View::Code => 1,
            View::Runs => 2,
            View::Dataset => 3,
        }
    }
    pub fn from_index(i: i32) -> Self {
        match i {
            1 => View::Code,
            2 => View::Runs,
            3 => View::Dataset,
            _ => View::Steps,
        }
    }
}

/// What the step side panel is showing. A step has more to say than fits on its
/// row — the value, the dataset parameter, and the whole locator ladder — so the
/// panel is tabbed rather than one long scroll.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PanelTab {
    Step,
    Locators,
    Raw,
}

impl PanelTab {
    pub fn index(self) -> i32 {
        match self {
            PanelTab::Step => 0,
            PanelTab::Locators => 1,
            PanelTab::Raw => 2,
        }
    }
    pub fn from_index(i: i32) -> Self {
        match i {
            1 => PanelTab::Locators,
            2 => PanelTab::Raw,
            _ => PanelTab::Step,
        }
    }
}

/// The step the side panel is open on. `None` closes the panel; the panel never
/// exists without a step behind it.
#[derive(Clone)]
pub struct StepPanel {
    pub index: usize,
    pub tab: PanelTab,
    /// The locator ladder as edited but not yet saved. A copy rather than an
    /// in-place edit: a half-typed selector is not a selector, and saving on
    /// every keystroke would push broken rungs to the server. `None` means
    /// "not being edited".
    pub locators: Option<Vec<api::Candidate>>,
}

/// An in-progress folder create or rename. Held locally so typing does not
/// round-trip on every keystroke.
#[derive(Clone)]
pub struct FolderDraft {
    /// `None` creates a folder; `Some` renames this one.
    pub id: Option<String>,
    pub name: String,
    /// The folder a new one nests under. Renaming ignores it.
    pub parent: Option<String>,
}

/// A step being added by hand between two recorded ones.
#[derive(Clone)]
pub struct InsertDraft {
    /// Index the new step takes (1-based).
    pub at: usize,
    pub action: String,
    pub label: String,
    pub value: String,
    pub param: String,
    /// How a check compares its expected value.
    pub match_mode: String,
    /// The user chose to record the step in the browser instead of typing it.
    pub recording: bool,
}

/// A contiguous run of steps selected to be saved as a reusable subflow.
#[derive(Clone)]
pub struct SubflowDraft {
    pub from: usize,
    pub to: usize,
    pub name: String,
}

/// Values supplied for the next run, as (parameter, value). Empty means "use
/// what was recorded", which is why empty is allowed rather than rejected.
#[derive(Clone, Default)]
pub struct DatasetDraft {
    pub values: Vec<(String, String)>,
}

/// A decoded screenshot, cached by URL. `None` records a failed load so a
/// missing file is not refetched on every update.
pub type ShotCache = HashMap<String, Option<slint::SharedPixelBuffer<slint::Rgba8Pixel>>>;

/// Everything a worker thread can report back. Workers never touch the UI or
/// the state directly; they send one of these and the UI thread applies it.
pub enum Msg {
    Connected(Result<api::Health, String>),
    Started(Result<api::Session, String>),
    Stopped(Result<api::Session, String>),
    Event(Event),
    StreamClosed(String),
    History(Result<Vec<api::Summary>, String>),
    Loaded(Result<api::Session, String>),
    Spec(Result<Option<String>, String>),
    SpecRefresh(String),
    Deleted(Result<String, String>),
    StepEdited(Result<api::Session, String>),
    StepDeleted(Result<api::Session, String>),
    StepReordered(Result<api::Session, String>),
    Folders(Result<Vec<api::Folder>, String>),
    FolderSaved(Result<api::Folder, String>),
    FolderDeleted(Result<(), String>),
    Moved(Result<api::Session, String>),
    ReplayStarted(Result<api::Replay, String>),
    PauseToggled(Result<api::Session, String>),
    ReplayControl(Result<(), String>),
    ShotLoaded(String, Option<slint::SharedPixelBuffer<slint::Rgba8Pixel>>),
    Inserted(Result<api::Session, String>),
    Captured(Result<api::Session, String>),
    CaptureCancelled(Result<(), String>),
    Subflows(Result<Vec<api::Subflow>, String>),
    SubflowSaved(Result<api::Subflow, String>),
    SubflowImported(Result<api::Session, String>),
    SubflowDeleted(Result<String, String>),
    /// A retry of the event stream is due for this session.
    Resubscribe(String),
}

pub struct RecordApp {
    pub tx: Sender<Msg>,
    pub sidecar_ok: bool,
    pub browser: String,
    pub demo_url: String,
    pub flow_name: String,
    pub start_url: String,
    pub history: Vec<api::Summary>,
    pub spec_code: String,
    pub view: View,
    pub folders: Vec<api::Folder>,
    /// The folder the recordings list is filtered to. `None` is "All".
    pub active_folder: Option<String>,
    pub search: String,
    /// Folder ids the user opened in the tree. Folders start closed — a
    /// folder holding hundreds of recordings would otherwise bury every other
    /// folder — except the one being shown, which is opened for you.
    pub expanded: HashSet<String>,
    pub folder_draft: Option<FolderDraft>,
    pub dataset: DatasetDraft,
    /// The run whose detail panel is open.
    pub open_run: Option<String>,
    pub session: Option<api::Session>,
    pub recording: bool,
    pub paused: bool,
    pub insert: Option<InsertDraft>,
    pub subflow_draft: Option<SubflowDraft>,
    pub subflows: Vec<api::Subflow>,
    /// The insert slot showing the "add a subflow" picker.
    pub subflow_pick: Option<usize>,
    pub selected: Option<StepPanel>,
    /// The step panel's value/param as last written into its fields, so they
    /// are only overwritten when the step itself changes.
    pub panel_seed: Option<(usize, String, String)>,
    /// The user cancelled the capture in progress, so the capture ending with
    /// no step is expected rather than an error to report.
    pub capture_cancelled: bool,
    /// The locator ladder's shape as last written into the panel. Typing into
    /// a rung does not change it, so the rows (and the caret) are left alone.
    pub ladder_shape: Option<String>,
    /// A rung was moved: two rungs of the same strategy swapping places keeps
    /// the shape, so a move forces the rebuild explicitly.
    pub ladder_moved: bool,
    pub busy: bool,
    /// Consecutive failed attempts to (re)open the event stream; drives backoff.
    pub retries: u32,
    /// The session the event stream is currently attached to. A stream for any
    /// other session that reports closing is stale and ignored.
    pub streaming: Option<String>,
    /// (message, is_error)
    pub toast: Option<(String, bool)>,
    /// Position in the open run's screenshot list being viewed full size.
    pub shot_view: Option<usize>,
    pub shots: ShotCache,
}

impl RecordApp {
    pub fn new(tx: Sender<Msg>) -> Self {
        Self {
            tx,
            sidecar_ok: false,
            browser: "Microsoft Edge".to_string(),
            demo_url: String::new(),
            flow_name: "Checkout happy path".to_string(),
            start_url: String::new(),
            history: Vec::new(),
            spec_code: String::new(),
            view: View::Steps,
            folders: Vec::new(),
            active_folder: None,
            search: String::new(),
            expanded: HashSet::new(),
            folder_draft: None,
            dataset: DatasetDraft::default(),
            open_run: None,
            session: None,
            recording: false,
            paused: false,
            insert: None,
            subflow_draft: None,
            subflows: Vec::new(),
            subflow_pick: None,
            selected: None,
            panel_seed: None,
            capture_cancelled: false,
            ladder_shape: None,
            ladder_moved: false,
            busy: false,
            retries: 0,
            streaming: None,
            toast: None,
            shot_view: None,
            shots: HashMap::new(),
        }
    }

    pub fn steps(&self) -> &[api::Step] {
        self.session.as_ref().map(|s| s.steps.as_slice()).unwrap_or(&[])
    }

    pub fn session_id(&self) -> Option<String> {
        self.session.as_ref().map(|s| s.id.clone())
    }

    /// A replay is in progress, running or paused.
    pub fn replay_running(&self) -> bool {
        self.session
            .as_ref()
            .and_then(|s| s.replay.as_ref())
            .map(|r| r.status == "running" || r.status == "paused")
            .unwrap_or(false)
    }

    pub fn replay_paused(&self) -> bool {
        self.session
            .as_ref()
            .and_then(|s| s.replay.as_ref())
            .map(|r| r.status == "paused")
            .unwrap_or(false)
    }

    pub fn error(&mut self, message: impl Into<String>) {
        self.toast = Some((message.into(), true));
    }

    pub fn notice(&mut self, message: impl Into<String>) {
        self.toast = Some((message.into(), false));
    }
}
