# WS Course Search — WordPress plugin

No external search service — no Meilisearch, no separate application server,
no third-party embeddings API. Keyword search, typo tolerance, and catalog
storage all live in plain PHP `admin-ajax.php` handlers and two plugin-owned
database tables (`ws_catalog`, `ws_embeddings`) in `ws-course-search.php`. AI
semantic matching's embeddings are computed **in the browser** — the visitor's
own browser for search queries, an admin's browser for the catalog — not on
the server.

**Tested end-to-end** against a real WordPress instance (WordPress core +
the official SQLite Database Integration plugin, no MySQL needed) — not just
reviewed. Verified: plugin activation creates both tables correctly; keyword
search, typo tolerance ("cardic" → Cardiac Rehabilitation), and nonsense
queries returning zero results all round-trip through the real
`admin-ajax.php` flow; the background WP-Cron pre-warm sweep processes real
batches and self-chains correctly; the embeddings-needed/save-embeddings
endpoints correctly dedupe by content hash and store/reconstruct real model
vectors with zero precision loss; semantic search correctly surfaces "Low
Back Pain" for "back pain course" (zero literal keyword overlap) and
correctly returns nothing for a genuinely unrelated query. The one thing this
environment couldn't drive directly is literal in-browser WASM execution (no
headless browser available) — verified instead by computing real embeddings
through the same model via Node and feeding them through the actual PHP
endpoints, which is everything this plugin's own code is responsible for.

## Hand-off event: `ws-search:results`

The integration boundary with Colibri's team (CL2 listings filtering) — see
the architecture doc's "surface-level integration" decision. The widget
never talks to CL2 directly; it only fires this event, and whatever's
downstream (a listener added by Ben/Saru's team) decides what to do with
the product codes.

Fired on the widget's root container element (the same element passed to
`WSCourseSearch.init(selector, ...)`) every time a search completes and
results render — including a zero-result render, in which case
`productCodes` is `[]`. `bubbles: true`, so a page-level listener can also
attach to `document` and check `event.target` to tell instances apart when
more than one widget is on the page.

```js
document.getElementById('ws-course-search-<id>').addEventListener(
  'ws-search:results',
  (e) => {
    const { query, stateAbbv, productCodes, ts } = e.detail;
    // query: the search phrase, e.g. "cardiac"
    // stateAbbv: 2-letter state code the search ran against, e.g. "FL"
    //            (empty string if no state was selected yet)
    // productCodes: string[] — the matched products' productId values,
    //               in the same order they're rendered
    // ts: number — Date.now() at fire time
  }
);
```

Deliberately **not** included in the payload: rendered HTML, full product
objects, or anything beyond the codes needed to filter — per the "post
product codes, not a search phrase or query string" decision, the payload
is the thin, stable contract; everything else CL2 needs about a product it
already has by `productId`.

## Why no external search service

Meilisearch and a fast embeddings API were both evaluated and ruled out for
this deployment (no approved place to host a persistent service). The
project's own git history had already tried the two obvious alternatives and
found both worse: a hand-rolled in-memory index (slower and less accurate
once Meilisearch was tuned) and an LLM judging relevance on every query via
Colibri's internal Bedrock gateway (1.6–8s per search — that gateway has no
real embeddings endpoint, only a chat-completion facade). This version goes
back to the project's own pre-Meilisearch approach for keyword search
(Levenshtein-based typo tolerance, ported to PHP's native `levenshtein()`)
and solves semantic search differently: since `@xenova/transformers` runs in
a browser via WebAssembly just as well as in Node, the embedding computation
moved to wherever a browser already is — no new infrastructure at all.

## How catalog data is stored

Three custom tables (created via `dbDelta` on plugin activation, migrated
automatically on upgrade — see `ws_search_maybe_upgrade_db()`):

- **`wp_ws_catalog`** — one row per `(product_id, state_abbv,
  license_type_id)`, since a course can legitimately appear under multiple
  states/professions with different pricing/approval. Populated by
  `ws_ensure_indexed()` on demand (when a visitor picks a state) and
  proactively by a chunked WP-Cron sweep (see below), same 6-hour
  freshness window as before (`WS_INDEX_TTL`).
- **`wp_ws_embeddings`** — one row per **distinct `product_id` only** (not
  per state/license combo) — a course's embedding text (name + tags)
  doesn't vary by state, so keying it per-combo would mean recomputing the
  same embedding up to ~50× for a widely-sold course. A `source_hash`
  column catches content drift (same product, changed name/tags) that a
  plain "row exists" check would miss.
- **`wp_ws_search_log`** — one row per committed search (`ws_search_log_term`,
  called from the JS side's `saveRecent()`, i.e. the same explicit-commit
  moments — button/Enter/picking a result — "recent searches" already uses,
  not every keystroke): `query`, `state_abbv`, `result_count`, `created_at`.
  Western didn't track search terms before this plugin (architecture doc
  §8). No admin UI on top of it yet — the data just needs to exist.

