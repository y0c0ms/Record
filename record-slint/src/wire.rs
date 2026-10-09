// Window callbacks → state changes. Each handler mutates `RecordApp` (and may
// start a worker), then the window is re-rendered from state. Handlers never
// format text or decide what is enabled; that is present.rs.

use std::cell::RefCell;
use std::rc::Rc;

use slint::ComponentHandle;

use crate::api;
use crate::present::{self, STRATEGIES};
use crate::state::{FolderDraft, PanelTab, RecordApp, View};
use crate::AppWindow;

type App = Rc<RefCell<RecordApp>>;

/// Runs `f` on the state, then re-renders and starts any screenshot loads the
/// new state needs.
fn update(app: &App, w: &AppWindow, f: impl FnOnce(&mut RecordApp)) {
    let mut a = app.borrow_mut();
    f(&mut a);
    for url in present::wanted_shots(&a) {
        a.load_shot(&url);
    }
    present::render(&mut a, w);
}

/// Wires a callback with no arguments.
macro_rules! on {
    ($w:ident, $app:ident, $setter:ident, |$a:ident| $body:expr) => {{
        let app = $app.clone();
        let weak = $w.as_weak();
        $w.$setter(move || {
            let Some(w) = weak.upgrade() else { return };
            update(&app, &w, |$a| {
                $body;
            });
        });
    }};
    ($w:ident, $app:ident, $setter:ident, |$a:ident, $($arg:ident),+| $body:expr) => {{
        let app = $app.clone();
        let weak = $w.as_weak();
        $w.$setter(move |$($arg),+| {
            let Some(w) = weak.upgrade() else { return };
            update(&app, &w, |$a| {
                $body;
            });
        });
    }};
}

fn idx(i: i32) -> usize {
    i.max(0) as usize
}

