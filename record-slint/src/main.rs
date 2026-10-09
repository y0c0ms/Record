// No console window behind the GUI in a release build. A debug build keeps it,
// because that is where panics and logs are read during development.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Record's desktop GUI. The UI is Slint (ui/*.slint); state and side effects
// are plain Rust (state.rs, actions.rs), and present.rs turns state into the
// view models the UI draws. Worker threads report back over a channel and wake
// the event loop, so the window does no work while nothing happens.

mod actions;
mod api;
mod present;
mod sidecar;
mod state;
mod wire;

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::OnceLock;

use state::{Msg, RecordApp};

slint::include_modules!();

/// Asks the UI thread to drain pending messages. Safe from any thread; a no-op
/// before the window exists.
static WAKE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

pub fn wake() {
    if let Some(wake) = WAKE.get() {
        wake();
    }
}

fn main() -> Result<(), slint::PlatformError> {
    let window = AppWindow::new()?;
    let (tx, rx) = mpsc::channel::<Msg>();
    let app = Rc::new(RefCell::new(RecordApp::new(tx)));
    let rx = Rc::new(rx);

    // Messages are drained on the UI thread, then the window is re-rendered
    // from state once per batch.
    {
        let weak = window.as_weak();
        let _ = WAKE.set(Box::new(move || {
            let weak = weak.clone();
            let _ = slint::invoke_from_event_loop(move || {
                if let Some(w) = weak.upgrade() {
                    w.invoke_drain();
                }
            });
        }));
    }
    {
        let app = app.clone();
        let rx = rx.clone();
        let weak = window.as_weak();
        window.on_drain(move || {
            let Some(w) = weak.upgrade() else { return };
            let mut changed = false;
            while let Ok(msg) = rx.try_recv() {
                app.borrow_mut().apply(msg);
                changed = true;
            }
            if changed {
                let mut a = app.borrow_mut();
                // A newly opened run, or a newly arrived one, needs its
                // screenshots fetched before they can show.
                for url in present::wanted_shots(&a) {
                    a.load_shot(&url);
                }
                present::render(&mut a, &w);
            }
        });
    }

    wire::connect(&window, &app);
    app.borrow_mut().connect();
    present::render(&mut app.borrow_mut(), &window);
    let result = window.run();
    // The sidecar this window started goes with it; one that was already
    // running before is left alone.
    sidecar::stop_owned();
    result
}
