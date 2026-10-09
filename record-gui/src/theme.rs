// Palette, scales, and the shared widgets, in one place so the panels stay about
// layout rather than about colour choices.
//
// The token set is gpui-kit's (crates/base/src/theme_tokens.rs, its
// `ColorTokens`/`SpacingTokens`/`RadiusTokens`/`TypographyTokens`): colours are
// named for the role they play — background, foreground, muted, border, ring —
// never for the hue they happen to be. That is what keeps every surface legible
// on a dark theme, because a token added next to the others cannot accidentally
// be an unreadable one.

use eframe::egui::{self, Color32, Stroke};

/// gpui-kit `ColorTokens::dark()`: lightness 0.039 = 10/255 = #0a0a0a.
/// Contrast on this background: foreground 18.97:1, muted-foreground 7.85:1.
pub const BG: Color32 = Color32::from_rgb(0x0a, 0x0a, 0x0a);
/// A raised plane. gpui-kit uses `secondary`/`muted` for these.
pub const SURFACE: Color32 = Color32::from_rgb(0x26, 0x26, 0x26);
pub const SURFACE_2: Color32 = Color32::from_rgb(0x1a, 0x1a, 0x1a);
/// Primary text. gpui-kit `foreground` (0.98 lightness = #fafafa).
pub const TEXT: Color32 = Color32::from_rgb(0xfa, 0xfa, 0xfa);
/// Text that is secondary but still readable: gpui-kit `muted_foreground`
/// (0.639 lightness), 7.85:1 on the background rather than a decorative grey.
pub const TEXT_DIM: Color32 = Color32::from_rgb(0xa3, 0xa3, 0xa3);
/// Hairlines and card edges: gpui-kit `border`.
pub const BORDER: Color32 = Color32::from_rgb(0x26, 0x26, 0x26);
/// The accent, for a focus ring and for the primary action.
pub const ACCENT: Color32 = Color32::from_rgb(0x7a, 0x9e, 0xff);
/// gpui-kit `destructive`, darkened for a dark theme so it stays readable.
pub const DANGER: Color32 = Color32::from_rgb(0xe7, 0x54, 0x5f);
/// A passing step or run.
pub const OK: Color32 = Color32::from_rgb(0x3e, 0xb9, 0x7e);

// gpui-kit `RadiusTokens`: sm 3, md 6, lg 8.
pub const R_SM: f32 = 3.0;
pub const R_MD: f32 = 6.0;
pub const R_LG: f32 = 8.0;

// gpui-kit `SpacingTokens`: xxs 2, xs 4, sm 8, md 12, lg 16, xl 24, xxl 32.
pub const SP_2: f32 = 2.0;
pub const SP_4: f32 = 4.0;
pub const SP_8: f32 = 8.0;
pub const SP_12: f32 = 12.0;
pub const SP_16: f32 = 16.0;
pub const SP_24: f32 = 24.0;

// gpui-kit `TypographyTokens`: xs 12/16, sm 14/20, md 16/24, lg 18/28.
pub const FS_XS: f32 = 12.0;
pub const FS_SM: f32 = 14.0;
pub const FS_MD: f32 = 16.0;
pub const FS_LG: f32 = 18.0;

/// Recordings shown in the history list before it collapses behind
/// "Show all". Enough to recognise a recent flow without the panel crowding out
/// the step list.
pub const SHOW_HISTORY: usize = 6;

/// Applies the palette to egui. Without this egui's dark theme keeps its own
/// near-black text colour, which on a near-black background is unreadable —
/// which is exactly what happened before this existed.
pub fn install(ctx: &egui::Context) {
    let mut style = (*ctx.style_of(egui::Theme::Dark)).clone();
    let mut visuals = egui::Visuals::dark();
    visuals.override_text_color = Some(TEXT);
    visuals.panel_fill = BG;
    visuals.window_fill = SURFACE_2;
    visuals.extreme_bg_color = BG;
    visuals.faint_bg_color = SURFACE;
    visuals.code_bg_color = SURFACE_2;
    visuals.hyperlink_color = ACCENT;
    visuals.selection.bg_fill = ACCENT.gamma_multiply(0.35);
    visuals.selection.stroke = Stroke::new(1.0, ACCENT);
    visuals.widgets.noninteractive.bg_fill = BG;
    visuals.widgets.noninteractive.weak_bg_fill = BG;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT_DIM);
    visuals.widgets.inactive.bg_fill = SURFACE;
    visuals.widgets.inactive.weak_bg_fill = SURFACE;
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.hovered.bg_fill = SURFACE;
    visuals.widgets.hovered.weak_bg_fill = SURFACE;
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.active.bg_fill = SURFACE_2;
    visuals.widgets.active.weak_bg_fill = SURFACE_2;
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, TEXT);
    visuals.widgets.open.bg_fill = SURFACE;
    visuals.widgets.open.weak_bg_fill = SURFACE;
    visuals.widgets.open.fg_stroke = Stroke::new(1.0, TEXT);
    style.visuals = visuals;
    // A visible focus ring, per gpui-kit's `ring` token: the only way a keyboard
    // user can tell where they are.
    style.visuals.selection.stroke = Stroke::new(1.0, ACCENT);
    ctx.set_style_of(egui::Theme::Dark, style);
}

/// A step's card: raised surface, hairline border, and an accent border when the
/// step's value comes from the dataset.
pub fn step_card(parametrized: bool) -> egui::Frame {
    egui::Frame::new()
        .fill(SURFACE_2)
        .inner_margin(egui::Margin::symmetric(12, 8))
        .corner_radius(R_MD)
        .stroke(egui::Stroke::new(1.0, if parametrized { ACCENT } else { BORDER }))
}

/// The same card with its step selected. Selection is a brighter fill and a
/// heavier border; the parameterised accent stays on the border of the
/// unselected card, so the two states never have to be told apart by hue alone.
pub fn step_card_selected() -> egui::Frame {
    egui::Frame::new()
        .fill(SURFACE)
        .inner_margin(egui::Margin::symmetric(12, 8))
        .corner_radius(R_MD)
        .stroke(egui::Stroke::new(1.5, ACCENT))
        .shadow(egui::Shadow {
            offset: [0, 0],
            blur: 8,
            spread: 0,
            color: egui::Color32::from_black_alpha(90),
        })
}

/// The top bar, so the header keeps the same height as the rest of the chrome.
pub fn header_bar() -> egui::Frame {
    egui::Frame::new()
        .fill(SURFACE)
        .inner_margin(egui::Margin::symmetric(16, 8))
}

/// A label that reads as body text at any zoom, rather than one whose colour is
/// left to whatever the surrounding widget happened to inherit.
pub fn label(text: impl Into<String>) -> egui::RichText {
    egui::RichText::new(text).size(FS_XS).color(TEXT)
}

/// Secondary label, for the supporting line under a value.
pub fn dim(text: impl Into<String>) -> egui::RichText {
    egui::RichText::new(text).size(FS_XS).color(TEXT_DIM)
}

/// A panel with nothing in it yet. Centred and dimmed, because an empty list is
/// a normal state rather than an error — the title says what is missing and the
/// body says how to get there, rather than leaving the panel blank.
pub fn empty_state(ui: &mut egui::Ui, title: &str, body: &str) {
    ui.add_space(SP_24);
    ui.vertical_centered(|ui| {
        ui.label(egui::RichText::new(title).size(FS_SM).strong().color(TEXT));
        ui.add_space(SP_4);
        ui.label(
            egui::RichText::new(body)
                .size(FS_XS)
                .color(TEXT_DIM),
        );
    });
}