pub fn connect(w: &AppWindow, app: &App) {
    // ---- flow controls ----
    on!(w, app, on_use_demo, |a| a.start_url = a.demo_url.clone());
    on!(w, app, on_flow_name_edited, |a, t| a.flow_name = t.to_string());
    on!(w, app, on_start_recording, |a| a.start_recording());
    on!(w, app, on_interrupt, |a| {
        let resume = a.paused || a.replay_paused();
        a.interrupt(resume)
    });
    on!(w, app, on_stop, |a| a.stop());
    on!(w, app, on_replay, |a| a.start_replay_with(Vec::new()));
    on!(w, app, on_export_spec, |a| a.export_spec());
    on!(w, app, on_set_view, |a, i| {
        a.view = View::from_index(i);
        if a.view != View::Runs {
            a.shot_view = None;
        }
    });

    // ---- folders and recordings ----
    on!(w, app, on_search_edited, |a, t| a.search = t.to_string());
    on!(w, app, on_new_folder, |a| a.folder_draft = Some(FolderDraft { id: None, name: String::new(), parent: None }));
    on!(w, app, on_folder_draft_edited, |a, t| {
        if let Some(d) = a.folder_draft.as_mut() {
            d.name = t.to_string();
        }
    });
    on!(w, app, on_folder_draft_save, |a| a.save_folder());
    on!(w, app, on_folder_draft_cancel, |a| a.folder_draft = None);
    on!(w, app, on_folder_select, |a, id| {
        a.active_folder = if id.is_empty() { None } else { Some(id.to_string()) };
    });
    on!(w, app, on_folder_toggle, |a, id| {
        let id = id.to_string();
        if !a.expanded.remove(&id) {
            a.expanded.insert(id);
        }
    });
    // Filing the open flow into a folder is done from the folder's row in the
    // tree, so there is no second folder list to keep in step.
    on!(w, app, on_folder_file, |a, id| {
        let id = id.to_string();
        a.move_to_folder(if id == "unfiled" { None } else { Some(id) });
    });
    on!(w, app, on_folder_new_child, |a, id| {
        a.folder_draft = Some(FolderDraft { id: None, name: String::new(), parent: Some(id.to_string()) })
    });
    on!(w, app, on_folder_rename, |a, id| {
        let name = find_folder(&a.folders, &id).map(|f| f.name.clone()).unwrap_or_default();
        a.folder_draft = Some(FolderDraft { id: Some(id.to_string()), name, parent: None })
    });
    on!(w, app, on_folder_delete, |a, id| a.delete_folder(id.to_string()));
    on!(w, app, on_recording_open, |a, id| a.open_session(id.to_string()));
    on!(w, app, on_recording_delete, |a, id| a.delete_session(id.to_string()));
    on!(w, app, on_reload, |a| {
        // Offline, Reload is how the sidecar is brought back.
        if !a.sidecar_ok {
            a.connect();
            return;
        }
        a.refresh_history();
        a.load_folders();
    });

    // ---- steps ----
    on!(w, app, on_select_step, |a, i| a.select_step(idx(i)));
    on!(w, app, on_set_action, |a, i, action| {
        let Some(step) = a.steps().iter().find(|s| s.index == idx(i)).cloned() else { return };
        let Some(spec) = api::ACTIONS.get(idx(action)) else { return };
        if spec.id != step.kind {
            a.apply_step_edit(step.index, spec.id.to_string(), step.literal_value(), None);
        }
    });
    on!(w, app, on_commit_value, |a, i, value, as_param, param| {
        let Some(step) = a.steps().iter().find(|s| s.index == idx(i)).cloned() else { return };
        let param = param.trim().to_string();
        let new_param = (as_param && !param.is_empty()).then(|| param.clone());
        // A ticked box with no name gets the suggested one, so promoting a
        // value to a parameter is one click.
        let new_param = if as_param && param.is_empty() { Some(step.suggested_param()) } else { new_param };
        let unchanged = value.as_str() == step.literal_value() && new_param == step.value_param.clone().filter(|p| !p.trim().is_empty());
        if !unchanged {
            a.apply_step_edit(step.index, step.kind.clone(), value.to_string(), new_param);
        }
    });
    on!(w, app, on_set_match, |a, i, m| {
        let Some(step) = a.steps().iter().find(|s| s.index == idx(i)).cloned() else { return };
        let Some((mode, _)) = api::MATCH_MODES.get(idx(m)) else { return };
        if *mode != step.match_mode() {
            a.apply_step_edit_with(step.index, step.kind.clone(), step.literal_value(), step.value_param.clone(), Some(mode.to_string()));
        }
    });
    on!(w, app, on_delete_step, |a, i| a.delete_step(idx(i)));
    on!(w, app, on_reorder, |a, from, to| a.reorder_step(idx(from), idx(to)));

    // ---- inserting ----
    on!(w, app, on_insert_at, |a, at| a.begin_insert(idx(at)));
    on!(w, app, on_insert_action, |a, i| {
        if let (Some(d), Some(spec)) = (a.insert.as_mut(), api::ACTIONS.get(idx(i))) {
            d.action = spec.id.to_string();
        }
    });
    on!(w, app, on_insert_match, |a, m| {
        if let (Some(d), Some((mode, _))) = (a.insert.as_mut(), api::MATCH_MODES.get(idx(m))) {
            d.match_mode = mode.to_string();
        }
    });
    on!(w, app, on_insert_label, |a, t| {
        if let Some(d) = a.insert.as_mut() {
            d.label = t.to_string();
        }
    });
    on!(w, app, on_insert_value, |a, t| {
        if let Some(d) = a.insert.as_mut() {
            d.value = t.to_string();
        }
    });
    on!(w, app, on_insert_param, |a, t| {
        if let Some(d) = a.insert.as_mut() {
            d.param = t.to_string();
        }
    });
    on!(w, app, on_insert_add, |a| a.insert_step());
    on!(w, app, on_insert_capture, |a| {
        if let Some(at) = a.insert.as_ref().map(|d| d.at) {
            a.capture_step(at);
        }
    });
    on!(w, app, on_insert_cancel, |a| a.insert = None);
    on!(w, app, on_capture_cancel, |a| a.cancel_capture());

    // ---- subflows ----
    on!(w, app, on_pick_subflow, |a, at| {
        a.insert = None;
        a.subflow_pick = Some(idx(at));
    });
    on!(w, app, on_subflow_insert, |a, id| {
        if let Some(at) = a.subflow_pick {
            a.import_subflow(id.to_string(), at);
        }
    });
    on!(w, app, on_subflow_delete, |a, id| a.delete_subflow(id.to_string()));
    on!(w, app, on_subflow_pick_cancel, |a| a.subflow_pick = None);
    {
        // Subflow mode is pure presentation (the tick boxes), held on the window.
        let app = app.clone();
        let weak = w.as_weak();
        w.on_toggle_subflow_mode(move || {
            let Some(w) = weak.upgrade() else { return };
            let on = !w.get_subflow_mode();
            w.set_subflow_mode(on);
            update(&app, &w, |a| {
                if !on {
                    a.subflow_draft = None;
                }
            });
        });
    }
    on!(w, app, on_toggle_subflow, |a, i, on| a.toggle_subflow_step(idx(i), on));
    on!(w, app, on_subflow_name_edited, |a, t| {
        if let Some(d) = a.subflow_draft.as_mut() {
            d.name = t.to_string();
        }
    });
    on!(w, app, on_subflow_save, |a| a.save_subflow());
    on!(w, app, on_subflow_clear, |a| a.subflow_draft = None);

    // ---- code, runs, dataset ----
    {
        let app = app.clone();
        let weak = w.as_weak();
        w.on_copy_code(move || {
            let Some(w) = weak.upgrade() else { return };
            let code = app.borrow().spec_code.clone();
            let copied = copy_to_clipboard(&code);
            update(&app, &w, |a| match copied {
                Ok(()) => a.notice("Spec copied to clipboard."),
                Err(err) => a.error(format!("Could not copy: {err}")),
            });
        });
    }
    on!(w, app, on_open_run, |a, id| {
        let id = id.to_string();
        a.open_run = if a.open_run.as_deref() == Some(id.as_str()) { None } else { Some(id) };
        a.shot_view = None;
    });
    on!(w, app, on_dataset_edited, |a, i, value| {
        let params = a.session.as_ref().map(|s| s.params()).unwrap_or_default();
        let Some(param) = params.get(idx(i)) else { return };
        match a.dataset.values.iter_mut().find(|(n, _)| *n == param.name) {
            Some(entry) => entry.1 = value.to_string(),
            None => a.dataset.values.push((param.name.clone(), value.to_string())),
        }
    });
    on!(w, app, on_dataset_replay, |a| {
        let entries: Vec<(String, String)> = a.dataset.values.iter().filter(|(_, v)| !v.trim().is_empty()).cloned().collect();
        a.start_replay_with(entries)
    });
    {
        // Clearing has to reach into the fields too: they hold their own text.
        let app = app.clone();
        let weak = w.as_weak();
        w.on_dataset_clear(move || {
            let Some(w) = weak.upgrade() else { return };
            app.borrow_mut().dataset.values.clear();
            w.set_params(slint::ModelRc::new(slint::VecModel::<crate::ParamRow>::default()));
            update(&app, &w, |_| {});
        });
    }

    // ---- step panel ----
    on!(w, app, on_panel_close, |a| a.selected = None);
    on!(w, app, on_panel_set_tab, |a, t| {
        if let Some(p) = a.selected.as_mut() {
            p.tab = PanelTab::from_index(t);
        }
    });
    on!(w, app, on_panel_set_action, |a, action| {
        let Some(index) = a.selected.as_ref().map(|p| p.index) else { return };
        let Some(step) = a.steps().iter().find(|s| s.index == index).cloned() else { return };
        let Some(spec) = api::ACTIONS.get(idx(action)) else { return };
        if spec.id != step.kind {
            a.apply_step_edit(index, spec.id.to_string(), step.literal_value(), None);
        }
    });
    on!(w, app, on_panel_set_optional, |a, on| {
        let Some(index) = a.selected.as_ref().map(|p| p.index) else { return };
        a.set_step_optional(index, on);
    });
    on!(w, app, on_panel_set_match, |a, m| {
        let Some(index) = a.selected.as_ref().map(|p| p.index) else { return };
        let Some(step) = a.steps().iter().find(|s| s.index == index).cloned() else { return };
        let Some((mode, _)) = api::MATCH_MODES.get(idx(m)) else { return };
        if *mode != step.match_mode() {
            a.apply_step_edit_with(index, step.kind.clone(), step.literal_value(), step.value_param.clone(), Some(mode.to_string()));
        }
    });
    on!(w, app, on_panel_commit_value, |a, value, as_param, param| {
        let Some(index) = a.selected.as_ref().map(|p| p.index) else { return };
        let Some(step) = a.steps().iter().find(|s| s.index == index).cloned() else { return };
        let param = param.trim().to_string();
        let new_param = (as_param && !param.is_empty()).then_some(param);
        let unchanged = value.as_str() == step.literal_value() && new_param == step.value_param.clone().filter(|p| !p.trim().is_empty());
        if !unchanged {
            a.apply_step_edit(index, step.kind.clone(), value.to_string(), new_param);
        }
    });
    {
        let app = app.clone();
        let weak = w.as_weak();
        w.on_panel_save_secret(move |secret| {
            let Some(w) = weak.upgrade() else { return };
            w.set_panel_new_secret("".into());
            update(&app, &w, |a| {
                let Some(index) = a.selected.as_ref().map(|p| p.index) else { return };
                let kind = a.steps().iter().find(|s| s.index == index).map(|s| s.kind.clone()).unwrap_or_default();
                a.apply_step_secret(index, kind, secret.to_string());
            });
        });
    }
    on!(w, app, on_panel_attach_file, |a| {
        if let Some(index) = a.selected.as_ref().map(|p| p.index) {
            a.pick_upload_file(index, true);
        }
    });
    on!(w, app, on_panel_disk_file, |a| {
        if let Some(index) = a.selected.as_ref().map(|p| p.index) {
            a.pick_upload_file(index, false);
        }
    });
    on!(w, app, on_panel_sample_file, |a, kind| {
        if let Some(index) = a.selected.as_ref().map(|p| p.index) {
            a.apply_step_file(
                index,
                api::FileChoice {
                    source: "sample".into(),
                    sample: Some(kind.to_string()),
                    name: Some(format!("sample.{kind}")),
                    ..Default::default()
                },
            );
        }
    });
    on!(w, app, on_panel_edit_locators, |a| {
        let Some(index) = a.selected.as_ref().map(|p| p.index) else { return };
        let ladder = a.steps().iter().find(|s| s.index == index).map(|s| s.candidates.clone()).unwrap_or_default();
        if let Some(p) = a.selected.as_mut() {
            p.locators = Some(ladder);
        }
    });
    on!(w, app, on_panel_cancel_locators, |a| {
        if let Some(p) = a.selected.as_mut() {
            p.locators = None;
        }
    });
    on!(w, app, on_panel_save_locators, |a| {
        let Some(panel) = a.selected.clone() else { return };
        let Some(chain) = panel.locators else { return };
        if let Some(bad) = chain.iter().position(|c| c.is_empty()) {
            a.error(format!("Way {} has nothing in it — give it a value or remove it.", bad + 1));
            return;
        }
        if chain.is_empty() {
            a.error("Every way to find this is empty — nothing would resolve.");
            return;
        }
        a.apply_step_locators(panel.index, chain);
        if let Some(p) = a.selected.as_mut() {
            p.locators = None;
        }
    });
    on!(w, app, on_panel_locator_up, |a, n| {
        edit_ladder(a, |chain| {
            let n = idx(n);
            if n > 0 && n < chain.len() {
                chain.swap(n, n - 1);
            }
        });
        a.ladder_moved = true;
    });
    on!(w, app, on_panel_locator_remove, |a, n| edit_ladder(a, |chain| {
        let n = idx(n);
        if n < chain.len() {
            chain.remove(n);
        }
    }));
    on!(w, app, on_panel_locator_add, |a| edit_ladder(a, |chain| {
        chain.push(api::Candidate { strategy: "css".into(), value: Some(String::new()), ..Default::default() });
    }));
    on!(w, app, on_panel_locator_strategy, |a, n, s| edit_ladder(a, |chain| {
        let Some(c) = chain.get_mut(idx(n)) else { return };
        let strategy = STRATEGIES.get(idx(s)).copied().unwrap_or("css");
        if c.strategy != strategy {
            c.strategy = strategy.to_string();
            if strategy == "role" {
                c.value = None;
                c.role.get_or_insert_with(String::new);
                c.name.get_or_insert_with(String::new);
            } else {
                c.role = None;
                c.name = None;
                c.value.get_or_insert_with(String::new);
            }
        }
    }));
    // Typing into a rung updates Rust's copy without re-rendering the ladder,
    // so the field keeps focus and caret.
    {
        let app = app.clone();
        w.on_panel_locator_role(move |n, t| rung(&app, n, |c| c.role = Some(t.to_string())));
    }
    {
        let app = app.clone();
        w.on_panel_locator_name(move |n, t| rung(&app, n, |c| c.name = Some(t.to_string())));
    }
    {
        let app = app.clone();
        w.on_panel_locator_value(move |n, t| rung(&app, n, |c| c.value = Some(t.to_string())));
    }

    // ---- run panel and screenshot viewer ----
    on!(w, app, on_run_close, |a| {
        a.open_run = None;
        a.shot_view = None;
    });
    on!(w, app, on_open_shot, |a, p| a.shot_view = Some(idx(p)));
    on!(w, app, on_shot_close, |a| a.shot_view = None);
    // Escape closes the innermost open thing first: the screenshot viewer, then
    // a half-filled form, then the side panel.
    on!(w, app, on_escape, |a| {
        if a.shot_view.is_some() {
            a.shot_view = None;
        } else if a.insert.is_some() && !a.busy {
            a.insert = None;
        } else if a.subflow_pick.is_some() {
            a.subflow_pick = None;
        } else if a.selected.is_some() {
            a.selected = None;
        } else if a.open_run.is_some() {
            a.open_run = None;
        }
    });
    on!(w, app, on_shot_prev, |a| a.shot_view = a.shot_view.map(|p| p.saturating_sub(1)));
    on!(w, app, on_shot_next, |a| a.shot_view = a.shot_view.map(|p| p + 1));
}
/// Changes one field of one rung of the ladder being edited.
fn rung(app: &App, n: i32, f: impl FnOnce(&mut api::Candidate)) {
    let mut a = app.borrow_mut();
    if let Some(c) = a.selected.as_mut().and_then(|p| p.locators.as_mut()).and_then(|chain| chain.get_mut(idx(n))) {
        f(c);
    }
}


