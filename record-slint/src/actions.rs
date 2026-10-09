// Side effects. Every network call runs on its own thread and reports back with
// a `Msg`; the UI thread applies it in `apply`. Nothing here blocks the window.

use std::sync::mpsc::Sender;
use std::time::Duration;

use crate::api;
use crate::state::{
    DatasetDraft, Event, InsertDraft, Msg, PanelTab, RecordApp, StepPanel, SubflowDraft, View,
};

/// Runs `work` on a worker thread and delivers its message to the UI thread.
/// The waker is what makes the event loop process it: there is no polling.
fn spawn(tx: &Sender<Msg>, work: impl FnOnce() -> Msg + Send + 'static) {
    let tx = tx.clone();
    std::thread::spawn(move || {
        let _ = tx.send(work());
        crate::wake();
    });
}

impl RecordApp {
    // ---- startup -----------------------------------------------------------

    pub fn connect(&mut self) {
        // Starts the sidecar when none is answering, so opening the app is the
        // only step. The lists below are re-fetched once it answers.
        spawn(&self.tx, || Msg::Connected(crate::sidecar::ensure_running()));
        self.refresh_history();
        self.load_folders();
        self.load_subflows();
    }

    pub fn refresh_history(&self) {
        spawn(&self.tx, || Msg::History(api::list_sessions()));
    }

    pub fn load_folders(&self) {
        spawn(&self.tx, || Msg::Folders(api::list_folders()));
    }

    pub fn load_subflows(&self) {
        spawn(&self.tx, || Msg::Subflows(api::list_subflows()));
    }

    // ---- recording and replay ---------------------------------------------

    pub fn start_recording(&mut self) {
        if !self.sidecar_ok {
            self.error("The sidecar is not running. Use Reload to start it again.");
            return;
        }
        self.busy = true;
        self.toast = None;
        self.spec_code.clear();
        self.view = View::Steps;
        let name = self.flow_name.clone();
        let url = self.start_url.clone();
        spawn(&self.tx, move || {
            Msg::Started(api::create_session(Some(&name), Some(&url)))
        });
    }

