// Browser-side recorder. Injected into every frame of the recording Edge context
// via context.addInitScript({ path }) so it survives full page loads and popups.
//
// Emits normalized step descriptors through the exposed Playwright binding
// `window.__recordEmit`. Locator *computation* lives here (it needs DOM access);
// converting a descriptor to a Playwright locator lives in src/locator.js.

(() => {
  // Installed once per *document*, not per window. An editor that builds its
  // canvas with `document.open()`/`write()` (WordPress' block editor does)
  // replaces the document but keeps the window — a window-level flag then said
  // "already installed" while every listener was gone with the old document,
  // so nothing typed into the canvas was recorded.
  if (document.__recordInstalled) return;
  document.__recordInstalled = true;

  // Every frame is instrumented, so a form inside an iframe is recorded too.
  // Which frame an action came from is worked out Node-side, from the binding's
  // source frame — a page cannot reliably name its own iframe, and cannot see
  // it at all across origins. Only the top frame tracks navigation and paints
  // the badge: a frame's own history is not a step a person took.
  const TOP = window.top === window.self;

  const IGNORE = '[data-record-ignore]';

  // Third-party consent/dialog widgets (cookie banners, chat bubbles, A/B
  // overlays) are chrome, not user intent. Recording them produces steps that
  // can never replay on another visit, so drop them by well-known vendor id or
  // by role.
  const NOISE = [
    /usercentrics/i,
    /cookiebot/i,
    /onetrust/i,
    /cookie[-_]?consent/i,
    /cookie[-_]?banner/i,
    /cmp[-_]?container/i,
    /hubspot/i,
    /intercom/i,
    /drift[-_]?frame/i,
    /zsiq/i,
    /liveperson/i,
    // Google Funding Choices consent (fc-consent-root, fc-dialog-container),
    // matched as a whole class token wherever it sits in the class list.
    /(^|\s)fc-(consent|dialog)/i,
    /qc-cmp/i,
    /truste|trustarc/i,
    /didomi/i,
  ];
  // A dialog on its own is not noise: an application's modal — the WordPress
  // editor's welcome guide, a Salesforce record dialog, a "confirm delete"
  // sheet — is where a user does real work, and dropping clicks there produced
  // flows that replayed straight into a dialog that was never closed. Only a
  // dialog that belongs to a known consent/chat vendor is noise; the vendor
  // patterns above decide that, wherever in the dialog the click landed.
  const isNoise = (el) => {
    if (!el || el.nodeType !== 1) return false;
    // Walked up across shadow roots: Usercentrics renders its banner inside
    // the shadow root of <aside id="usercentrics-cmp-ui">, so stopping at the
    // root never reached the vendor's id and "Rejeitar tudo" was recorded as a
    // step — one that replay can never perform, because replay sweeps the
    // same banner away before it is reached.
    const up = (node) => node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    for (let node = el; node && node.nodeType === 1; node = up(node)) {
      const id = node.id || '';
      const cls = typeof node.className === 'string' ? node.className : '';
      for (const re of NOISE) {
        if (re.test(id) || re.test(cls)) return true;
      }
    }
    return false;
  };

  const lastValue = new WeakMap();
  const fillTimers = new WeakMap();
  // An editable's accessible name as it was before the user typed into it.
  const nameBeforeTyping = new WeakMap();

  const emit = (step) => {
    try {
      const r = window.__recordEmit(step);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (_) {}
  };

  // What the element says, in the case its source has. `innerText` is what is
  // on screen, so it skips hidden text — but it also applies CSS
  // `text-transform`, and a menu styled in capitals ("INVESTIDOR") has the
  // DOM text "Investidor". Locators match the DOM text, so a recorded
  // "INVESTIDOR" found nothing at replay and every such step waited out its
  // full timeout. When the two agree apart from case, the DOM's case wins.
  const text = (el) => {
    const shown = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const source = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!shown) return source;
    return shown !== source && shown.toLowerCase() === source.toLowerCase() ? source : shown;
  };

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const t = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map(text)
        .join(' ');
      // Frameworks label a whole list row by every text in it — dates, status,
      // the "not selected" hint in the user's language. That name changes with
      // the row's state and the browser's locale, so a long one is not kept as
      // an exact-match locator.
      if (t.trim() && t.trim().length <= 80) return t.trim();
    }
    if (/^(button|a|summary)$/i.test(el.tagName)) {
      const t = text(el);
      if (t && t.length <= 80) return t;
    }
    if (/^(input|select|textarea)$/i.test(el.tagName) && el.labels && el.labels.length) {
      const t = Array.from(el.labels).map(text).join(' ').trim();
      if (t) return t;
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    return '';
  };

  const implicitRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (['number', 'range'].includes(t)) return 'spinbutton';
      if (['email', 'tel', 'url', 'text', ''].includes(t)) return 'textbox';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'img') return 'img';
    if (tag === 'table') return 'table';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    return '';
  };

  // Whether `el` is the only visible element with this role in its document or
  // shadow root. A role locator with no name means exactly that, so it is only
  // recorded when it is true now. Checked by a cheap tag/attribute pre-filter
  // and implicitRole, not a full accessibility walk.
  const onlyOfRole = (el, role) => {
    const root = el.getRootNode();
    const scope = root && root.querySelectorAll ? root : document;
    let seen = 0;
    for (const other of scope.querySelectorAll(`[role], ${el.tagName.toLowerCase()}`)) {
      if (implicitRole(other) !== role) continue;
      if (!(other.offsetWidth || other.offsetHeight || other.getClientRects().length)) continue;
      if (++seen > 1) return false;
    }
    return true;
  };

  // The parent of `node`, stepping out of a shadow root when the walk reaches
  // the top of one. `parentElement` alone stops dead at a shadow boundary,
  // because the parent of a shadow root's child is the ShadowRoot, not an
  // element — so a path built from it describes an element inside a shadow
  // root as though that root were the whole document. For a nested tree
  // (xweb-shellbar -> xweb-utility-links -> xweb-proxy-now) the path collapsed
  // to the bare tag of the innermost element, which matches every element of
  // that tag on the page.
  const parentAcrossShadow = (node) => {
    if (node.parentElement) return { node: node.parentElement, crossed: false };
    const root = node.getRootNode();
    if (root && root.host) return { node: root.host, crossed: true };
    return null;
  };

  // An id identifies an element only when no other element in the same root
  // carries it. Duplicate ids are invalid HTML and common anyway — a form
  // template copied twice, a component rendered in two places — and trusting
  // one made every structural rung of the ladder match two elements at once.
  const uniqueId = (node) => {
    if (!node.id || !/^[A-Za-z][\w-]*$/.test(node.id)) return false;
    const root = node.getRootNode();
    const scope = root && root.querySelectorAll ? root : document;
    return scope.querySelectorAll(`[id="${node.id}"]`).length === 1;
  };

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (uniqueId(node)) {
        parts.unshift({ sel: `#${node.id}`, cross: false });
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift({ sel: part, cross: false });
      const up = parentAcrossShadow(node);
      if (!up) break;
      // A shadow boundary takes a descendant combinator, not a child one:
      // Playwright's css engine pierces a shadow root for `a b` and refuses
      // `a > b`, so `>` across a boundary matches nothing at all.
      if (up.crossed) parts[0].cross = true;
      node = up.node;
      if (node === document.body) break;
    }
    return parts.map((p, i) => (i === 0 ? p.sel : (p.cross ? ' ' : ' > ') + p.sel)).join('');
  };

  // XPath is the fallback locator family: brittle by nature, but the one
  // strategy that survives DOM churn that breaks role/label/testId.
  const xpathOf = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (uniqueId(el)) return `//*[@id="${el.id}"]`;

    const parts = [];
    let node = el;
    // Walk up to <html>, collecting one step per element. The walk stops at
    // documentElement, so `html` itself is added below and every path ends up
    // absolute — an xpath handed to Playwright has to start at the document
    // root, and a relative `body/...` matches nothing at all.
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      // An id anywhere on the way up makes the whole prefix collapse to a single
      // lookup, which survives far more DOM churn than a positional path.
      if (uniqueId(node)) {
        parts.unshift(`//*[@id="${node.id}"]`);
        return parts.length > 1 ? parts.join('/') : parts[0];
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        // Only positional predicates where the tag actually repeats: `a[2]`
        // where two `a`s are siblings, plain `a` where there is only one.
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        parts.unshift(same.length > 1 ? `${tag}[${same.indexOf(node) + 1}]` : tag);
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    if (!parts.length) return null;
    return `/html/${parts.join('/')}`;
  };

  // Every element step carries an ordered chain of locators, most reliable
  // first. Replay walks the chain, so a richer chain is a longer runway before
  // a step fails — and the full xpath is always kept as the last rung, since it
  // is the only strategy that survives DOM churn.
  //
  // The ladder is capped rather than exhaustive: past about six candidates the
  // chains overlap enough that the extra entries cost recording time and spec
  // noise without meaningfully raising the chance of a hit.
  const MAX_CANDIDATES = 6;

  // Identity of a locator descriptor, so two spellings of the same target never
  // both occupy a rung of the chain.
  const locatorKeyOf = (d) =>
    `${d.strategy}:${d.strategy === 'role' ? `${d.role}/${d.name}` : d.value}`;

  const candidatesFor = (el) => {
    if (!el || el.nodeType !== 1) return [];
    const out = [];
    const push = (descriptor) => {
      if (!descriptor) return;
      // A role candidate carries `role`/`name` and no `value`, so the emptiness
      // check has to be per strategy: testing `value` alone would silently drop
      // every role rung from the chain.
      const empty =
        descriptor.strategy === 'role'
          ? !descriptor.role
          : descriptor.value === null || descriptor.value === undefined || descriptor.value === '';
      if (empty) return;
      const key = locatorKeyOf(descriptor);
      if (out.some((c) => locatorKeyOf(c) === key)) return;
      out.push(descriptor);
    };

    // Strongest first: things the page declares are meant to be found this way.
    // The attribute the value came from is recorded alongside it: `data-qa`
    // and `data-testid` mean the same thing to a person reading a test, but a
    // lookup that only ever checked `data-testid` would skip a locator that
    // came from `data-qa` and never resolve it.
    const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa'];
    const attr = TEST_ID_ATTRS.find((name) => el.getAttribute(name));
    const testId = attr ? el.getAttribute(attr) : null;
    if (testId) push({ strategy: 'testId', value: testId, attr });

    const role = implicitRole(el);
    const name = accessibleName(el);
    // A rich-text block's accessible name can describe its state rather than
    // the block — WordPress names an empty paragraph "Empty block; start
    // writing…" and the same paragraph "Block: Paragraph" once typed into — so
    // the recording sees one name and replay meets the other. The name the
    // block had before the first keystroke is remembered (`nameBeforeTyping`);
    // a name that changed with typing is not a locator. A fixed label ("Add
    // title") is the same before and after, and stays.
    const before = nameBeforeTyping.get(el);
    const nameIsState = before !== undefined && before !== name;
    if (role && role !== 'generic') {
      if (name && !nameIsState) push({ strategy: 'role', role, name });
      // A role with no accessible name still pins the element down when it is
      // the only one of its kind on the page — and only then. Kept for a row
      // that has siblings, it resolved at replay whenever the list happened to
      // hold one row (mid-filter, mid-load) and clicked that one, which is not
      // the record the recording opened.
      if (onlyOfRole(el, role)) push({ strategy: 'role', role, name: '' });
    }

    if (/^(input|select|textarea)$/i.test(el.tagName)) {
      if (name && el.labels && el.labels.length) push({ strategy: 'label', value: name });
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) push({ strategy: 'placeholder', value: placeholder });
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) push({ strategy: 'label', value: ariaLabel });
      // The field's `name` is what the server reads, so it is the most stable
      // thing about a form control: kept through redesigns that rename every
      // id and class. Used only when it picks out this one element.
      const fieldName = el.getAttribute('name');
      if (fieldName) {
        const tag = el.tagName.toLowerCase();
        const sel = `${tag}[name="${fieldName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
        const root = el.getRootNode();
        const scope = root && root.querySelectorAll ? root : document;
        // A radio group shares one name across its options, so the value is
        // what tells this option apart.
        const value = el.getAttribute('value');
        const exact = /^(radio|checkbox)$/i.test(el.type || '') && value
          ? `${sel}[value="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
          : sel;
        if (scope.querySelectorAll(exact).length === 1) push({ strategy: 'css', value: exact });
      }
    }

    if (/^(a|button|summary|option)$/i.test(el.tagName)) {
      const t = text(el);
      if (t && t.length <= 80) {
        push({ strategy: 'text', value: t });
        // The same words trimmed: a label with the site chrome around it often
        // matches nothing exactly but matches once the extra words go.
        const trimmed = t.replace(/\s+/g, ' ').trim();
        if (trimmed !== t) push({ strategy: 'text', value: trimmed });
      }
    }

    // A rich-text block's identity is its position among the editable blocks
    // of the editor — "the second editable region" — not its id, which an
    // editor regenerates (WordPress: `block-<uuid>` on every load) or its
    // accessible name, which flips from "Empty block…" to "Block: Paragraph"
    // the moment it is typed into. The recorder sees it after typing; replay
    // meets it empty.
    if (el.isContentEditable && !/^(input|textarea)$/i.test(el.tagName)) {
      const root = el.getRootNode();
      const scope = root && root.querySelectorAll ? root : document;
      // Counted exactly as Playwright's `nth` will count them at replay: every
      // element carrying the attribute, in document order.
      const editables = Array.from(scope.querySelectorAll('[contenteditable="true"]'));
      const at = editables.indexOf(el);
      if (at >= 0) push({ strategy: 'css', value: `[contenteditable="true"] >> nth=${at}` });
    }

    // A row in a list, table or grid — the thing a person clicks to open a
    // record — usually has no id worth keeping (UI5 and others generate
    // `__item0-__clone3`) and no short accessible name, so the ladder fell back
    // to its position: "the second row". That replays onto whatever record is
    // second today. Its most identifying line of text (an order number, a
    // name) pins down the record instead, as long as it is unique in the list.
    if (/^(li|tr)$/i.test(el.tagName) || /^(listitem|option|row|gridcell|treeitem)$/i.test(el.getAttribute('role') || '')) {
      const tag = el.tagName.toLowerCase();
      const lines = (el.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s.length >= 3 && s.length <= 60);
      const root = el.getRootNode();
      const scope = root && root.querySelectorAll ? root : document;
      const siblings = Array.from(scope.querySelectorAll(tag));
      // Prefer the line that looks most like a record identifier — "Order
      // 6858" over a date — by the length of its longest run of digits, then
      // any line that no other row of the same kind contains. Dates are never
      // used: two records share a day far too easily.
      const digits = (l) => Math.max(0, ...(l.match(/\d+/g) || []).map((d) => d.length));
      const dateLike = (l) => /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/.test(l);
      const ranked = lines.filter((l) => !dateLike(l)).sort((a, b) => digits(b) - digits(a));
      const unique = ranked.find((line) => siblings.filter((s) => (s.innerText || '').includes(line)).length === 1);
      if (unique) push({ strategy: 'css', value: `${tag}:has-text(${JSON.stringify(unique)})` });
    }

    const alt = el.getAttribute('alt');
    if (alt && /^(input|img)$/i.test(el.tagName)) push({ strategy: 'altText', value: alt });

    push({ strategy: 'css', value: cssPath(el) });

    // The full xpath is the last rung and is never dropped by the cap: it is the
    // only strategy that still resolves when the page's structure moves under a
    // step. The cap trims the middle of the ladder instead of the tail.
    //
    // It is left out entirely for an element inside a shadow root. Playwright's
    // xpath engine does not cross a shadow boundary, so the rung could never
    // resolve there — it would only spend its probe budget on every run before
    // the step failed for the real reason.
    if (el.getRootNode() !== document) return out.slice(0, MAX_CANDIDATES);
    const xpath = { strategy: 'xpath', value: xpathOf(el) };
    if (!xpath.value) return out.slice(0, MAX_CANDIDATES);
    const kept = out.slice(0, MAX_CANDIDATES - 1);
    const key = locatorKeyOf(xpath);
    if (!kept.some((c) => locatorKeyOf(c) === key)) kept.push(xpath);
    return kept;
  };

  // What the element *is*, independent of how it is found.
  //
  // Locators answer "where is it?"; a fingerprint answers "is this the same
  // thing?". Replay uses it to verify a match found by position — the fallback
  // that clicks whatever now sits where the element used to be — so a position
  // hit on a different control fails instead of passing on the wrong element.
  //
  // The box is relative to the nearest shadow host when there is one, so a
  // layout change elsewhere on the page does not move it; and the viewport is
  // kept so replay can reproduce the size the coordinates were taken at.
  const STABLE_ATTRS = ['type', 'name', 'title', 'aria-label', 'placeholder', 'href', 'value'];
  const fingerprintOf = (el) => {
    const rect = el.getBoundingClientRect();
    const root = el.getRootNode();
    const scope = root && root.host ? root.host : null;
    const scopeRect = scope ? scope.getBoundingClientRect() : null;
    const attrs = {};
    for (const name of STABLE_ATTRS) {
      const v = el.getAttribute(name);
      if (v !== null && v !== '' && String(v).length <= 120) attrs[name] = v;
    }
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || implicitRole(el) || '',
      name: (accessibleName(el) || '').slice(0, 120),
      text: text(el).slice(0, 120),
      attrs,
      // Centre of the element, in CSS pixels from the viewport's top-left.
      point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
      size: { w: Math.round(rect.width), h: Math.round(rect.height) },
      // Where in its shadow host the click landed, 0..1 on each axis. The only
      // handle on an element inside a closed shadow root.
      inHost: scopeRect && scopeRect.width && scopeRect.height
        ? {
            x: +((rect.left + rect.width / 2 - scopeRect.left) / scopeRect.width).toFixed(3),
            y: +((rect.top + rect.height / 2 - scopeRect.top) / scopeRect.height).toFixed(3),
          }
        : null,
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  };

  // The primary locator stays what the recorder considers best; candidates
  // carry the full fallback chain including XPath.
  const describeAll = (el) => {
    const candidates = candidatesFor(el);
    if (!candidates.length) return null;
    let fingerprint = null;
    try {
      fingerprint = fingerprintOf(el);
    } catch {
      // A fingerprint is a verification aid, never a reason to drop a step.
    }
    return { locator: candidates[0], candidates, fingerprint };
  };

  // Human-readable form of a locator descriptor, matching src/locator.js.
  const describeLocator = (locator) => {
    if (!locator) return '';
    if (locator.strategy === 'role') return `role=${locator.role} name="${locator.name}"`;
    return `${locator.strategy}=${locator.value}`;
  };

  // Step titles read best when they match the locator replay will use, so the
  // accessible name wins over raw inner text. Elements with no accessible name
  // (bare search inputs, icon buttons) fall back to their best locator, which
  // is far more useful than the bare tag name.
  const label = (el, found) => {
    const name = accessibleName(el);
    if (name) return name;
    const t = text(el);
    if (t && t.length <= 80) return t;
    const id = el.getAttribute('id');
    if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
    if (found && found.locator) return describeLocator(found.locator);
    return el.tagName.toLowerCase();
  };

  // The editable element a text event belongs to. Besides inputs and
  // textareas, rich editors (WordPress' block editor, Salesforce's rich text,
  // CKEditor, Notion-likes) are contenteditable regions — typing into them was
  // not recorded at all, so a flow that wrote a post replayed without its text.
  const editableRoot = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === 'TEXTAREA') return el;
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(t) ? null : el;
    }
    // The outermost contenteditable host, not the inline element under the
    // caret: a block is filled as a whole, the way a person thinks of it.
    if (!el.isContentEditable) return null;
    let host = el;
    while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
    return host;
  };
  const isTextEntry = (el) => editableRoot(el) === el;
  const editableValue = (el) =>
    el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA'
      ? (el.innerText || '').replace(/\u00a0/g, ' ').replace(/\n+$/, '')
      : el.value == null ? '' : String(el.value);

  const ignored = (node) => !!(node && node.closest && node.closest(IGNORE)) || isNoise(node);

  // The element an event was actually dispatched at.
  //
  // `event.target` is retargeted as an event crosses a shadow boundary: a click
  // on a button three shadow roots down arrives at a document-level listener
  // with `target` set to the outermost host. Recording that produced a step
  // that clicked the shell rather than the control inside it — the step passed,
  // on the wrong element. `composedPath()[0]` is the real target, and is the
  // only way to see past a shadow boundary from outside it.
  const realTarget = (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    const first = path && path.length ? path[0] : null;
    if (first && first.nodeType === 1) return first;
    // Older engines and synthetic events may not compose; the retargeted node
    // is still better than nothing.
    return event.target;
  };

  // ---- navigation (SPA) ----------------------------------------------------
  let lastNav = '';
  const nav = (kind) => {
    if (!TOP) return;
    const url = location.href;
    if (url === 'about:blank' || url === lastNav) return;
    lastNav = url;
    emit({ type: 'navigate', url, via: kind });
  };
  for (const fn of ['pushState', 'replaceState']) {
    const original = history[fn];
    history[fn] = function patched(...args) {
      const out = original.apply(this, args);
      nav('spa');
      return out;
    };
  }
  window.addEventListener('popstate', () => nav('spa'));
  window.addEventListener('hashchange', () => nav('spa'));

  // A real mouse click is dispatched at a coordinate, so `event.target` is
  // whatever element happened to be under the cursor — often a container such
  // as <body> when the pointer is over padding or between children, or the
  // <svg>/<path> of an icon inside a button. Walk up to the element that is
  // actually the control.
  //
  // A real control (button, link, form field) anywhere above wins over
  // anything below it: an icon font or inline svg carries `role="img"` or
  // `aria-hidden`, and stopping there recorded "click the picture" — a step
  // that, replayed, clicked a decorative node and let the button's handler
  // never run while reporting a pass.
  const CONTROL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox]';
  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role],label,[onclick],[tabindex]';
  const DECORATIVE_ROLE = /^(img|presentation|none|graphics-symbol|graphics-document)$/i;
  // `closest` stops at a shadow root, and a button's icon is often a component
  // of its own, so the walk continues through each host.
  const closestAcrossShadow = (node, selector) => {
    for (let at = node; at; ) {
      const hit = at.closest ? at.closest(selector) : null;
      if (hit) return hit;
      const root = at.getRootNode && at.getRootNode();
      at = root && root.host ? root.host : null;
    }
    return null;
  };
  const targetFor = (node) => {
    if (!node || node.nodeType !== 1) return null;
    const control = closestAcrossShadow(node, CONTROL);
    if (control) return control;
    let el = node;
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      const tag = el.tagName;
      const decorative =
        DECORATIVE_ROLE.test(el.getAttribute('role') || '') ||
        el.getAttribute('aria-hidden') === 'true' ||
        el.namespaceURI === 'http://www.w3.org/2000/svg';
      if (!decorative && el.matches(INTERACTIVE)) return el;
      // Elements that only contain text and no interactive descendants behave
      // like their label; keep them so clicking on a label still records.
      if (/^(label|span|p|strong|em|small|h[1-6])$/i.test(tag) && !el.querySelector(INTERACTIVE)) {
        return el;
      }
      el = el.parentElement;
    }
    return node;
  };

  // ---- checks (assertions) -------------------------------------------------
  // Armed from the badge. The next press on the page picks the element to
  // check instead of acting on it: the event is swallowed before the page sees
  // it, so choosing "the welcome message" cannot also submit a form the message
  // sits in. What is checked follows from the element — a field's value, a
  // checkbox's state, anything else's visible text — read as it is now, which
  // is what the user is pointing at and saying "this should be so".
  let assertArmed = false;
  let assertOutline = null;
  const assertKind = (el) => {
    if (el.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) return 'assertChecked';
    if (/^(checkbox|radio|switch)$/.test(el.getAttribute('role') || '')) return 'assertChecked';
    if (isTextEntry(el) || el.tagName === 'SELECT') return 'assertValue';
    return 'assertText';
  };
  const assertTarget = (node) => {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    // A field or checkbox is checked as the control, wherever inside it the
    // press landed; any other element is checked as what was pressed, because
    // walking up to a container would check a whole card instead of one line.
    const control = el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role=checkbox], [role=radio], [role=switch]');
    return control || el;
  };
  const armAssert = (on) => {
    assertArmed = on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on && assertOutline) {
      assertOutline.remove();
      assertOutline = null;
    }
    if (window.__recordAssertArmed) window.__recordAssertArmed(on);
  };
  document.addEventListener(
    'mousemove',
    (event) => {
      if (!assertArmed) return;
      const el = assertTarget(realTarget(event));
      if (!el || ignored(el)) return;
      if (!assertOutline) {
        assertOutline = document.createElement('div');
        assertOutline.setAttribute('data-record-ignore', '');
        assertOutline.style.cssText =
          'position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #22c55e;border-radius:3px;background:rgba(34,197,94,.08)';
        (document.body || document.documentElement).appendChild(assertOutline);
      }
      const r = el.getBoundingClientRect();
      Object.assign(assertOutline.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    },
    true
  );
  const swallow = (event) => {
    if (!assertArmed || ignored(realTarget(event))) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    document.addEventListener(type, swallow, true);
  }
  document.addEventListener(
    'click',
    (event) => {
      if (!swallow(event)) return;
      const pressed = realTarget(event);
      let el = assertTarget(pressed);
      // A label stands for its control: pointing at "I accept the terms" means
      // the checkbox, not the words.
      if (el && el.tagName === 'LABEL' && el.control) el = el.control;
      armAssert(false);
      if (!el) return;
      const found = describeAll(el);
      if (!found) return;
      const type = assertKind(el);
      let value;
      if (type === 'assertChecked') {
        // A click on a native checkbox flips `checked` before listeners run and
        // `preventDefault` flips it back after, so in here it reads the opposite
        // of what the user sees — unless the press landed on its label, which
        // never reached the box.
        const native = el.tagName === 'INPUT';
        const flipped = native && pressed === el;
        const on = native ? el.checked !== flipped : el.getAttribute('aria-checked') === 'true';
        value = on ? 'checked' : 'unchecked';
      } else if (type === 'assertValue') {
        value = el.tagName === 'SELECT' ? el.value : editableValue(el);
      } else {
        value = text(el);
        // A long block is checked by its opening words: a paragraph that gains
        // a sentence elsewhere is still the paragraph the user meant.
        if (value.length > 80) value = value.slice(0, 80).replace(/\s+\S*$/, '');
      }
      emit({
        type,
        locator: found.locator,
        candidates: found.candidates,
        fingerprint: found.fingerprint,
        value,
        // A field's value is compared whole; text is a "contains", because the
        // page around the words a person points at is free to change.
        match: type === 'assertValue' ? 'equals' : 'contains',
        label: label(el, found),
        url: location.href,
      });
    },
    true
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (assertArmed && event.key === 'Escape') armAssert(false);
    },
    true
  );

  // ---- clicks --------------------------------------------------------------
  document.addEventListener(
    'click',
    (event) => {
      if (ignored(realTarget(event))) return;
      const el = targetFor(realTarget(event));
      if (!el) return;
      const found = describeAll(el);
      if (!found) return;
      // A click that resolves all the way to <html> hit padding or empty space;
      // recording it would produce a step that can never be replayed.
      if (
        found.locator.strategy === 'css' &&
        /^(html|body)$/i.test(found.locator.value.split(' > ').pop())
      ) {
        return;
      }
      emit({
        type: 'click',
        locator: found.locator,
        candidates: found.candidates,
        fingerprint: found.fingerprint,
        label: label(el, found),
        url: location.href,
      });
    },
    true
  );

  // ---- text entry ----------------------------------------------------------
  const flushFill = (el) => {
    clearTimeout(fillTimers.get(el));
    fillTimers.delete(el);
    if (!isTextEntry(el)) return;
    const value = editableValue(el);
    if (value === '') return;
    if (lastValue.get(el) === value) return;
    lastValue.set(el, value);
    const found = describeAll(el);
    if (!found) return;
    emit({
      type: 'fill',
      locator: found.locator,
      candidates: found.candidates,
      fingerprint: found.fingerprint,
      value,
      label: label(el, found),
      secret: el.type === 'password',
      url: location.href,
    });
  };

  document.addEventListener(
    'beforeinput',
    (event) => {
      const el = editableRoot(realTarget(event));
      if (el && !nameBeforeTyping.has(el)) nameBeforeTyping.set(el, accessibleName(el));
    },
    true
  );
  document.addEventListener(
    'input',
    (event) => {
      const el = editableRoot(realTarget(event));
      if (!el || ignored(el)) return;
      clearTimeout(fillTimers.get(el));
      fillTimers.set(el, setTimeout(() => flushFill(el), 350));
    },
    true
  );
  document.addEventListener(
    'change',
    (event) => {
      const el = editableRoot(realTarget(event));
      if (!el || ignored(el)) return;
      flushFill(el);
    },
    true
  );
  document.addEventListener(
    'blur',
    (event) => {
      const el = editableRoot(realTarget(event));
      if (!el || ignored(el)) return;
      flushFill(el);
    },
    true
  );

  // ---- select --------------------------------------------------------------
  document.addEventListener(
    'change',
    (event) => {
      const el = realTarget(event);
      if (ignored(el) || el.tagName !== 'SELECT') return;
      const values = Array.from(el.selectedOptions || []).map((o) => o.value);
      if (!values.length) return;
      const found = describeAll(el);
      if (!found) return;
      emit({
        type: 'select',
        locator: found.locator,
        candidates: found.candidates,
        fingerprint: found.fingerprint,
        value: el.multiple ? values : values[0],
        label: label(el, found),
        url: location.href,
      });
    },
    true
  );

  // ---- file upload ---------------------------------------------------------
  // A page only ever sees a file's name, never where it came from, so the path
  // cannot be recorded — but the bytes can. They are sent Node-side and kept
  // with the flow, which is the only way a replay on another machine, or after
  // the file was moved, still has something to upload. Files past the cap are
  // recorded by name only and the replay asks for a file to be chosen, rather
  // than shipping hundreds of megabytes through a page binding.
  const UPLOAD_CAP = 25 * 1024 * 1024;
  const base64Of = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  };
  document.addEventListener(
    'change',
    async (event) => {
      const el = realTarget(event);
      if (ignored(el) || el.tagName !== 'INPUT' || (el.type || '').toLowerCase() !== 'file') return;
      const list = Array.from(el.files || []);
      if (!list.length) return;
      const found = describeAll(el);
      if (!found) return;
      const total = list.reduce((n, f) => n + f.size, 0);
      let files = list.map((f) => ({ name: f.name, type: f.type, size: f.size, data: null }));
      if (total <= UPLOAD_CAP) {
        try {
          files = await Promise.all(
            list.map(async (f) => ({ name: f.name, type: f.type, size: f.size, data: await base64Of(f) })),
          );
        } catch (_) {
          // Unreadable (a file removed between picking and reading): recorded by
          // name, and replay will ask for it.
        }
      }
      emit({
        type: 'upload',
        locator: found.locator,
        candidates: found.candidates,
        fingerprint: found.fingerprint,
        files,
        label: label(el, found),
        url: location.href,
      });
    },
    true
  );

  // ---- native dialogs ------------------------------------------------------
  // alert/confirm/prompt block the page until a person answers, and replay has
  // to give the same answer — a confirm dismissed instead of accepted is a
  // flow that silently stops deleting the record it was meant to delete. The
  // dialog itself is drawn by the browser, so the only place the answer can be
  // read is the return value, here.
  for (const kind of ['alert', 'confirm', 'prompt']) {
    const original = window[kind];
    if (typeof original !== 'function') continue;
    window[kind] = function recordedDialog(message, ...rest) {
      const answer = original.call(window, message, ...rest);
      emit({ type: 'dialog', kind, message: String(message ?? ''), answer });
      return answer;
    };
  }

  // ---- keyboard ------------------------------------------------------------
  document.addEventListener(
    'keydown',
    (event) => {
      if (ignored(realTarget(event))) return;
      if (event.key !== 'Enter') return;
      const el = realTarget(event);
      flushFill(el);
      const found = describeAll(el);
      if (!found) return;
      emit({
        type: 'press',
        key: 'Enter',
        locator: found.locator,
        candidates: found.candidates,
        fingerprint: found.fingerprint,
        label: label(el, found),
        url: location.href,
      });
    },
    true
  );

  // ---- recording badge (visible proof the recorder is live) -----------------
  // Hovering reveals controls. The badge itself never takes pointer events, so
  // it cannot intercept the clicks the recorder is trying to observe; only the
  // revealed buttons do.
  const paint = () => {
    let badge = document.getElementById('__record_badge__');
    if (badge) return;
    badge = document.createElement('div');
    badge.id = '__record_badge__';
    badge.setAttribute('data-record-ignore', '');
    badge.style.cssText = [
      'position:fixed',
      'bottom:14px',
      'right:14px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:7px 12px',
      'border-radius:999px',
      'font:600 12px/1 -apple-system,Segoe UI,Roboto,sans-serif',
      'background:#0b1020',
      'color:#fff',
      'box-shadow:0 6px 20px rgba(0,0,0,.35)',
      // The badge itself must not take pointer events, or it would swallow the
      // clicks the recorder is trying to observe. A separate invisible pad below
      // is what actually receives the hover.
      'pointer-events:none',
    ].join(';');

    const style = document.createElement('style');
    style.textContent = '@keyframes __rec_pulse{0%{opacity:1}50%{opacity:.25}100%{opacity:1}}';
    (document.head || document.documentElement).appendChild(style);

    // A real element rather than a pseudo-element: `pointer-events:none` on the
    // badge suppresses hover on its pseudo-element too, so a ::before pad would
    // never fire mouseenter. This pad is a sibling positioned over the corner,
    // large enough that the pointer does not have to find a 12px dot.
    const pad = document.createElement('div');
    pad.id = '__record_pad__';
    pad.setAttribute('data-record-ignore', '');
    pad.style.cssText = [
      'position:fixed',
      'bottom:0',
      'right:0',
      'width:220px',
      'height:72px',
      'z-index:2147483646',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText =
      'width:9px;height:9px;border-radius:50%;background:#ff3b47;animation:__rec_pulse 1.1s infinite';
    const count = document.createElement('span');
    count.id = '__record_count__';
    count.textContent = 'REC';
    badge.appendChild(dot);
    badge.appendChild(count);

    // Revealed on hover. `stopPropagation` matters: a control click must not
    // also reach the page, or pressing stop would click whatever the button
    // happens to sit on top of.
    const control = (label, title, onClick, color) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-record-ignore', '');
      button.textContent = label;
      button.title = title;
      button.style.cssText = [
        'display:none',
        'pointer-events:auto',
        'border:0',
        'border-radius:999px',
        'padding:5px 10px',
        'cursor:pointer',
        'font:600 11px/1 -apple-system,Segoe UI,Roboto,sans-serif',
        `background:${color}`,
        'color:#fff',
      ].join(';');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      badge.appendChild(button);
      return button;
    };

    const stop = control('■ Stop', 'Stop recording', () => emit({ type: 'command', command: 'stop' }), '#ff3b47');

    // While a step is being recorded, a pause is what you actually want: the
    // browser stays open and the run resumes where it left off.
    const pause = control('❙❙ Pause', 'Pause recording — the browser stays open', () =>
      emit({ type: 'command', command: 'pause' }), '#5b6b8c');
    const resume = control('▶ Resume', 'Resume recording', () =>
      emit({ type: 'command', command: 'resume' }), '#1f9d55');

    // Checks. "Check" arms a pick: the next element pressed is checked rather
    // than acted on. "Check URL" records the address the page is at now.
    const check = control('✓ Check', 'Check an element: press it next, and its text, value or state is recorded as what the page must show (Esc cancels)', () =>
      armAssert(!assertArmed), '#15803d');
    const checkUrl = control('✓ URL', 'Check that the page is at this URL', () =>
      emit({ type: 'assertUrl', value: location.href, match: 'equals', url: location.href }), '#15803d');
    window.__recordAssertArmed = (on) => {
      check.textContent = on ? '✓ Pick an element…' : '✓ Check';
    };

    // Status is written by the recorder so the badge reflects the real state
    // rather than the last thing the page happened to do.
    const showOnly = (...wanted) => {
      for (const [button, on] of [
        [stop, wanted.includes('stop')],
        [pause, wanted.includes('pause')],
        [resume, wanted.includes('resume')],
        // Checks are recorded only while recording, never while paused.
        [check, wanted.includes('pause') || assertArmed],
        [checkUrl, wanted.includes('pause')],
      ]) {
        button.style.display = on ? 'inline-block' : 'none';
      }
    };

    // The state the buttons should show for a given recorder state.
    const controlsFor = (state) => (state === 'paused' ? ['stop', 'resume'] : ['stop', 'pause']);

    // Hover is observed on the pad, not the badge: the badge ignores pointer
    // events entirely so it cannot intercept what the user is recording.
    pad.addEventListener('mouseenter', () => {
      showOnly(...controlsFor(badge.dataset.state || 'recording'));
    });
    pad.addEventListener('mouseleave', (event) => {
      // Buttons live outside the pad, so moving onto one fires this too. Hiding
      // on a timer rather than immediately means the pointer has a moment to
      // arrive, instead of the button vanishing under it.
      const to = event.relatedTarget;
      if (to && badge.contains(to)) return;
      setTimeout(() => {
        if (badge.matches(':hover') || pad.matches(':hover')) return;
        showOnly();
      }, 180);
    });


    // Applied whenever the recorder reports a state change. `steps` is the count
    // the recorder has; the span above is the label it writes into.
    window.__recordBadge = (state, steps) => {
      badge.dataset.state = state;
      const word =
        state === 'paused' ? 'PAUSED' : state === 'inserting' ? 'INSERTING' : 'REC';
      count.textContent = steps == null ? word : `${word} ${steps}`;
      dot.style.background = state === 'paused' ? '#f0a92a' : '#ff3b47';
      dot.style.animationPlayState = state === 'paused' ? 'paused' : 'running';
      // Pressing Pause while the controls are already open must swap Pause for
      // Resume in place. Hiding here would leave the pointer sitting over a pad
      // with no visible button, and no new hover would ever arrive.
      if (badge.matches(':hover') || pad.matches(':hover')) {
        showOnly(...controlsFor(state));
      }
    };

    const root = document.body || document.documentElement;
    root.appendChild(pad);
    root.appendChild(badge);
  };
  if (TOP) {
    if (document.body) paint();
    else document.addEventListener('DOMContentLoaded', paint, { once: true });
    // Whether the user's own gesture brought the page here — a link, a form
    // submit — or it was loaded from the address bar. The browser carries user
    // activation across a navigation the user caused and not across a typed
    // URL, so this tells the two apart without guessing from timing.
    const activation = navigator.userActivation;
    emit({ type: 'ready', url: location.href, byGesture: !!(activation && activation.hasBeenActive) });
  }
})();