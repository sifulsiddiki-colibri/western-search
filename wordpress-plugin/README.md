# WS Course Search — WordPress plugin

Talks directly to a self-hosted Meilisearch instance via `wp_remote_*` calls —
no separate application server. Keyword search, typo tolerance, and AI
semantic matching are all handled through plain PHP `admin-ajax.php` handlers
in `ws-course-search.php`, exactly as originally recommended.

**Tested end-to-end** against a real WordPress instance (WordPress core +
the official SQLite integration plugin, no MySQL needed) — not just
reviewed. Verified through the actual browser: keyword search, typo
tolerance, semantic rescue with zero keyword overlap, correct "Suggested"
tag rendering, and — critically — that a nonsense query returns zero
results (proves the AI relevance gate works, not just that AI matching
"does something").

## How the AI matching works without a Node/Python service

Meilisearch's own built-in embedder (`huggingFace` source) computes text
embeddings server-side, for both indexed documents (automatically, from
each document's name + tags) and search queries. Getting a query's own
embedding vector out of Meilisearch (there's no dedicated "embed this text"
endpoint) uses a small trick in `ws_get_query_vector()`: add a throwaway
document containing just the query text, wait for Meilisearch to index
(and thus embed) it, read its vector back, then delete it. That vector is
then compared via raw cosine similarity (`ws_cosine_similarity()`) against
each semantic-search candidate's own stored vector, gated at a threshold —
not Meilisearch's built-in `_rankingScore`/`_rankingScoreDetails`, both of
which were tested and found unreliable as an absolute relevance signal
(gibberish queries scored as "confident" as genuine matches on both).

This means **zero embedding computation happens in PHP or in any separate
process** — it's all Meilisearch REST calls. The one thing this doesn't
eliminate: Meilisearch itself is still a separate service that has to run
somewhere reachable from the WordPress server. That's a smaller ask than
hosting a Node app (Meilisearch already needs to run for indexing, today),
but it's still real infrastructure — see "Still open" below.

An earlier version of this plugin proxied to a Node.js backend
(`server.js`) because computing embeddings appeared to need a Node/Python
embedding library. That backend is no longer part of the request path —
`server.js` still exists in the repo root as a convenience for iterating on
the widget's UI locally without a WordPress install, but it is not part of
the deployed system.

## Install

1. Get a Meilisearch instance (community/free edition) running somewhere
   reachable from your WordPress server, with an index named `courses`
   configured with a single `default` embedder:
   ```json
   {
     "default": {
       "source": "huggingFace",
       "model": "sentence-transformers/all-MiniLM-L6-v2",
       "pooling": "forceMean",
       "documentTemplate": "{{doc.name}}. {% for t in doc.tags %}{{t}}, {% endfor %}"
     }
   }
   ```
   The narrow template (name + tags only, not the full description) matters —
   embedding full descriptions dilutes relevance filtering because course
   descriptions share a lot of generic boilerplate language.
2. Point the plugin at it, either way:
   - **File access** (SFTP/SSH to the server): define `WS_MEILI_HOST` and
     `WS_MEILI_API_KEY` in `wp-config.php` before this plugin loads.
     Defaults to `http://localhost:7700` with no API key (local development
     only).
   - **WP Admin only** (managed/staging hosting, no file access): activate
     the plugin first (steps 3–4 below), then go to
     **Settings → WS Course Search** and enter the host + key there. Stored
     as options; takes priority over the constants above if both are set.
3. Install the plugin — either copy the `ws-course-search/` folder into
   `wp-content/plugins/` (file access), or **Plugins → Add New → Upload
   Plugin** and upload `ws-course-search.zip` (WP Admin only — this is also
   how to push an updated zip to replace an already-installed version, with
   no file access needed).
4. Activate it from the WordPress admin (Plugins → Installed Plugins).
5. Add `[ws_course_search]` to the homepage and product listing page
   templates (or directly in the block editor as a Shortcode block).
   Optional attribute: `[ws_course_search default_state="FL"]`.

## Still open

- ~~Where does Meilisearch actually run in production?~~ Fronted by a
  Cloudflare Worker (`meilisearch-mcp`, separate repo, built from Colibri's
  `mcp-agent-template`) that reverse-proxies `WS_MEILI_HOST` to the real
  Meilisearch instance, so the real API key never has to live in WordPress
  config at all — only a separate proxy token does. Production hosting for
  the *real* Meilisearch instance itself (Meilisearch Cloud vs. self-hosted)
  is a smaller, still-open follow-up once the trial window is evaluated.
- Only the `nursing` profession's course-URL slug is confirmed against a
  real page (in `assets/search-widget.js`). The other two are a
  best-guess slugification.
- The plugin currently points at `test-api-ms.westernschools.com` via
  `WS_MARKETING_API_BASE` — swap to the production Marketing API host
  before this goes live anywhere real.
