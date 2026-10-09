// The folder bar and the runs view: how recordings are organised, and what
// happened when they were replayed. Both are read-only about a single recording
// and editable about the collection.

use eframe::egui;

use crate::api;
use crate::state::RecordApp;
use crate::icons::{self, Icon};
use crate::theme::{self, ACCENT, DANGER, TEXT, TEXT_DIM, OK};

impl RecordApp {
    /// Folders as a tree, plus an inline field for making one. A folder is
    /// created from here rather than from a dialog: it is one field, and a
    /// modal for one field is a step in the way.
    ///
    /// Each folder expands to list the recordings filed under it, so the tree
    /// and the recording list are the same list seen two ways rather than two
    /// lists to keep in step.
    pub fn folder_panel(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.label(
                egui::RichText::new("Folders")
                    .size(11.0)
                    .color(TEXT_DIM)
                    .strong(),
            );
            if icons::button(ui, Icon::Plus, "New folder", theme::TEXT_DIM).clicked() {
                self.folder_draft = Some(crate::state::FolderDraft {
                    id: None,
                    name: String::new(),
                    parent: None,
                });
            }
        });

        self.folder_draft_field(ui);
        ui.add_space(2.0);

        // "All" is a filter, not a folder: it never appears as a target.
        let all_count: usize = self.history.len();
        self.folder_row(ui, "All recordings", None, all_count, 0, true);

        let folders = self.folders.clone();
        let searching = !self.search.trim().is_empty();
        for folder in &folders {
            // A search that matches nothing should not leave a wall of folders
            // the reader already ruled out, so a folder only shows when it has
            // something the search could have found.
            if searching && !self.folder_matches(folder) {
                continue;
            }
            let indent = 0;
            self.folder_tree_row(ui, folder, indent);
            for child in &folder.children {
                if searching && !self.folder_matches(child) {
                    continue;
                }
                self.folder_tree_row(ui, child, indent + 1);
            }
        }
    }

    /// The inline name field, shown while a folder is being created or renamed.
    /// Taken out of `self` for the row: the closure needs `&mut self` to reach
    /// save and cancel, and the field is only cleared by those two.
    fn folder_draft_field(&mut self, ui: &mut egui::Ui) {
        let Some(mut draft) = self.folder_draft.take() else {
            return;
        };
        let renaming = draft.id.is_some();
        let mut done = false;
        ui.horizontal(|ui| {
            ui.add(
                egui::TextEdit::singleline(&mut draft.name)
                    .hint_text(if renaming { "Rename" } else { "Folder name" })
                    .desired_width(120.0),
            );
            let name = draft.name.clone();
            let saving = !name.trim().is_empty();
            if ui.add_enabled(saving, egui::Button::new("Save").small()).clicked() {
                self.save_folder(draft.id.clone(), name, draft.parent.clone());
                done = true;
            }
            if icons::button(ui, Icon::Close, "Cancel", theme::TEXT_DIM).clicked() {
                done = true;
            }
        });
        if !done {
            self.folder_draft = Some(draft);
        }
    }

    /// A folder in the tree: its name, how many recordings it holds, and the
    /// actions that apply to it. Expanding one lists the recordings underneath.
    fn folder_tree_row(&mut self, ui: &mut egui::Ui, folder: &api::Folder, depth: usize) {
        let id = folder.id.clone();
        let expandable = !folder.children.is_empty() || folder.count > 0;
        // A search opens the folders that hold a match and leaves the rest
        // closed. Opening every folder the moment a query exists was what made
        // the tree grow under the search box on each keystroke, which moved the
        // box the reader was typing in.
        let open = self.expanded.contains(&id)
            || (!self.search.trim().is_empty() && self.folder_matches(folder));
        let indent = 14.0 + depth as f32 * 12.0;

        ui.horizontal(|ui| {
            ui.add_space(indent);

            // The disclosure mark only appears on a folder with something
            // behind it; an empty leaf is shown with a fixed mark instead, so
            // the column does not jump as folders gain recordings.
            if expandable {
                let (rect, response) =
                    ui.allocate_exact_size(egui::vec2(12.0, 14.0), egui::Sense::click());
                // A chevron that turns down when open. Drawn rather than typed,
                // so it is the same mark everywhere and no font can drop it.
                let painter = ui.painter();
                let c = rect.center();
                let half = 3.5;
                let tip = if open {
                    egui::pos2(c.x, c.y + 1.5)
                } else {
                    egui::pos2(c.x + 1.5, c.y)
                };
                let arm = if open {
                    egui::pos2(c.x - half, c.y - 1.5)
                } else {
                    egui::pos2(c.x - 1.5, c.y - half)
                };
                let arm2 = if open {
                    egui::pos2(c.x + half, c.y - 1.5)
                } else {
                    egui::pos2(c.x - 1.5, c.y + half)
                };
                let stroke = egui::Stroke::new(1.3, if open { TEXT_DIM } else { theme::TEXT_DIM });
                painter.line_segment([arm, tip], stroke);
                painter.line_segment([arm2, tip], stroke);
                if response.clicked() {
                    if self.expanded.contains(&id) {
                        self.expanded.remove(&id);
                    } else {
                        self.expanded.insert(id.clone());
                    }
                }
            } else {
                ui.add_space(12.0);
            }

            let (r, _) =
                ui.allocate_exact_size(egui::vec2(icons::SIZE, icons::SIZE), egui::Sense::hover());
            Icon::Folder.paint(
                ui.painter(),
                r.center(),
                if self.active_folder.as_deref() == Some(folder.id.as_str()) {
                    TEXT
                } else {
                    theme::TEXT_DIM
                },
            );

            let selected = self.active_folder.as_deref() == Some(folder.id.as_str());
            let label = egui::RichText::new(format!("{}  {}", folder.name, folder.count))
                .size(12.0)
                .color(if selected { TEXT } else { theme::TEXT_DIM });
            // A sub-folder says so: two levels of the same name read as a
            // duplicate until the indentation is explained.
            let hint = match &folder.parent {
                Some(_) => "Sub-folder — click to show only its recordings",
                None => "Show only this folder",
            };
            if ui
                .selectable_label(selected, label)
                .on_hover_text(hint)
                .clicked()
            {
                self.active_folder = Some(folder.id.clone());
            }

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if !folder.system
                    && icons::button(ui, Icon::Trash, "Delete folder", theme::DANGER).clicked()
                {
                    self.delete_folder(id.clone());
                }
                if !folder.system
                    && icons::button(ui, Icon::Plus, "New sub-folder", theme::TEXT_DIM).clicked()
                {
                    self.folder_draft = Some(crate::state::FolderDraft {
                        id: None,
                        name: String::new(),
                        parent: Some(folder.id.clone()),
                    });
                }
                if !folder.system
                    && icons::button(ui, Icon::Pencil, "Rename folder", theme::TEXT_DIM).clicked()
                {
                    self.folder_draft = Some(crate::state::FolderDraft {
                        id: Some(folder.id.clone()),
                        name: folder.name.clone(),
                        parent: None,
                    });
                }
            });
        });

        // The recordings inside, indented to sit under the folder that holds
        // them rather than as a second, separate list.
        if open {
            let rows = self.recordings_in(&folder.id);
            if rows.is_empty() {
                ui.horizontal(|ui| {
                    ui.add_space(indent + 26.0);
                    ui.label(
                        egui::RichText::new("empty")
                            .size(11.0)
                            .color(theme::TEXT_DIM)
                            .italics(),
                    );
                });
            }
            for entry in rows {
                self.recording_row(ui, &entry, indent + 26.0);
            }
        }
    }

    /// Whether a folder is worth showing under the current search: either the
    /// folder's own name matches, or a recording filed under it does.
    fn folder_matches(&self, folder: &api::Folder) -> bool {
        let needle = self.search.trim().to_lowercase();
        if folder.name.to_lowercase().contains(&needle) {
            return true;
        }
        self.recordings_in(&folder.id)
            .iter()
            .any(|e| e.name.to_lowercase().contains(&needle))
    }

    /// The recordings filed directly under a folder, newest first, narrowed by
    /// the search box.
    fn recordings_in(&self, folder_id: &str) -> Vec<api::Summary> {
        let needle = self.search.trim().to_lowercase();
        self.history
            .iter()
            .filter(|e| e.folder.as_deref() == Some(folder_id))
            .filter(|e| needle.is_empty() || e.name.to_lowercase().contains(&needle))
            .cloned()
            .collect()
    }

    /// The "All recordings" row. It is a filter rather than a folder, so it has
    /// no folder mark, no children, and nothing behind it to expand.
    fn folder_row(
        &mut self,
        ui: &mut egui::Ui,
        name: &str,
        id: Option<String>,
        count: usize,
        depth: usize,
        all: bool,
    ) {
        let selected = self.active_folder.as_deref() == id.as_deref() && id.is_some()
            || self.active_folder.is_none() && id.is_none();
        ui.horizontal(|ui| {
            ui.add_space(14.0 + depth as f32 * 12.0);
            if all {
                ui.add_space(12.0);
                ui.add_space(icons::SIZE);
            } else {
                let (r, _) = ui.allocate_exact_size(
                    egui::vec2(icons::SIZE, icons::SIZE),
                    egui::Sense::hover(),
                );
                icons::Icon::Folder.paint(
                    ui.painter(),
                    r.center(),
                    if selected { TEXT } else { TEXT_DIM },
                );
            }
            let label = egui::RichText::new(format!("{name}  {count}"))
                .size(12.0)
                .color(if selected { TEXT } else { TEXT_DIM });
            if ui
                .selectable_label(selected, label)
                .on_hover_text("Show only this folder")
                .clicked()
            {
                self.active_folder = id;
            }
        });
    }

    /// One recording in the tree: its name, when it was made, and how it is
    /// doing. The same row the flat list used, so a recording reads identically
    /// whether it is being found by folder or by search.
    pub(crate) fn recording_row(
        &mut self,
        ui: &mut egui::Ui,
        entry: &api::Summary,
        indent: f32,
    ) {
        let selected = self
            .session
            .as_ref()
            .map(|s| s.id == entry.id)
            .unwrap_or(false);
        // A filled dot for a live run, an outline for an idle one: circles
        // rather than characters, so no font can fail here.
        let (filled, dot_color) = match entry.status.as_str() {
            "recording" => (true, DANGER),
            "replaying" => (true, ACCENT),
            _ => (false, TEXT_DIM),
        };
        ui.horizontal(|ui| {
            ui.add_space(indent);
            let label = egui::RichText::new(&entry.name)
                .size(12.0)
                .strong()
                .color(if selected { TEXT } else { TEXT_DIM });
            if ui.selectable_label(selected, label).clicked() {
                self.open_session(entry.id.clone());
            }
            let (dot_rect, _) =
                ui.allocate_exact_size(egui::vec2(icons::SIZE, icons::SIZE), egui::Sense::hover());
            if filled {
                ui.painter().circle_filled(dot_rect.center(), 3.5, dot_color);
            } else {
                ui.painter().circle_stroke(
                    dot_rect.center(),
                    3.5,
                    egui::Stroke::new(1.2, dot_color),
                );
            }
            ui.label(
                egui::RichText::new(api::relative_time(entry.created_at))
                    .size(10.5)
                    .color(TEXT_DIM),
            );
            // Nested rows are narrow, so the step count only shows when there is
            // room for it; the flat list has the width for it either way.
            if indent < 20.0 {
                ui.label(
                    egui::RichText::new(format!("{} steps", entry.step_count))
                        .size(10.5)
                        .color(TEXT_DIM),
                );
            }
            if entry.run_count > 0 {
                ui.label(
                    egui::RichText::new(format!("{} runs", entry.run_count))
                        .size(10.5)
                        .color(ACCENT),
                );
            }
            if !self.recording
                && icons::button(ui, Icon::Trash, "Delete this recording", theme::DANGER)
                    .clicked()
            {
                self.delete_session(entry.id.clone());
            }
        });
    }

    /// Where the open recording is filed, with a way to change it. Filing is a
    /// property of the recording, not of the sidebar, so it belongs beside the
    /// other per-recording controls.
    pub fn folder_picker(&mut self, ui: &mut egui::Ui) {
        let Some(session_id) = self.session.as_ref().map(|s| s.id.clone()) else {
            return;
        };
        let current = self.session.as_ref().and_then(|s| s.folder.clone());
        let folders = self.folders.clone();
        // Flattened depth-first so a sub-folder is selectable here and shown
        // under its parent, rather than being reachable only by rearranging the
        // tree first.
        let mut flat: Vec<(String, String, usize)> = Vec::new();
        for folder in &folders {
            flat.push((folder.id.clone(), folder.name.clone(), 0));
            for child in &folder.children {
                flat.push((child.id.clone(), child.name.clone(), 1));
            }
        }

        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("Filed under").size(11.0).color(TEXT_DIM));
            let label = flat
                .iter()
                .find(|(id, _, _)| Some(id) == current.as_ref())
                .map(|(_, name, _)| name.clone())
                .unwrap_or_else(|| "Unfiled".to_string());
            egui::ComboBox::from_id_salt("session_folder")
                .width(140.0)
                .selected_text(label)
                .show_ui(ui, |ui| {
                    for (id, name, depth) in &flat {
                        let at = Some(id.clone());
                        if ui
                            .selectable_value(
                                &mut current.clone(),
                                at.clone(),
                                egui::RichText::new(format!("{}{name}", "    ".repeat(*depth)))
                                    .size(12.0),
                            )
                            .clicked()
                        {
                            self.move_to_folder(session_id.clone(), at);
                        }
                    }
                    if ui
                        .selectable_value(
                            &mut current.clone(),
                            None,
                            egui::RichText::new("Unfiled").size(12.0),
                        )
                        .clicked()
                    {
                        self.move_to_folder(session_id.clone(), None);
                    }
                });
        });
    }

    /// The Dataset tab: this flow's parameters, what each one recorded, and what
    /// to feed the next run. Separate from the Steps tab so changing a value does
    /// not require scrolling past every step to find it.
    pub fn dataset_panel(&mut self, ui: &mut egui::Ui) {
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            ui.label(
                egui::RichText::new("Parameters")
                    .size(15.0)
                    .strong()
                    .color(TEXT),
            );
            ui.label(
                egui::RichText::new("steps that take a value instead of typing one in")
                    .size(11.5)
                    .color(TEXT_DIM),
            );
        });
        ui.add_space(4.0);

        let params = match &self.session {
            Some(s) => s.params(),
            None => Vec::new(),
        };
        if params.is_empty() {
            theme::empty_state(
                ui,
                "No parameters in this flow",
                "Give a step a parameter name and it appears here, ready to change \
                 between runs without editing the flow itself.",
            );
            return;
        }

        // Reconciled against the flow's current parameters, by name.
        //
        // A parameter that is in the flow but not in the draft is added, one
        // that has been removed is dropped — matched by position instead, a
        // value would be applied to whichever parameter moved into its place.
        // A parameter with neither a draft entry nor a value falls back to
        // what the last run actually used, so reopening a flow shows the data
        // the recorded runs say was used rather than an empty column beside a
        // parameter that plainly has one.
        let last_run = self.session.as_ref().and_then(|s| s.runs.first());
        let mut draft = self.dataset.clone().unwrap_or_default();
        draft.values = params
            .iter()
            .map(|p| {
                let typed = draft
                    .values
                    .iter()
                    .find(|(name, _)| name == &p.name)
                    .map(|(_, value)| value.clone());
                let used = last_run
                    .and_then(|run| run.dataset.iter().find(|e| e.name == p.name))
                    .map(|e| e.value.clone());
                (
                    p.name.clone(),
                    typed.or(used).unwrap_or_else(String::new),
                )
            })
            .collect();
        let mut changed = false;

        egui::Grid::new("dataset_grid")
            .num_columns(3)
            .striped(false)
            .spacing([16.0, 8.0])
            .show(ui, |ui| {
                ui.label(
                    egui::RichText::new("Name")
                        .size(11.0)
                        .strong()
                        .color(TEXT_DIM),
                );
                ui.label(
                    egui::RichText::new("Value for the next run")
                        .size(11.0)
                        .strong()
                        .color(TEXT_DIM),
                );
                ui.label(
                    egui::RichText::new("Recorded")
                        .size(11.0)
                        .strong()
                        .color(TEXT_DIM),
                );
                ui.end_row();

                for (index, param) in params.iter().enumerate() {
                    ui.label(
                        egui::RichText::new(param.name.clone())
                            .monospace()
                            .size(12.0)
                            .color(ACCENT),
                    );
                    let blank_hint = format!("blank — use \"{}\"", param.recorded);
                    if let Some((_, value)) = draft.values.get_mut(index) {
                        if ui
                            .add(egui::TextEdit::singleline(value).desired_width(240.0))
                            .changed()
                        {
                            changed = true;
                        }
                        // A field that looks empty but is not is how an override
                        // gets lost; saying so inline is worth the label.
                        if value.is_empty() {
                            ui.label(
                                egui::RichText::new(blank_hint).size(11.0).color(TEXT_DIM),
                            );
                        } else {
                            ui.label(egui::RichText::new(&param.recorded).size(11.0).color(TEXT_DIM));
                        }
                    }
                    ui.end_row();
                }
            });

        let _ = changed;
        ui.add_space(8.0);
        self.dataset_actions(ui, &mut draft);
        self.dataset = Some(draft);
    }

    /// The run controls shared by the parameter table and the inline editor: a
    /// replay button that says what it will do, and a way back to the recorded
    /// values.
    fn dataset_actions(&mut self, ui: &mut egui::Ui, draft: &mut crate::state::DatasetDraft) {
        ui.horizontal(|ui| {
            let entries: Vec<(String, String)> = draft
                .values
                .iter()
                .filter(|(_, v)| !v.trim().is_empty())
                .cloned()
                .collect();
            let overrides = entries.len();
            let label = if overrides == 0 {
                "Replay as recorded".to_string()
            } else {
                format!(
                    "Replay with {overrides} override{}",
                    plural(overrides)
                )
            };
            if icons::labelled(ui, icons::Icon::Play, &label, "", ACCENT).clicked() {
                // The draft is kept, not cleared. Clearing it made the values
                // vanish the moment a run used them, while the Runs tab went on
                // showing exactly which values those were — so the flow looked
                // parameterless and had to be rebuilt on reopening.
                self.start_replay_with(entries);
                return;
            }
            if icons::labelled(ui, icons::Icon::Back, "Use recorded values", "Clear every override", TEXT_DIM)
                .clicked()
            {
                for (_, value) in draft.values.iter_mut() {
                    value.clear();
                }
            }
        });
    }

    /// Past runs: what passed, what failed, with which data, and the screenshots
    /// to look at. A run without history is a claim nobody can check.
    pub fn runs_panel(&mut self, ui: &mut egui::Ui) {
        let Some(session) = &self.session else {
            ui.vertical_centered(|ui| {
                ui.label(
                    egui::RichText::new("Open a recording to see its runs.")
                        .size(12.0)
                        .color(TEXT_DIM),
                );
            });
            return;
        };
        if session.runs.is_empty() {
            ui.vertical_centered(|ui| {
                ui.add_space(20.0);
                ui.label(
                    egui::RichText::new("Never replayed.")
                        .size(12.5)
                        .color(TEXT_DIM),
                );
                ui.label(
                    egui::RichText::new("Press Replay to record what happened.")
                        .size(11.5)
                        .color(TEXT_DIM),
                );
            });
            return;
        }

        let runs = session.runs.clone();
        for run in &runs {
            let selected = self.carousel_run.as_deref() == Some(run.id.as_str());
            let (badge, color) = match run.status.as_str() {
                "passed" => ("passed", OK),
                "failed" => ("failed", DANGER),
                "cancelled" => ("cancelled", TEXT_DIM),
                _ => (run.status.as_str(), TEXT_DIM),
            };
            let when = run
                .finished_at
                .map(|at| api::relative_time(at as i64))
                .unwrap_or_else(|| "in progress".to_string());
            // The failed count is spelled out rather than folded into a ratio:
            // "3/5" reads as partial success, while "2 failed of 5" reads as a
            // run that broke partway through.
            let label = if run.failed > 0 {
                format!(
                    "{badge} · {} passed, {} failed of {} · {when}",
                    run.passed, run.failed, run.total
                )
            } else {
                format!("{badge} · {}/{} · {when}", run.passed, run.total)
            };

            ui.push_id(&run.id, |ui| {
                if ui
                    .selectable_label(selected, egui::RichText::new(label).size(12.0).color(color))
                    .clicked()
                {
                    // Opening a run closes any viewer: a position carried over
                    // from another run would land on an unrelated picture.
                    self.carousel_run = Some(run.id.clone());
                    self.shot_view = None;
                }
                ui.horizontal(|ui| {
                    ui.add_space(14.0);
                    ui.label(
                        egui::RichText::new(format!("{}s", run.duration_s()))
                            .size(10.5)
                            .color(TEXT_DIM),
                    );
                    for entry in &run.dataset {
                        ui.label(
                            egui::RichText::new(format!("{}={}", entry.name, entry.value))
                                .monospace()
                                .size(10.5)
                                .color(if entry.overridden { ACCENT } else { TEXT_DIM }),
                        );
                    }
                });
                if let Some(failed) = run.steps.iter().find(|s| s.status == "failed") {
                    ui.horizontal(|ui| {
                        ui.add_space(14.0);
                        ui.label(
                            egui::RichText::new(format!(
                                "step {}: {}",
                                failed.index,
                                failed.error.as_deref().unwrap_or("failed")
                            ))
                            .size(10.5)
                            .color(DANGER),
                        );
                    });
                }
            });
        }

        ui.add_space(6.0);
        // The detail of the open run — its steps, timings and locators, and the
        // pictures it saved — lives in the side panel. It used to be laid out
        // here, under the list, which meant reading one run pushed every other
        // run out of view.
        if self.carousel_run.is_none() {
            ui.label(
                egui::RichText::new("Select a run to see how it went.")
                    .size(11.5)
                    .color(TEXT_DIM),
            );
        }
}

    /// The open run, in full: every step, how long it took, which locator
    /// resolved, and the pictures the run saved.
    ///
    /// This is what a run is for. "Passed 20/20" says the run finished; it does
    /// not say which step took four seconds, which locator only worked because
    /// the primary had stopped matching, or what the page looked like at the
    /// moment a screenshot step fired.
    pub fn run_panel(&mut self, ui: &mut egui::Ui) {
        let Some(run) = self
            .session
            .as_ref()
            .and_then(|s| s.runs.iter().find(|r| self.carousel_run.as_deref() == Some(r.id.as_str())))
            .cloned()
        else {
            return;
        };
        let session_id = self.session.as_ref().map(|s| s.id.clone()).unwrap_or_default();

        ui.horizontal(|ui| {
            let (badge, color) = match run.status.as_str() {
                "passed" => ("passed", OK),
                "failed" => ("failed", DANGER),
                "cancelled" => ("stopped", TEXT_DIM),
                _ => (run.status.as_str(), TEXT_DIM),
            };
            ui.label(egui::RichText::new(badge).size(13.0).strong().color(color));
            ui.label(
                egui::RichText::new(format!("{}s", run.duration_s()))
                    .size(12.0)
                    .color(TEXT_DIM),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icons::button(ui, Icon::Close, "Close this run", TEXT_DIM).clicked() {
                    self.carousel_run = None;
                }
            });
        });
        ui.label(
            egui::RichText::new(format!(
                "{} of {} passed",
                run.passed, run.total
            ))
            .size(11.5)
            .color(TEXT_DIM),
        );
        for entry in &run.dataset {
            ui.label(
                egui::RichText::new(format!("{} = {}", entry.name, entry.value))
                    .monospace()
                    .size(11.0)
                    .color(if entry.overridden { ACCENT } else { TEXT_DIM }),
            );
        }
        ui.separator();
        // Every step that saved a picture, in step order. The step rows use it
        // to find a picture's position, and the viewer pages through it, so
        // both agree on what "next screenshot" means.
        let shots = run.shots();

        egui::ScrollArea::vertical().show(ui, |ui| {
            for step in &run.steps {
                let color = match step.status.as_str() {
                    "passed" => OK,
                    "failed" => DANGER,
                    _ => TEXT_DIM,
                };
                ui.horizontal(|ui| {
                    ui.add_space(2.0);
                    let dot = egui::Rect::from_center_size(
                        ui.cursor().center(),
                        egui::vec2(6.0, 6.0),
                    );
                    ui.painter().circle_filled(dot.center(), 3.0, color);
                    ui.label(
                        egui::RichText::new(format!("{:>2}", step.index))
                            .monospace()
                            .size(11.0)
                            .color(TEXT_DIM),
                    );
                    ui.label(
                        egui::RichText::new(step.name())
                            .size(12.0)
                            .color(if step.status == "failed" { DANGER } else { TEXT }),
                    );
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            egui::RichText::new(format!("{}ms", step.duration_ms.unwrap_or(0.0) as i64))
                                .monospace()
                                .size(10.5)
                                .color(TEXT_DIM),
                        );
                    });
                });

                // The locator line is only worth its space when something
                // happened: a fallback means the recorded locator no longer
                // matches, which is the finding a run exists to surface.
                let note = step.locator_note();
                if !note.is_empty() {
                    let fallback = step.locator_rung.unwrap_or(0) > 0;
                    ui.horizontal(|ui| {
                        ui.add_space(26.0);
                        ui.label(
                            egui::RichText::new(format!("{} · {}", note, step.locator_source()))
                                .monospace()
                                .size(10.0)
                                .color(if fallback { ACCENT } else { TEXT_DIM }),
                        );
                    });
                }
                if let Some(files) = step.uploaded.as_ref().filter(|f| !f.is_empty()) {
                    ui.horizontal(|ui| {
                        ui.add_space(26.0);
                        ui.label(
                            egui::RichText::new(format!("uploaded {}", files.join(", ")))
                                .monospace()
                                .size(10.0)
                                .color(TEXT_DIM),
                        );
                    });
                }
                if let Some(err) = &step.error {
                    ui.horizontal(|ui| {
                        ui.add_space(26.0);
                        ui.label(egui::RichText::new(err).size(10.5).color(DANGER));
                    });
                }
                // A miniature, only on the steps that asked for a picture. The
                // snapshot taken after every step is not one of these: showing
                // it put a thumbnail on every row and made the viewer page
                // through steps with nothing to look at.
                //
                // Nothing is drawn until the picture is decoded. A placeholder
                // in a step row reads as a broken screenshot, which is a claim
                // about the run that is not true — the picture is simply not
                // here yet.
                if step.is_asked_for_shot() {
                    if let Some(file) = step.shot.clone() {
                        let url = api::shot_url(&session_id, &file);
                        let position =
                            shots.iter().position(|s| s.index == step.index).unwrap_or(0);
                        if let Some(texture) = self.shot_texture(ui.ctx(), &url) {
                            ui.horizontal(|ui| {
                                ui.add_space(26.0);
                                let thumb = egui::Button::image(
                                    egui::Image::from_texture(&texture)
                                        .fit_to_exact_size(egui::vec2(132.0, 78.0)),
                                );
                                if ui.add(thumb).on_hover_text("Open this screenshot").clicked() {
                                    self.shot_view = Some(position);
                                }
                            });
                        }
                    }
                }
                ui.add_space(6.0);
            }

        });
    }

    /// The screenshot, full size, with the neighbouring pictures a click away.
    ///
    /// A modal rather than a window: looking at a screenshot answers one
    /// question — what did the page look like at that moment — and the answer
    /// should not have to share the screen with the panel that asked it.
    /// `Modal::should_close` covers the two ways out a reader expects: a click
    /// on the backdrop, and Escape.
    pub fn shot_viewer(&mut self, ctx: &egui::Context) {
        let Some(position) = self.shot_view else { return };
        let session_id = self.session.as_ref().map(|s| s.id.clone()).unwrap_or_default();

        // Only what the viewer draws is taken out of the session, so the borrow
        // ends before the viewer decides whether to move to another picture.
        let Some((step_index, step_name, file, total)) = self.session.as_ref().and_then(|s| {
            let run = s
                .runs
                .iter()
                .find(|r| self.carousel_run.as_deref() == Some(r.id.as_str()))?;
            let shots = run.shots();
            let at = position.min(shots.len().checked_sub(1)?);
            let step = shots[at];
            Some((step.index, step.name(), step.shot.clone(), shots.len()))
        }) else {
            self.shot_view = None;
            return;
        };
        let at = position.min(total - 1);

        let mut go: Option<usize> = None;
        let modal = egui::Modal::new(egui::Id::new("shot_viewer")).show(ctx, |ui| {
            ui.set_width(880.0);
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new(format!("Step {}", step_index))
                        .size(13.0)
                        .strong()
                        .color(TEXT),
                );
                ui.label(egui::RichText::new(step_name).size(12.0).color(TEXT_DIM));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Close").clicked() {
                        go = Some(usize::MAX);
                    }
                });
            });
            ui.add_space(4.0);
            if let Some(file) = file.as_ref() {
                let url = api::shot_url(&session_id, file);
                if let Some(texture) = self.shot_texture(ui.ctx(), &url) {
                    ui.add(
                        egui::Image::from_texture(&texture).max_size(egui::vec2(860.0, 520.0)),
                    );
                } else {
                    ui.label(
                        egui::RichText::new("Loading the screenshot…")
                            .size(12.0)
                            .color(TEXT_DIM),
                    );
                }
            }
            ui.add_space(4.0);
            ui.separator();
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(
                        at > 0,
                        egui::Button::new("<  Previous").min_size(egui::vec2(120.0, 24.0)),
                    )
                    .clicked()
                {
                    go = Some(at - 1);
                }
                ui.label(
                    egui::RichText::new(format!("{} of {}", at + 1, total))
                        .size(11.5)
                        .color(TEXT_DIM),
                );
                if ui
                    .add_enabled(
                        at + 1 < total,
                        egui::Button::new("Next  >").min_size(egui::vec2(120.0, 24.0)),
                    )
                    .clicked()
                {
                    go = Some(at + 1);
                }
                ui.label(
                    egui::RichText::new("click outside or press Escape to close")
                        .size(10.5)
                        .color(TEXT_DIM),
                );
            });
        });

        if modal.should_close() {
            self.shot_view = None;
        } else if let Some(next) = go {
            // `usize::MAX` is the Close button; anything else is a position.
            self.shot_view = if next == usize::MAX { None } else { Some(next) };
        }
    }
}

fn plural(n: usize) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}
