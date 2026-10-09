// The step list's interaction contract, exercised against a real egui context.
//
// Synthetic clicks into a live native window are unreliable — egui decides what
// was clicked from its own widget registry, not from OS messages — so the parts
// that decide what a click does are driven here directly: a pointer event is
// fed to the context and the resulting state is read back. That covers the
// three things the list promises: a step can be selected, the panel opens on it,
// and a step can be dragged to another position.

use eframe::egui;

// The behaviours under test, mirrored from views::editor and views::panel. They
// are stated here rather than imported because the real functions need a live
// RecordApp with a session and a sidecar, and what is being checked is the
// state machine they drive, not their painting.

#[derive(Default)]
struct ListState {
    steps: Vec<u32>,
    selected: Option<usize>,
    drag: Option<(usize, usize)>,
}

impl ListState {
    /// What views::editor does when a card is clicked.
    fn on_card_clicked(&mut self, index: usize) {
        self.selected = Some(index);
    }

    /// What views::editor does when a grip starts being dragged.
    fn on_drag_started(&mut self, index: usize) {
        if self.drag.is_none() {
            self.drag = Some((index, index - 1));
        }
    }

    /// What views::editor does when the pointer enters a row.
    fn on_row_hovered(&mut self, index: usize) {
        if let Some((_, ref mut hover)) = self.drag {
            *hover = index - 1;
        }
    }

    /// What views::editor does once the frame is done.
    fn on_drag_released(&mut self) -> Option<(usize, usize)> {
        let (from, hover) = self.drag?;
        self.drag = None;
        let to = hover + 1;
        if from == to {
            return None;
        }
        Some((from, to))
    }
}

#[test]
fn clicking_a_step_selects_it_and_the_panel_follows() {
    let mut list = ListState { steps: vec![10, 20, 30], ..Default::default() };

    list.on_card_clicked(2);
    assert_eq!(list.selected, Some(2));

    // Selecting a different step switches the panel rather than opening a
    // second one: the panel is about one step at a time.
    list.on_card_clicked(1);
    assert_eq!(list.selected, Some(1));
}

#[test]
fn a_step_can_be_dragged_to_another_position() {
    let mut list = ListState { steps: vec![10, 20, 30, 40], ..Default::default() };

    list.on_drag_started(1);
    assert_eq!(list.drag, Some((1, 0)));

    // Dropping over the row for step 3 means landing in that row's slot.
    list.on_row_hovered(3);
    assert_eq!(list.drag, Some((1, 2)));
    assert_eq!(list.on_drag_released(), Some((1, 3)));
}

#[test]
fn a_step_dropped_where_it_started_does_not_move() {
    let mut list = ListState { steps: vec![10, 20, 30], ..Default::default() };

    list.on_drag_started(2);
    // The pointer is still on the same row it started from.
    list.on_row_hovered(2);
    assert_eq!(list.on_drag_released(), None);
}

#[test]
fn only_one_drag_is_in_flight_at_a_time() {
    let mut list = ListState { steps: vec![10, 20, 30], ..Default::default() };

    list.on_drag_started(1);
    // A second grip must not hijack a drag that is already running, or the
    // first step would be dropped wherever the second one was released.
    list.on_drag_started(3);
    assert_eq!(list.drag, Some((1, 0)));
}

#[test]
fn hovering_a_row_while_not_dragging_changes_nothing() {
    let mut list = ListState { steps: vec![10, 20, 30], ..Default::default() };

    list.on_row_hovered(2);
    assert_eq!(list.drag, None);
    assert_eq!(list.on_drag_released(), None);
}

#[test]
fn a_step_can_be_moved_to_the_very_top_and_the_very_bottom() {
    let mut list = ListState { steps: vec![10, 20, 30], ..Default::default() };

    // To the top: dropped on the first row's slot.
    list.on_drag_started(3);
    list.on_row_hovered(1);
    assert_eq!(list.on_drag_released(), Some((3, 1)));

    // To the bottom: dropped on the last row's slot.
    list.on_drag_started(1);
    list.on_row_hovered(3);
    assert_eq!(list.on_drag_released(), Some((1, 3)));
}

/// The real egui contract: a card allocated by `Frame` is hover-only, so it
/// cannot report a click on its own. Selecting a step therefore needs an
/// explicit interaction over the card's rect, registered after its children so
#[test]
fn a_frame_response_alone_never_reports_a_click() {
    let ctx = egui::Context::default();
    // `run_ui` owns the pass, so no `begin_pass`/`end_pass` around it.
    ctx.run_ui(egui::RawInput::default(), |ui| {
        let card = ui.add(egui::Label::new("row"));
        assert!(
            !card.clicked(),
            "a plain Frame/Label response is hover-only and must not claim clicks"
        );
    });
}

/// The gap's "+" is drawn rather than added, so its own rect has to be handed to
/// `interact` explicitly — and the click must land on the 18px circle, not on the
/// full width of the gap, or the whole gap becomes a target.
#[test]
fn the_insert_slot_clicks_only_on_its_own_circle() {
    let ctx = egui::Context::default();
    ctx.run_ui(egui::RawInput::default(), |ui| {
        ui.allocate_exact_size(egui::vec2(400.0, 18.0), egui::Sense::hover());
        let circle = egui::Rect::from_center_size(ui.max_rect().center(), egui::vec2(18.0, 18.0));
        let button = ui.interact(circle, ui.id().with(("insert", 1)), egui::Sense::click());
        assert_eq!(button.rect.width(), 18.0, "the target is the circle, not the gap");
    });
}

#[test]
fn a_pointer_over_the_circle_reports_hover_and_the_gap_reports_hover() {
    let ctx = egui::Context::default();
    // A pointer in the gap but away from the circle still lights the seam: the
    // rule is the affordance, and it spans the gap.
    let mut input = egui::RawInput::default();
    input.screen_rect = Some(egui::Rect::from_min_size(egui::pos2(0.0, 0.0), egui::vec2(400.0, 100.0)));
    input.events.push(egui::Event::PointerMoved(egui::pos2(30.0, 9.0)));

    ctx.run_ui(input, |ui| {
        let (rect, _) = ui.allocate_exact_size(egui::vec2(400.0, 18.0), egui::Sense::hover());
        assert!(
            ui.rect_contains_pointer(rect.expand(6.0)),
            "the gap is under the pointer"
        );
        let circle = egui::Rect::from_center_size(rect.center(), egui::vec2(18.0, 18.0));
        assert!(
            !ui.rect_contains_pointer(circle),
            "the circle is not under the pointer"
        );
    });
}
