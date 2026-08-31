# WS Course Search — 5-Minute Demo Script

**Scope of this demo:** two things, back to back — the redesigned header
search (the homepage/view-all recreation, repo-root prototype) and the
Gutenberg block that ships the same search into real WordPress pages. Not
covered: grouped Courses/Bundles results view, search analytics UI,
semantic/AI search (see "If asked" below).

## Before you go live

**Homepage popup search (repo root, port 8080)**
- Confirm it's up: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/` → should print `200`.
- If it's down or you edited any CSS/JS: `lsof -ti :8080 | xargs kill` then `npm start` from the repo root (this server does **not** hot-reload).
- No manual cache warm needed — it pre-warms all state/profession combos in the background on startup (168 combos, a few seconds after boot).
- Demo page: `http://localhost:8080/` — click the magnifying glass next to the cart to open the search.
- Clear localStorage first if you tested recently (`localStorage.clear()` in devtools, then reload) so the state field starts on "Select your state" and there's no leftover "recent searches" clutter.

**Gutenberg block / WordPress (local WP instance, port 8090)**
- Confirm it's up: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8090/` → should print `200`.
- If it's down, restart it: `cd /private/tmp/ws-wp-test && php -S localhost:8090`
- Admin login (only needed to show the block editor): `admin` / `demo-pass-123`
- Demo page (front end): `http://localhost:8090/?page_id=19`
- Demo page (editor): `http://localhost:8090/wp-admin/post.php?post=19&action=edit`
- Re-warm the cache if it's been hours since you last searched FL on this instance, so the first live query doesn't pause a few seconds on the real course-catalog API:
  `curl -s "http://localhost:8090/wp-admin/admin-ajax.php?action=ws_search_warm&state=FL"`

**Search terms to have ready (type these live, don't paste):**
- `ca` — shows live-as-you-type suggestions appearing immediately, before you finish typing
- `cardic` — intentional typo for "cardiac," the typo-tolerance "wow" moment
- `zzznonexistentqueryzzz` — the honest zero-result case
- State to pick: **Florida**

---

## 1. Open with the one-liner (0:00–0:45)

> "This is the new course search — same search engine, two places it
> shows up. First, the redesigned header search on the site itself.
> Second, the same thing packaged as a WordPress block anyone on the
> content team can drop into a page. No external search service behind
> either one — it's typo-tolerant search against the live course catalog,
> running in code we own."

## 2. Homepage popup search — the main event (0:45–2:45)

Go to `http://localhost:8080/`. Click the magnifying glass icon next to
the cart.

> "Clicking the search icon opens this panel — one box holding
> everything: state, search, and results, so it reads as a single piece
> of UI rather than floating pieces."

Point out the state field says "Select your state" — never pre-filled.

> "It never defaults to a state — course availability and pricing are
> state-specific, so we don't want to guess wrong."

Select **Florida** from the dropdown.

Type **`ca`** slowly, letter by letter.

> "Watch — it's already showing matches after two letters. No need to
> finish typing or hit enter."

Clear it, then type **`cardic`** (the intentional typo).

> "And here's the one that always lands — I misspelled 'cardiac' and it
> still found the right course: Cardiac Rehabilitation. That's
> Levenshtein-distance typo tolerance, tuned to scale with word length —
> short words need an exact match, longer ones tolerate a slip or two.
> Same idea Algolia or Elasticsearch use, just running here with no
> external search infrastructure."

Point out the rectangular "ELECTIVE" badges and the layout — mention this
was pixel-matched against the design mockup (color, corner radius, one
unified panel) rather than eyeballed.

Click a result (or "Search") to show it lands on the recreated "view all"
results page, still wired to the same live search.

## 3. The Gutenberg block — same engine, WordPress packaging (2:45–4:15)

Switch to `http://localhost:8090/wp-admin/post.php?post=19&action=edit`.

> "This is the exact same search, but packaged as a real Gutenberg block
> so anyone on the content team can add it to any page — no code, no
> shortcode to memorize."

Click the **+** inserter, type "WS Course Search" to show it appear in the
block list.

> "It's a *dynamic* block — the editor shows this placeholder instead of a
> live preview because the real markup only renders on the front end, but
> it's a first-class registered block, not a workaround."

(Optional, only if asked: "It also still works as a `[ws_course_search]`
shortcode for older pages — both call the exact same rendering code, so
they can't drift apart.")

Switch to the front end (`?page_id=19`). Type "flo" into the state field
to show the type-ahead narrowing to Florida — this copy of the widget uses
a type-ahead text field instead of the homepage's dropdown.

> "Same search behavior, same typo tolerance — just a different state
> picker, because this version needed to handle a much longer state list
> inline on a content page."

## 4. Show the honest failure case (4:15–4:45)

Type **`zzznonexistentqueryzzz`** in either instance.

> "And it fails gracefully — a clear 'no courses found' message, not a
> blank box or an error. That's a tested path, not just the happy path."

## 5. Close honestly — what's still open (4:45–5:00)

> "A few things still open, not blocking today: the grouped
> Courses/Bundles results view from the design isn't built yet — needs a
> data-model change we haven't scoped. Search-term analytics logging
> landed without explicit sign-off on where that data should live
> long-term. And there's a pending architecture conversation about
> search-phrase-in-URL versus resolving it live in the browser."

---

## If asked about semantic ("AI") search

The plugin has a semantic-search code path (embeddings computed in the
visitor's/admin's own browser, no server-side model) already built and
wired up, but **no embeddings have been generated on the WP test
instance**, so it has nothing to show live right now.

> "There's a meaning-based search layer built in — it'd catch something
> like 'back pain course' matching 'Low Back Pain' with zero literal word
> overlap — but it needs a one-time embeddings pass that hasn't been run
> on this test instance. Happy to turn that on and show it in a
> follow-up."

Don't try to demo this live unless it's been explicitly prepared first —
running the refresh cold, live, downloads a ~30MB model and computes
hundreds of embeddings in-browser, which is a bad thing to be waiting on
in front of people.

## If asked "why no external search service"

> "There's no Meilisearch, no separate search server, no third-party API.
> Catalog data lives in tables this plugin/prototype owns. Keyword search
> and typo tolerance run in plain code. That was a deliberate call —
> there wasn't an approved place to host a persistent search service for
> this deployment, and earlier attempts at a hand-rolled index and an
> LLM-judges-relevance approach both turned out worse than doing this
> properly."

## If asked about the integration hand-off

> "When a search finishes, the widget fires one browser event with just
> the matched product codes — nothing else. Whatever downstream code
> filters listings decides what to do with those codes; the widget
> doesn't reach into that code and it doesn't reach into the widget."

## Anticipated questions

- **"Does this work on mobile?"** — Yes, the bar collapses to stacked
  boxes below a breakpoint; state/search/button each get their own row.
- **"What happens with more than one of these on a page?"** (WP block) —
  Fully independent instances (unique container ids, namespaced
  localStorage) — verified with two blocks + a shortcode on the same test
  page.
- **"Is this live on the real site?"** — No. The homepage popup is a
  local recreation of westernschools.com's real header/hero (the search
  icon itself is this demo's own addition, not on the live site). The WP
  block is on `test-api-ms` / local WordPress. Production Marketing API
  host and the real view-all-page search-quality gap are both still open
  items.
