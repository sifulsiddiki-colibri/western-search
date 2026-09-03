# Meeting 2 (Sep 2, 2026) — Answers, Deliverables, and Plugin Update Plan

Source: `Western Schools Wordpress Integration Meeting 2` transcript (Siful, Saru
Toleikis, Benjamin Phillips, Aashima Sahgal, Rob Roark, Dawn Waugh).
Cross-checked against the current `ws-course-search` plugin code
(v4.0.7) on 2026-09-02.

**Headline finding:** the plugin already exists at a more advanced stage than
what was demoed live in this meeting — several things Saru/Aashima asked
about turn out to already be solved (or partially solved) in the current
code. The gaps below are real gaps, not a from-scratch build.

---

## 0. Action items — do these in order

Checked off = done. Each item names the file(s) it touches and which
stakeholder ask it closes out. Full reasoning for each is in §1–§4 below.

- [x] **1. Bump the debounce.** `assets/search-widget.js` — `DEBOUNCE_MS`
      150 → ~500. *(Saru, §1 "Debounce?")*
- [x] **2. Raise the search floor to 3 letters.** `MIN_QUERY_LENGTH`
      2 → 3 in `search-widget.js` — no live search fires on 1 or 2
      characters at all; 3+ is where real search (backed by item 3) kicks
      in. *(Saru, §1 — refined per Siful 2026-09-03: start search at 3
      letters, not 2)*
- [x] **3. Build the 3-letter related-terms database.** A new table keyed
      by 3-letter combination (trigram) → related search terms, used to
      speed up and broaden the very first search instead of computing
      synonym/semantic expansion live. Design:
      - `wp_ws_trigram_terms`: `trigram` (3 chars, lowercase) ×
        `related_term` (a word/phrase pulled from the catalog's
        name/tags vocabulary) × `weight`/`rank`.
      - Populated offline (WP-Cron or the item-7 Claude plugin, not
        computed per-request): for every significant term in the
        catalog vocabulary, find its nearest neighbors via the existing
        embedding vectors (`wp_ws_embeddings`/cosine similarity — same
        machinery `ws_search_handle_semantic()` already has), then index
        those related terms under the 3-letter prefix(es) they and their
        neighbors start with.
      - At query time: a 3+ letter search looks up the typed prefix in
        this table, gets back the related terms instantly (no live
        embedding compute, no Marketing API call), and searches
        `wp_ws_catalog` (already local) using the original term *plus*
        the related ones in one shot — this is what actually speeds up
        that first search, since the expensive part was always computing
        the expansion, not querying the catalog itself.
      - Refresh on the same WP-Cron cadence as the prewarm sweep, or
        whenever embeddings are refreshed (item 6/7), since it's
        derived from the same vectors.
      *(Saru, §1 "cache 2-3 letter combos" — refined 2026-09-03 into a
      related-terms expansion table rather than a flat popular-products
      list, and scoped to 3-letter combinations only)*
