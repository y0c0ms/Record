// State → window. Every user-visible string and every enable/disable rule is
// decided here, in one pass over the state, so the .slint files only lay out
// what they are given.

use slint::{Image, Model, ModelRc, SharedString, VecModel};

use crate::api;
use crate::state::RecordApp;
use crate::{
    AppWindow, FolderRow, InsertState, Line, LocatorRow, ParamRow, RunRow,
    RunStepRow, StepRow, SubflowRow,
};

pub const STRATEGIES: [&str; 8] = ["role", "testId", "label", "placeholder", "text", "altText", "css", "xpath"];

fn model<T: Clone + 'static>(items: Vec<T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(items))
}

/// Writes `rows` into the model the window already shows, touching only rows
/// that changed. Replacing the whole model rebuilt every card on every event,
/// which on a long flow made each new recorded step cost the entire list — and
/// reset any card the user was typing in. Diffing keeps unchanged cards alive.
fn sync_rows<T: Clone + PartialEq + 'static>(current: ModelRc<T>, rows: Vec<T>, set: impl FnOnce(ModelRc<T>)) {
    let Some(vec) = current.as_any().downcast_ref::<VecModel<T>>() else {
        set(model(rows));
        return;
    };
    let shared = rows.len().min(vec.row_count());
    for (i, row) in rows.iter().enumerate().take(shared) {
        if vec.row_data(i).as_ref() != Some(row) {
            vec.set_row_data(i, row.clone());
        }
    }
    while vec.row_count() > rows.len() {
        vec.remove(vec.row_count() - 1);
    }
    for row in rows.into_iter().skip(shared) {
        vec.push(row);
    }
}

/// A folder's name, prefixed with its parent's when it is a sub-folder.
fn folder_path(folders: &[api::Folder], id: &str) -> String {
    for f in folders {
        if f.id == id {
            return f.name.clone();
        }
        for c in &f.children {
            if c.id == id {
                return format!("{} / {}", f.name, c.name);
            }
        }
    }
    "a folder".to_string()
}

