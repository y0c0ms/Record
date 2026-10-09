// Dragging a step to another position, driven through a real egui context.
//
// The live window could not be used for this: Windows held the foreground lock,
// so presses never reached the native grip and no drag could be observed there.
// What is pinned here is the part that decides the outcome — that a grip inside
// a card claims the press, and that the row under the pointer, not the last row
// drawn, becomes the drop target.

use eframe::egui;

fn input(time: f64, events: Vec<egui::Event>) -> egui::RawInput {
    let mut raw = egui::RawInput::default();
    raw.screen_rect = Some(egui::Rect::from_min_size(
        egui::pos2(0.0, 0.0),
        egui::vec2(600.0, 400.0),
    ));
    raw.time = Some(time);
    raw.events = events;
    raw
}

fn press(x: f32, y: f32, down: bool) -> egui::Event {
    egui::Event::PointerButton {
        pos: egui::pos2(x, y),
        button: egui::PointerButton::Primary,
        pressed: down,
        modifiers: egui::Modifiers::default(),
    }
}

fn moved(x: f32, y: f32) -> egui::Event {
    egui::Event::PointerMoved(egui::pos2(x, y))
}

const ROW_H: f32 = 60.0;
const ROWS: [u32; 3] = [1, 2, 3];

fn card(row: u32) -> egui::Rect {
    egui::Rect::from_min_size(
        egui::pos2(0.0, (row - 1) as f32 * ROW_H),
        egui::vec2(500.0, 56.0),
    )
}

fn grip(row: u32) -> egui::Rect {
    egui::Rect::from_center_size(
        egui::pos2(10.0, (row - 1) as f32 * ROW_H + 28.0),
        egui::vec2(14.0, 20.0),
    )
}

/// One frame of the list: every row's card is drawn, and the row named by
/// `grip_row` also gets its grip — the shape `step_row` lays them out in.
fn frame(ctx: &egui::Context, grip_row: Option<u32>, raw: egui::RawInput) -> Frame {
    let mut out = Frame::default();
    ctx.run_ui(raw, |ui| {
        for row in ROWS {
            let c = card(row);
            let _ = ui.interact(c, ui.id().with(("card", row)), egui::Sense::hover());
            if ui.rect_contains_pointer(c) {
                out.hovered.push(row);
            }
            if Some(row) == grip_row {
                let g = ui.interact(
                    grip(row),
                    ui.id().with(("grip", row)),
                    egui::Sense::click_and_drag(),
                );
                out.drag_started = g.drag_started();
                out.dragging = g.dragged();
                out.pressed = g.is_pointer_button_down_on();
            }
        }
    });
    out
}

#[derive(Default)]
struct Frame {
    drag_started: bool,
    dragging: bool,
    pressed: bool,
    hovered: Vec<u32>,
}

/// Every row is drawn every frame, so the drop target has to come from where
/// the pointer is. Hovering unconditionally would make the last-drawn row the
/// target every time, and every drag would land at the end of the flow.
#[test]
fn only_the_row_under_the_pointer_is_hovered() {
    let ctx = egui::Context::default();
    let out = frame(&ctx, None, input(1.0, vec![moved(250.0, 25.0)]));
    assert_eq!(
        out.hovered,
        vec![1],
        "the drop target is the row under the pointer, not the last row drawn"
    );
}

/// The grip has to win the press against the card around it, otherwise the
/// card's own click handler swallows it and a drag can never begin.
#[test]
fn a_grip_inside_a_card_claims_the_press_and_reports_the_drag() {
    let ctx = egui::Context::default();
    let c = grip(2).center();

    // A first idle frame: egui resolves which widget owns a press against the
    // rects registered in the previous pass, so the grip has to have been drawn
    // once before a press can land on it. This is also why the app reads the
    // grip's response after the card's frame rather than during it.
    frame(&ctx, Some(2), input(99.0, Vec::new()));

    let down = frame(
        &ctx,
        Some(2),
        input(100.0, vec![moved(c.x, c.y), press(c.x, c.y, true)]),
    );
    assert!(down.pressed, "the grip inside the card must claim the press");

    // Still held, moved far enough to clear the drag threshold.
    let started = frame(&ctx, Some(2), input(100.5, vec![moved(c.x, 200.0)]));
    assert!(started.drag_started, "moving off the grip must start the drag");
    assert!(
        started.dragging,
        "the grip must keep reporting dragged while held"
    );

    let released = frame(
        &ctx,
        Some(2),
        input(101.1, vec![press(c.x, 200.0, false)]),
    );
    assert!(
        !released.dragging,
        "releasing ends the drag, which is what commits the reorder"
    );
}

/// The row the pointer is over while dragging decides where the step lands. If
/// this is wrong the drop lands on whichever row happened to be drawn last, and
/// the step lands in the wrong place with no visible error.
#[test]
fn the_hovered_row_tracks_the_pointer_during_a_drag() {
    let ctx = egui::Context::default();
    let c = grip(2).center();
    frame(&ctx, Some(2), input(99.0, Vec::new()));
    frame(
        &ctx,
        Some(2),
        input(100.0, vec![moved(c.x, c.y), press(c.x, c.y, true)]),
    );

    // Drag down over row 4's slot — below every card drawn here.
    let below = frame(&ctx, Some(2), input(100.4, vec![moved(c.x, 250.0)]));
    assert!(below.hovered.is_empty(), "past the last row, nothing is hovered");

    // Back up over row 1.
    let top = frame(&ctx, Some(2), input(100.8, vec![moved(250.0, 25.0)]));
    assert_eq!(
        top.hovered,
        vec![1],
        "the drop target follows the pointer during the drag"
    );
}