- [x] **4. Replace the pulsing "Searching…" text with a real spinner.**
      `assets/search-widget.css` (+ a small markup tweak in
      `search-widget.js`'s `showLoading()`). *(Aashima, §1 "add a wait
      timer/searching indicator")*
- [ ] **5. Lock the embeddings JSON schema** — `{productId, vector[384],
      sourceHash}[]`, matching what `ws_search_handle_save_embeddings()`
      already accepts. This is a 5-minute decision, but items 6 and 7 both
      depend on it, so do it before either.
- [ ] **6. Build the admin "Import embeddings" UI.** New section on
      Settings → WS Course Search: file upload field + a new
      `manage_options`/nonce-gated AJAX endpoint that reads the uploaded
      JSON and upserts into `wp_ws_embeddings`, reusing the existing
      save-embeddings logic. `ws-course-search.php` +
      `assets/admin-embeddings.js`. *(Saru, §1 "is there an admin side...
      upload JSON files with existing embeddings")*
- [ ] **7. Build the Claude Code plugin that generates that JSON.**
      `claude-plugins/embeddings-generator/` currently has nothing but a
      stray `node_modules` — needs a real manifest + skill/script using
      `@xenova/transformers` + `Xenova/all-MiniLM-L6-v2` in Node, so its
      output matches item 6's schema exactly. *(Saru, §1 "package the
      embedding-generation logic as a Claude plugin")*
- [ ] **8. Verify the Gutenberg block live.** Open a real page on the
      Western Schools WP site, type `/`, confirm "WS Course Search" shows
      up in the block inserter. No code change expected — this is
      confirming what the README already claims. *(Saru, §1 "are those
      controls JS snippets or Gutenberg blocks?")*
- [ ] **9. Sanity-check block self-sufficiency.** Drop the block twice on
      one test page (or block + `[ws_course_search]` shortcode together)
      and confirm the two instances stay fully independent — this should
      already hold by design, just confirm it live alongside item 8.
      *(Saru, §1 "block should be self-sufficient")*
- [ ] **10. Before any real go-live:** swap `WS_MARKETING_API_BASE` and
      `WS_VIEW_ALL_BASE` in `ws-course-search.php` from the test hosts to
      production. Not from this meeting directly, but blocks shipping
      anything above for real.

**Not on this list on purpose:** progressive "exact phrase first, extend
with synonyms after" search. Saru and Aashima both explicitly deprioritized
it in the meeting — leave it as a later follow-up, not part of this pass.

---

## 1. Answers to the questions raised

**Saru — "Is there an admin side to it? A place to update/upload embeddings?"**
Not yet, in the form Saru wants. There *is* a Settings → WS Course Search
admin page today, but it only has a "Refresh search embeddings" button that
recomputes vectors from courses already in this site's own catalog. It has
no way to *import* an embeddings file from elsewhere. See Deliverable D1.

**Saru — "Is anything written to a WordPress database? Currently everyone
has add capability?"**
Yes — three plugin-owned MySQL tables (`wp_ws_catalog`, `wp_ws_embeddings`,
`wp_ws_search_log`), created on activation. Any logged-in admin who can
reach Settings → WS Course Search can trigger the embeddings refresh
(gated by `manage_options`, so actually just Administrators already — not
"everyone," but Saru's broader point stands: there's no fine-grained
workflow around it). Saru explicitly said not to bother with per-role
permissioning beyond "logged in" — keep it simple.

**Saru — "Is the existing stock WordPress search connected to the same
database or the marketing API?"**
Answered by Benjamin: no relation at all. Stock WP search is a plain text
match against WordPress articles/pages, unrelated to courses or the
Marketing API.

**Saru — "Does the search call the marketing API for the phrase and every
synonym, then combine results?"**
Confirmed by Siful: yes, that was the logic in the version demoed live.
(Current code has since moved further — see §2 below.)

**Benjamin — "How long is the delay, actually?"**
8–16 seconds on a cold/first search, confirmed by Siful.

**Saru / Benjamin — progressive loading (fire the exact phrase first, extend
with synonyms after)**
Discussed as a good idea but explicitly **deprioritized** — Saru: "not sure
if it's worth over-optimizing this... could be a follow-up task." Aashima
confirmed the team is fine shipping without it for now, given the widget is
fully integrated and hostable. Treat as a later-phase item, not urgent.

**Aashima — "Can you cache the marketing API data locally / temp memory
in the widget?"**
Agreed as the right near-term direction. Current code already does a
version of this (see §2) — worth confirming with Aashima/Saru that the
`wp_ws_catalog` table + WP-Cron pre-warm satisfies what she meant by "temp
memory," since her framing (comparing to S3-dumping Vault MCP data for QA
agents) suggests she pictures a scheduled dump/refresh, which is
essentially what the pre-warm sweep already is.

**Siful → Saru — "Deliverables: backend endpoints access, DB, admin UI for
maintaining embeddings, package embedding-generation logic as a Claude
plugin, package the WordPress-side as a real WordPress plugin"**
Saru confirmed all of these explicitly:
- Admin UI for maintaining embeddings — "yes, that would be nice."
- Embedding-generation logic packaged as a Claude plugin — "otherwise
  anyone trying to use the system would have to invent that layer... it
  would involve some reverse engineering... ideally it would just be part
  of the deliverables."
- WordPress-side packaged as an actual WordPress plugin (not raw JS
  snippets) — "if you ask Claude to do exactly that."

**Saru — "Are those controls JS snippets or Gutenberg blocks?"**
Siful believed it was registered as a proper Gutenberg block but wanted to
double check. Saru's test: open a WP page, type `/`, and the block should
appear in the inserter list. See Deliverable D7.

**Saru — "Should the block be self-sufficient — just the input + button,
with 'insert more of them' handled outside the block?"**
Yes, confirmed as the intended design; the block itself should not contain
functionality for managing multiple instances — that's WordPress's own job
(dropping the block in twice).

**Benjamin — "Is it restarting the search on every keystroke, even mid-typing?"**
Confirmed by Siful: yes, each input change aborts and restarts the
in-flight request (though an already-warm state returns faster). Benjamin
flagged this as a real risk of hammering the API on every letter typed.

**Saru — "Debounce?"**
Yes — Saru's specific suggestion: debounce ~0.5s so nothing fires until the
user pauses.

**Saru — "Skip searching entirely on 1–2 letter input; cache ~10 popular
products for 2–3 letter combos in SQL for instant display instead"**
Saru called this "an immediate and obvious improvement" to prioritize for
the next touchpoint. Siful agreed to do it.

**Aashima — "Add a visible 'searching...' state while we wait?"**
Agreed. Siful noted one already exists but "doesn't look the nicest" —
needs a visual pass, not a from-scratch build.

---

## 2. What the current plugin code already does (as of v4.0.7)

Good news — several of the above are already implemented, apparently in
work done since (or in parallel with) this meeting:

- **Local catalog cache, not a live marketing-API call per keystroke.**
  `wp_ws_catalog` holds a plugin-owned copy of the Marketing API's product
  data per `(product_id, state_abbv, license_type_id)`, refreshed on a 6h
  TTL (`WS_INDEX_TTL`). Live searches hit this table, not the Marketing API
  directly. This is functionally the "temp memory / local cache" Aashima
  asked about.
- **Background pre-warming.** A self-chaining WP-Cron sweep
  (`ws_search_prewarm_sweep` / `ws_search_prewarm_batch`) walks all
  state+profession combos 5 at a time so most visitors never pay the cold
  first-search cost — it's usually already been paid by the sweep. There's
  also a `warmState()` fire-and-forget call the moment a visitor picks a
  state, before they've even finished typing a query.
- **Staged results, just not the exact "phrase-then-synonyms" shape
  discussed.** Keyword/typo search (server-side Levenshtein matching)
  returns first; semantic ("meaning") matches are fetched as a second,
  non-blocking request *after* keyword results are already on screen
  (`runSemanticRescue()`), so semantic compute never delays the fast path.
  This satisfies the spirit of "show something fast, extend it after."
- **Debounce already exists**, just shorter than Saru's suggestion:
  currently 150ms, not ~500ms.
- **Minimum query length already exists**, just not tuned to Saru's ask:
  currently 2 characters (`MIN_QUERY_LENGTH = 2`), so a 1-letter query is
  already skipped, but a 2-letter query still fires a real (if fast,
  locally-cached) search rather than showing a pre-cached popular list.
- **A loading indicator already exists** — a pulsing "Searching…" message —
  just, per Siful's own read, not polished.
- **Search-term logging already exists** (`wp_ws_search_log`), capturing
  every committed (not per-keystroke) search — the raw data a "popular
  searches" feature would be built from — but nothing reads from it yet.
- **Gutenberg block is registered properly** (`ws-course-search/search`,
  `registerBlockType`, dynamic block with `save() { return null }`), and
  the plugin's own README documents it as tested end-to-end, including that
  multiple instances (block+block, block+shortcode) stay fully independent
  — i.e., self-sufficient, per Saru's requirement. Still worth a live "type
  `/` and look for it" confirmation on the real Western Schools site (see
  D7) since that's a fast, concrete check Saru specifically asked for.

---

## 3. Real gaps → concrete deliverables

### D1. Admin "import embeddings" page (Saru's core ask — not built yet)
A new section on Settings → WS Course Search: a file upload field for a
JSON file of precomputed embeddings, a new AJAX endpoint that accepts the
upload (`$_FILES`, capability-gated to `manage_options`, nonce-protected),
validates its shape, and upserts rows into `wp_ws_embeddings` (same
`ws_search_handle_save_embeddings()` logic, reusable, just fed by an
uploaded file instead of the browser's own live compute). Needs a defined
JSON schema — proposal: `{ "productId": string, "vector": number[384],
"sourceHash": string }[]`, matching exactly what D2's generator produces
and what `ws_search_handle_save_embeddings()` already accepts, so the two
deliverables share one contract.

### D2. Package the embedding-generation logic as a Claude Code plugin
`claude-plugins/embeddings-generator/` currently contains nothing but a
stray `node_modules` — no source, no manifest. Needs building from
scratch: a Claude Code plugin (skill + script) that takes course
catalog/content and produces a JSON file in the D1 schema, using the same
`Xenova/all-MiniLM-L6-v2` model (via `@xenova/transformers` in Node) so
vectors land in the identical vector space as the browser-computed ones —
this is what makes D1's uploaded file and the live "Refresh search
embeddings" button interchangeable rather than two incompatible formats.

### D3. Debounce: 150ms → ~500ms
One constant change in `search-widget.js` (`DEBOUNCE_MS`), per Saru's
explicit number.

### D4. Don't search on 1–2 letters; show a cached "popular" list instead
Raise `MIN_QUERY_LENGTH` behavior so 1–2 character input shows a fast
precomputed list rather than either nothing or a real search.

### D5. Prefix-popularity cache (Saru: "an immediate, obvious improvement")
A small table (or a derived/materialized view) mapping short prefixes
(2–3 letters) → top ~10 product ids, refreshable on a schedule from
`wp_ws_search_log` (which already has the raw committed-search data) or
from raw popularity/sales data if that's a better signal. Served for D4's
short-query case, near-instantly, no Marketing-API/catalog round trip.

### D6. Loading-state visual polish
Replace/augment the pulsing text-only "Searching…" message with an actual
spinner element, per Aashima's ask and Siful's own "doesn't look the
nicest" assessment.

### D7. Confirm Gutenberg registration + block self-sufficiency, live
Saru's own test: open a real WP page, type `/`, confirm "WS Course Search"
appears in the inserter. Quick to do, closes the loop on his specific
question rather than relying on the README's own claim.

### D8. Before go-live (already flagged in the plugin's own README, restating here since it's relevant to "deliverables")
`WS_MARKETING_API_BASE` and `WS_VIEW_ALL_BASE` still point at test hosts
(`test-api-ms.westernschools.com`, `test.westernschools.com`) — swap to
production before this ships anywhere real.

### Explicitly deprioritized (do not build yet)
Progressive "exact phrase first, synonyms after" search — Saru and Aashima
both said this is fine as a follow-up, not needed for this checkpoint.

---

## 4. Suggested order

1. D3 + D4 (debounce + min-length) — smallest, safest, immediate UX win.
2. D6 (loading spinner polish) — small, visible, no backend changes.
3. D5 (prefix-popularity cache) — the "immediate and obvious improvement"
   Saru called out by name for the next touchpoint.
4. D1 + D2 together — the admin import UI and the Claude-plugin generator
   need to agree on one JSON schema, so building them in the same pass
   avoids designing the contract twice.
5. D7 (live Gutenberg check) — a 5-minute verification, can happen anytime.
6. D8 (prod hostnames) — do last, right before an actual go-live.