Transients were deliberately **not** used for catalog/embedding data itself
(too large and too frequently re-read for `wp_options` on a host with no
persistent object cache) — they're still used for the small, genuinely
ephemeral things they're good at: the indexing concurrency lock
(`ws_indexing_lock_{key}`), the "is this combo fresh" flag
(`ws_indexed_{key}`), and the embedding-refresh concurrency lock
(`ws_embedding_refresh_lock`).

## Background pre-warming (WP-Cron)

The on-demand `ws_ensure_indexed()` path means the *first* visitor to a
never-before-searched state still pays the full Marketing-API-latency cost.
A WP-Cron sweep tops this up proactively: an outer recurring event (every
`WS_INDEX_TTL`) starts a fresh sweep, and a self-chaining
`wp_schedule_single_event()` walks through all state+profession combos a
bounded 5 at a time (`WS_PREWARM_BATCH_SIZE`) — unlike `server.js`'s
single long-running Node loop, a WP-Cron callback has to fit inside one HTTP
request, so sweeping all ~150 combos at once would risk hitting a shared
host's `max_execution_time`. It's fine if a full sweep takes a while; the
on-demand path still carries real visitor traffic in the meantime.

WP-Cron only actually fires on site traffic (WordPress's own pseudo-cron) —
for a low-traffic site, consider a real system cron hitting `wp-cron.php`
periodically instead of relying on visits alone.

## Semantic search: embeddings computed in the browser

`@xenova/transformers`'s browser build (self-hosted under `assets/vendor/`
and `assets/models/` — copied from this repo's own `node_modules` cache, no
external CDN call) runs the same `Xenova/all-MiniLM-L6-v2` model used by
`server.js`, just in WebAssembly instead of Node:

- **Catalog-side**: Settings → WS Course Search has a "Refresh search
  embeddings" button. Clicking it runs in the *admin's* browser: fetches
  which products need a (re-)embedded vector
  (`ws_search_embeddings_needed`), computes each via `embeddings.js`, and
  POSTs results back in batches of 50 (`ws_search_save_embeddings`) so a
  closed tab only loses unsaved progress, not the whole run. A heartbeat
  lock keeps two admins from starting a duplicate full sweep.
- **Query-side**: the visitor's own browser computes the search query's
  embedding the same way, then sends it as a second, non-blocking request
  (`ws_search_semantic`) fired *after* keyword results already rendered —
  embedding compute alone can take longer than the whole keyword round
  trip, so gating the main response on it would slow down every
  keystroke-driven search, not just semantic ones. PHP only does a plain
  cosine-similarity comparison against precomputed vectors; it never
  computes an embedding itself.
- Vectors are stored base64-encoded, not raw binary — `$wpdb`'s
  charset-aware escaping can mangle arbitrary bytes on a real MySQL
  connection, while a base64 string is plain ASCII and immune to that.

This is a real, deliberate trade, not a free win: the self-hosted
model/runtime assets are a genuine ~30MB one-time (then browser-cached)
download for whoever's browser computes an embedding. **Settings → WS Course
Search** has a toggle to disable semantic search entirely, keeping search to
fast keyword/typo matching only with no extra download for visitors.

## Install

1. Copy the `ws-course-search/` folder into `wp-content/plugins/` (file
   access), or **Plugins → Add New → Upload Plugin** and upload
   `ws-course-search.zip` (WP Admin only — also how to push an updated zip
   to replace an already-installed version, no file access needed).
2. Activate it from the WordPress admin (Plugins → Installed Plugins). This
   creates the `ws_catalog`/`ws_embeddings` tables and schedules the
   background pre-warm sweep.
3. Add `[ws_course_search]` to the homepage and product listing page
   templates, or insert the **WS Course Search** block directly in the
   block editor — both render the same widget. Leave `default_state` unset
   so the widget starts on "Select your state"; only pass it (with
   `hide_state_field`) on a page that already establishes the state, e.g.
   `[ws_course_search default_state="FL" hide_state_field="true"]` on an
   FL-specific listings page.
4. Once real visitor traffic (or a manual state search) has populated the
   catalog, go to **Settings → WS Course Search** and click "Refresh search
   embeddings" to turn on semantic search. Re-run this after any catalog
   change — courses that haven't changed are skipped automatically.

## Still open

- Only the `nursing` profession's course-URL slug is confirmed against a
  real page (in `assets/search-widget.js`). The other two are a
  best-guess slugification.
- The plugin currently points at `test-api-ms.westernschools.com` via
  `WS_MARKETING_API_BASE` — swap to the production Marketing API host
  before this goes live anywhere real.
- The self-hosted model/WASM assets (~60MB across `assets/vendor/` and
  `assets/models/`) are committed straight into this repo and the plugin
  zip. That's simple and dependency-free, but worth a second look before
  this scales — a CDN-hosted or build-step-fetched alternative would keep
  the repo/zip itself lighter, at the cost of reintroducing an external
  fetch.