/// Applies a structural change (reorder, add, remove, strategy) to the ladder
/// being edited; the render that follows rebuilds the rows.
fn edit_ladder(a: &mut RecordApp, f: impl FnOnce(&mut Vec<api::Candidate>)) {
    if let Some(chain) = a.selected.as_mut().and_then(|p| p.locators.as_mut()) {
        f(chain);
    }
}

fn find_folder<'a>(folders: &'a [api::Folder], id: &str) -> Option<&'a api::Folder> {
    for f in folders {
        if f.id == id {
            return Some(f);
        }
        if let Some(c) = f.children.iter().find(|c| c.id == id) {
            return Some(c);
        }
    }
    None
}

/// Copies text to the system clipboard through the platform's own tool, so no
/// clipboard crate is needed for one button.
fn copy_to_clipboard(text: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    #[cfg(windows)]
    let mut child = Command::new("clip").stdin(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let mut child = Command::new("pbcopy").stdin(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut child = Command::new("xclip")
        .args(["-selection", "clipboard"])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    #[cfg(not(windows))]
    let bytes = text.as_bytes().to_vec();
    child.stdin.take().ok_or("no stdin")?.write_all(&bytes).map_err(|e| e.to_string())?;
    child.wait().map_err(|e| e.to_string())?;
    Ok(())
}
