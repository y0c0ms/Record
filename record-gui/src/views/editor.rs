// The step list: the no-code view where each step is an action, a value, and
// the element it applies to. Editing here regenerates the code view.
//
// Three things make this a list rather than a form. A step can be dragged to a
// new position. A step can be inserted at any point through the "+" in the gap
// it goes into. And clicking a step opens a side panel carrying everything that
// does not fit on the row — the value in full, and the whole locator ladder.

use std::cell::Cell;

use eframe::egui;

use crate::api;
use crate::icons::{self, Icon};
use crate::state::{DragState, PanelTab, RecordApp, StepPanel};
use crate::theme::{self, ACCENT, TEXT, TEXT_DIM};

impl RecordApp {
    pub fn steps_editor(&mut self, ui: &mut egui::Ui) {
        let steps = self.steps().to_vec();
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
            // A flow with no steps still needs a way in, or the first step can
            // only ever come from a recording.
            ui.add_space(8.0);
            self.insert_slot(ui, 1);
            return;
        }

        let locked = self.recording || self.busy;

        egui::ScrollArea::vertical()
            .id_salt("editor")
            .auto_shrink([false, false])
            .show(ui, |ui| {
                // A "+" in every gap: before the first step, between every pair,
                // and after the last. Appending at the end should not mean
                // scrolling past every step, and inserting in the middle should
                // mean clicking where the step goes rather than picking a number.
                self.insert_slot(ui, 1);
                for step in &steps {
                    self.step_row(ui, step, locked);
                    self.insert_slot(ui, step.index + 1);
                }
            });

