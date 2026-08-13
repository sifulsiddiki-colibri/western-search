# WS Course Search — WordPress plugin

A thin WordPress-side proxy. All the real search logic — Meilisearch query,
text embeddings, keyword+typo matching, semantic relevance filtering — lives
in the Node backend (`server.js` in the repo root, github.com/sifulsiddiki-colibri/western-search).
This plugin just wires that backend into WordPress via `admin-ajax.php`.

**Tested end-to-end** against a real WordPress instance (WordPress core +
the official SQLite integration plugin, no MySQL needed) — not just
reviewed. Verified: keyword search, typo tolerance, semantic rescue with
zero keyword overlap, and the "Suggested" tag rendering correctly through
the full WordPress → PHP → Node → Meilisearch path.

## Why a proxy, not a PHP port

An earlier version of this plugin reimplemented the matching logic
natively in PHP. That worked for keyword/typo search (PHP's built-in
`levenshtein()` made it straightforward), but hit a real wall once AI
semantic matching was added: computing text embeddings has no clean PHP
equivalent to the Node embedding pipeline — the same shape of problem
AWS SigV4 signing was for the Mantle-based version before that. Proxying
to the Node backend avoids duplicating business logic in two languages
and two places to keep in sync.

## Install

1. Get the Node backend (`server.js` + a Meilisearch instance) running
   somewhere reachable from your WordPress server.
2. Set `WS_SEARCH_BACKEND_URL` to point at it — either edit the `define()`
   near the top of `ws-course-search.php`, or define the constant in
   `wp-config.php` before this plugin loads. Defaults to
   `http://localhost:8080` (local development only).
3. Copy the `ws-course-search/` folder into `wp-content/plugins/`.
4. Activate it from the WordPress admin (Plugins → Installed Plugins).
5. Add `[ws_course_search]` to the homepage and product listing page
   templates (or directly in the block editor as a Shortcode block).
   Optional attribute: `[ws_course_search default_state="FL"]`.

## Still open

- **Where does the Node backend actually run in production?** This is the
  big open question — deferred deliberately while validating the
  Meilisearch approach itself. Needs a real hosting decision (small VM,
  container service, etc.) before this goes live anywhere real.
- Only the `nursing` profession's course-URL slug is confirmed against a
  real page (in `assets/search-widget.js`). The other two are a
  best-guess slugification.
- The backend currently points at `test-api-ms.westernschools.com` — swap
  to the production Marketing API host before this goes live anywhere real.
