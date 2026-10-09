// The app's data: what the sidecar told us, what the user is typing, and which
// view is on screen. No rendering lives here.
use std::sync::mpsc::{Receiver, Sender};

use eframe::egui;
use serde::Deserialize;

use crate::api;

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
    /// Emitted once a run finishes. Without this the run history stays empty
    /// however many replays were made, because nothing else carries a finished
    /// run to the client.
    #[serde(default)]
    pub run: Option<api::Run>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    /// No-code editor: action dropdown plus value and element.
    Steps,
    /// Generated Playwright spec. Always available, never replaced.
    Code,
    /// Past runs: outcome, dataset used, and the screenshots to review.
    Runs,
    /// Parameters for this flow: which steps take a value, and what to feed them
    /// on the next run.
    Dataset,
}

/// An in-progress folder edit: either a new folder, or a rename of an existing
/// one. Held locally so typing does not round-trip on every keystroke.
pub struct FolderDraft {
    /// Empty means "create a new folder"; otherwise rename this id.
    pub id: Option<String>,
    pub name: String,
    /// The folder a new one nests under. Set when it is being created from a
    /// folder's own row; renaming ignores it, since a folder's place in the
    /// tree is not part of its name.
    pub parent: Option<String>,
}

/// A dataset supplied for the next run. Empty values mean "use what was
/// recorded", which is why they are allowed rather than rejected.
#[derive(Clone, Default)]
pub struct DatasetDraft {
    pub values: Vec<(String, String)>,
}

/// What the step side panel is showing. A step has more to say than fits on its
/// row — the value, the dataset parameter, and the whole locator ladder — so
/// the panel is tabbed rather than one long scroll the user has to read past.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum PanelTab {
    /// The action, the value, and the target label: what the step *does*.
    Step,
    /// The candidate ladder, in the order replay will try it.
    Locators,
    /// The raw locator of each candidate, for when the ladder needs reading.
    Raw,
}

/// The step the side panel is open on, and which tab it is showing. `None`
/// closes the panel; the panel never exists without a step behind it.
#[derive(Clone)]
pub struct StepPanel {
    pub index: usize,
    pub tab: PanelTab,
    /// The locator ladder as edited but not yet saved.
    ///
    /// A copy rather than an in-place edit: a half-typed selector is not a
    /// selector, and saving on every keystroke would push broken rungs to the
    /// server and rewrite the ladder under the user's cursor. `None` means "not
    /// currently being edited", which is the state outside the edit UI.
    pub locators: Option<Vec<crate::api::Candidate>>,
}

/// The step currently being dragged through the list, if any. Held as an index
/// rather than a value so the row being dragged can still be read from the
/// session — a stale copy would drag a step that has since been edited.
#[derive(Clone, Copy)]
pub struct DragState {
    pub from: usize,
    /// Where it would land if dropped now, as a 0-based slot in the list.
    pub hover: usize,
}

/// A step being added by hand between two recorded ones. Manual by default: a
/// recording is only worth its cost when the step is something the user cannot
/// type.
#[derive(Clone)]
pub struct InsertDraft {
    /// Index the new step will take. 1 is before the first recorded step; one
    /// past the end appends.
    pub at: usize,
    pub action: String,
    pub label: String,
    pub value: String,
    pub param: String,
    /// Set when the user chose to record this step in the browser instead of
    /// typing it. The recorder fills in `label` and `value` from what it sees.
    pub recording: bool,
}

/// A run of steps being saved as a subflow. The range is inclusive and in step
/// indexes, which is what the step list shows, so "steps 2 to 5" means the same
/// thing here as it does on screen.
#[derive(Clone)]
pub struct SubflowDraft {
    pub from: usize,
    pub to: usize,
    pub name: String,
}

/// An in-progress edit, held locally until applied. Editing must not round-trip
/// to the server on every keystroke.
pub struct Draft {
    pub index: usize,
    pub action: String,
    pub value: String,
    pub param: String,
    pub use_param: bool,
}