    /// Pause or resume whatever is live. A recording and a replay have
    /// different verbs on the server, and sending a replay the recording verb
    /// did nothing — so the replay is tried first and the recording only if no
    /// replay answered.
    pub fn interrupt(&mut self, resume: bool) {
        let Some(id) = self.session_id() else { return };
        let recording = self.recording;
        let paused = self.paused;
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            if api::pause_replay(&id, resume).unwrap_or(false) {
                let _ = tx.send(Msg::ReplayControl(Ok(())));
            } else if recording {
                let _ = tx.send(Msg::PauseToggled(api::pause_recording(&id, resume || paused)));
            } else {
                let _ = tx.send(Msg::ReplayControl(Ok(())));
            }
            crate::wake();
        });
    }

    /// Stop whatever is live: a replay if one is running, the recording
    /// otherwise.
    pub fn stop(&mut self) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        spawn(&self.tx, move || {
            if api::interrupt_replay(&id).unwrap_or(false) {
                Msg::ReplayControl(Ok(()))
            } else {
                Msg::Stopped(api::stop_recording(&id))
            }
        });
    }

    pub fn start_replay_with(&mut self, dataset: Vec<(String, String)>) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        spawn(&self.tx, move || Msg::ReplayStarted(api::start_replay_with(&id, &dataset)));
    }

    // ---- sessions ----------------------------------------------------------

    pub fn open_session(&mut self, id: String) {
        self.busy = true;
        self.selected = None;
        self.open_run = None;
        self.shot_view = None;
        self.insert = None;
        self.subflow_draft = None;
        self.subflow_pick = None;
        self.dataset = DatasetDraft::default();
        spawn(&self.tx, move || Msg::Loaded(api::get_session(&id)));
    }

    pub fn delete_session(&mut self, id: String) {
        self.busy = true;
        spawn(&self.tx, move || {
            Msg::Deleted(api::delete_session(&id).map(|_| id))
        });
    }

    pub fn export_spec(&mut self) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        spawn(&self.tx, move || Msg::Spec(api::get_spec(&id)));
    }

    /// Re-reads the generated spec after an edit, so the Code view never shows
    /// a spec for steps that no longer exist.
    pub fn refresh_spec(&self) {
        let Some(id) = self.session_id() else { return };
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            if let Ok(Some(code)) = api::get_spec(&id) {
                let _ = tx.send(Msg::SpecRefresh(code));
                crate::wake();
            }
        });
    }

    // ---- steps -------------------------------------------------------------

    /// Persists a step change. Navigation carries its URL in `url`; sending it
    /// as `value` would leave the step replaying where it was recorded.
    pub fn apply_step_edit(
        &mut self,
        index: usize,
        action: String,
        value: String,
        param: Option<String>,
    ) {
        self.apply_step_edit_with(index, action, value, param, None);
    }

    /// As `apply_step_edit`, also setting how a check compares its value.
    pub fn apply_step_edit_with(
        &mut self,
        index: usize,
        action: String,
        value: String,
        param: Option<String>,
        match_mode: Option<String>,
    ) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let navigating = action == "navigate";
        let edit = api::StepEdit {
            kind: Some(action),
            value: (!navigating).then_some(value.clone()),
            url: navigating.then_some(value),
            param,
            match_mode,
            ..Default::default()
        };
        spawn(&self.tx, move || Msg::StepEdited(api::edit_step(&id, index, &edit)));
    }

    /// Marks whether replay may skip the step when its element is not there.
    pub fn set_step_optional(&mut self, index: usize, optional: bool) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let edit = api::StepEdit { optional: Some(optional), ..Default::default() };
        spawn(&self.tx, move || Msg::StepEdited(api::edit_step(&id, index, &edit)));
    }

    /// A new password for a secret step. The sidecar encrypts it on arrival;
    /// the GUI keeps nothing.
    pub fn apply_step_secret(&mut self, index: usize, action: String, secret: String) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let edit = api::StepEdit { kind: Some(action), secret: Some(secret), ..Default::default() };
        spawn(&self.tx, move || Msg::StepEdited(api::edit_step(&id, index, &edit)));
    }

    pub fn apply_step_file(&mut self, index: usize, file: api::FileChoice) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let edit = api::StepEdit { kind: Some("upload".into()), file: Some(file), ..Default::default() };
        spawn(&self.tx, move || Msg::StepEdited(api::edit_step(&id, index, &edit)));
    }

    /// Opens the native file picker off the UI thread and applies the choice.
    /// `keep` copies the file into the flow; otherwise replay reads it from its
    /// place on disk every time.
    pub fn pick_upload_file(&mut self, index: usize, keep: bool) {
        let Some(id) = self.session_id() else { return };
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let Some(path) = rfd::FileDialog::new().set_title("Choose the file to upload").pick_file() else {
                return;
            };
            let file = if keep {
                let bytes = match std::fs::read(&path) {
                    Ok(b) => b,
                    Err(e) => {
                        let _ = tx.send(Msg::StepEdited(Err(format!("cannot read {}: {e}", path.display()))));
                        crate::wake();
                        return;
                    }
                };
                use base64::Engine as _;
                api::FileChoice {
                    source: "stored".into(),
                    attach: vec![api::Attachment {
                        name: path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "file".into()),
                        mime: String::new(),
                        data: base64::engine::general_purpose::STANDARD.encode(bytes),
                    }],
                    ..Default::default()
                }
            } else {
                api::FileChoice {
                    source: "path".into(),
                    paths: vec![path.to_string_lossy().into_owned()],
                    ..Default::default()
                }
            };
            let edit = api::StepEdit { kind: Some("upload".into()), file: Some(file), ..Default::default() };
            let _ = tx.send(Msg::StepEdited(api::edit_step(&id, index, &edit)));
            crate::wake();
        });
    }

    /// Replaces a step's whole locator ladder. Separate from `apply_step_edit`:
    /// sending the action too would rebuild the ladder from the label and
    /// discard the edit.
    pub fn apply_step_locators(&mut self, index: usize, candidates: Vec<api::Candidate>) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let edit = api::StepEdit { candidates: Some(candidates), ..Default::default() };
        spawn(&self.tx, move || Msg::StepEdited(api::edit_step(&id, index, &edit)));
    }

    pub fn delete_step(&mut self, index: usize) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        if self.selected.as_ref().map(|p| p.index) == Some(index) {
            self.selected = None;
        }
        spawn(&self.tx, move || Msg::StepDeleted(api::delete_step(&id, index)));
    }

    /// Moves step `from` to position `to` (both 1-based). The open panel
    /// follows the step it was showing, not the position.
    pub fn reorder_step(&mut self, from: usize, to: usize) {
        let Some(id) = self.session_id() else { return };
        if from == to {
            return;
        }
        self.busy = true;
        if let Some(panel) = self.selected.as_mut() {
            panel.index = match panel.index {
                i if i == from => to,
                i if i > from && i <= to => i - 1,
                i if i >= to && i < from => i + 1,
                i => i,
            };
        }
        spawn(&self.tx, move || Msg::StepReordered(api::reorder_step(&id, from, to)));
    }

    pub fn begin_insert(&mut self, at: usize) {
        self.subflow_pick = None;
        self.insert = Some(InsertDraft {
            at,
            action: "click".into(),
            label: String::new(),
            value: String::new(),
            param: String::new(),
            match_mode: "contains".into(),
            recording: false,
        });
    }

    pub fn insert_step(&mut self) {
        let Some(id) = self.session_id() else { return };
        let Some(draft) = self.insert.clone() else { return };
        let action = api::action_for(&draft.action);
        if action.map(|a| a.needs_target).unwrap_or(false) && draft.label.trim().is_empty() {
            self.error("Name what this step acts on");
            return;
        }
        if action.map(|a| a.needs_value).unwrap_or(false) && draft.value.trim().is_empty() {
            self.error("Give this step a value");
            return;
        }
        // The draft stays open until the sidecar accepts the step: a check it
        // refuses (an empty expected text, a broken regex) is corrected in
        // place rather than typed again from nothing.
        self.busy = true;
        spawn(&self.tx, move || {
            Msg::Inserted(api::insert_step(
                &id,
                draft.at,
                &draft.action,
                draft.label.trim(),
                draft.value.trim(),
                draft.param.trim(),
                &draft.match_mode,
            ))
        });
    }

    /// Records one step in the browser at `at` instead of typing it.
    pub fn capture_step(&mut self, at: usize) {
        if !self.sidecar_ok {
            self.error("The sidecar is not running. Use Reload to start it again.");
            return;
        }
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        self.capture_cancelled = false;
        if let Some(d) = self.insert.as_mut() {
            d.recording = true;
        }
        spawn(&self.tx, move || Msg::Captured(api::capture_step(&id, at)));
    }

    pub fn cancel_capture(&mut self) {
        let Some(id) = self.session_id() else { return };
        self.capture_cancelled = true;
        spawn(&self.tx, move || Msg::CaptureCancelled(api::cancel_capture(&id)));
    }

    pub fn select_step(&mut self, index: usize) {
        let same = self.selected.as_ref().map(|p| p.index) == Some(index);
        if !same {
            self.selected = Some(StepPanel { index, tab: PanelTab::Step, locators: None });
        }
    }

    // ---- subflows ----------------------------------------------------------

    /// Adds or removes a step from the contiguous selection being saved as a
    /// subflow. A selection only ever grows at its ends, so it stays a run of
    /// consecutive steps; unticking a step inside it trims the end there.
    pub fn toggle_subflow_step(&mut self, index: usize, on: bool) {
        if !on {
            let Some(draft) = self.subflow_draft.as_mut() else { return };
            if index >= draft.from && index <= draft.to {
                if index == draft.from {
                    self.subflow_draft = None;
                } else {
                    draft.to = index - 1;
                }
            }
            return;
        }
        self.subflow_draft = match self.subflow_draft.take() {
            Some(d) if index >= d.from && index <= d.to => Some(d),
            Some(d) if index + 1 == d.from => Some(SubflowDraft { from: index, ..d }),
            Some(d) if index == d.to + 1 => Some(SubflowDraft { to: index, ..d }),
            _ => Some(SubflowDraft { from: index, to: index, name: String::new() }),
        };
    }

    pub fn save_subflow(&mut self) {
        let Some(id) = self.session_id() else { return };
        let Some(draft) = self.subflow_draft.clone() else { return };
        let name = draft.name.trim().to_string();
        if name.is_empty() {
            self.error("A subflow needs a name.");
            return;
        }
        self.busy = true;
        spawn(&self.tx, move || {
            Msg::SubflowSaved(api::create_subflow(&id, &name, draft.from, draft.to))
        });
    }

    pub fn import_subflow(&mut self, subflow_id: String, at: usize) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        spawn(&self.tx, move || {
            Msg::SubflowImported(api::import_subflow(&subflow_id, &id, at))
        });
    }

    pub fn delete_subflow(&mut self, subflow_id: String) {
        self.busy = true;
        spawn(&self.tx, move || {
            Msg::SubflowDeleted(api::delete_subflow(&subflow_id).map(|_| subflow_id))
        });
    }

    // ---- folders -----------------------------------------------------------

    pub fn save_folder(&mut self) {
        let Some(draft) = self.folder_draft.clone() else { return };
        let name = draft.name.trim().to_string();
        if name.is_empty() {
            return;
        }
        self.busy = true;
        spawn(&self.tx, move || {
            Msg::FolderSaved(match &draft.id {
                Some(id) => api::rename_folder(id, &name),
                None => api::create_folder(&name, draft.parent.as_deref()),
            })
        });
    }

    pub fn delete_folder(&mut self, id: String) {
        self.busy = true;
        if self.active_folder.as_deref() == Some(id.as_str()) {
            self.active_folder = None;
        }
        spawn(&self.tx, move || Msg::FolderDeleted(api::delete_folder(&id)));
    }

    pub fn move_to_folder(&mut self, folder: Option<String>) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        spawn(&self.tx, move || {
            Msg::Moved(api::move_to_folder(&id, folder.as_deref()))
        });
    }

    // ---- screenshots -------------------------------------------------------

    /// Fetches and decodes a screenshot once; the result, success or failure,
    /// is cached by URL so the run panel never refetches on redraw.
    pub fn load_shot(&mut self, url: &str) {
        if self.shots.contains_key(url) {
            return;
        }
        self.shots.insert(url.to_string(), None);
        let url = url.to_string();
        spawn(&self.tx, move || {
            let image = (|| {
                let res = ureq::get(&url).timeout(Duration::from_secs(10)).call().ok()?;
                let mut bytes = Vec::new();
                std::io::Read::read_to_end(&mut res.into_reader(), &mut bytes).ok()?;
                let decoded = image::load_from_memory(&bytes).ok()?.into_rgba8();
                Some(slint::SharedPixelBuffer::<slint::Rgba8Pixel>::clone_from_slice(
                    decoded.as_raw(),
                    decoded.width(),
                    decoded.height(),
                ))
            })();
            Msg::ShotLoaded(url, image)
        });
    }

    // ---- live updates ------------------------------------------------------

    /// Attaches the event stream to a session. A reader thread forwards each
    /// event; when the stream ends it reports which session it was for, so a
    /// stale stream closing after the user moved on does not trigger a retry.
    pub fn subscribe(&mut self, id: String) {
        self.streaming = Some(id.clone());
        match api::subscribe(&id) {
            Ok(rx) => {
                self.retries = 0;
                let tx = self.tx.clone();
                std::thread::spawn(move || {
                    for raw in rx {
                        if let Ok(event) = serde_json::from_str::<Event>(&raw) {
                            if tx.send(Msg::Event(event)).is_err() {
                                return;
                            }
                            crate::wake();
                        }
                    }
                    let _ = tx.send(Msg::StreamClosed(id));
                    crate::wake();
                });
            }
            Err(err) => {
                self.error(format!("Live updates unavailable: {err}"));
                self.schedule_retry(id);
            }
        }
    }

    /// Retries the event stream with exponential backoff, capped at 8 s.
    pub fn schedule_retry(&mut self, id: String) {
        let wait = 250u64 << self.retries.min(5);
        self.retries += 1;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(wait));
            let _ = tx.send(Msg::Resubscribe(id));
            crate::wake();
        });
    }

    fn apply_event(&mut self, event: Event) {
        match event.kind.as_str() {
            "status" => {
                if let Some(session) = event.session {
                    if self.session.as_ref().map(|s| s.id != session.id).unwrap_or(false) {
                        return;
                    }
                    self.recording = session.status == "recording" || session.status == "paused";
                    self.paused = session.status == "paused";
                    self.session = Some(session);
                }
            }
            "step" => {
                if let (Some(step), Some(session)) = (event.step, self.session.as_mut()) {
                    match session.steps.iter_mut().find(|s| s.index == step.index) {
                        Some(existing) => *existing = step,
                        None => session.steps.push(step),
                    }
                    session.steps.sort_by_key(|s| s.index);
                }
            }
            "reset" => {
                if let Some(session) = event.session {
                    self.session = Some(session);
                }
            }
            "replay:status" => {
                if let (Some(replay), Some(session)) = (event.replay, self.session.as_mut()) {
                    session.replay = Some(replay);
                }
            }
            "run" => {
                if let (Some(run), Some(session)) = (event.run, self.session.as_mut()) {
                    session.runs.retain(|r| r.id != run.id);
                    session.runs.insert(0, run);
                }
                self.refresh_history();
            }
            _ => {}
        }
    }

    // ---- applying results --------------------------------------------------

    pub fn apply(&mut self, msg: Msg) {
        match msg {
            Msg::Connected(Ok(health)) => {
                // The first lists were asked for before a sidecar it had to start
                // was up, and came back empty; ask again now that it answers.
                if !self.sidecar_ok {
                    self.refresh_history();
                    self.load_folders();
                    self.load_subflows();
                }
                self.sidecar_ok = true;
                if !health.browser.is_empty() {
                    self.browser = health.browser;
                }
                self.demo_url = health.demo_url;
                if self.toast.as_ref().map(|t| t.1).unwrap_or(false) {
                    self.toast = None;
                }
            }
            Msg::Connected(Err(err)) => {
                self.sidecar_ok = false;
                self.error(format!("Sidecar unreachable: {err}"));
            }
            Msg::Started(Ok(session)) => {
                self.busy = false;
                self.recording = true;
                let id = session.id.clone();
                self.session = Some(session);
                self.subscribe(id);
                self.refresh_history();
            }
            Msg::Started(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not start recording: {err}"));
            }
            Msg::Stopped(Ok(session)) => {
                self.busy = false;
                self.recording = false;
                self.paused = false;
                self.session = Some(session);
                self.refresh_history();
            }
            Msg::Stopped(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not stop: {err}"));
            }
            Msg::Event(event) => self.apply_event(event),
            Msg::StreamClosed(id) => {
                if self.streaming.as_deref() == Some(id.as_str()) {
                    self.schedule_retry(id);
                }
            }
            Msg::Resubscribe(id) => {
                if self.session_id().as_deref() == Some(id.as_str()) {
                    self.subscribe(id);
                }
            }
            Msg::History(Ok(list)) => self.history = list,
            Msg::History(Err(err)) => self.error(format!("Could not list recordings: {err}")),
            Msg::Loaded(Ok(session)) => {
                self.busy = false;
                self.flow_name = session.name.clone();
                self.recording = session.status == "recording" || session.status == "paused";
                self.paused = session.status == "paused";
                // Opening a recording subscribes as well: without it the GUI
                // could send Pause and Stop to a replay but never hear back.
                let id = session.id.clone();
                self.session = Some(session);
                self.spec_code.clear();
                self.subscribe(id);
            }
            Msg::Loaded(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not open that recording: {err}"));
            }
            Msg::Spec(Ok(code)) => {
                self.busy = false;
                match code {
                    Some(text) => {
                        self.spec_code = text;
                        self.view = View::Code;
                    }
                    None => self.error("No steps to export yet."),
                }
            }
            Msg::Spec(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not export: {err}"));
            }
            Msg::SpecRefresh(code) => {
                if !self.spec_code.is_empty() {
                    self.spec_code = code;
                }
            }
            Msg::Deleted(Ok(id)) => {
                self.busy = false;
                self.history.retain(|s| s.id != id);
                if self.session_id().as_deref() == Some(id.as_str()) {
                    self.session = None;
                    self.streaming = None;
                    self.selected = None;
                    self.spec_code.clear();
                }
                self.load_folders();
            }
            Msg::Deleted(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not delete that recording: {err}"));
            }
            Msg::StepEdited(Ok(session)) | Msg::StepDeleted(Ok(session)) => {
                self.busy = false;
                self.session = Some(session);
                self.refresh_spec();
            }
            Msg::StepEdited(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not save that step: {err}"));
            }
            Msg::StepDeleted(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not delete that step: {err}"));
            }
            Msg::StepReordered(Ok(session)) => {
                self.busy = false;
                self.session = Some(session);
                self.refresh_spec();
            }
            Msg::StepReordered(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not move that step: {err}"));
            }
            Msg::Folders(Ok(folders)) => self.folders = folders,
            Msg::Folders(Err(err)) => self.error(format!("Could not list folders: {err}")),
            Msg::FolderSaved(Ok(folder)) => {
                self.busy = false;
                self.folder_draft = None;
                self.notice(format!("Folder “{}” saved", folder.name));
                self.load_folders();
            }
            Msg::FolderSaved(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not save that folder: {err}"));
            }
            Msg::FolderDeleted(Ok(())) => {
                self.busy = false;
                self.load_folders();
                self.refresh_history();
            }
            Msg::FolderDeleted(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not delete that folder: {err}"));
            }
            Msg::Moved(Ok(session)) => {
                self.busy = false;
                self.session = Some(session);
                self.refresh_history();
                self.load_folders();
            }
            Msg::Moved(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not move that recording: {err}"));
            }
            Msg::ReplayStarted(Ok(replay)) => {
                self.busy = false;
                if let Some(session) = self.session.as_mut() {
                    session.replay = Some(replay);
                }
            }
            Msg::ReplayStarted(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not replay: {err}"));
            }
            Msg::PauseToggled(Ok(session)) => {
                self.busy = false;
                self.paused = session.status == "paused";
                self.session = Some(session);
            }
            Msg::PauseToggled(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not change that: {err}"));
            }
            Msg::ReplayControl(Ok(())) => self.busy = false,
            Msg::ReplayControl(Err(err)) => {
                self.busy = false;
                self.error(err);
            }
            Msg::ShotLoaded(url, image) => {
                self.shots.insert(url, image);
            }
            Msg::Inserted(Ok(session)) => {
                self.busy = false;
                self.insert = None;
                self.session = Some(session);
                self.refresh_spec();
            }
            Msg::Inserted(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not add that step: {err}"));
            }
            Msg::Captured(Ok(session)) => {
                self.busy = false;
                self.insert = None;
                self.session = Some(session);
                self.refresh_spec();
            }
            Msg::Captured(Err(err)) => {
                self.busy = false;
                self.insert = None;
                if std::mem::take(&mut self.capture_cancelled) {
                    self.notice("Capture cancelled — the flow is unchanged.");
                } else {
                    self.error(format!("No step was recorded: {err}"));
                }
            }
            Msg::CaptureCancelled(Ok(())) => {}
            Msg::CaptureCancelled(Err(err)) => self.error(format!("Could not cancel: {err}")),
            Msg::Subflows(Ok(list)) => self.subflows = list,
            Msg::Subflows(Err(_)) => {}
            Msg::SubflowSaved(Ok(sub)) => {
                self.busy = false;
                self.subflow_draft = None;
                self.subflows.push(sub);
                self.notice("Subflow saved.");
            }
            Msg::SubflowSaved(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not save that subflow: {err}"));
            }
            Msg::SubflowImported(Ok(session)) => {
                self.busy = false;
                self.subflow_pick = None;
                self.insert = None;
                self.session = Some(session);
                self.refresh_spec();
            }
            Msg::SubflowImported(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not add that subflow: {err}"));
            }
            Msg::SubflowDeleted(Ok(id)) => {
                self.busy = false;
                self.subflows.retain(|s| s.id != id);
                self.notice("Subflow deleted.");
            }
            Msg::SubflowDeleted(Err(err)) => {
                self.busy = false;
                self.error(format!("Could not delete that subflow: {err}"));
            }
        }
    }
}