fn s(text: impl AsRef<str>) -> SharedString {
    SharedString::from(text.as_ref())
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// "before the first step" / "after step 3" — where an inserted step lands.
pub fn position_of(at: usize) -> String {
    if at <= 1 { "before the first step".into() } else { format!("after step {}", at - 1) }
}

pub fn action_index(kind: &str) -> i32 {
    api::ACTIONS.iter().position(|a| a.id == kind).map(|i| i as i32).unwrap_or(0)
}

fn strategy_index(strategy: &str) -> i32 {
    STRATEGIES.iter().position(|s| *s == strategy).map(|i| i as i32).unwrap_or(6)
}

fn line(text: impl AsRef<str>, tone: &str, mono: bool) -> Line {
    Line { text: s(text), tone: s(tone), mono }
}

pub fn render(app: &mut RecordApp, w: &AppWindow) {
    header(app, w);
    sidebar(app, w);
    steps(app, w);
    step_panel(app, w);
    w.set_view(app.view.index());
    w.set_code(s(&app.spec_code));
    runs(app, w);
    dataset(app, w);
    shot_viewer(app, w);
    match &app.toast {
        Some((text, error)) => {
            w.set_toast(s(text));
            w.set_toast_error(*error);
        }
        None => w.set_toast(s("")),
    }
}

fn header(app: &RecordApp, w: &AppWindow) {
    let (text, tone) = if app.recording {
        ("Recording", "danger")
    } else if app.sidecar_ok {
        ("Ready", "ok")
    } else {
        ("Sidecar offline — Reload to start it", "danger")
    };
    w.set_status_text(s(text));
    w.set_status_tone(s(tone));
}

fn sidebar(app: &RecordApp, w: &AppWindow) {
    // Never written back while the user is typing in it: a render triggered by
    // an unrelated message would otherwise move the caret.
    if w.get_flow_name() != app.flow_name.as_str() {
        w.set_flow_name(s(&app.flow_name));
    }
    w.set_demo_url(s(&app.demo_url));
    let replaying = app.replay_running();
    let has_steps = !app.steps().is_empty();
    w.set_can_edit_flow(!app.recording && !app.busy);
    w.set_can_record(app.sidecar_ok && !app.recording && !app.busy);
    w.set_interrupting(app.recording || replaying);
    w.set_pause_label(s(if app.paused || app.replay_paused() { "Resume" } else { "Pause" }));
    w.set_stop_hint(s(if replaying { "End the run, keeping its record" } else { "End the recording" }));
    w.set_can_replay(has_steps && !app.recording && !replaying && !app.busy);
    w.set_can_export(has_steps && !app.recording && !app.busy);
    w.set_recording_live(app.recording);
    w.set_has_session(app.session.is_some());
    if let Some(session) = &app.session {
        w.set_session_name(s(&session.name));
        let count = session.steps.len();
        let (summary, tone) = match &session.replay {
            Some(r) if r.status == "running" => (format!("replaying {}/{} steps", r.done(), r.total), "accent"),
            Some(r) if r.status == "paused" => (format!("replay paused at step {} of {}", r.done() + 1, r.total), "accent"),
            Some(r) if r.status == "cancelled" => (format!("replay stopped at step {} of {}", r.done() + 1, r.total), "dim"),
            Some(r) if r.status == "passed" && r.skipped > 0 => {
                (format!("replay passed · {}/{} steps, {} skipped", r.passed, r.total, r.skipped), "ok")
            }
            Some(r) if r.status == "passed" => (format!("replay passed · {}/{} steps", r.passed, r.total), "ok"),
            Some(r) if r.status == "failed" => (format!("replay failed at step {} of {}", r.done(), r.total), "danger"),
            // Why a recording ended other than by Stop: the browser was closed,
            // or the recorder failed. Without it the flow just looks short.
            _ => match session.error.as_deref().filter(|e| !e.trim().is_empty()) {
                Some(err) => (format!("{count} step{} captured · recording ended: {err}", plural(count)), "danger"),
                None => (format!("{count} step{} captured", plural(count)), "dim"),
            },
        };
        w.set_session_summary(s(summary));
        w.set_session_summary_tone(s(tone));

        // Where the open flow is filed. Filing is done from the folder's own
        // row in the tree, so this is a readout, not a second folder list.
        w.set_filed_under(s(match session.folder.as_deref() {
            None | Some("unfiled") => "Not filed in a folder".to_string(),
            Some(id) => format!("Filed in {}", folder_path(&app.folders, id)),
        }));
    }

    if w.get_search() != app.search.as_str() {
        w.set_search(s(&app.search));
    }
    let needle = app.search.trim().to_lowercase();
    let searching = !needle.is_empty();
    let open_id = app.session.as_ref().map(|s| s.id.as_str());
    // The folder the open flow lives in, so its own row does not offer to file
    // it there. `None` while no flow is open: nothing to file.
    let filed = app.session.as_ref().map(|s| s.folder.clone().unwrap_or_else(|| "unfiled".to_string()));
    let own_match = |folder: &api::Folder| {
        folder.name.to_lowercase().contains(&needle)
            || app.history.iter().any(|e| {
                e.folder.as_deref() == Some(folder.id.as_str()) && e.name.to_lowercase().contains(&needle)
            })
    };
    // A parent stays listed when only one of its sub-folders matches;
    // otherwise a search for a sub-folder, or a flow filed in one, found
    // nothing.
    let matches = |folder: &api::Folder| own_match(folder) || folder.children.iter().any(|c| own_match(c));
    // A search narrows what is listed; it never adds a second copy of it.
    let shows = |e: &api::Summary| !searching || e.name.to_lowercase().contains(&needle);
    fn live_of(status: &str) -> &str {
        match status {
            "recording" | "replaying" => status,
            _ => "",
        }
    }

    // One tree: the root row, then every folder with its sub-folders and the
    // recordings it holds. Each recording appears exactly once, under the
    // folder it is filed in.
    let mut rows: Vec<FolderRow> = vec![FolderRow {
        id: s("all"),
        name: s("All recordings"),
        count: app.history.len() as i32,
        depth: 0,
        system: true,
        selected: app.active_folder.is_none(),
        tip: s("Clear the folder filter and show every recording"),
        ..Default::default()
    }];
    // Folders start closed, as in a file manager; a search opens what it found,
    // and the folder being shown is opened for you.
    let is_open = |folder: &api::Folder| {
        searching || app.expanded.contains(&folder.id) || app.active_folder.as_deref() == Some(folder.id.as_str())
    };
    let push_folder = |folder: &api::Folder, depth: i32, rows: &mut Vec<FolderRow>| {
        let expandable = !folder.children.is_empty() || folder.count > 0;
        let expanded = is_open(folder);
        rows.push(FolderRow {
            id: s(&folder.id),
            name: s(&folder.name),
            count: folder.count as i32,
            depth,
            system: folder.system,
            renamable: !folder.system,
            // The sidecar nests one level only, under a folder the user made.
            nestable: !folder.system && folder.parent.is_none(),
            // Shown on every folder the open flow is not already in — and only
            // while a flow is open, or every folder would offer to file a flow
            // that is not there.
            file_here: !app.recording && !app.busy && filed.as_deref().is_some_and(|f| f != folder.id),
            expandable,
            expanded,
            selected: app.active_folder.as_deref() == Some(folder.id.as_str()),
            tip: s(if folder.parent.is_some() {
                "Click to show only its recordings"
            } else {
                "Click to show only this folder"
            }),
            ..Default::default()
        });
        if !expanded {
            return;
        }
        let entries: Vec<&api::Summary> = app
            .history
            .iter()
            .filter(|e| e.folder.as_deref() == Some(folder.id.as_str()) && shows(e))
            .collect();
        // "empty" only when it is: during a search a folder can match by name
        // while none of its recordings do, and it is not empty then.
        if entries.is_empty() && folder.children.is_empty() && folder.count == 0 {
            rows.push(FolderRow { depth: depth + 1, empty_marker: true, ..Default::default() });
        }
        for e in entries {
            rows.push(FolderRow {
                name: s(&e.name),
                depth: depth + 1,
                // What the flat list used to show beside each recording: when
                // it was captured, how long it is, and how often it has run.
                tip: s(format!(
                    "{}{}{}",
                    api::relative_time(e.created_at),
                    if e.step_count > 0 { format!(" · {} steps", e.step_count) } else { String::new() },
                    if e.run_count > 0 { format!(" · {} runs", e.run_count) } else { String::new() },
                )),
                is_recording: true,
                recording_id: s(&e.id),
                live: s(live_of(&e.status)),
                selected: open_id == Some(e.id.as_str()),
                ..Default::default()
            });
        }
    };
    // With a folder selected the tree shows that folder and its sub-folders
    // only — the contents of the folder, the way a file manager behaves — and
    // the root row is the way back.
    let scope = app.active_folder.as_deref().and_then(|id| {
        app.folders.iter().find_map(|f| {
            if f.id == id {
                Some(f)
            } else {
                f.children.iter().find(|c| c.id == id)
            }
        })
    });
    match &scope {
        Some(folder) => {
            push_folder(folder, 0, &mut rows);
            if is_open(folder) {
                for child in &folder.children {
                    push_folder(child, 1, &mut rows);
                }
            }
        }
        None => {
            for folder in &app.folders {
                if searching && !matches(folder) {
                    continue;
                }
                push_folder(folder, 0, &mut rows);
                // A collapsed folder hides its sub-folders as well.
                if !is_open(folder) {
                    continue;
                }
                for child in &folder.children {
                    if searching && !matches(child) {
                        continue;
                    }
                    push_folder(child, 1, &mut rows);
                }
            }
        }
    }
    sync_rows(w.get_folders(), rows, |m| w.set_folders(m));
    w.set_folder_draft_open(app.folder_draft.is_some());
    w.set_folder_draft_renaming(app.folder_draft.as_ref().map(|d| d.id.is_some()).unwrap_or(false));
    let draft_name = app.folder_draft.as_ref().map(|d| d.name.clone()).unwrap_or_default();
    if w.get_folder_draft_name() != draft_name.as_str() {
        w.set_folder_draft_name(s(draft_name));
    }
}

fn steps(app: &RecordApp, w: &AppWindow) {
    let locked = app.recording || app.busy;
    let selected = app.selected.as_ref().map(|p| p.index);
    let rows: Vec<StepRow> = app
        .steps()
        .iter()
        .map(|step| {
            let spec = api::action_for(&step.kind).unwrap_or(&api::ACTIONS[0]);
            let ways = step.candidates.len();
            let fallbacks: Vec<String> = step.candidates.iter().skip(1).map(|c| c.describe()).collect();
            StepRow {
                index: step.index as i32,
                kind: s(&step.kind),
                action_index: action_index(&step.kind),
                editable: api::is_editable(&step.kind),
                needs_value: spec.needs_value,
                value_label: s(spec.value_label),
                value: s(step.literal_value()),
                is_check: step.kind.starts_with("assert"),
                matched: spec.matched,
                match_index: api::match_index(step.match_mode()),
                is_param: step.is_param(),
                param: s(step.param_name()),
                secret: step.secret,
                secret_stored: step.secret_stored,
                phrase: s(step.phrase()),
                target: s(step.target()),
                ways: s(match (ways > 1, step.optional) {
                    (true, true) => format!("· {ways} ways to find this · can be skipped"),
                    (true, false) => format!("· {ways} ways to find this"),
                    (false, true) => "· can be skipped".to_string(),
                    (false, false) => String::new(),
                }),
                ways_tip: s(if fallbacks.is_empty() {
                    String::new()
                } else {
                    format!("{ways} ways to find this:\n\n{}", fallbacks.join("\n\n"))
                }),
                edited: step.edited,
                status: s(match step.status.as_str() {
                    "passed" | "failed" | "running" | "skipped" => step.status.as_str(),
                    _ => "",
                }),
                selected: selected == Some(step.index),
                in_subflow: app
                    .subflow_draft
                    .as_ref()
                    .map(|d| step.index >= d.from && step.index <= d.to)
                    .unwrap_or(false),
                scope: s(step.scope_note()),
            }
        })
        .collect();
    sync_rows(w.get_steps(), rows, |m| w.set_steps(m));
    w.set_action_labels(model(api::ACTIONS.iter().map(|a| s(a.label)).collect()));
    w.set_match_labels(model(api::MATCH_MODES.iter().map(|(_, l)| s(*l)).collect()));
    w.set_locked(locked);

    let insert = match &app.insert {
        Some(d) => {
            let action = api::action_for(&d.action);
            let needs_target = action.map(|a| a.needs_target).unwrap_or(false);
            let needs_value = action.map(|a| a.needs_value).unwrap_or(false);
            InsertState {
                open: true,
                at: d.at as i32,
                position: s(position_of(d.at)),
                action_index: action_index(&d.action),
                needs_target,
                needs_value,
                value_label: s(action.map(|a| a.value_label).unwrap_or("Value")),
                target_label: s(if d.action.starts_with("assert") { "What to check" } else { "What to act on" }),
                matched: action.map(|a| a.matched).unwrap_or(false),
                match_index: api::match_index(&d.match_mode),
                label: s(&d.label),
                value: s(&d.value),
                param: s(&d.param),
                recording: d.recording,
                capturing: d.recording && app.busy,
                ready: (!needs_target || !d.label.trim().is_empty())
                    && (!needs_value || !d.value.trim().is_empty())
                    && !app.busy,
            }
        }
        None => InsertState::default(),
    };
    w.set_insert(insert);
    w.set_subflow_pick_open(app.subflow_pick.is_some());
    w.set_subflow_pick_at(app.subflow_pick.unwrap_or(0) as i32);
    w.set_subflow_pick_position(s(position_of(app.subflow_pick.unwrap_or(1))));
    w.set_subflows(model(
        app.subflows
            .iter()
            .map(|sf| SubflowRow { id: s(&sf.id), label: s(format!("{} · {} steps", sf.name, sf.step_count)) })
            .collect(),
    ));
    match &app.subflow_draft {
        Some(d) => {
            w.set_subflow_range(s(format!("Steps {}–{} selected", d.from, d.to)));
            w.set_subflow_count((d.to - d.from + 1) as i32);
            if w.get_subflow_name() != d.name.as_str() {
                w.set_subflow_name(s(&d.name));
            }
        }
        None => {
            w.set_subflow_range(s(""));
            w.set_subflow_count(0);
        }
    }
}

fn step_panel(app: &mut RecordApp, w: &AppWindow) {
    let Some(panel) = &app.selected else {
        w.set_panel_open(false);
        return;
    };
    // Cloned: the panel writes back its field seed into `app` below, which a
    // borrow of the step list would forbid.
    let Some(step) = app.steps().iter().find(|s| s.index == panel.index).cloned() else {
        w.set_panel_open(false);
        return;
    };
    let step = &step;
    let index_changed = w.get_panel_index() != step.index as i32 || !w.get_panel_open();
    w.set_panel_open(true);
    w.set_panel_index(step.index as i32);
    w.set_panel_phrase(s(step.phrase()));
    w.set_panel_tab(panel.tab.index());
    w.set_panel_editable(api::is_editable(&step.kind) && !app.recording && !app.busy);
    let spec = api::action_for(&step.kind).unwrap_or(&api::ACTIONS[0]);
    w.set_panel_action_index(action_index(&step.kind));
    w.set_panel_needs_value(spec.needs_value);
    w.set_panel_value_label(s(spec.value_label));
    w.set_panel_matched(spec.matched);
    w.set_panel_optional(step.optional);
    w.set_panel_match_index(api::match_index(step.match_mode()));
    // The editable fields are re-seeded only when another step is opened or
    // the step's stored value changed (a save, an edit elsewhere) — never on an
    // unrelated render, which would wipe what the user is typing.
    let seed = (step.index, step.literal_value(), step.param_name());
    if index_changed || app.panel_seed.as_ref() != Some(&seed) {
        w.set_panel_value(s(&seed.1));
        w.set_panel_param(s(&seed.2));
        app.panel_seed = Some(seed);
    }
    if index_changed {
        w.set_panel_new_secret(s(""));
    }
    w.set_panel_is_param(step.is_param());
    w.set_panel_secret(step.secret);
    w.set_panel_secret_stored(step.secret_stored);
    w.set_panel_is_upload(step.kind == "upload");
    let file = step.file.clone().unwrap_or_default();
    let missing = file.source.is_empty()
        || (file.source == "stored" && (file.files.is_empty() || file.files.iter().any(|f| f.missing)));
    w.set_panel_file_text(s(if file.source.is_empty() { "no file chosen".to_string() } else { file.describe() }));
    w.set_panel_file_missing(missing);
    w.set_panel_file_sample(s(if file.source == "sample" { file.sample.clone().unwrap_or_default() } else { String::new() }));
    w.set_panel_dialogs(model(step.dialog_notes().into_iter().map(s).collect()));
    w.set_panel_target(s(step.target()));
    w.set_panel_scope(s(step.scope_note()));

    let mut outcome = Vec::new();
    match step.status.as_str() {
        "passed" => outcome.push(line("Last run: passed", "ok", false)),
        // Not run: the step is marked "can be skipped" and its element was
        // not on the page. The reason travels in `error`.
        "skipped" => {
            outcome.push(line("Last run: skipped", "dim", false));
            if let Some(why) = &step.error {
                outcome.push(line(why, "dim", false));
            }
        }
        "failed" => {
            outcome.push(line("Last run: failed", "danger", false));
            match step.failure_kind.as_deref() {
                Some("locator-timeout") => {
                    outcome.push(line("Every locator was given 30s and none matched.", "danger", false))
                }
                // The element was there; the page showed something else. The
                // fix is in the app under test or the expected value, not the
                // locators.
                Some("assertion-failed") => {
                    outcome.push(line("The check failed: the page did not show what was expected.", "danger", false))
                }
                _ => {}
            }
            if let Some(err) = &step.error {
                outcome.push(line(err, "danger", false));
            }
        }
        _ => {}
    }
    if let Some(found) = &step.resolved_locator {
        let fallback = step.candidates.first().map(|c| c != found).unwrap_or(false);
        let waited = step.locator_wait_ms.unwrap_or(0.0) / 1000.0;
        outcome.push(line(
            format!(
                "{} {} after {:.0}s",
                if fallback { "Fell back to" } else { "Found by" },
                found.describe(),
                waited
            ),
            if fallback { "accent" } else { "dim" },
            true,
        ));
    }
    w.set_panel_outcome(model(outcome));

    // Locators: the saved ladder, or the one being edited.
    let editing = panel.locators.is_some();
    let ladder: Vec<api::Candidate> = panel.locators.clone().unwrap_or_else(|| step.candidates.clone());
    let rows: Vec<LocatorRow> = ladder
        .iter()
        .enumerate()
        .map(|(n, c)| {
            let used = !editing && step.resolved_locator.as_ref() == Some(c);
            LocatorRow {
                mark: s(if used { "✓".to_string() } else { format!("{}.", n + 1) }),
                text: s(c.describe()),
                used,
                strategy_index: strategy_index(&c.strategy),
                role: s(c.role.clone().unwrap_or_default()),
                name: s(c.name.clone().unwrap_or_default()),
                value: s(c.value.clone().unwrap_or_default()),
                is_role: c.strategy == "role",
            }
        })
        .collect();
    // While editing, typing into a rung updates Rust's copy only (see
    // wire::rung) so the field keeps its caret. The rows are rebuilt when the
    // ladder's *shape* changes — a rung moved, added, removed, or switched
    // strategy — or when it is not being edited at all.
    let order: Vec<String> = ladder.iter().map(|c| c.strategy.clone()).collect();
    let shape = format!("{}:{}:{}", step.index, editing, order.join(","));
    let structural = app.ladder_shape.as_deref() != Some(shape.as_str()) || app.ladder_moved;
    if !editing || index_changed || structural {
        w.set_panel_locators(model(rows));
        app.ladder_shape = Some(shape);
        app.ladder_moved = false;
    }
    w.set_panel_editing_locators(editing);
    let n = step.candidates.len();
    w.set_panel_locator_summary(s(format!("{n} way{} to find this, tried in order", plural(n))));
    w.set_strategies(model(STRATEGIES.iter().map(|x| s(*x)).collect()));
    w.set_panel_raw(model(
        step.candidates
            .iter()
            .enumerate()
            .map(|(n, c)| LocatorRow {
                mark: s(format!("{} · {}", n + 1, c.strategy)),
                text: s(locator_source(c)),
                used: step.resolved_locator.as_ref() == Some(c),
                ..Default::default()
            })
            .collect(),
    ));
}

/// A rung as Playwright source, the way the generated spec writes it.
fn locator_source(c: &api::Candidate) -> String {
    let q = |v: &str| serde_json::to_string(v).unwrap_or_default();
    let value = c.value.clone().unwrap_or_default();
    match c.strategy.as_str() {
        "role" => {
            let role = c.role.clone().unwrap_or_default();
            let name = c.name.clone().unwrap_or_default();
            if name.is_empty() {
                format!("page.getByRole({})", q(&role))
            } else {
                format!("page.getByRole({}, {{ name: {}, exact: true }})", q(&role), q(&name))
            }
        }
        "testId" => format!("page.getByTestId({})", q(&value)),
        "label" => format!("page.getByLabel({}, {{ exact: true }})", q(&value)),
        "placeholder" => format!("page.getByPlaceholder({}, {{ exact: true }})", q(&value)),
        "text" => format!("page.getByText({}, {{ exact: true }})", q(&value)),
        "altText" => format!("page.getByAltText({}, {{ exact: true }})", q(&value)),
        "xpath" => format!("page.locator({})", q(&format!("xpath={value}"))),
        _ => format!("page.locator({})", q(&value)),
    }
}

fn runs(app: &RecordApp, w: &AppWindow) {
    let Some(session) = &app.session else {
        w.set_runs(model(Vec::new()));
        w.set_run_open(false);
        return;
    };
    let rows: Vec<RunRow> = session
        .runs
        .iter()
        .map(|run| {
            let badge = match run.status.as_str() {
                "passed" | "failed" | "cancelled" => run.status.as_str(),
                other => other,
            };
            let when = run.finished_at.map(|at| api::relative_time(at as i64)).unwrap_or_else(|| "in progress".into());
            let label = if run.failed > 0 {
                format!("{badge} · {} passed, {} failed of {} · {when}", run.passed, run.failed, run.total)
            } else {
                format!("{badge} · {}/{} · {when}", run.passed, run.total)
            };
            RunRow {
                id: s(&run.id),
                label: s(label),
                status: s(&run.status),
                duration: s(format!("{}s", run.duration_s())),
                dataset: s(run.dataset.iter().map(|e| format!("{}={}", e.name, e.value)).collect::<Vec<_>>().join("  ")),
                failure: s(run
                    .steps
                    .iter()
                    .find(|st| st.status == "failed")
                    .map(|st| format!("step {}: {}", st.index, st.error.as_deref().unwrap_or("failed")))
                    .unwrap_or_default()),
                selected: app.open_run.as_deref() == Some(run.id.as_str()),
            }
        })
        .collect();
    w.set_runs(model(rows));

    let Some(run) = session.runs.iter().find(|r| app.open_run.as_deref() == Some(r.id.as_str())) else {
        w.set_run_open(false);
        return;
    };
    w.set_run_open(true);
    w.set_run_status(s(&run.status));
    w.set_run_badge(s(match run.status.as_str() {
        "cancelled" => "stopped",
        other => other,
    }));
    w.set_run_duration(s(format!("{}s", run.duration_s())));
    w.set_run_summary(s(if run.skipped > 0 {
        format!("{} of {} passed, {} skipped", run.passed, run.total, run.skipped)
    } else {
        format!("{} of {} passed", run.passed, run.total)
    }));
    // A value set for this run, rather than the one recorded, is marked: it is
    // the difference between this run and a plain replay.
    w.set_run_dataset(model(
        run.dataset
            .iter()
            .map(|e| s(if e.overridden { format!("{} = {}  (set for this run)", e.name, e.value) } else { format!("{} = {}", e.name, e.value) }))
            .collect(),
    ));
    let shots = run.shots();
    let steps: Vec<RunStepRow> = run
        .steps
        .iter()
        .map(|st| {
            let note = st.locator_note();
            let (has_shot, image, position) = if st.is_asked_for_shot() {
                let url = api::shot_url(&session.id, st.shot.as_deref().unwrap_or_default());
                let image = app.shots.get(&url).and_then(|b| b.clone()).map(Image::from_rgba8);
                let position = shots.iter().position(|x| x.index == st.index).unwrap_or(0) as i32;
                (image.is_some(), image.unwrap_or_default(), position)
            } else {
                (false, Image::default(), 0)
            };
            RunStepRow {
                index: st.index as i32,
                name: s(st.name()),
                status: s(&st.status),
                duration: s(format!("{}ms", st.duration_ms.unwrap_or(0.0) as i64)),
                note_is_fallback: st.locator_rung.unwrap_or(0) > 0,
                note: s(if note.is_empty() { String::new() } else { format!("{note} · {}", st.locator_source()) }),
                uploaded: s(st.uploaded.as_ref().filter(|f| !f.is_empty()).map(|f| format!("uploaded {}", f.join(", "))).unwrap_or_default()),
                error: s(st.error.clone().unwrap_or_default()),
                has_shot,
                shot: image,
                shot_position: position,
            }
        })
        .collect();
    w.set_run_steps(model(steps));
}

/// Screenshot URLs the open run needs, so they can be fetched once.
pub fn wanted_shots(app: &RecordApp) -> Vec<String> {
    let Some(session) = &app.session else { return Vec::new() };
    let Some(run) = session.runs.iter().find(|r| app.open_run.as_deref() == Some(r.id.as_str())) else {
        return Vec::new();
    };
    run.shots()
        .iter()
        .filter_map(|st| st.shot.as_deref())
        .map(|file| api::shot_url(&session.id, file))
        .collect()
}

fn dataset(app: &RecordApp, w: &AppWindow) {
    let params = app.session.as_ref().map(|s| s.params()).unwrap_or_default();
    let rows: Vec<ParamRow> = params
        .iter()
        .map(|p| ParamRow {
            name: s(&p.name),
            value: s(app.dataset.values.iter().find(|(n, _)| *n == p.name).map(|(_, v)| v.clone()).unwrap_or_default()),
            recorded: s(&p.recorded),
        })
        .collect();
    // Replaced only when the parameter list itself changes, so typing into a
    // value is not interrupted by a re-render.
    let names_changed = w.get_params().row_count() != rows.len()
        || (0..rows.len()).any(|i| w.get_params().row_data(i).map(|r| r.name != rows[i].name).unwrap_or(true));
    if names_changed {
        w.set_params(model(rows));
    }
    let overrides = app.dataset.values.iter().filter(|(_, v)| !v.trim().is_empty()).count();
    w.set_dataset_replay_label(s(if overrides == 0 {
        "Replay as recorded".to_string()
    } else {
        format!("Replay with {overrides} override{}", plural(overrides))
    }));
}

fn shot_viewer(app: &RecordApp, w: &AppWindow) {
    let Some(position) = app.shot_view else {
        w.set_shot_open(false);
        return;
    };
    let Some(session) = &app.session else {
        w.set_shot_open(false);
        return;
    };
    let Some(run) = session.runs.iter().find(|r| app.open_run.as_deref() == Some(r.id.as_str())) else {
        w.set_shot_open(false);
        return;
    };
    let shots = run.shots();
    if shots.is_empty() {
        w.set_shot_open(false);
        return;
    }
    let at = position.min(shots.len() - 1);
    let step = shots[at];
    let url = api::shot_url(&session.id, step.shot.as_deref().unwrap_or_default());
    let image = app.shots.get(&url).and_then(|b| b.clone()).map(Image::from_rgba8);
    w.set_shot_open(true);
    w.set_shot_title(s(format!("Step {}", step.index)));
    w.set_shot_caption(s(step.name()));
    w.set_shot_loading(image.is_none());
    w.set_shot_image(image.unwrap_or_default());
    w.set_shot_can_prev(at > 0);
    w.set_shot_can_next(at + 1 < shots.len());
    w.set_shot_counter(s(format!("{} of {}", at + 1, shots.len())));
}
