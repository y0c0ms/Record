// Steps inside iframes.
//
// A frame cannot reliably say which iframe it is: across origins it cannot see
// its own <iframe> element at all. The Node side can — Playwright hands the
// binding the frame an action came from, and `frameElement()` works whatever
// the origin. So the recorder describes the frame from outside, as the chain
// of <iframe> elements from the top document down, and replay walks the same
// chain with frameLocator.
//
// Each hop is identified the way a person would point at it — id, then name,
// then title — and only by position when the iframe carries nothing else.
// Position is the weakest: a page that adds an ad frame above the payment form
// shifts it. It is kept because some embedded forms really do have nothing
// else, and failing outright there would be worse than a weak match.

// The frame chain for the frame an action came from, or null for the top frame.
export async function frameScope(frame) {
  if (!frame || !frame.parentFrame()) return null;
  const hops = [];
  for (let f = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const element = await f.frameElement();
    const hop = await element.evaluate((node) => {
      const all = Array.from(node.ownerDocument.querySelectorAll('iframe,frame'));
      return {
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        name: node.getAttribute('name') || null,
        title: node.getAttribute('title') || null,
        src: node.getAttribute('src') || null,
        index: all.indexOf(node),
      };
    });
    await element.dispose().catch(() => {});
    hops.unshift(hop);
  }
  return hops;
}

const cssString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// The selector for one hop, most specific first. An id that is not a valid CSS
// identifier is still addressable as an attribute.
export function hopSelector(hop) {
  const tag = hop.tag === 'frame' ? 'frame' : 'iframe';
  if (hop.id) return `${tag}[id=${cssString(hop.id)}]`;
  if (hop.name) return `${tag}[name=${cssString(hop.name)}]`;
  // The address of what the frame shows, without its query string: which
  // embed it is (a share chart, a payment form), and stable across visits
  // where the query carries session tokens. Ahead of the title, because
  // builders stamp the same generic title ("Iframe") on every embed, and two
  // frames titled alike made every step inside either one ambiguous.
  const src = srcPrefix(hop.src);
  if (src) return `${tag}[src^=${cssString(src)}]`;
  if (hop.title) return `${tag}[title=${cssString(hop.title)}]`;
  return `:is(iframe,frame) >> nth=${Math.max(0, hop.index ?? 0)}`;
}

// A frame's src up to its query string, or null when it says nothing about
// what the frame is (empty, about:blank, javascript:, data:).
function srcPrefix(src) {
  if (typeof src !== 'string') return null;
  const s = src.trim();
  if (!s || /^(about|javascript|data|blob):/i.test(s)) return null;
  const cut = s.search(/[?#]/);
  const base = cut >= 0 ? s.slice(0, cut) : s;
  // A bare origin or "/" names a site, not an embed.
  return base.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\/+$/, '') ? base : null;
}

// The root a step's locators resolve against: the page itself, or the frame the
// step was recorded in. `frameLocator` chains are lazy, so a frame that loads
// late is waited for by the locator wait rather than failing here.
export function scopeRoot(page, frame) {
  if (!Array.isArray(frame) || !frame.length) return page;
  let root = page;
  // Only the visible copy: a responsive page embeds the same frame twice and
  // hides one per breakpoint, the same duplication `resolveUnique` allows for
  // elements. Without the filter every step in such a frame was ambiguous.
  for (const hop of frame) root = root.frameLocator(`${hopSelector(hop)} >> visible=true`);
  return root;
}

// How the frame chain reads in a step's detail and in a failure message.
export function describeFrame(frame) {
  if (!Array.isArray(frame) || !frame.length) return '';
  return frame
    .map((hop) => (hop.id ? `#${hop.id}` : hop.name ? `[name=${hop.name}]` : hop.title ? `"${hop.title}"` : `frame ${hop.index}`))
    .join(' › ');
}
