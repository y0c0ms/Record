// Icons drawn as vectors rather than typed as characters. The bundled font
// carries Latin and punctuation but not the symbol range, so a character like
// "↻" renders as a square; painting the same shape removes the dependency on
// whatever the font happens to have.
//
// Every icon is the same visual weight: a 1.5px stroke on a 12x12 box, drawn in
// the caller's colour so it inherits hover and disabled states.

use eframe::egui::{self, Color32, Pos2, Stroke, Vec2};

/// Side of the square an icon is drawn in.
pub const SIZE: f32 = 12.0;

/// Stroke weight for every icon, so a set drawn at different sizes still looks
/// like one family.
const W: f32 = 1.5;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    /// Record: a filled dot, the one shape that reads as "start capturing".
    Record,
    /// Pause: two upright bars.
    Pause,
    /// Play: a triangle.
    Play,
    /// Stop: a filled square.
    Stop,
    /// A cross, for closing and dismissing.
    Close,
    /// A pencil, for editing or renaming.
    Pencil,
    /// A downward arrow into a base line, for export.
    Download,
    /// An arrow turning back, for undo and rewind.
    Back,
    /// A chevron pointing right, for a next action or collapsed disclosure.
    Chevron,
    /// A trash can, for delete. Distinct from Close by its lid and body.
    Trash,
    /// A folder, for the folder tree.
    Folder,
    /// A check, for a passing step or run.
    Check,
    Cross,
    /// Two arrows in a circle, for refresh and retry.
    Refresh,
    /// A camera, for a screenshot.
    Camera,
    /// A picture, for a screenshot thumbnail.
    Image,
    /// A plus, for adding a step, a folder, or a row.
    Plus,
    /// An upward arrow, for moving a rung earlier in the order.
    Up,
}

impl Icon {
    /// Paints the icon at `centre`, so a caller places it without knowing the
    /// geometry.
    pub fn paint(self, painter: &egui::Painter, centre: Pos2, color: Color32) {
        let h = SIZE / 2.0;
        let stroke = Stroke::new(W, color);
        let filled = Stroke::new(SIZE * 0.8, color);
        let at = |x: f32, y: f32| Pos2::new(centre.x + x, centre.y + y);
        let line = |a: Pos2, b: Pos2| painter.line_segment([a, b], stroke);
        let box_ = |x0: f32, y0: f32, x1: f32, y1: f32, st: Stroke| {
            let r = egui::Rect::from_min_max(at(x0, y0), at(x1, y1));
            if st.width > 1.0 {
                painter.rect_filled(r, 1.0, color);
            } else {
                painter.rect_stroke(r, 1.0, st, egui::StrokeKind::Middle);
            }
        };

        match self {
            Icon::Record => box_(-h * 0.5, -h * 0.5, h * 0.5, h * 0.5, filled),
            Icon::Pause => {
                box_(-h * 0.55, -h * 0.6, -h * 0.12, h * 0.6, filled);
                box_(h * 0.12, -h * 0.6, h * 0.55, h * 0.6, filled);
            }
            Icon::Play => {
                let pts = vec![at(-h * 0.35, -h * 0.6), at(-h * 0.35, h * 0.6), at(h * 0.6, 0.0)];
                painter.add(egui::Shape::convex_polygon(pts, color, Stroke::NONE));
            }
            Icon::Stop => box_(-h * 0.5, -h * 0.5, h * 0.5, h * 0.5, filled),
            Icon::Close | Icon::Cross => {
                line(at(-h * 0.5, -h * 0.5), at(h * 0.5, h * 0.5));
                line(at(h * 0.5, -h * 0.5), at(-h * 0.5, h * 0.5));
            }
            Icon::Pencil => {
                // A diagonal with a nib: what a pencil reads as without needing
                // a full glyph.
                line(at(h * 0.55, -h * 0.55), at(-h * 0.35, h * 0.4));
                line(at(-h * 0.35, h * 0.4), at(-h * 0.02, h * 0.66));
                line(at(-h * 0.35, h * 0.4), at(-h * 0.66, h * 0.02));
            }
            Icon::Download => {
                line(at(0.0, -h * 0.75), at(0.0, h * 0.2));
                line(at(-h * 0.45, -h * 0.25), at(0.0, h * 0.25));
                line(at(h * 0.45, -h * 0.25), at(0.0, h * 0.25));
                line(at(-h * 0.75, h * 0.6), at(h * 0.75, h * 0.6));
            }
            Icon::Back => {
                line(at(h * 0.55, -h * 0.6), at(-h * 0.5, 0.0));
                line(at(-h * 0.5, 0.0), at(h * 0.55, h * 0.6));
            }
            Icon::Refresh => {
                // A broken circle with an arrowhead closing the gap: the rotation
                // is what makes it read as reload rather than as a plain ring.
                let r = h * 0.6;
                let pts: Vec<Pos2> = (0..=20)
                    .map(|i| {
                        let a = -2.0 + (i as f32 / 20.0) * 4.2;
                        Pos2::new(centre.x + a.cos() * r, centre.y + a.sin() * r)
                    })
                    .collect();
                painter.add(egui::Shape::line(pts, stroke));
                let tip = at(h * 0.3, -h * 0.6);
                line(tip, at(h * 0.74, -h * 0.48));
                line(tip, at(h * 0.52, -h * 0.12));
            }
            Icon::Chevron => {
                line(at(-h * 0.3, -h * 0.6), at(h * 0.3, 0.0));
                line(at(h * 0.3, 0.0), at(-h * 0.3, h * 0.6));
            }
            Icon::Plus => {
                line(at(-h * 0.62, 0.0), at(h * 0.62, 0.0));
                line(at(0.0, -h * 0.62), at(0.0, h * 0.62));
            }
            Icon::Up => {
                // A shaft and a head, reading as "earlier in the list".
                line(at(0.0, h * 0.62), at(0.0, -h * 0.55));
                line(at(0.0, -h * 0.55), at(-h * 0.42, -h * 0.1));
                line(at(0.0, -h * 0.55), at(h * 0.42, -h * 0.1));
            }
            Icon::Trash => {
                line(at(-h * 0.7, -h * 0.4), at(h * 0.7, -h * 0.4));
                line(at(-h * 0.28, -h * 0.68), at(h * 0.28, -h * 0.68));
                line(at(-h * 0.52, -h * 0.4), at(-h * 0.4, h * 0.68));
                line(at(h * 0.52, -h * 0.4), at(h * 0.4, h * 0.68));
                line(at(-h * 0.4, h * 0.68), at(h * 0.4, h * 0.68));
            }
            Icon::Folder => {
                // A tab on the left and a body: what makes a folder read as a
                // folder rather than as a plain box.
                let pts = vec![
                    at(-h * 0.78, -h * 0.42),
                    at(-h * 0.78, -h * 0.7),
                    at(-h * 0.15, -h * 0.7),
                    at(h * 0.05, -h * 0.42),
                    at(h * 0.78, -h * 0.42),
                    at(h * 0.78, h * 0.6),
                    at(-h * 0.78, h * 0.6),
                ];
                painter.add(egui::Shape::closed_line(pts, stroke));
            }
            Icon::Check => {
                line(at(-h * 0.6, 0.05), at(-h * 0.15, h * 0.55));
                line(at(-h * 0.15, h * 0.55), at(h * 0.65, -h * 0.5));
            }
            Icon::Camera => {
                let body = egui::Rect::from_min_max(at(-h * 0.75, -h * 0.3), at(h * 0.75, h * 0.6));
                painter.rect_stroke(body, 2.0, stroke, egui::StrokeKind::Middle);
                line(at(-h * 0.38, -h * 0.3), at(-h * 0.18, -h * 0.62));
                line(at(-h * 0.18, -h * 0.62), at(h * 0.22, -h * 0.62));
                line(at(h * 0.22, -h * 0.62), at(h * 0.42, -h * 0.3));
                painter.circle_stroke(centre, h * 0.26, stroke);
            }
            Icon::Image => {
                let body = egui::Rect::from_min_max(at(-h * 0.75, -h * 0.6), at(h * 0.75, h * 0.6));
                painter.rect_stroke(body, 2.0, stroke, egui::StrokeKind::Middle);
                // A horizon and a sun: the two marks that say "picture".
                line(at(-h * 0.75, h * 0.25), at(-h * 0.15, -h * 0.2));
                line(at(-h * 0.15, -h * 0.2), at(h * 0.25, h * 0.25));
                line(at(h * 0.05, h * 0.25), at(h * 0.75, -h * 0.3));
                painter.circle_stroke(at(h * 0.28, -h * 0.24), h * 0.16, stroke);
            }
        }
    }
}