/// Everything that arrives from a worker thread. Each variant carries the
/// sidecar's result so the handler can turn a failure into a toast.
pub enum Msg {
    Connected(Result<(), String>),
    Started(Result<api::Session, String>),
    Stopped(Result<api::Session, String>),
    Event(Event),
    StreamClosed,
    History(Result<Vec<api::Summary>, String>),
    Loaded(Result<api::Session, String>),
    Spec(Result<Option<String>, String>),
    Deleted(Result<String, String>),
    StepEdited(Result<api::Session, String>),
    StepDeleted(Result<api::Session, String>),
    StepReordered(Result<api::Session, String>),
    SpecRefresh(String),
    Folders(Result<Vec<api::Folder>, String>),
    FolderSaved(Result<api::Folder, String>),
    FolderDeleted(Result<(), String>),
    Moved(Result<api::Session, String>),
    ReplayStarted(Result<api::Replay, String>),
    PauseToggled(Result<api::Session, String>),
    ReplayControl(Result<(), String>),
    /// A screenshot finished loading. `None` means it could not be fetched or
    /// decoded, which the cache keeps so it is not asked for again.
    ShotLoaded(String, Option<egui::TextureHandle>),
    Inserted(Result<api::Session, String>),
    Captured(Result<api::Session, String>),
    SubflowSaved(Result<api::Subflow, String>),
    SubflowImported(Result<api::Session, String>),
    SubflowDeleted(Result<(), String>),
    CaptureCancelled(Result<(), String>),
}

pub struct RecordApp {
    pub tx: Sender<Msg>,
    pub rx: Receiver<Msg>,
    pub sidecar_ok: bool,
    pub browser: String,
    pub demo_url: String,
    pub flow_name: String,
    pub start_url: String,
    pub history: Vec<api::Summary>,
    pub spec_code: String,
    pub view: View,
    pub draft: Option<Draft>,
    pub show_all_history: bool,
    /// Folders shown in the left panel, each with the number of recordings it
    /// holds. Recreated from the UI, so the panel is the only way to make one.
    pub folders: Vec<api::Folder>,
    /// The folder the history list is filtered to; None shows everything.
    pub active_folder: Option<String>,
    /// Free text matched against recording names, and against folder names so
    /// a folder can be found the same way. Empty means "no filter".
    pub search: String,
    /// Folder ids whose recordings are listed underneath them. A folder with
    /// nothing in it has nothing to show, so it does not need to be open.
    pub expanded: std::collections::HashSet<String>,
    pub folder_draft: Option<FolderDraft>,
    /// Values for the next run's dataset. Empty means "use what was recorded".
    pub dataset: Option<DatasetDraft>,
    /// The run whose detail the side panel is showing.
    pub carousel_run: Option<String>,
    pub session: Option<api::Session>,
    pub recording: bool,
    /// True while a recording is paused. The recording is still live; it is
    /// just not collecting steps until resumed.
    pub paused: bool,
    /// A step being added by hand, and where it will land. `None` when no
    /// insertion is in progress.
    pub insert: Option<InsertDraft>,
    /// A subflow being saved from a run of steps, before it has a name. `None`
    /// when no selection is pending.
    pub subflow_draft: Option<SubflowDraft>,
    /// The subflows available to import, loaded with the rest of the library.
    pub subflows: Vec<api::Subflow>,
    /// The index whose insert form is choosing a subflow rather than typing a
    /// step, so the "+" knows which slot it is filling.
    pub subflow_pick: Option<usize>,
    /// The step whose side panel is open. Selecting a step opens the panel;
    /// closing it clears this, so the two can never disagree.
    pub selected: Option<StepPanel>,
    /// The step being dragged, and where it would land. `None` when nothing is
    /// being dragged.
    pub drag: Option<DragState>,
    pub busy: bool,
    /// The egui context, kept so a worker thread can ask for the frame that
    /// drains its message. egui draws only when asked, and everything that
    /// arrives here arrives off-thread.
    pub ctx: egui::Context,
    /// The session whose event stream dropped, waiting to be picked up again.
    /// Held as state rather than retried where the failure happened, so the
    /// wait between attempts is spent in the frame loop and not inside a
    /// blocking connect on the thread that draws.
    pub resubscribe: Option<String>,
    /// When that attempt is due. `None` means no attempt is pending.
    pub retry_at: Option<std::time::Instant>,
    /// Attempts made since the stream last held. Backs off so a sidecar that
    /// is down is not hammered once a frame.
    pub retries: u32,
    pub toast: Option<(String, bool)>,
    pub autoscroll: bool,
    pub accent: egui::Color32,

    /// The screenshot being looked at full size, as a position within the open
    /// run's shots. `None` means the viewer is closed.
    ///
    /// Held by position among the shots rather than by step, because the
    /// previous and next buttons in the viewer move between pictures: walking
    /// the flow's step numbers would land on steps that have no picture.
    pub shot_view: Option<usize>,

    /// Decoded screenshots, keyed by URL. `None` while a fetch is in flight, or
    /// after one failed.
    pub shot_tex: std::collections::HashMap<String, Option<egui::TextureHandle>>,
}