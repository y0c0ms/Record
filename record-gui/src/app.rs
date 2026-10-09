// The eframe entry point: drains the message channel, then lays the window
// out. Panel drawing lives in views, side effects in actions.

use eframe::egui;

use crate::state::{Msg, RecordApp, View};
use crate::theme::{self, ACCENT, DANGER, TEXT, TEXT_DIM};

impl RecordApp {
    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Connected(Ok(())) => {
                self.sidecar_ok = true;
                self.toast = None;
            }
            Msg::Connected(Err(err)) => {
                self.sidecar_ok = false;
                self.toast = Some((format!("Sidecar unreachable: {err}"), true));
            }
            Msg::Started(Ok(session)) => {
                self.busy = false;
                self.recording = true;
                self.accent = DANGER;
                self.autoscroll = true;
                let id = session.id.clone();
                self.session = Some(session);
                self.subscribe(id);
            }
            Msg::Started(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not start recording: {err}"), true));
            }
            Msg::Stopped(Ok(session)) => {
                self.busy = false;
                self.recording = false;
                if self.accent == DANGER {
                    self.accent = TEXT_DIM;
                }
                self.session = Some(session);
            }
            Msg::Stopped(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not stop: {err}"), true));
            }
            Msg::ReplayStarted(Ok(_)) => {
                self.busy = false;
                self.accent = ACCENT;
            }
            Msg::ReplayStarted(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not replay: {err}"), true));
            }
            Msg::PauseToggled(Ok(session)) => {
                self.busy = false;
                self.paused = session.status == "paused";
                self.session = Some(session);
            }
            Msg::PauseToggled(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not change that: {err}"), true));
            }
            Msg::Inserted(Ok(session)) => {
                self.busy = false;
                self.session = Some(session);
            }
            Msg::Inserted(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not add that step: {err}"), true));
            }
            Msg::Captured(Ok(session)) => {
                self.busy = false;
                // The form closes: the step exists, and what it is was seen in
                // the browser rather than typed as a guess.
                self.insert = None;
                self.session = Some(session);
            }
            Msg::Captured(Err(err)) => {
                self.busy = false;
                if let Some(d) = self.insert.as_mut() {
                    d.recording = false;
                }
                self.toast = Some((err, true));
            }
            Msg::SubflowSaved(Ok(sub)) => {
                self.busy = false;
                self.subflow_draft = None;
                self.subflows.push(sub);
                self.toast = Some(("Subflow saved.".to_string(), false));
            }
            Msg::SubflowSaved(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not save that subflow: {err}"), true));
            }
            Msg::SubflowImported(Ok(session)) => {
                self.busy = false;
                self.subflow_pick = None;
                self.insert = None;
                self.session = Some(session);
            }
            Msg::SubflowImported(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not add that subflow: {err}"), true));
            }
            Msg::SubflowDeleted(Ok(())) => {
                self.busy = false;
                self.toast = Some(("Subflow deleted.".to_string(), false));
            }
            Msg::SubflowDeleted(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not delete that subflow: {err}"), true));
            }
            Msg::CaptureCancelled(Ok(())) => {}
            Msg::CaptureCancelled(Err(err)) => {
                self.toast = Some((format!("Could not close that window: {err}"), true));
            }
            Msg::Event(event) => self.apply_event(event),
            Msg::History(Ok(list)) => self.history = list,
            Msg::History(Err(err)) => {
                self.toast = Some((format!("Could not load recordings: {err}"), true));
            }
            Msg::StepReordered(Ok(session)) => {
                self.busy = false;
                self.session = Some(session);
            }
            Msg::StepReordered(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not move that step: {err}"), true));
            }
            Msg::Loaded(Ok(session)) => {
                self.busy = false;
                self.flow_name = session.name.clone();
                // Opening a recording has to subscribe as well as starting one.
                // Without it the GUI learned about a replay only for a flow it
                // had recorded in this window: it could send Pause and Stop, but
                // never heard back what they did, so the buttons described a run
                // it had no information about.
                self.subscribe(session.id.clone());
                self.session = Some(session);
                self.spec_code.clear();
            }
            Msg::Loaded(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not open that recording: {err}"), true));
            }
            Msg::Spec(Ok(code)) => {
                self.busy = false;
                match code {
                    Some(text) => {
                        self.spec_code = text;
                        self.view = View::Code;
                    }
                    None => self.toast = Some(("No steps to export yet.".to_string(), true)),
                }
            }
            Msg::Spec(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not export: {err}"), true));
            }
            Msg::Deleted(Ok(id)) => {
                self.busy = false;
                self.history.retain(|s| s.id != id);
                if self.session.as_ref().map(|s| s.id.as_str()) == Some(id.as_str()) {
                    self.session = None;
                    self.spec_code.clear();
                }
            }
            Msg::Deleted(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not delete: {err}"), true));
            }
            // A silent refresh keeps whichever view is open, so editing a step
            // never yanks the user out of the code they are reading.
            Msg::SpecRefresh(code) => {
                self.spec_code = code;
            }
            Msg::StepEdited(Ok(session)) => {
                self.busy = false;
                self.draft = None;
                self.session = Some(session);
                // The spec is generated from the same steps, so an edit has to
                // refresh it or the code view would show stale code.
                self.refresh_spec();
            }
            Msg::StepEdited(Err(err)) => {
                self.busy = false;
                self.draft = None;
                self.toast = Some((format!("Could not apply that change: {err}"), true));
            }
            Msg::StepDeleted(Ok(session)) => {
                self.busy = false;
                self.session = Some(session);
                self.refresh_spec();
            }
            Msg::StepDeleted(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not remove that step: {err}"), true));
            }
            Msg::Folders(Ok(folders)) => {
                self.folders = folders;
            }
            Msg::Folders(Err(err)) => {
                self.toast = Some((format!("Could not load folders: {err}"), true));
            }
            Msg::FolderSaved(Ok(folder)) => {
                self.busy = false;
                self.folder_draft = None;
                // A rename changes a label already on screen, so refresh the
                // list rather than patching one entry.
                self.toast = Some((format!("Folder “{}” saved", folder.name), false));
                self.load_folders();
            }
            Msg::FolderSaved(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not save that folder: {err}"), true));
            }
            Msg::FolderDeleted(Ok(())) => {
                self.busy = false;
                // Deleting the folder being viewed would leave the filter
                // pointing at nothing, so fall back to showing everything.
                self.load_folders();
            }
            Msg::FolderDeleted(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not delete that folder: {err}"), true));
            }
            Msg::Moved(Ok(session)) => {
                self.busy = false;
                self.session = Some(session);
                self.refresh_history();
                self.load_folders();
            }
            Msg::Moved(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not move that recording: {err}"), true));
            }
            // Losing the stream used to be terminal for the session: the toast
            // said the sidecar had gone, and nothing ever reconnected. The GUI
            // then went blind — it could still send commands, but never learned
            // what happened to them, so a paused replay looked like a running
            // one and Resume sent a second Pause. Reconnecting is what makes the
            // controls describe the run they are controlling.
            Msg::StreamClosed => match self.session.as_ref().map(|s| s.id.clone()) {
                Some(id) => self.schedule_retry(id),
                None => {
                    self.toast = Some((
                        "Lost the connection to the sidecar. Is it still running?".to_string(),
                        true,
                    ));
                }
            },
            // The run's own status arrives over the stream, so nothing is
            // patched here — only the busy flag the press set.
            Msg::ReplayControl(Ok(())) => self.busy = false,
            Msg::ReplayControl(Err(err)) => {
                self.busy = false;
                self.toast = Some((format!("Could not change the run: {err}"), true));
            }
            Msg::ShotLoaded(url, texture) => {
                self.shot_tex.insert(url, texture);
            }
        }
    }

}

