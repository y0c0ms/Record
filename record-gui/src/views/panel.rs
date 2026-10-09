// The step side panel.
//
// A step row has room for an action, a value, and a target — and nothing else.
// Everything else about a step (why it is failing, how many ways there are to
// find its element, what the raw selectors actually are) either does not fit or
// is only needed sometimes. It lives here, in a panel that opens when a step is
// selected, so the list stays a list.

use eframe::egui;

use crate::api;
use crate::icons::{self, Icon};
use crate::state::{PanelTab, RecordApp};
use crate::theme::{self, ACCENT, DANGER, OK, TEXT, TEXT_DIM};

/// How wide the panel is when open. Fixed rather than resizable: a resizable
/// panel on a window this size is a second thing to manage, and the content
/// here does not want to be very narrow.
const PANEL_WIDTH: f32 = 330.0;

impl RecordApp {
    /// The panel for the selected step, or nothing when no step is selected.
    /// Returns whether it drew anything, so the caller can skip the splitter
    /// entirely when the panel is closed.
    pub fn step_panel(&mut self, ui: &mut egui::Ui) -> bool {
        let Some(panel) = self.selected.clone() else {
            return false;
        };
        // Resolved every frame rather than cached: a step's index moves when the
        // list is reordered, and a stale handle would show a different step's
        // locators under the right heading.
        let Some(step) = self
            .steps()
            .iter()
            .find(|s| s.index == panel.index)
            .cloned()
        else {
            // The step is gone — deleted, or the flow was replaced. Close rather
            // than show an empty panel: the user asked about a step that no
            // longer exists, and inventing one would be worse than saying so.
            self.selected = None;
            return false;
        };

        ui.vertical(|ui| {
            ui.set_width(PANEL_WIDTH);

            // ---- header: which step, and the way out ----
            ui.horizontal(|ui| {
                ui.label(
                    egui::RichText::new(format!("Step {}", step.index))
                        .size(15.0)
                        .strong()
                        .color(TEXT),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if icons::button(ui, Icon::Close, "Close the panel", theme::TEXT_DIM).clicked() {
                        self.close_panel();
                    }
                });
            });
            ui.label(
                egui::RichText::new(step.phrase())
                    .size(12.0)
                    .color(TEXT_DIM)
                    .weak(),
            );
            ui.add_space(6.0);

            // ---- tabs ----
            ui.horizontal(|ui| {
                for (label, tab) in [
                    ("Step", PanelTab::Step),
                    ("Locators", PanelTab::Locators),
                    ("Raw", PanelTab::Raw),
                ] {
                    if ui
                        .selectable_label(panel.tab == tab, egui::RichText::new(label).size(12.5))
                        .clicked()
                    {
                        self.panel_tab(tab);
                    }
                }
            });
            ui.add_space(4.0);
            ui.separator();

            egui::ScrollArea::vertical()
                .id_salt("step_panel")
                .auto_shrink([false, false])
                .show(ui, |ui| match panel.tab {
                    PanelTab::Step => self.panel_step_tab(ui, &step),
                    PanelTab::Locators => self.panel_locators_tab(ui, &step),
                    PanelTab::Raw => self.panel_raw_tab(ui, &step),
                });
        });

