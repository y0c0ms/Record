// The sidebar and the non-editor panels: where a session is configured, which
// recordings exist, and what the code looks like. The no-code step editor
// lives in views::editor.

use eframe::egui;

use crate::api;
use crate::state::RecordApp;
use crate::icons::{self, Icon};
use crate::theme::{self, ACCENT, DANGER, TEXT, TEXT_DIM, OK, SHOW_HISTORY};

pub mod editor;
pub mod folders;
pub mod panel;

/// Where a step inserted at `at` would land, in words. One phrasing for every
/// place a position is shown — the hover on a gap, the form it opens, the
/// subflow picker — so the same position is never described two ways.
pub fn position_of(at: usize) -> String {
    if at <= 1 {
        "before the first step".to_string()
    } else {
        format!("after step {}", at - 1)
    }
}

impl RecordApp {
    pub fn header(&self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("Record").size(21.0).strong().color(TEXT));
            ui.label(
                egui::RichText::new(format!("· {}", self.browser))
                    .size(12.5)
                    .color(TEXT_DIM),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let (label, color) = if self.recording {
                    ("Recording".to_string(), DANGER)
                } else if self.sidecar_ok {
                    ("Ready".to_string(), OK)
                } else {
                    ("Sidecar offline".to_string(), DANGER)
                };
                ui.label(egui::RichText::new(label).size(12.5).color(color));
                // A dot rather than a glyph: the same mark at any font, and it
                // takes the status colour without depending on a character.
                let (rect, _) = ui.allocate_exact_size(
                    egui::vec2(icons::SIZE, icons::SIZE),
                    egui::Sense::hover(),
                );
                ui.painter().circle_filled(rect.center(), 4.0, color);
            });
        });
        ui.label(
            egui::RichText::new(if self.demo_url.is_empty() {
                "Start the sidecar: npm start".to_string()
            } else {
                format!("Demo target: {}", self.demo_url)
            })
            .size(11.5)
            .color(TEXT_DIM),
        );
    }

    pub fn controls(&mut self, ui: &mut egui::Ui) {
        ui.add_enabled_ui(!self.recording && !self.busy, |ui| {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("Flow name").size(12.5).color(TEXT_DIM));
                ui.add(
                    egui::TextEdit::singleline(&mut self.flow_name)
                        .desired_width(190.0)
                        .hint_text("Checkout happy path"),
                );
            });
            // The start URL is not a session setting: it is step 1 of the flow,
            // shown and edited in the step list like any other step. A field
            // here meant the URL the flow was recorded at and the URL the flow
            // replayed could drift apart, and neither one showed the other.
            // This button only picks a starting point for the next recording.
            if !self.demo_url.is_empty()
                && ui
                    .add(egui::Button::new("Use demo").min_size(egui::vec2(60.0, 20.0)))
                    .clicked()
            {
                self.start_url = self.demo_url.clone();
            }
        });

        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            let can_record = self.sidecar_ok && !self.recording && !self.busy;
            if icons::labelled(
                ui,
                Icon::Record,
                "Start recording",
                "Open a browser and record what you do",
                if can_record { theme::OK } else { theme::TEXT_DIM },
            )
            .clicked()
            {
                self.start_recording();
            }
            // Pause and Stop interrupt whatever is currently running. A
            // recording and a replay are different things with different
            // controls on the server, and sending a replay the recording verbs
            // did nothing at all — so which one is live decides where the click
            // goes, rather than the button always meaning "the recording".
            let replaying = self.replay_running();
            let replay_paused = self.replay_paused();
            let (icon, label) = if self.paused || replay_paused {
                (Icon::Play, "Resume")
            } else {
                (Icon::Pause, "Pause")
            };
            let interrupting = self.recording || replaying;
            if icons::labelled(ui, icon, label, "", if interrupting { theme::TEXT } else { theme::TEXT_DIM })
                .clicked()
            {
                // No routing here: the action asks the sidecar what is running.
                // Which one it is can change between the press and the reply.
                self.interrupt(self.paused || replay_paused);
            }
            let stop_hint = if replaying { "End the run, keeping its record" } else { "End the recording" };
            if icons::labelled(ui, Icon::Stop, "Stop", stop_hint, theme::DANGER).clicked() {
                self.stop();
            }
            let has_steps = !self.steps().is_empty();
            let can_replay = has_steps && !self.recording && !replaying && !self.busy;
            let can_export = has_steps && !self.recording && !self.busy;
            if icons::labelled(
                ui,
                Icon::Play,
                "Replay",
                "Run the steps again",
                if can_replay { theme::ACCENT } else { theme::TEXT_DIM.gamma_multiply(0.5) },
            )
            .clicked()
            {
                self.start_replay();
            }
            if icons::labelled(
                ui,
                Icon::Download,
                "Export spec",
                "",
                if can_export { theme::TEXT_DIM } else { theme::TEXT_DIM.gamma_multiply(0.5) },
            )
            .clicked()
            {
                self.export_spec();
            }
        });

        ui.add_space(6.0);
        if let Some(session) = &self.session {
            ui.label(
                egui::RichText::new(&session.name)
                    .size(12.5)
                    .strong()
                    .color(TEXT),
            );
            let count = session.steps.len();
            // A paused run is a run. Rendering it as "N steps captured" made a
            // suspended replay look like nothing had started, which is the
            // one state where the reader most needs to be told what is going on.
            let summary = match &session.replay {
                Some(r) if r.status == "running" => {
                    format!("replaying {}/{} steps", r.passed + r.failed, r.total)
                }
                Some(r) if r.status == "paused" => {
                    format!("replay paused at step {} of {}", r.passed + r.failed + 1, r.total)
                }
                Some(r) if r.status == "cancelled" => {
                    format!("replay stopped at step {} of {}", r.passed + r.failed + 1, r.total)
                }
                Some(r) if r.status == "passed" => {
                    format!("replay passed · {}/{} steps", r.passed, r.total)
                }
                Some(r) if r.status == "failed" => format!(
                    "replay failed at step {} of {}",
                    r.passed + r.failed + 1,
                    r.total
                ),
                _ => format!(
                    "{} step{} captured",
                    count,
                    if count == 1 { "" } else { "s" }
                ),
            };
            ui.label(egui::RichText::new(summary).size(12.0).color(self.accent));
            if let Some(err) = &session.error {
                ui.label(egui::RichText::new(err).size(11.5).color(DANGER));
            }
        } else {
            ui.label(
                egui::RichText::new("No session yet.")
                    .size(12.0)
                    .color(TEXT_DIM),
            );
        }
    }

    /// The one box that finds a recording, by name, wherever it is filed.
    ///
    /// Rendered above the folder tree rather than beside the list it filters.
    /// Filtering a tree means the tree changes shape as the query changes, and
    /// a control sitting below something that grows moves every keystroke —
    /// the field the reader is typing in slides down under their cursor. Above
    /// the tree, nothing it does can move it.
    pub fn search_box(&mut self, ui: &mut egui::Ui) {
        let mut query = self.search.clone();
        if ui
            .add(
                egui::TextEdit::singleline(&mut query)
                    .hint_text("Search recordings and folders")
                    .desired_width(f32::INFINITY),
            )
            .changed()
        {
            self.search = query;
        }
        ui.add_space(2.0);
    }

    /// Past recordings, newest first. Reopening one is how a user iterates on a
    /// flow they recorded earlier without redoing the whole session.
    ///
    /// A search narrows this list and the folder tree at the same time, so one
    /// box finds a recording whether it is filed or not, and without a name
    /// remembered exactly.
    pub fn history_panel(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icons::button(ui, Icon::Refresh, "Reload from disk", TEXT_DIM).clicked() {
                    self.refresh_history();
                }
                let total = self.history.len();
                if total > SHOW_HISTORY && self.search.trim().is_empty() {
                    let label = if self.show_all_history {
                        "Show less".to_string()
                    } else {
                        format!("Show all {total}")
                    };
                    if ui.small_button(label).clicked() {
                        self.show_all_history = !self.show_all_history;
                    }
                }
                ui.label(
                    egui::RichText::new("Recordings")
                        .size(11.0)
                        .color(TEXT_DIM)
                        .strong(),
                );
            });
        });
        ui.add_space(2.0);

        let searching = !self.search.trim().is_empty();
        let rows: Vec<api::Summary> = self
            .history
            .iter()
            // A folder filter narrows the list; None shows everything.
            .filter(|e| match &self.active_folder {
                Some(id) => e.folder.as_deref() == Some(id.as_str()),
                None => true,
            })
            // An empty box is not a filter that matches nothing: it is no
            // filter at all, which is what makes clearing the search work.
            .filter(|e| {
                !searching || e.name.to_lowercase().contains(&self.search.trim().to_lowercase())
            })
            .take(if searching || self.show_all_history {
                self.history.len()
            } else {
                SHOW_HISTORY.min(self.history.len())
            })
            .cloned()
            .collect();

        if rows.is_empty() {
            ui.label(
                egui::RichText::new(if searching {
                    "No recording matches that."
                } else {
                    "Nothing in this folder yet."
                })
                .size(11.5)
                .color(TEXT_DIM),
            );
            return;
        }

        egui::ScrollArea::vertical()
            .id_salt("history")
            .max_height(190.0)
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for entry in rows {
                    self.recording_row(ui, &entry, 0.0);
                }
            });
    }

    /// The exported Playwright spec. Shown read-only apart from the code
    /// viewer: the generated file is the artifact users hand to their test
    /// suite, so the GUI shows exactly what was written and offers a copy
    /// button rather than inviting edits that would be overwritten.
    pub fn spec_panel(&mut self, ui: &mut egui::Ui) {
        if self.spec_code.is_empty() {
            ui.add_space(20.0);
            ui.vertical_centered(|ui| {
                ui.label(
                    egui::RichText::new("No spec exported yet")
                        .size(14.0)
                        .color(TEXT_DIM),
                );
                ui.label(
                    egui::RichText::new("Record some steps, then press Export spec.")
                        .size(12.0)
                        .color(TEXT_DIM),
                );
            });
            return;
        }

        ui.horizontal(|ui| {
            ui.label(
                egui::RichText::new("generated/<session>.spec.js")
                    .monospace()
                    .size(11.0)
                    .color(TEXT_DIM),
            );
            if ui.button("⧉  Copy").clicked() {
                ui.ctx().copy_text(self.spec_code.clone());
                self.toast = Some(("Spec copied to clipboard.".to_string(), false));
            }
        });
        ui.add_space(4.0);

        egui::ScrollArea::vertical()
            .id_salt("spec")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                ui.add(
                    egui::TextEdit::multiline(&mut self.spec_code)
                        .font(egui::TextStyle::Monospace)
                        .desired_width(f32::INFINITY)
                        .desired_rows(24),
                );
            });
    }

    pub fn footer(&self, ui: &mut egui::Ui) {
        if let Some((msg, is_error)) = &self.toast {
            ui.label(
                egui::RichText::new(msg)
                    .size(12.0)
                    .color(if *is_error { DANGER } else { OK }),
            );
        } else {
            ui.label(
                egui::RichText::new(format!(
                    "Playwright · channel msedge · sidecar {}",
                    api::SIDECAR_ORIGIN
                ))
                .size(11.0)
                .color(TEXT_DIM),
            );
        }
    }

    /// Recorded detail: the locator ladder and per-step status, for when the
    /// phrase above is not enough to explain a replay failure.
    pub fn steps_panel(&mut self, ui: &mut egui::Ui) {
        let steps = self.steps().to_vec();
        let autoscroll = self.autoscroll;
        self.subflow_save_bar(ui);
        ui.add_space(4.0);
        egui::ScrollArea::vertical()
            .stick_to_bottom(autoscroll)
            .auto_shrink([false, false])
            .id_salt("steps")
            .show(ui, |ui| {
                if steps.is_empty() {
                    ui.add_space(14.0);
                    ui.vertical_centered(|ui| {
                        ui.label(egui::RichText::new("No steps yet").size(14.0).color(TEXT_DIM));
                        ui.label(
                            egui::RichText::new(
                                "Press Start recording, drive the Edge window, then press Stop.",
                            )
                            .size(12.0)
                            .color(TEXT_DIM),
                        );
                    });
                    return;
                }

                let mut rows = Vec::with_capacity(steps.len());
                egui::Grid::new("steps_grid")
                    .num_columns(2)
                    .spacing([8.0, 6.0])
                    .striped(false)
                    .show(ui, |ui| {
                        // A "+" before the first step and between every pair,
                        // plus one at the end. Each opens the same form at that
                        // position, so adding a step is a choice of *where* and
                        // not a separate flow.
                        self.insert_slot(ui, 1);
                        ui.end_row();
                        for (n, step) in steps.iter().enumerate() {
                            let (badge, color) = match step.status.as_str() {
                                "passed" => (OK, OK),
                                "failed" => (DANGER, DANGER),
                                "running" => (ACCENT, TEXT),
                                _ => (TEXT_DIM, TEXT),
                            };
                            let status = if step.status.is_empty() {
                                step.kind.clone()
                            } else {
                                step.status.clone()
                            };

                            rows.push(());
                            ui.vertical(|ui| {
                                ui.set_width(300.0);
                                ui.label(
                                    egui::RichText::new(&step.title)
                                        .size(13.0)
                                        .strong()
                                        .color(color),
                                );
                                // What a fill/select step actually enters, and
                                // whether a dataset parameter overrides it.
                                let value = step.raw_value();
                                if !value.is_empty() {
                                    let color = if step.is_param() { ACCENT } else { TEXT_DIM };
                                    ui.label(
                                        egui::RichText::new(format!("value: {value}"))
                                            .monospace()
                                            .size(11.0)
                                            .color(color),
                                    );
                                }
                                if !step.detail.is_empty() {
                                    ui.label(
                                        egui::RichText::new(&step.detail)
                                            .monospace()
                                            .size(11.0)
                                            .color(TEXT_DIM),
                                    );
                                }
                                // Show the whole fallback ladder: a step with
                                // several locators survives a page redesign in
                                // a way a single locator does not, and the user
                                // should be able to see that before replaying.
                                if step.candidates.len() > 1 {
                                    let fallbacks: Vec<String> = step
                                        .candidates
                                        .iter()
                                        .skip(1)
                                        .map(|c| c.describe())
                                        .collect();
                                    ui.label(
                                        egui::RichText::new(format!(
                                            "{} ways to find this · {} fallbacks",
                                            step.candidates.len(),
                                            fallbacks.len()
                                        ))
                                        .size(10.5)
                                        .color(TEXT_DIM),
                                    )
                                    .on_hover_text(fallbacks.join("\n"));
                                }
                                // When the run had to fall back, or had to wait
                                // for the element, say so. Both are the
                                // difference between a test that will keep
                                // working and one that is about to break.
                                if let Some(found) = &step.resolved_locator {
                                    let used_fallback = step
                                        .candidates
                                        .first()
                                        .map(|c| c != found)
                                        .unwrap_or(false);
                                    let waited = step.locator_wait_ms.unwrap_or(0.0) / 1000.0;
                                    if used_fallback || waited > 1.0 {
                                        ui.label(
                                            egui::RichText::new(format!(
                                                "used {} after {:.0}s of waiting",
                                                found.describe(),
                                                waited
                                            ))
                                            .size(10.5)
                                            .color(if used_fallback {
                                                theme::ACCENT
                                            } else {
                                                TEXT_DIM
                                            }),
                                        );
                                    }
                                }
                                if let Some(err) = &step.error {
                                    // A timeout is not the same failure as a
                                    // refused action, and the fix is different:
                                    // one needs a new locator, the other needs
                                    // the page to settle. Naming which it was
                                    // is the whole value of the message.
                                    let timed_out = step.failure_kind.as_deref() == Some("locator-timeout");
                                    if timed_out {
                                        ui.label(
                                            egui::RichText::new("Element never appeared")
                                                .size(11.0)
                                                .strong()
                                                .color(DANGER),
                                        );
                                    }
                                    ui.label(egui::RichText::new(err).size(11.0).color(DANGER));
                                }
                                // Marks the run of steps a subflow would cover.
                                // Clicking the first and last step of a run is
                                // how a group is chosen; the rows in between are
                                // shown so the range is never a surprise.
                                if let Some(draft) = &self.subflow_draft {
                                    if (step.index as usize) >= draft.from
                                        && (step.index as usize) <= draft.to
                                    {
                                        ui.label(
                                            egui::RichText::new("· part of the subflow ·")
                                                .size(10.0)
                                                .color(ACCENT),
                                        );
                                    }
                                }
                            });
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                ui.label(
                                    egui::RichText::new(format!("{:>2}", step.index))
                                        .monospace()
                                        .size(12.0)
                                        .color(badge),
                                );
                                ui.label(
                                    egui::RichText::new(status).small().color(badge),
                                );
                                // Ticking a step starts or extends the run of
                                // steps that "save as subflow" will take. The
                                // run is always contiguous, because a subflow
                                // that skipped steps would not replay.
                                let in_run = self
                                    .subflow_draft
                                    .as_ref()
                                    .map(|d| {
                                        (step.index as usize) >= d.from && (step.index as usize) <= d.to
                                    })
                                    .unwrap_or(false);
                                let mut tick = in_run;
                                if ui
                                    .checkbox(&mut tick, egui::RichText::new("sub").size(10.5))
                                    .changed()
                                {
                                    self.toggle_subflow_step(step.index as usize, tick);
                                }
                            });
                            ui.end_row();
                            // The gap after this step is where the next one goes.
                            self.insert_slot(ui, n + 2);
                            ui.end_row();
                        }
                    });
            });
    }

    /// The bar shown while a run of steps is marked for a subflow. It is above
    /// the list rather than in a dialog: saving keeps the steps in place, so
    /// the user needs to see what they are still marking.
    fn subflow_save_bar(&mut self, ui: &mut egui::Ui) {
        let Some(draft) = self.subflow_draft.clone() else {
            return;
        };
        let count = draft.to - draft.from + 1;
        ui.horizontal(|ui| {
            ui.label(
                egui::RichText::new(format!("Steps {}–{} selected", draft.from, draft.to))
                    .size(11.0)
                    .strong()
                    .color(ACCENT),
            );
            let mut name = draft.name.clone();
            let response = ui.add(
                egui::TextEdit::singleline(&mut name)
                    .hint_text("Subflow name")
                    .desired_width(150.0),
            );
            if response.changed() {
                if let Some(d) = self.subflow_draft.as_mut() {
                    d.name = name.clone();
                }
            }
            let ready = !name.trim().is_empty() && !self.busy;
            if ui
                .add_enabled(
                    ready,
                    egui::Button::new(format!("Save {count} steps")).small(),
                )
                .clicked()
            {
                self.save_subflow(draft.from, draft.to, name);
            }
            if icons::button(ui, Icon::Close, "Clear the selection", theme::TEXT_DIM).clicked() {
                self.subflow_draft = None;
            }
        });
    }

    /// The "+" between steps, and the form it opens. Manual entry is the
    /// default: a recorded step is only worth its cost when the target is
    /// something that cannot be typed, so recording is offered but never
    /// assumed.
    pub(crate) fn insert_slot(&mut self, ui: &mut egui::Ui, at: usize) {
        if self.subflow_pick == Some(at) {
            self.subflow_form(ui, at);
            return;
        }
        let open = self.insert.as_ref().map(|d| d.at) == Some(at);
        if open {
            self.insert_form(ui, at);
            return;
        }

        // One round "+" centred in the gap it fills, sitting on a hairline rule
        // that only appears while the pointer is anywhere on the gap. The list
        // then reads as a column of steps with a seam between them rather than a
        // stack of buttons, and the affordance is still there the moment it is
        // wanted.
        let (rect, _) =
            ui.allocate_exact_size(egui::vec2(ui.available_width(), 18.0), egui::Sense::hover());
        let hovered = ui.rect_contains_pointer(rect.expand(6.0));
        let painter = ui.painter();
        let mid = rect.center().y;
        let half_gap = 11.0;
        if hovered {
            // The rule runs either side of the circle rather than under it, so
            // the circle is not bisected and the seam still reads as one line.
            let rule = egui::Stroke::new(1.0, theme::BORDER);
            painter.hline(egui::Rangef::new(rect.left(), rect.center().x - half_gap), mid, rule);
            painter.hline(egui::Rangef::new(rect.center().x + half_gap, rect.right()), mid, rule);
        }
        let circle = egui::Rect::from_center_size(rect.center(), egui::vec2(18.0, 18.0));
        painter.circle_filled(circle.center(), 8.0, theme::SURFACE_2);
        painter.circle_stroke(
            circle.center(),
            8.0,
            egui::Stroke::new(1.0, if hovered { ACCENT } else { theme::BORDER }),
        );
        painter.text(
            circle.center(),
            egui::Align2::CENTER_CENTER,
            "+",
            egui::FontId::proportional(13.0),
            if hovered { ACCENT } else { TEXT_DIM },
        );

        // The circle is its own interaction rect, so what is drawn and what is
        // clickable cannot disagree — and so the click lands on the 18px the
        // user can see rather than on the full width of the gap.
        let button = ui.interact(circle, ui.id().with(("insert", at)), egui::Sense::click());
        if button.clicked() {
            self.insert = Some(crate::state::InsertDraft {
                at,
                action: "click".to_string(),
                label: String::new(),
                value: String::new(),
                param: String::new(),
                recording: false,
            });
        }
        button.on_hover_text(format!("Insert a step {}", position_of(at)));

        // Saved groups are offered on the same gap rather than as a second
        // button on it: they are the rarer choice, and a second button per gap
        // would undo what the round "+" is for.
        if hovered && !self.subflows.is_empty() {
            if ui
                .add(
                    egui::Button::new(egui::RichText::new("from a subflow").size(10.5).color(ACCENT))
                        .frame(false)
                        .min_size(egui::vec2(90.0, 16.0)),
                )
                .clicked()
            {
                self.subflow_pick = Some(at);
            }
        }
    }

    /// The subflow picker opened from a "+" slot: a list of saved groups, and
    /// the one that will be dropped in at this position.
    fn subflow_form(&mut self, ui: &mut egui::Ui, at: usize) {
        let position = position_of(at);
        ui.vertical(|ui| {
            ui.set_width(300.0);
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new(format!("Add a subflow {position}"))
                        .size(11.0)
                        .strong()
                        .color(ACCENT),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if icons::button(ui, Icon::Close, "Cancel", theme::TEXT_DIM).clicked() {
                        self.subflow_pick = None;
                    }
                });
            });

            if self.subflows.is_empty() {
                theme::empty_state(
                    ui,
                    "No subflows yet",
                    "Select a run of steps in the Detail view and save it as one, \
                     then it can be added here.",
                );
                return;
            }

            for sub in self.subflows.clone() {
                ui.horizontal(|ui| {
                    let label = format!("{}  ·  {} steps", sub.name, sub.step_count);
                    if ui
                        .selectable_label(false, egui::RichText::new(label).size(12.0))
                        .clicked()
                    {
                        self.import_subflow(sub.id.clone(), at);
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if icons::button(ui, Icon::Trash, "Delete this subflow", theme::DANGER)
                            .clicked()
                        {
                            self.delete_subflow(sub.id.clone());
                            self.subflows.retain(|s| s.id != sub.id);
                        }
                    });
                });
            }
        });
    }

    fn insert_form(&mut self, ui: &mut egui::Ui, at: usize) {
        let Some(draft) = self.insert.clone() else { return };
        let position = position_of(at);

        // While a capture is running the step comes from the browser, so the
        // typed fields would only invite an edit that has nowhere to go.
        if draft.recording && self.busy {
            self.capture_form(ui);
            return;
        }
        ui.vertical(|ui| {
            ui.set_width(300.0);
            ui.label(
                egui::RichText::new(format!("New step {position}"))
                    .size(11.0)
                    .strong()
                    .color(ACCENT),
            );
            // Every action the sidecar accepts, taken from the same list the
            // server validates against. Offering a hand-picked pair here meant
            // any action not on it — a screenshot, a wait, a key press — could
            // not be added at all, however much the backend supported it.
            egui::Grid::new("insert-action").num_columns(2).spacing([6.0, 2.0]).show(ui, |ui| {
                for a in api::ACTIONS {
                    if ui
                        .selectable_label(draft.action == a.id, egui::RichText::new(a.label).size(12.0))
                        .clicked()
                    {
                        if let Some(d) = self.insert.as_mut() {
                            d.action = a.id.to_string();
                        }
                    }
                    ui.end_row();
                }
            });
            ui.add_space(4.0);
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icons::button(ui, Icon::Close, "Cancel", theme::TEXT_DIM).clicked() {
                    self.insert = None;
                }
                // Readiness follows the action: a step that acts on something
                // is not ready until it says what, one that does not is ready
                // as soon as the values it needs are in.
                let ready = self
                    .insert
                    .as_ref()
                    .and_then(|d| api::action_for(&d.action))
                    .map(|a| {
                        let d = self.insert.as_ref().unwrap();
                        (!a.needs_target || !d.label.trim().is_empty())
                            && (!a.needs_value || !d.value.trim().is_empty())
                    })
                    .unwrap_or(false);
                if ui
                    .add_enabled(ready, egui::Button::new("Add step").small())
                    .clicked()
                {
                    self.insert_step(at);
                }
            });

            let Some(action) = api::action_for(&draft.action) else {
                return;
            };
            // The target and the value fields appear only for the actions that
            // have one. A screenshot has no element to point at, and showing
            // an empty "what to click" box next to it would be asking for an
            // answer the step has no use for.
            if let Some(d) = self.insert.as_mut() {
                if action.needs_target {
                    ui.add(
                        egui::TextEdit::singleline(&mut d.label)
                            .hint_text("What to act on, e.g. Buy")
                            .desired_width(300.0),
                    );
                }
                if action.needs_value {
                    ui.add(
                        egui::TextEdit::singleline(&mut d.value)
                            .hint_text(action.value_label)
                            .desired_width(300.0),
                    );
                    ui.add(
                        egui::TextEdit::singleline(&mut d.param)
                            .hint_text("Optional: make this value a dataset parameter, e.g. SEARCH")
                            .desired_width(300.0),
                    );
                }
            }

            // Recording is the alternative, not the default: it needs the
            // browser open and costs more than typing, so it is offered only
            // when someone actually wants it.
            let recording = self.insert.as_ref().map(|d| d.recording).unwrap_or(false);
            if recording {
                ui.label(
                    egui::RichText::new(
                        "Act on the element in the Edge window, or press Stop in it."
                    )
                    .size(10.5)
                    .color(TEXT_DIM),
                );
                if ui.button("Record this step in the browser").clicked() {
                    self.capture_step(at);
                }
            } else if ui
                .button("Record this step in the browser instead")
                .clicked()
            {
                if let Some(d) = self.insert.as_mut() {
                    d.recording = true;
                }
            }
        });
    }

    /// Shown while the browser is capturing. Only the two things that can be
    /// done are offered: act on the element, or give up.
    fn capture_form(&mut self, ui: &mut egui::Ui) {
        ui.vertical(|ui| {
            ui.set_width(300.0);
            ui.label(
                egui::RichText::new("Recording one step")
                    .size(11.0)
                    .strong()
                    .color(ACCENT),
            );
            ui.label(
                egui::RichText::new(
                    "Act on the element in the Edge window. The step is captured \
                     and the window closes on its own.",
                )
                .size(10.5)
                .color(TEXT_DIM),
            );
            if ui.button("Cancel capture").clicked() {
                self.cancel_capture();
            }
        });
    }
}
