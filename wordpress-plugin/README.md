# WS Course Search — WordPress plugin

Ports the working prototype (github.com/sifulsiddiki-colibri/western-search) into
a real WordPress plugin, using `admin-ajax.php` instead of the local Node dev proxy.

**Not yet tested against a real WordPress install** — there's no WP instance in
this environment. Test on a staging site before touching production.

## Install

1. Copy the `ws-course-search/` folder into `wp-content/plugins/`.
2. Activate it from the WordPress admin (Plugins → Installed Plugins).
3. Add `[ws_course_search]` to the homepage and product listing page templates
   (or directly in the block editor as a Shortcode block). Optional attribute:
   `[ws_course_search default_state="FL"]`.

## What works out of the box

Keyword + typo-tolerant search — the same Levenshtein-based matching from
`server.js`, ported to PHP (which has `levenshtein()` built in, so that part
was actually less code than the JS version). Uses WordPress transients for
the catalog cache instead of an in-memory Map, same 15-minute TTL.

## What still needs wiring up: AI semantic suggestions

The semantic pass calls Colibri's internal Mantle Bedrock gateway, which
needs AWS SigV4 bearer-token signing — no clean PHP equivalent exists the
way `@aws/bedrock-token-generator` does for Node. Rather than reimplement
AWS request signing in PHP, `ws_search_handle_semantic()` proxies to
whatever URL you set in `WS_SEARCH_SEMANTIC_ENDPOINT` (see the commented-out
`define()` near the top of `ws-course-search.php`).

That means you need a small always-on service somewhere that:
- accepts `?state=XX&q=...`
- runs the same logic as `handleSemanticSearch()` in `server.js`
- returns `{ "products": [...] }`

Realistic options, roughly in order of effort:
1. Deploy `server.js`'s semantic piece as a small serverless function
   (Lambda, Vercel, etc.) and point `WS_SEARCH_SEMANTIC_ENDPOINT` at it.
2. Implement AWS SigV4 signing directly in PHP (more self-contained, more
   work, and this plugin would then own the AWS credential management).

Until one of those exists, semantic search degrades gracefully to "no
suggestions" — the keyword/typo-tolerant search is unaffected either way.

## Also still open

- Only the `nursing` profession's course-URL slug is confirmed against a
  real page. The other two are a best-guess slugification.
- Real (long-lived, service-level) AWS credentials — whatever's currently
  in the prototype's `.env` is a personal temporary SSO session token and
  will expire.
- This plugin talks to `test-api-ms.westernschools.com` (`WS_SEARCH_API_BASE`
  near the top of the file) — swap to the production Marketing API host
  before this goes live anywhere real.