        true
    }

    /// What the step does: its action, its value, and its target, each editable
    /// in a field wide enough to read.
    fn panel_step_tab(&mut self, ui: &mut egui::Ui, step: &api::Step) {
        let locked = self.recording || self.busy;
        let editable = api::is_editable(&step.kind) && !locked;

        // ---- action ----
        ui.label(egui::RichText::new("Action").size(11.0).color(TEXT_DIM));
        if editable {
            let current = api::action_for(&step.kind).unwrap_or(&api::ACTIONS[0]);
            let mut chosen = step.kind.clone();
            egui::ComboBox::from_id_salt(("panel-action", step.index))
                .width(ui.available_width())
                .selected_text(current.label)
                .show_ui(ui, |ui| {
                    for a in api::ACTIONS {
                        ui.selectable_value(&mut chosen, a.id.to_string(), a.label);
                    }
                });

            if chosen != step.kind {
                self.apply_step_edit(step.index, chosen, step.literal_value(), None, None);
            }
        } else {
            // Navigation and wait steps are dictated by the recording.
            ui.label(egui::RichText::new(step.phrase()).size(13.0).color(TEXT_DIM));
        }
        ui.add_space(10.0);

        // ---- value ----
        // The same fields as the row, but full width: the row has to share its
        // width with the action dropdown and the target, and a value truncated
        // to a dozen characters is not editable.
        if editable {
            let spec = api::action_for(&step.kind).unwrap_or(&api::ACTIONS[0]);
            if spec.needs_value && !step.secret {
                ui.label(egui::RichText::new("Value").size(11.0).color(TEXT_DIM));
                self.step_value_fields(ui, step, spec);
                ui.add_space(10.0);
            }
        }

        // ---- password ----
        // The stored password is never sent to the GUI. What can be done is to
        // enter a new one, which the sidecar encrypts on arrival.
        if step.secret {
            ui.label(egui::RichText::new("Password").size(11.0).color(TEXT_DIM));
            let (note, color) = if step.secret_stored {
                ("Stored encrypted. Replay types the real password.", OK)
            } else {
                ("Recorded before passwords were kept — replay will fail until one is entered.", DANGER)
            };
            ui.label(egui::RichText::new(note).size(11.5).color(color));
            if editable {
                let key = egui::Id::new(("secret-entry", step.index));
                let mut entry: String = ui.data_mut(|d| d.get_temp::<String>(key).unwrap_or_default());
                ui.horizontal(|ui| {
                    let field = ui.add(
                        egui::TextEdit::singleline(&mut entry)
                            .password(true)
                            .hint_text("new password")
                            .desired_width(ui.available_width() - 70.0),
                    );
                    let save = ui.add_enabled(!entry.is_empty(), egui::Button::new("Save"));
                    let enter = field.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                    if (save.clicked() || enter) && !entry.is_empty() {
                        self.apply_step_secret(step.index, step.kind.clone(), std::mem::take(&mut entry));
                    }
                });
                ui.data_mut(|d| d.insert_temp(key, entry));
            }
            ui.add_space(10.0);
        }

        // ---- upload ----
        if step.kind == "upload" {
            ui.label(egui::RichText::new("File").size(11.0).color(TEXT_DIM));
            let spec = step.file.clone().unwrap_or_default();
            let missing = spec.source.is_empty()
                || (spec.source == "stored" && (spec.files.is_empty() || spec.files.iter().any(|f| f.missing)));
            ui.label(
                egui::RichText::new(if spec.source.is_empty() { "no file chosen".to_string() } else { spec.describe() })
                    .size(12.0)
                    .color(if missing { DANGER } else { TEXT }),
            );
            if editable {
                ui.add_space(4.0);
                ui.horizontal_wrapped(|ui| {
                    if ui
                        .button("Attach file…")
                        .on_hover_text("Copy a file into the flow. Replays the same file on any machine.")
                        .clicked()
                    {
                        self.pick_upload_file(step.index, true);
                    }
                    if ui
                        .button("Use file from disk…")
                        .on_hover_text("Read the file from this path at every replay, e.g. a document that changes.")
                        .clicked()
                    {
                        self.pick_upload_file(step.index, false);
                    }
                });
                ui.horizontal_wrapped(|ui| {
                    ui.label(egui::RichText::new("Generate a sample:").size(11.0).color(TEXT_DIM));
                    for kind in ["pdf", "png", "docx", "csv", "txt"] {
                        let current = spec.source == "sample" && spec.sample.as_deref() == Some(kind);
                        if ui.selectable_label(current, kind).on_hover_text("A small valid file of this type, made at replay.").clicked() {
                            self.apply_step_file(
                                step.index,
                                api::FileChoice {
                                    source: "sample".into(),
                                    sample: Some(kind.into()),
                                    name: Some(format!("sample.{kind}")),
                                    ..Default::default()
                                },
                            );
                        }
                    }
                });
            }
            ui.add_space(10.0);
        }

        // ---- dialogs ----
        let dialogs = step.dialog_notes();
        if !dialogs.is_empty() {
            ui.label(egui::RichText::new("Answers dialogs").size(11.0).color(TEXT_DIM));
            for line in dialogs {
                ui.label(egui::RichText::new(line).size(12.0).color(TEXT));
            }
            ui.add_space(10.0);
        }

        // ---- target ----
        ui.label(egui::RichText::new("Target element").size(11.0).color(TEXT_DIM));
        ui.label(egui::RichText::new(step.target()).size(13.0).color(TEXT));
        let scope = step.scope_note();
        if !scope.is_empty() {
            ui.label(egui::RichText::new(scope).size(11.5).color(TEXT_DIM));
        }
        ui.add_space(10.0);

        // ---- last run ----
        match step.status.as_str() {
            "passed" => {
                ui.label(egui::RichText::new("Last run: passed").size(12.0).color(OK));
            }
            "failed" => {
                ui.label(egui::RichText::new("Last run: failed").size(12.0).color(DANGER));
                if let Some(err) = &step.error {
                    ui.add_space(4.0);
                    // Whether the element never appeared or the action was
                    // refused is a different bug with a different fix, so the
                    // kind is named rather than left to be read out of the text.
                    if step.failure_kind.as_deref() == Some("locator-timeout") {
                        ui.label(
                            egui::RichText::new("Every locator was given 30s and none matched.")
                                .size(11.5)
                                .color(DANGER),
                        );
                    }
                    ui.label(egui::RichText::new(err).size(11.5).color(DANGER));
                }
            }
            _ => {}
        }

        // Which locator the last run settled on, if it was not the first: the
        // primary going stale is the thing worth knowing before it goes red.
        if let Some(found) = &step.resolved_locator {
            let used_fallback = step.candidates.first().map(|c| c != found).unwrap_or(false);
            let waited = step.locator_wait_ms.unwrap_or(0.0) / 1000.0;
            if used_fallback || waited > 1.0 {
                ui.add_space(6.0);
                ui.label(
                    egui::RichText::new(format!(
                        "Used {} after {:.0}s of waiting",
                        found.describe(),
                        waited
                    ))
                    .size(11.5)
                    .color(if used_fallback { ACCENT } else { TEXT_DIM }),
                );
            }
        }
    }

    /// The locator ladder, in the order replay tries it, with the rung that
    /// worked last time called out. This is the list a user reads when a step
    /// fails and they need to know which selector to fix — and it is where a
    /// wrong selector gets corrected.
    fn panel_locators_tab(&mut self, ui: &mut egui::Ui, step: &api::Step) {
        if step.candidates.is_empty() {
            theme::empty_state(
                ui,
                "No locator",
                "This step has no element to find — a navigation or a wait does not use one.",
            );
            return;
        }

        let editing = self
            .selected
            .as_ref()
            .map(|p| p.locators.is_some())
            .unwrap_or(false);

        ui.horizontal(|ui| {
            ui.label(
                egui::RichText::new(format!(
                    "{} way{} to find this, tried in order",
                    step.candidates.len(),
                    if step.candidates.len() == 1 { "" } else { "s" }
                ))
                .size(11.5)
                .color(TEXT_DIM),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if editing {
                    if ui
                        .button(
                            egui::RichText::new("Cancel")
                                .size(11.5)
                                .color(TEXT_DIM),
                        )
                        .clicked()
                    {
                        self.edit_locators(None);
                    }
                    if ui
                        .button(
                            egui::RichText::new("Save")
                                .size(11.5)
                                .color(ACCENT)
                                .strong(),
                        )
                        .clicked()
                    {
                        let pending = self
                            .selected
                            .as_ref()
                            .and_then(|p| p.locators.clone());
                        if let Some(chain) = pending {
                            // A rung with nothing in it resolves to nothing, so
                            // saving one would leave the step with a locator that
                            // can only ever fail — silently, and long after the
                            // mistake. Refusing here says so while the editor is
                            // still showing the row that caused it, and the
                            // editor stays open instead of vanishing on a save
                            // that did not take.
                            let empty = chain.iter().position(|c| c.is_empty());
                            if let Some(bad) = empty {
                                self.toast = Some((
                                    format!("Way {} has nothing in it — give it a value or remove it.", bad + 1),
                                    true,
                                ));
                            } else {
                                // Saved in order, and the first rung becomes the
                                // primary — so a rung promoted to the top is the
                                // one replay tries first from now on.
                                self.apply_step_locators(step.index, chain);
                                self.edit_locators(None);
                            }
                        }
                    }
                } else if ui
                    .button(egui::RichText::new("Edit").size(11.5).color(ACCENT))
                    .clicked()
                {
                    self.edit_locators(Some(step.candidates.clone()));
                }
            });
        });
        ui.add_space(8.0);

        if let Some(chain) = self
            .selected
            .as_ref()
            .and_then(|p| p.locators.clone())
        {
            self.locator_editor(ui, chain);
            return;
        }

        for (n, candidate) in step.candidates.iter().enumerate() {
            // The rung that resolved last run, if any: the first thing worth
            // knowing is which one is currently carrying the step.
            let used = step.resolved_locator.as_ref() == Some(candidate);
            let (color, mark) = if used {
                (OK, "\u{2713}".to_string())
            } else {
                (TEXT, format!("{}.", n + 1))
            };

            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(mark).size(12.0).color(color));
                ui.label(
                    egui::RichText::new(candidate.describe())
                        .size(12.0)
                        .monospace()
                        .color(color),
                );
            });

            // The rung a replay would give up on, spelled out. A step with a
            // long ladder is slow to fail, and knowing that before waiting for
            // it is better than after.
            if n > 0 && !used {
                ui.label(
                    egui::RichText::new(format!("  up to 30s if the ones before it fail"))
                        .size(10.0)
                        .color(TEXT_DIM),
                );
            }
            ui.add_space(6.0);
        }
    }

    /// The editing form for a ladder: a row per rung, each with its strategy
    /// and value, plus the two things a failing step actually needs — a rung
    /// moved up the order, and a rung that was not recorded at all.
    fn locator_editor(&mut self, ui: &mut egui::Ui, mut chain: Vec<api::Candidate>) {
        const STRATEGIES: [&str; 8] = [
            "role", "testId", "label", "placeholder", "text", "altText", "css", "xpath",
        ];

        let mut drop = None;
        let mut add = false;

        for n in 0..chain.len() {
            ui.push_id(n, |ui| {
                ui.horizontal(|ui| {
                    // Ordering is the whole point of a ladder, so it is edited
                    // directly rather than inferred from some separate priority
                    // field that could disagree with the order shown.
                    if n > 0
                        && icons::button(ui, Icon::Up, "Try this one earlier", TEXT_DIM).clicked()
                    {
                        drop = Some((n, n - 1));
                    }

                    let mut strategy = chain[n].strategy.clone();
                    egui::ComboBox::from_id_salt("strategy")
                        .width(92.0)
                        .selected_text(short_strategy(&strategy))
                        .show_ui(ui, |ui| {
                            for s in STRATEGIES {
                                ui.selectable_value(&mut strategy, s.to_string(), s);
                            }
                        });

                    // A role is `role=button "Save"`, two pieces; every other
                    // strategy is a single value. Showing one field for both
                    // would mean typing `role=button "Save"` into a box that is
                    // about to be sent as a raw value.
                    if strategy == "role" {
                        let mut role = chain[n].role.clone().unwrap_or_default();
                        let mut name = chain[n].name.clone().unwrap_or_default();
                        egui::TextEdit::singleline(&mut role)
                            .desired_width(64.0)
                            .hint_text("role")
                            .show(ui);
                        egui::TextEdit::singleline(&mut name)
                            .desired_width(ui.available_width())
                            .hint_text("accessible name (empty for any)")
                            .show(ui);
                        chain[n].role = Some(role);
                        chain[n].name = Some(name);
                        chain[n].value = None;
                    } else {
                        let mut value = chain[n].value.clone().unwrap_or_default();
                        egui::TextEdit::singleline(&mut value)
                            .desired_width(ui.available_width())
                            .hint_text("selector")
                            .show(ui);
                        chain[n].value = Some(value);
                        chain[n].role = None;
                        chain[n].name = None;
                    }
                    chain[n].strategy = strategy;

                    if icons::button(ui, Icon::Close, "Remove this way to find it", DANGER)
                        .clicked()
                    {
                        drop = Some((n, usize::MAX));
                    }
                });
            });
            ui.add_space(4.0);
        }

        ui.add_space(4.0);
        ui.horizontal(|ui| {
            if ui
                .button(egui::RichText::new("+ Add a way").size(11.5).color(TEXT_DIM))
                .clicked()
            {
                add = true;
            }
            // Why the order matters, said once here rather than on every rung.
            ui.label(
                egui::RichText::new("tried top to bottom")
                    .size(10.5)
                    .color(TEXT_DIM),
            );
        });

        if add {
            chain.push(api::Candidate {
                strategy: "css".to_string(),
                value: Some(String::new()),
                ..Default::default()
            });
        }
        if let Some((from, to)) = drop {
            match to {
                // A sentinel rather than an Option so one borrow covers both
                // "move" and "remove": both are a single splice.
                usize::MAX => {
                    if chain.len() > 1 {
                        chain.remove(from);
                    }
                }
                to if to < from => {
                    let item = chain.remove(from);
                    chain.insert(to, item);
                }
                _ => {}
            }
        }

        // Saved ladder without a rung the replay could actually use is worse
        // than the recorded one, so the button reflects whether there is
        // anything here at all.
        let usable = chain.iter().any(|c| {
            c.strategy == "role"
                || c.value.as_ref().is_some_and(|v| !v.trim().is_empty())
        });
        self.edit_locators(Some(chain));
        if !usable {
            ui.label(
                egui::RichText::new("Every way to find this is empty — nothing would resolve.")
                    .size(10.5)
                    .color(DANGER),
            );
        }
    }

    /// The raw locator descriptors, for when the ladder's summary is not enough
    /// — a selector that has to be copied into an editor, or compared with a
    /// devtools query.
    fn panel_raw_tab(&mut self, ui: &mut egui::Ui, step: &api::Step) {
        if step.candidates.is_empty() {
            theme::empty_state(
                ui,
                "No locator",
                "This step has no element to find — a navigation or a wait does not use one.",
            );
            return;
        }

        for (n, candidate) in step.candidates.iter().enumerate() {
            let used = step.resolved_locator.as_ref() == Some(candidate);
            ui.label(
                egui::RichText::new(format!("{} · {}", n + 1, candidate.strategy))
                    .size(11.0)
                    .strong()
                    .color(if used { OK } else { TEXT_DIM }),
            );
            let mut source = locator_source(candidate);
            ui.add(
                egui::TextEdit::multiline(&mut source)
                    .desired_width(ui.available_width())
                    .font(egui::TextStyle::Monospace)
                    .desired_rows(2),
            );
            ui.add_space(8.0);
        }
    }
}

/// The strategy name as the editor's dropdown shows it. `testId` is the
/// odd one out among the names, so it is shortened to fit a narrow dropdown
/// without wrapping onto two lines.
fn short_strategy(strategy: &str) -> &str {
    match strategy {
        "testId" => "test id",
        "altText" => "alt",
        "placeholder" => "holder",
        other => other,
    }
}

/// The locator as Playwright source — the form a user would paste into an
/// editor, or line up against a devtools query. Read-only on purpose: the
/// server owns the ladder, so a copy edited here and pasted back would not be
/// the thing that runs.
fn locator_source(candidate: &api::Candidate) -> String {
    let text = candidate.value.clone().unwrap_or_default();
    match candidate.strategy.as_str() {
        "role" => format!(
            "getByRole('{}', {{ name: '{}' }})",
            candidate.role.clone().unwrap_or_default(),
            candidate.name.clone().unwrap_or_default()
        ),
        "text" => format!("getByText('{text}')"),
        "label" => format!("getByLabel('{text}')"),
        "placeholder" => format!("getByPlaceholder('{text}')"),
        "testId" => format!("getByTestId('{text}')"),
        _ => candidate.describe(),
    }
}