/// A small button whose face is an icon, with a tooltip when one is given.
/// Hover is painted by hand rather than through a themed widget so the icon keeps
/// the caller's colour instead of inheriting a colour meant for letters.
pub fn button(ui: &mut egui::Ui, icon: Icon, tooltip: &str, color: Color32) -> egui::Response {
    let (rect, response) =
        ui.allocate_exact_size(Vec2::new(SIZE + 8.0, SIZE + 8.0), egui::Sense::click());
    if ui.is_rect_visible(rect) {
        if response.hovered() || response.is_pointer_button_down_on() {
            ui.painter().rect(
                rect,
                4.0,
                ui.visuals().widgets.hovered.bg_fill,
                egui::Stroke::NONE,
                egui::StrokeKind::Inside,
            );
        }
        // Dimmed when idle, so a row of icons does not read as a row of text.
        let tint = if response.hovered() { color } else { color.gamma_multiply(0.7) };
        icon.paint(ui.painter(), rect.center(), tint);
    }
    if tooltip.is_empty() {
        response
    } else {
        response.on_hover_text(tooltip)
    }
}

/// A button with an icon and a label, the label laid out by egui as real text so
/// it measures and wraps like any other text in the app.
pub fn labelled(
    ui: &mut egui::Ui,
    icon: Icon,
    label: &str,
    tooltip: &str,
    color: Color32,
) -> egui::Response {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        let font = egui::FontId::proportional(11.0);
        // `layout_no_wrap` is how egui measures a run of text, so the hit area
        // covers the label exactly rather than a width guessed from a character
        // count.
        let text_w = ui.ctx().fonts_mut(|f| {
            f.layout_no_wrap(label.to_owned(), font.clone(), Color32::WHITE).rect.width()
        });
        let (rect, response) = ui.allocate_exact_size(
            Vec2::new(SIZE + 6.0 + text_w, SIZE.max(14.0)),
            egui::Sense::click(),
        );
        if ui.is_rect_visible(rect) {
            if response.hovered() || response.is_pointer_button_down_on() {
                ui.painter().rect(rect, 4.0, ui.visuals().widgets.hovered.bg_fill, egui::Stroke::NONE, egui::StrokeKind::Inside);
            }
            let tint = if response.hovered() { color } else { color.gamma_multiply(0.7) };
            icon.paint(ui.painter(), Pos2::new(rect.left() + SIZE / 2.0, rect.center().y), tint);
            ui.painter().text(
                Pos2::new(rect.left() + SIZE + 6.0, rect.center().y),
                egui::Align2::LEFT_CENTER,
                label,
                font,
                tint,
            );
        }
        if tooltip.is_empty() {
            response
        } else {
            response.on_hover_text(tooltip)
        }
    })
    .inner
}