impl eframe::App for RecordApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        while let Ok(msg) = self.rx.try_recv() {
            self.handle(msg);
            ctx.request_repaint();
        }
        // Reconnect after a dropped stream. Timed rather than retried every
        // frame, because a sidecar that is not coming back would otherwise be
        // dialled once per repaint for as long as the window stayed open.
        if let (Some(id), Some(at)) = (self.resubscribe.clone(), self.retry_at) {
            if std::time::Instant::now() >= at {
                self.resubscribe = None;
                self.retry_at = None;
                self.subscribe(id);
            } else {
                ctx.request_repaint_after(at.saturating_duration_since(std::time::Instant::now()));
            }
        }

        // egui repaints on input only; while a recording or replay is live the
        // worker threads deliver events asynchronously, so keep asking for
        // frames until the state settles.
        if self.recording || self.busy {
            ctx.request_repaint();
        }

        let bar = theme::header_bar();

        ui.allocate_ui_with_layout(
            egui::Vec2::new(ui.available_width(), 56.0),
            egui::Layout::top_down(egui::Align::Min),
            |ui| {
                bar.show(ui, |ui| self.header(ui));
            },
        );
        ui.add_space(8.0);

        // The step detail panel is a right-hand panel rather than a column
        // beside the list. As a column its width came out of `available_width`
        // at a point where the layout had already been narrowed by the header
        // and the sidebar, so a wide window could push it past the right edge
        // and it was laid out off-screen with nothing visible. A right panel is
        // sized against the viewport itself, so it cannot land outside it.
        //
        // It is still only shown when there is something to show: the panel is
        // about one step, so with no selection there is no step to be about.
        //
        // A run gets the same treatment. A run's steps, timings and locators are
        // too much to read in the list beside them — and that list is the thing
        // being read, so crowding it with the detail of whichever run is open
        // hides the other runs.
        let show_run_panel = self.view == View::Runs && self.carousel_run.is_some();
        if show_run_panel {
            egui::Panel::right("run_panel")
                .exact_size(420.0)
                .resizable(true)
                .show(ui, |ui| self.run_panel(ui));
        } else {
            let show_panel = self.view == View::Steps && self.selected.is_some();
            if show_panel {
                egui::Panel::right("step_panel")
                    .exact_size(340.0)
                    .resizable(true)
                    .show(ui, |ui| self.step_panel(ui));
            }
        }

        egui::CentralPanel::default()
            .frame(egui::Frame::NONE)
            .show(ui, |ui| {
                let side = egui::Panel::left("controls")
                    .exact_size(340.0)
                    .resizable(false);
                side.show(ui, |ui| {
                    ui.vertical(|ui| {
                        ui.heading(egui::RichText::new("Session").size(15.0).color(TEXT));
                        ui.add_space(4.0);
                        self.controls(ui);
                        ui.add_space(4.0);
                        self.folder_picker(ui);
                    });
                    // The search box comes before the folder tree, not after it
                    // with the list it filters. The tree changes shape as the
                    // query narrows it, so a box beneath it would move under
                    // the reader on every keystroke.
                    ui.separator();
                    self.search_box(ui);
                    self.folder_panel(ui);
                    ui.separator();
                    self.history_panel(ui);
                    ui.separator();
                    ui.label(
                        egui::RichText::new("Engine")
                            .size(11.0)
                            .color(TEXT_DIM)
                            .strong(),
                    );
                    // The channel is the part that is not obvious from the product
                    // name, so show it only when it adds information.
                    let engine = if self.browser.contains("Edge") {
                        format!("{} · Playwright channel msedge", self.browser)
                    } else {
                        self.browser.clone()
                    };
                    ui.label(egui::RichText::new(engine).size(11.5).color(TEXT_DIM));
                });

                ui.vertical(|ui| {
                    ui.horizontal(|ui| {
                        // Three views of one model. The code view is always
                        // available: editing a step changes what it generates, it
                        // never replaces it.
                        for (i, (name, id)) in [
                            ("Steps", View::Steps),
                            ("Code", View::Code),
                            ("Runs", View::Runs),
                            ("Dataset", View::Dataset),
                        ]
                        .iter()
                        .enumerate()
                        {
                            if i > 0 {
                                ui.add_space(4.0);
                            }
                            if ui
                                .selectable_label(
                                    self.view == *id,
                                    egui::RichText::new(*name).size(13.5),
                                )
                                .clicked()
                            {
                                self.view = *id;
                            }
                        }

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let count = self.steps().len();
                            ui.label(
                                egui::RichText::new(format!("{count}"))
                                    .monospace()
                                    .size(12.0)
                                    .color(TEXT_DIM),
                            );
                            let mut follow = self.autoscroll;
                            if ui
                                .checkbox(&mut follow, egui::RichText::new("Follow").size(11.5))
                                .changed()
                            {
                                self.autoscroll = follow;
                            }
                        });
                    });
                    ui.add_space(4.0);
                    ui.separator();
                    // The list takes whatever the panels leave. It is not given
                    // a width of its own, so a resize widens it rather than
                    // crowding the panel.
                    match self.view {
                        View::Steps => self.steps_editor(ui),
                        View::Code => self.spec_panel(ui),
                        View::Runs => self.runs_panel(ui),
                        View::Dataset => self.dataset_panel(ui),
                    }
                });
            });


        ui.add_space(6.0);
        ui.separator();
        self.footer(ui);

        // Drawn last so it sits over everything, including the panel whose
        // miniature opened it.
        self.shot_viewer(&ctx);
    }
}