        self.apply_drop();
    }

    /// Commits a drop once the list has been walked. Done here rather than in the
    /// row so the flow is not mutated while it is being walked, which would
    /// invalidate the very indexes the walk is using.
    fn apply_drop(&mut self) {
        let Some(drag) = self.drag.take() else { return };
        // `hover` is a 0-based slot; the wire format wants a 1-based position.
        let to = drag.hover + 1;
        if drag.from == to {
            return;
        }
        // Dropping a step back where it started is not a move, and asking the
        // server to perform one would renumber the whole flow for no change.
        self.reorder_step(drag.from, to);
    }

    fn step_row(&mut self, ui: &mut egui::Ui, step: &api::Step, locked: bool) {
        let editable = api::is_editable(&step.kind) && !locked;
        let selected = self
            .selected
            .as_ref()
            .map(|s| s.index == step.index)
            .unwrap_or(false);
        let dragging = self.drag.map(|d| d.from == step.index).unwrap_or(false);
        let index = step.index;

        // The grip's response has to come back out of the layout closure, which
        // cannot borrow `self` mutably while `ui` is borrowed, so it is parked
        // here and read once the card is finished.
        let handle: Cell<Option<egui::Response>> = Cell::new(None);
        let hover: Cell<bool> = Cell::new(false);

        let card = if selected {
            theme::step_card_selected()
        } else {
            theme::step_card(step.is_param())
        }
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                    if editable {
                        handle.set(Some(ui.add(
                            egui::Button::new(
                                egui::RichText::new("\u{283f}")
                                    .size(13.0)
                                    .color(if dragging { ACCENT } else { TEXT_DIM }),
                            )
                            .frame(false)
                            .sense(egui::Sense::click_and_drag()),
                        )));
                    } else {
                        ui.add_space(14.0);
                    }

                    ui.label(
                        egui::RichText::new(format!("{:>2}", index))
                            .monospace()
                            .size(11.5)
                            .color(TEXT_DIM),
                    );

                    if !editable {
                        // Navigation and wait steps come from the recording, so
                        // they are shown rather than edited.
                        ui.label(egui::RichText::new(step.phrase()).size(13.0).color(TEXT_DIM));
                    } else {
                        // First parameter: the action.
                        let current = api::action_for(&step.kind).unwrap_or(&api::ACTIONS[0]);
                        let mut chosen = step.kind.clone();
                        egui::ComboBox::from_id_salt(("action", index))
                            .width(118.0)
                            .selected_text(current.label)
                            .show_ui(ui, |ui| {
                                for a in api::ACTIONS {
                                    ui.selectable_value(&mut chosen, a.id.to_string(), a.label);
                                }
                            });
                        if chosen != step.kind {
                            self.draft = Some(crate::state::Draft {
                                index,
                                action: chosen.clone(),
                                // Seeded from the literal, not the displayed
                                // `${PARAM}`, so switching action cannot turn a
                                // placeholder into the step's recorded value.
                                value: step.literal_value(),
                                param: step.param_name(),
                                use_param: step.is_param(),
                            });
                        }

                        // Second parameter: the value, or the dataset parameter
                        // that replaces it.
                        let spec = *api::action_for(&chosen).unwrap_or(current);
                        // A password's value is a mask, not something to edit
                        // inline; it is re-entered in the step panel instead.
                        if step.secret {
                            let (text, color) = if step.secret_stored {
                                ("•••••••• (stored)", theme::TEXT_DIM)
                            } else {
                                ("password missing — open the step", theme::DANGER)
                            };
                            ui.label(egui::RichText::new(text).size(11.5).color(color));
                        } else {
                            self.step_value_fields(ui, step, &spec);
                        }
                    }

                    // A step that no longer matches what was recorded: worth
                    // flagging, because a replay failure here has a likely cause.
                    if step.edited {
                        ui.label(egui::RichText::new("edited").small().color(theme::DANGER));
                    }

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if icons::button(
                            ui,
                            Icon::Trash,
                            "Delete this step",
                            if editable { theme::DANGER } else { theme::TEXT_DIM.gamma_multiply(0.4) },
                        )
                        .clicked()
                        {
                            self.delete_step(index);
                        }
                    });
                });

                // The target element, with its fallback ladder on hover.
                ui.horizontal(|ui| {
                    ui.add_space(4.0);
                    ui.label(egui::RichText::new("on").size(11.0).color(TEXT_DIM));
                    let fallbacks: Vec<String> =
                        step.candidates.iter().skip(1).map(|c| c.describe()).collect();
                    let target = ui.label(
                        egui::RichText::new(step.target())
                            .size(12.0)
                            .strong()
                            .color(TEXT),
                    );
                    if !fallbacks.is_empty() {
                        target.on_hover_text(format!(
                            "{} ways to find this:\n{}",
                            step.candidates.len(),
                            fallbacks.join("\n")
                        ));
                    }
                    // How resilient the step is, on the row rather than only on
                    // hover: a hover nobody performs is not a fact on display.
                    if step.candidates.len() > 1 {
                        ui.label(
                            egui::RichText::new(format!(
                                "\u{b7} {} ways to find this",
                                step.candidates.len()
                            ))
                            .size(10.5)
                            .color(TEXT_DIM),
                        );
                    }
                });
            });

        // Whether the *pointer* is over this card, not merely that the card was
        // drawn: during a drag every row is still drawn, so an unconditional
        // true would make the last row the drop target every time. The frame's
        // own response already carries exactly this, since it is allocated with
        // `Sense::hover`.
        hover.set(card.response.hovered());

        // `Frame` allocates its space with `Sense::hover`, so its own response can
        // never report a click. The card is the selection target, so it gets an
        // explicit interaction over the same rect — registered last, after the
        // widgets inside it, so those keep their own clicks and only the bare
        // part of the card selects.
        let card = ui.interact(card.response.rect, ui.id().with(("step", index)), egui::Sense::click());

        // Clicking the card selects the step, which opens the side panel. Checked
        // against `clicked` rather than `clicked_by`, so a click that ends a
        // drag does not also select.
        if card.clicked() {
            self.selected = Some(StepPanel {
                index,
                tab: PanelTab::Step,
                locators: None,
            });
        }

        // The grip starts the drag. Dragging the row body instead would fight
        // the combobox and the text field sitting in it.
        if let Some(handle) = handle.take() {
            if handle.drag_started() || (handle.dragged() && self.drag.is_none()) {
                self.drag = Some(DragState {
                    from: index,
                    hover: index - 1,
                });
            }
        }

        // The row under the pointer is where the step lands, because that is the
        // position the user is pointing at.
        if hover.get() && self.drag.is_some() {
            if let Some(d) = self.drag.as_mut() {
                d.hover = index - 1;
            }
        }
    }

    /// Opens the side panel on `index`. One panel, one step: selecting a second
    /// step switches to it rather than opening a second panel, because two
    /// panels for one flow is one more than the layout can carry.
    pub fn select_step(&mut self, index: usize) {
        self.selected = Some(StepPanel {
            index,
            tab: PanelTab::Step,
            locators: None,
        });
    }

    pub fn close_panel(&mut self) {
        self.selected = None;
    }

    pub fn panel_tab(&mut self, tab: PanelTab) {
        if let Some(panel) = self.selected.as_mut() {
            panel.tab = tab;
        }
    }

    /// Sets or clears the ladder being edited. `None` leaves edit mode and
    /// discards the pending changes; `Some` replaces them outright, which is
    /// what the editor form does on every frame so its fields stay the source
    /// of truth while editing.
    pub fn edit_locators(&mut self, chain: Option<Vec<api::Candidate>>) {
        if let Some(panel) = self.selected.as_mut() {
            panel.locators = chain;
        }
    }

    pub fn begin_insert(&mut self, at: usize) {
        self.insert = Some(crate::state::InsertDraft {
            at,
            action: "click".to_string(),
            label: String::new(),
            value: String::new(),
            param: String::new(),
            recording: false,
        });
    }

    /// The value fields for a step: the literal, the checkbox that promotes it
    /// to a dataset parameter, and the parameter's name.
    ///
    /// Edits are held in `self.draft` rather than sent as they are typed. A
    /// round trip per keystroke would fight the field the user is still typing
    /// in, and nothing is renumbered by an edit, so nothing is lost by
    /// committing when the field is left.
    pub fn step_value_fields(&mut self, ui: &mut egui::Ui, step: &api::Step, spec: &api::Action) {
        if !spec.needs_value {
            return;
        }
        let index = step.index;
        let draft = self.draft.as_ref().filter(|d| d.index == index);
        let mut value = draft.map(|d| d.value.clone()).unwrap_or_else(|| step.literal_value());
        let mut param = draft.map(|d| d.param.clone()).unwrap_or_else(|| step.param_name());
        let mut as_param = draft.map(|d| d.use_param).unwrap_or_else(|| step.is_param());

        let keep = |value: String, param: String, as_param: bool| crate::state::Draft {
            index,
            action: step.kind.clone(),
            value,
            param,
            use_param: as_param,
        };

        let literal = ui.add(
            egui::TextEdit::singleline(&mut value)
                .hint_text(spec.value_label)
                .desired_width(180.0),
        );
        if literal.changed() {
            self.draft = Some(keep(value.clone(), param.clone(), as_param));
        }

        if ui
            .checkbox(&mut as_param, egui::RichText::new("as parameter").size(11.0))
            .changed()
        {
            // Ticking it for the first time offers a name derived from the
            // target, so the common case needs no typing at all.
            if as_param && param.trim().is_empty() {
                param = step.suggested_param();
            }
            self.draft = Some(keep(value.clone(), param.clone(), as_param));
        }

        // The parameter name only means something once the value is promoted, so
        // the field appears when it is checked rather than sitting greyed out
        // beside every step that has no use for it.
        let mut name_field: Option<egui::Response> = None;
        if as_param {
            let response = ui.add(
                egui::TextEdit::singleline(&mut param)
                    .hint_text("PARAMETER")
                    .desired_width(130.0),
            );
            if response.changed() {
                self.draft = Some(keep(value.clone(), param.clone(), as_param));
            }
            name_field = Some(response);
        }

        // Committed on focus loss rather than per keystroke: the user is done
        // with the field, and the step now has one authoritative value.
        if literal.lost_focus() || name_field.map(|r| r.lost_focus()).unwrap_or(false) {
            self.apply_step_edit(
                index,
                step.kind.clone(),
                value,
                if as_param && !param.trim().is_empty() {
                    Some(param)
                } else {
                    None
                },
                None,
            );
        }
    }
}
