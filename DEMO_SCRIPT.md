# WS Course Search — Demo Script

**Scope of this demo:** the Gutenberg block + live search only. Not covered:
grouped Courses/Bundles results view, search analytics UI, semantic/AI search
(none built for this pass — see "If asked" below).

## Before you go live

- Confirm the local server is up: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8090/` should print `200`.
  If it's down, restart it from the WP root: `cd /private/tmp/ws-wp-test && php -S localhost:8090`
- Admin login (only needed if you're showing the block editor): `admin` / `demo-pass-123`
- Demo page (front end): `http://localhost:8090/?page_id=19`
- Demo page (editor): `http://localhost:8090/wp-admin/post.php?post=19&action=edit`
- If it's been hours since you last searched FL/NY on this instance, re-warm the cache so the first live query doesn't pause for a few seconds waiting on the real course-catalog API:
  `curl -s "http://localhost:8090/wp-admin/admin-ajax.php?action=ws_search_warm&state=FL"`

---

## 1. Open with the one-liner

> "This is the course search widget for the site redesign — it's a real
> Gutenberg block anyone on the content team can drop into a page, and it
> does typo-tolerant search against the live course catalog with no
> external search service running anywhere."

## 2. Show it's a real block, not just a shortcode

Open the editor page. Point at the block already on the page:

> "This box is the 'WS Course Search' block. It's a *dynamic* block — the
> editor shows this placeholder instead of a live preview because the
> real markup only exists on the actual front end, but it's registered
> like any other block."

Click the **+** inserter, type "WS Course Search" to show it appear in the
list — proves it's a first-class block in the inserter, not a workaround.

> "Anyone on the content team can add this to any page the same way they'd
> add a paragraph or an image — no code, no shortcode to memorize."

(Optional, only if asked: "It also still works as a `[ws_course_search]`
shortcode for older pages — both call the exact same rendering code, so
they can never drift apart.")

## 3. Front end — the state-gate

Switch to the front-end tab (`?page_id=19`). If localStorage has a
leftover state from earlier testing, clear it first (`localStorage.clear()`
in devtools, then reload) so it starts clean.

> "It always starts on 'Select your state' — never a hardcoded default —
> because course availability and pricing are state-specific, and we don't
> want to show someone the wrong state's catalog by accident."

Type "flo" into the state field — show the type-ahead narrowing to Florida,
select it with a click or arrow keys + Enter.

## 4. The actual search — lead with typo tolerance

Type **"cardic"** (intentional typo) into the search box.

> "Watch — I misspelled 'cardiac' and it still found the right course."

Result: **"Cardiac Rehabilitation: The Nurses' Integral Role in Heart
Recovery"** shows up. This is the single best "wow" beat in the demo —
it's a real product, not a canned mockup.

> "That's Levenshtein-distance typo tolerance, tuned to scale with word
> length — short words need an exact match, longer ones tolerate one or
> two character slips. It's the same idea Algolia and Elasticsearch use,
> just running in plain PHP with no external search infrastructure."

## 5. Show the honest failure case too

Clear the box, type something that shouldn't match anything real, e.g.
**"zzznonexistentqueryzzz"**.

> "And it fails gracefully — a clear 'no courses found' message instead of
> a blank box or an error."

This matters because it proves the zero-result path was actually built and
tested, not just the happy path.

## 6. Why no external search service (if they ask "what's this built on")

> "There's no Meilisearch, no separate search server, no third-party API
> for this. Catalog data lives in two tables this plugin owns. Keyword
> search and typo tolerance run in plain PHP. That was a deliberate call —
> there wasn't an approved place to host a persistent search service for
> this deployment, and the project's own history had already tried a
> hand-rolled index and an LLM-judges-relevance approach and found both
> worse than just doing this properly."

## 7. The integration hand-off (mention, don't over-explain unless asked)

> "When a search finishes, the widget fires one browser event with just
> the matched product codes — nothing else. Whatever the listings-filtering
> team builds downstream decides what to do with those codes; the widget
> doesn't reach into their code and their code doesn't reach into the
> widget's rendering."

## 8. Close honestly — what's still open

Don't oversell. End with the real state of things:

> "Three things are still open, not blocking this demo but worth flagging:
> we're logging search terms to a new table, but that landed without an
> explicit sign-off from Ben and Sara on where that data should live long
> term. There's a question about whether a zero-result search should fire
> its own event downstream — that's unspecified either way right now. And
> there's an architecture conversation still pending with Sara about
> search-phrase-in-URL versus resolving it live in the browser."

## If asked about semantic ("AI") search

The plugin has a semantic-search code path (embeddings computed in the
visitor's/admin's own browser, no server-side model) already built and
wired up, but **no embeddings have been generated on this local instance**,
so it has nothing to show live right now. Be straightforward about that:

> "There's a meaning-based search layer built in — it'd catch something
> like 'back pain course' matching 'Low Back Pain' with zero literal word
> overlap — but it needs a one-time embeddings pass from Settings that
> hasn't been run on this test instance. Happy to turn that on and show it
> in a follow-up."

Don't try to demo this live unless it's been explicitly prepared first —
running the refresh cold, live, downloads a ~30MB model and computes
hundreds of embeddings in-browser, which is a bad thing to be waiting on
in front of people.

## Anticipated questions

- **"Does this work on mobile?"** — Yes, the bar collapses to stacked
  boxes below a breakpoint; state/search/button each get their own row.
- **"What happens with more than one of these on a page?"** — Fully
  independent instances (unique container ids, namespaced localStorage) —
  verified with two blocks + a shortcode on the same test page.
- **"Is this live on the real site?"** — No, this is `test-api-ms` /
  local WordPress. Production Marketing API host and the real
  view-all-page search-quality gap are both still open items.
