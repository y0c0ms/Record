// What a hand-edited locator ladder is allowed to contain.
//
// The locator editor lets a user rewrite a step's whole chain of selectors, and
// the one mistake worth refusing is a rung with nothing in it: replay waits out
// that rung's full share of the budget on it and then fails anyway, so it costs
// a run real seconds and can still break a step whose other rungs were fine.
// These checks pin exactly which rungs count as empty, because "empty" is
// subtler than "has no value" — an unnamed role rung is a deliberate way of
// saying "the only button on the page".
//
// The rule is mirrored from `api::Candidate::is_empty` rather than imported:
// the crate is binary-only, so an integration test cannot name it. The
// behaviour that matters is the rule, and it is stated here in full.

// A rung as the editor holds it: a strategy plus whichever of the three
// describing fields that strategy uses.
#[derive(Debug, Default, Clone)]
struct Rung {
    strategy: String,
    value: Option<String>,
    role: Option<String>,
    name: Option<String>,
}

impl Rung {
    fn of(strategy: &str, value: &str) -> Self {
        Rung {
            strategy: strategy.into(),
            value: Some(value.into()),
            ..Default::default()
        }
    }

    fn nothing(strategy: &str) -> Self {
        Rung {
            strategy: strategy.into(),
            ..Default::default()
        }
    }

    fn role(role: &str, name: &str) -> Self {
        Rung {
            strategy: "role".into(),
            role: Some(role.into()),
            name: Some(name.into()),
            value: None,
        }
    }

    /// Mirrors `api::Candidate::is_empty`.
    fn is_empty(&self) -> bool {
        let value = self.value.as_deref().unwrap_or_default().trim();
        if !value.is_empty() {
            return false;
        }
        if self.strategy == "role" {
            let role = self.role.as_deref().unwrap_or_default().trim();
            let name = self.name.as_deref().unwrap_or_default().trim();
            return role.is_empty() && name.is_empty();
        }
        true
    }
}

#[test]
fn a_rung_with_a_selector_is_never_empty() {
    for c in [
        Rung::of("css", "#login > input"),
        Rung::of("xpath", "/html/body/main/form/input[2]"),
        Rung::of("label", "Password"),
        Rung::of("testId", "nav-alpha"),
        Rung::of("text", "Alpha"),
        Rung::of("altText", "A picture"),
        Rung::of("placeholder", "Search"),
    ] {
        assert!(!c.is_empty(), "{} with a selector read as empty", c.strategy);
    }
}

#[test]
fn a_rung_with_no_selector_is_empty() {
    for c in [Rung::of("css", ""), Rung::nothing("css"), Rung::nothing("xpath")] {
        assert!(c.is_empty(), "{} with nothing read as filled", c.strategy);
    }
}

/// Whitespace is what a half-finished edit looks like, and it finds nothing
/// just as surely as an empty box does.
#[test]
fn whitespace_only_is_empty() {
    assert!(Rung::of("css", "   ").is_empty());
    assert!(Rung::of("css", "\t\n ").is_empty());
    assert!(!Rung::of("css", " #login ").is_empty());
}

/// The ladder deliberately contains a nameless role rung — "any link" — because
/// on a page with exactly one link that is a *good* locator. Reading it as
/// empty would make every recorded link refuse to save.
#[test]
fn an_unnamed_role_rung_is_never_empty() {
    for c in [
        Rung::role("textbox", "Password"),
        Rung::role("link", ""),
        Rung::role("", "Save"),
    ] {
        assert!(!c.is_empty(), "role {:?}/{:?} read as empty", c.role, c.name);
    }
}

#[test]
fn a_role_rung_with_nothing_at_all_is_empty() {
    assert!(Rung::role("", "").is_empty());
    assert!(Rung::nothing("role").is_empty());
}

/// A role rung is spelled with `role` and `name`, never `value` — the editor
/// clears the other fields when the strategy is switched. So a stray `value` on
/// a role rung is not a state the editor can produce, and the rule only has to
/// answer for rungs that are spelled correctly.
#[test]
fn a_role_rung_is_judged_on_role_and_name() {
    let stray = Rung {
        strategy: "role".into(),
        value: Some("textbox".into()),
        role: None,
        name: None,
    };
    assert!(!stray.is_empty(), "a value is present, so this rung is not blank");
    assert!(Rung::nothing("role").is_empty());
}

/// A rung that is *not* the first does not need a selector to be legal either —
/// the cap and the ordering are the editor's business, and an empty rung in the
/// middle is the exact case that has to be caught.
#[test]
fn an_empty_rung_anywhere_in_a_ladder_is_found() {
    let ladder = vec![
        Rung::role("textbox", "Password"),
        Rung::of("label", "Password"),
        Rung::nothing("css"),
        Rung::of("xpath", "//*[@id='q']"),
    ];
    let bad = ladder.iter().position(|c| c.is_empty());
    assert_eq!(bad, Some(2), "expected the empty rung at index 2, got {bad:?}");
}
