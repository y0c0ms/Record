// Everything the app does in response to a click: it validates intent, spawns

// a worker for the network call, and sends the result back as a `Msg`.
//
// No rendering lives here, and nothing blocks a repaint — that is the whole
// point of the channel.

use crate::api;
use eframe::egui;
use std::io::Read;
use crate::state::{Event, Msg, RecordApp, SubflowDraft, View};

impl RecordApp {
    pub fn steps(&self) -> &[api::Step] {
        self.session
            .as_ref()
            .map(|s| s.steps.as_slice())
            .unwrap_or(&[])
    }

    // Refresh the history list off-thread: it is a network call and must never
    // block a repaint.
    pub fn refresh_history(&self) {
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::History(api::list_sessions()));
        });
    }

    pub fn start_recording(&mut self) {
        if !self.sidecar_ok {
            self.toast = Some((
                "Sidecar is not running. Start it with: npm start".to_string(),
                true,
            ));
            return;
        }
        self.busy = true;
        self.toast = None;
        self.spec_code.clear();
        self.view = View::Steps;
        let name = self.flow_name.clone();
        let url = self.start_url.clone();
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Started(api::create_session(
                Some(&name),
                Some(&url),
            )));
        });
    }

    pub fn stop_recording(&mut self) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Stopped(api::stop_recording(&id)));
        });
    }

    /// Pauses or resumes. The recording continues either way: a pause just
    /// stops collecting steps, so the browser stays open and the step list is
    /// never truncated.
    pub fn set_paused(&mut self, resume: bool) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::PauseToggled(api::pause_recording(&id, resume)));
        });
    }

    /// Pauses or resumes whatever is running, replay first.
    ///
    /// The replay is asked about before the recording is touched, and the
    /// server is the one that answers. Deciding from the GUI's own copy of the
    /// status sent a press landing between two events to the wrong endpoint —
    /// and a button that does nothing is worse than one that is a moment slow.
    pub fn interrupt(&mut self, resume: bool) {
        let Some(id) = self.session_id() else { return };
        let tx = self.tx.clone();
        let recording = self.recording;
        let paused = self.paused;
        self.busy = true;
        std::thread::spawn(move || {
            if api::pause_replay(&id, resume).unwrap_or(false) {
                let _ = tx.send(Msg::ReplayControl(Ok(())));
                return;
            }
            // No run to interrupt, so the press meant the recording.
            if recording {
                let _ = tx.send(Msg::PauseToggled(api::pause_recording(&id, resume || paused)));
            }
            let _ = tx.send(Msg::ReplayControl(Ok(())));
        });
    }

    /// Stops whatever is running, replay first, on the same terms as
    /// `interrupt`.
    pub fn stop(&mut self) {
        let Some(id) = self.session_id() else { return };
        let tx = self.tx.clone();
        self.busy = true;
        std::thread::spawn(move || {
            if api::interrupt_replay(&id).unwrap_or(false) {
                let _ = tx.send(Msg::ReplayControl(Ok(())));
                return;
            }
            let _ = tx.send(Msg::Stopped(api::stop_recording(&id)));
        });
    }

    /// The screenshot at `url` as a texture, starting a fetch the first time it
    /// is asked for. `None` means it is not here yet — still arriving, or it
    /// could not be fetched, which from a step row's point of view are the same
    /// thing: there is nothing to draw.
    ///
    /// Fetched and decoded here rather than through egui's URI loader so the
    /// two states are distinguishable at the call site. A loader that draws its
    /// own placeholder makes "no picture yet" look like "no picture", and a row
    /// of those reads as a run whose screenshots are all broken.
    pub fn shot_texture(&mut self, ctx: &egui::Context, url: &str) -> Option<egui::TextureHandle> {
        if let Some(entry) = self.shot_tex.get(url) {
            return entry.clone();
        }
        // Marked before the fetch starts, so a row drawn twice in one frame
        // does not start the same download twice.
        self.shot_tex.insert(url.to_string(), None);
        let tx = self.tx.clone();
        let ctx = ctx.clone();
        let key = url.to_string();
        std::thread::spawn(move || {
            let loaded = ureq::get(&key)
                .call()
                .ok()
                .and_then(|res| {
                    let mut bytes = Vec::new();
                    res.into_reader().read_to_end(&mut bytes).ok()?;
                    Some(bytes)
                })
                .and_then(|bytes| image::load_from_memory(&bytes).ok())
                .map(|img| {
                    let rgba = img.to_rgba8();
                    let size = [rgba.width() as usize, rgba.height() as usize];
                    let colour = egui::ColorImage::from_rgba_unmultiplied(size, rgba.as_raw());
                    ctx.load_texture(key.clone(), colour, egui::TextureOptions::LINEAR)
                });
            // A failure is kept as an empty entry rather than retried: a missing
            // file stays missing, and retrying once a frame would dial the
            // sidecar for as long as the panel stayed open.
            let _ = tx.send(Msg::ShotLoaded(key, loaded));
            ctx.request_repaint();
        });
        None
    }

    /// Whether a replay is in flight. The run's status is the only place that
    /// knows: the GUI does not drive the loop, so it cannot infer liveness from
    /// its own state without going stale the moment a step took a while.
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

    /// Commits a hand-inserted step. Server-side, because inserting renumbers
    /// every step after it and the client must not guess those indexes.
    pub fn insert_step(&mut self, resume_at: usize) {
        let Some(id) = self.session_id() else { return };
        let Some(draft) = self.insert.clone() else { return };
        // What the step must be told depends on what it is: a click needs
        // something to click, a screenshot needs only a name. Requiring the
        // target for every action blocked the ones that have none.
        let action = crate::api::action_for(&draft.action);
        if action.map(|a| a.needs_target).unwrap_or(false) && draft.label.trim().is_empty() {
            self.toast = Some(("Name what this step acts on".to_string(), true));
            return;
        }
        if action.map(|a| a.needs_value).unwrap_or(false) && draft.value.trim().is_empty() {
            self.toast = Some(("Give this step a value".to_string(), true));
            return;
        }
        self.busy = true;
        self.insert = None;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Inserted(api::insert_step(
                &id,
                resume_at,
                &draft.action,
                draft.label.trim(),
                draft.value.trim(),
                draft.param.trim(),
            )));
        });
    }

    /// Arms the recorder to capture one action into the flow at `at`. Runs on a
    /// worker thread because it blocks until the user acts in the browser.
    pub fn capture_step(&mut self, at: usize) {
        if !self.sidecar_ok {
            self.toast = Some((
                "Sidecar is not running. Start it with: npm start".to_string(),
                true,
            ));
            return;
        }
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        if let Some(d) = self.insert.as_mut() {
            d.recording = true;
        }
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Captured(api::capture_step(&id, at)));
        });
    }

    /// Closes a capture browser the user is no longer using.
    pub fn cancel_capture(&mut self) {
        let Some(id) = self.session_id() else { return };
        self.busy = false;
        if let Some(d) = self.insert.as_mut() {
            d.recording = false;
        }
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::CaptureCancelled(api::cancel_capture(&id)));
        });
    }

    pub fn start_replay(&mut self) {
        self.start_replay_with(Vec::new());
    }

    /// Starts a replay, substituting the given values for the flow's dataset
    /// parameters. Parameters left out keep the value that was recorded, so a
    /// partial dataset is a valid dataset.
    pub fn start_replay_with(&mut self, dataset: Vec<(String, String)>) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        self.autoscroll = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::ReplayStarted(api::start_replay_with(&id, &dataset)));
        });
    }

    pub fn load_folders(&mut self) {
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Folders(api::list_folders()));
        });
    }

    pub fn save_folder(&mut self, id: Option<String>, name: String, parent: Option<String>) {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            self.toast = Some(("A folder needs a name.".to_string(), true));
            return;
        }
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            // A rename leaves the folder where it is: `parent` describes where
            // a new folder goes, not where an existing one belongs.
            let result = match id {
                Some(id) => api::rename_folder(&id, &trimmed),
                None => api::create_folder(&trimmed, parent.as_deref()),
            };
            let _ = tx.send(Msg::FolderSaved(result));
        });
    }

    pub fn delete_folder(&mut self, id: String) {
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::FolderDeleted(api::delete_folder(&id)));
        });
    }

    pub fn move_to_folder(&mut self, session_id: String, folder: Option<String>) {
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Moved(api::move_to_folder(&session_id, folder.as_deref())));
        });
    }

    pub fn save_subflow(&mut self, from: usize, to: usize, name: String) {
        let Some(id) = self.session_id() else { return };
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            self.toast = Some(("A subflow needs a name.".to_string(), true));
            return;
        }
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let result = api::create_subflow(&id, &trimmed, from, to);
            let _ = tx.send(Msg::SubflowSaved(result));
        });
    }

    pub fn import_subflow(&mut self, subflow_id: String, at: usize) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::SubflowImported(api::import_subflow(
                &subflow_id,
                &id,
                at,
            )));
        });
    }

    pub fn delete_subflow(&mut self, id: String) {
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::SubflowDeleted(api::delete_subflow(&id)));
        });
    }

    /// Starts, extends, or shrinks the run of steps a subflow will be saved
    /// from. The run is always contiguous: ticking a step that is not next to
    /// the run restarts it there, because a subflow with a hole in it would
    /// replay as something other than what it looks like.
    pub fn toggle_subflow_step(&mut self, index: usize, on: bool) {
        if !on {
            let Some(draft) = self.subflow_draft.as_mut() else {
                return;
            };
            if index >= draft.from && index <= draft.to {
                draft.to = index - 1;
                if draft.to < draft.from {
                    self.subflow_draft = None;
                }
            }
            return;
        }
        self.subflow_draft = match self.subflow_draft.take() {
            Some(d) if index >= d.from && index <= d.to => Some(d),
            Some(d) if index == d.from - 1 => Some(SubflowDraft {
                from: index,
                to: d.to,
                name: d.name,
            }),
            Some(d) if index == d.to + 1 => Some(SubflowDraft {
                from: d.from,
                to: index,
                name: d.name,
            }),
            // Anywhere else: a new run begins at this step.
            _ => Some(SubflowDraft {
                from: index,
                to: index,
                name: String::new(),
            }),
        };
    }

    /// Moves a step to a new position. Off-thread, like every other edit that
    /// costs a round trip.
    pub fn reorder_step(&mut self, from: usize, to: usize) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        // The panel follows the step, not the position: a step dragged from 2 to
        // 7 is still the step the user was looking at, and leaving the panel on
        // index 2 would silently retarget it at a different step.
        if let Some(panel) = self.selected.as_mut() {
            if panel.index == from {
                panel.index = to;
            } else if panel.index > from && panel.index <= to {
                panel.index -= 1;
            } else if panel.index >= from && panel.index < to {
                panel.index += 1;
            }
        }
        if let Some(draft) = self.draft.as_mut() {
            draft.index = match draft.index {
                i if i == from => to,
                i if i > from && i <= to => i - 1,
                i if i >= from && i < to => i + 1,
                i => i,
            };
        }
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::StepReordered(api::reorder_step(&id, from, to)));
        });
    }

    pub fn open_session(&mut self, id: String) {
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Loaded(api::get_session(&id)));
        });
    }

    pub fn delete_session(&mut self, id: String) {
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Deleted(api::delete_session(&id).map(|_| id)));
        });
    }

    pub fn export_spec(&mut self) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Spec(api::get_spec(&id)));
        });
    }

    /// Re-fetch the spec without switching to the code view or clearing it.
    /// Editing a step changes what the code says, and the user should not lose
    /// the code they are looking at to see the consequence of their edit.
    pub fn refresh_spec(&mut self) {
        let Some(id) = self.session_id() else { return };
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            if let Ok(Some(code)) = api::get_spec(&id) {
                let _ = tx.send(Msg::SpecRefresh(code));
            }
        });
    }

    /// Persist a step change. Off-thread: it is a network round trip and must
    /// not block a repaint.
    pub fn apply_step_edit(
        &mut self,
        index: usize,
        action: String,
        value: String,
        param: Option<String>,
        candidates: Option<Vec<api::Candidate>>,
    ) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        // Navigation carries its URL in `url`; every other action carries a
        // plain value. Sending a navigate step's URL as `value` would leave the
        // step replaying the URL it was recorded against.
        let navigating = action == "navigate";
        let edit = api::StepEdit {
            kind: Some(action),
            value: (!navigating).then_some(value.clone()),
            url: navigating.then_some(value),
            param,
            candidates,
            ..Default::default()
        };
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::StepEdited(api::edit_step(&id, index, &edit)));
        });
    }

    /// Re-enters a password step's value. The new value goes to the sidecar,
    /// which encrypts it; the GUI keeps nothing.
    pub fn apply_step_secret(&mut self, index: usize, action: String, secret: String) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let edit = api::StepEdit { kind: Some(action), secret: Some(secret), ..Default::default() };
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::StepEdited(api::edit_step(&id, index, &edit)));
        });
    }

    /// Sets where an upload step's file comes from.
    pub fn apply_step_file(&mut self, index: usize, file: api::FileChoice) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let edit = api::StepEdit { kind: Some("upload".into()), file: Some(file), ..Default::default() };
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::StepEdited(api::edit_step(&id, index, &edit)));
        });
    }

    /// Opens the native file picker off the UI thread and applies the choice.
    /// `keep` copies the file into the flow; otherwise the step reads it from
    /// its place on disk at every replay.
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
                        return;
                    }
                };
                use base64::Engine as _;
                api::FileChoice {
                    source: "stored".into(),
                    attach: vec![api::Attachment {
                        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into()),
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
        });
    }

    /// Replaces a step's whole locator ladder with a hand-edited one.
    ///
    /// Separate from `apply_step_edit` because the two write different things:
    /// that one re-points what a step does, this one re-points what it looks
    /// for. Sending the action too would rebuild the ladder from the label and
    /// silently discard the edit that was just made.
    pub fn apply_step_locators(&mut self, index: usize, candidates: Vec<api::Candidate>) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        let edit = api::StepEdit {
            candidates: Some(candidates),
            ..Default::default()
        };
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::StepEdited(api::edit_step(&id, index, &edit)));
        });
    }

    pub fn delete_step(&mut self, index: usize) {
        let Some(id) = self.session_id() else { return };
        self.busy = true;
        self.draft = None;
        let tx = self.tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(Msg::StepDeleted(api::delete_step(&id, index)));
        });
    }

    fn session_id(&self) -> Option<String> {
        self.session.as_ref().map(|s| s.id.clone())
    }

    /// Follow a session's live event feed. The stream never ends, so it runs on
    /// its own thread for the life of the session.
    pub fn subscribe(&mut self, id: String) {
        let tx = self.tx.clone();
        // egui only drains this channel while it is drawing, and it only draws
        // when something asks it to. A worker thread that posts a message
        // without asking leaves the message sitting there: the connection dies,
        // the reconnect is never scheduled, and the window goes quiet without
        // ever running the code that would notice. The context is how a thread
        // asks for the frame it needs.
        let ctx = self.ctx.clone();
        self.retry_at = None;
        match api::subscribe(&id) {
            Ok(rx) => {
                // A stream that held is a stream that is working; the next drop
                // should be retried promptly rather than on the backoff a
                // dead sidecar had built up.
                self.retries = 0;
                std::thread::spawn(move || {
                    for raw in rx {
                        match serde_json::from_str::<Event>(&raw) {
                            Ok(event) => {
                                if tx.send(Msg::Event(event)).is_err() {
                                    return;
                                }
                                ctx.request_repaint();
                            }
                            Err(_) => continue,
                        }
                    }
                    let _ = tx.send(Msg::StreamClosed);
                    ctx.request_repaint();
                });
            }
            Err(err) => {
                self.toast = Some((format!("Live updates unavailable: {err}"), true));
                self.schedule_retry(id);
            }
        }
    }

    /// Queues another connection attempt, waiting longer each time. Without
    /// this a sidecar that is down is dialled once per frame for as long as
    /// the window stays open.
    pub(crate) fn schedule_retry(&mut self, id: String) {
        let wait = 250u64 << self.retries.min(5);
        self.retries += 1;
        self.resubscribe = Some(id);
        self.retry_at = Some(
            std::time::Instant::now() + std::time::Duration::from_millis(wait),
        );
    }

    /// Fold one streamed event into the current session.
    pub fn apply_event(&mut self, event: Event) {
        match event.kind.as_str() {
            "status" => {
                if let Some(session) = event.session {
                    let was_recording = self.recording;
                    // A paused recording is still a live recording: the browser
                    // is open and it continues from where it left off.
                    self.recording = session.status == "recording" || session.status == "paused";
                    self.paused = session.status == "paused";
                    if self.recording && !was_recording {
                        self.accent = crate::theme::DANGER;
                    }
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
            // The sidecar's own spelling, not a shortened one: matching "replay"
            // here meant every status update was silently dropped, so the UI
            // showed a run as still going after it had already ended.
            "replay:status" => {
                if let (Some(replay), Some(session)) = (event.replay, self.session.as_mut()) {
                    session.replay = Some(replay);
                }
            }
            // The sidecar announces a finished run here and nowhere else, so this
            // is what puts a pass *and* a failure into the Runs tab.
            "run" => {
                if let (Some(run), Some(session)) = (event.run, self.session.as_mut()) {
                    session.runs.retain(|r| r.id != run.id);
                    session.runs.insert(0, run);
                }
            }
            _ => {}
        }
    }
}