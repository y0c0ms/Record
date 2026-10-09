// Record — a native shell over the recording sidecar.
//
// The crate is split by responsibility so no one file grows into a grab bag:
//   api           — typed sidecar calls
//   state         — what we know (no rendering)
//   actions       — what a click does (no rendering)
//   views         — sidebar and panels (no side effects)
//   views::editor — the no-code step editor
mod actions;
mod api;
mod app;
mod icons;
mod state;
mod theme;
mod views;
use eframe::egui;

use state::{Msg, RecordApp, View};
use theme::TEXT_DIM;

impl RecordApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        cc.egui_ctx.set_theme(egui::Theme::Dark);
        // The palette has to be applied, not just the theme selected: egui's
        // dark theme otherwise keeps its own near-black text, which on a
        // near-black background cannot be read.
        theme::install(&cc.egui_ctx);
        let (tx, rx) = std::sync::mpsc::channel();

        // The first health call is synchronous so the first frame already shows
        // the real state; the probe keeps it honest if the sidecar starts later.
        let health = api::health();
        let (sidecar_ok, browser, demo_url) = match &health {
            Ok(h) => (
                true,
                if h.browser.is_empty() {
                    "Microsoft Edge".to_string()
                } else {
                    h.browser.clone()
                },
                h.demo_url.clone(),
            ),
            Err(_) => (false, "Microsoft Edge".to_string(), String::new()),
        };

        let probe = tx.clone();
        std::thread::spawn(move || {
            let _ = probe.send(Msg::Connected(api::health().map(|_| ())));
        });

        let history = api::list_sessions().unwrap_or_default();
        Self {
            tx,
            rx,
            sidecar_ok,
            browser,
            demo_url,
            flow_name: "Checkout happy path".to_string(),
            start_url: String::new(),
            history,
            spec_code: String::new(),
            view: View::Steps,
            draft: None,
            show_all_history: false,
            // Folders are read up front so the panel is populated on the first
            // frame rather than popping in a moment later.
            folders: api::list_folders().unwrap_or_default(),
            // Read up front too, so the "+" can offer subflows on its first
            // frame rather than after a round trip.
            subflows: api::list_subflows().unwrap_or_default(),
            active_folder: None,
            search: String::new(),
            expanded: Default::default(),
            folder_draft: None,
            dataset: None,
            carousel_run: None,
            session: None,
            recording: false,
            paused: false,
            insert: None,
            subflow_draft: None,
            subflow_pick: None,
            selected: None,
            drag: None,
            busy: false,
            ctx: cc.egui_ctx.clone(),
            resubscribe: None,
            retry_at: None,
            retries: 0,
            toast: None,
            autoscroll: true,
            accent: TEXT_DIM,
            shot_view: None,
            shot_tex: std::collections::HashMap::new(),
        }
    }
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1000.0, 680.0])
            .with_min_inner_size([840.0, 520.0])
            .with_title("Record — Edge flow recorder"),
        ..Default::default()
    };
    eframe::run_native(
        "Record",
        options,
        Box::new(|cc| Ok(Box::new(RecordApp::new(cc)))),
    )
}