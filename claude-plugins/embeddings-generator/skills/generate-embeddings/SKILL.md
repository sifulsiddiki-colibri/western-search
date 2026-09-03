---
name: generate-embeddings
description: Generate course-catalog embeddings offline for the ws-course-search WordPress plugin (or any subsidiary reusing the same schema). Use this when the user has a course/product catalog and wants an embeddings JSON file to upload via Settings -> WS Course Search's "Import embeddings", or to hand to another ws-course-search install.
---

# Generate embeddings offline

Produces a JSON file of `{ productId, vector[384], sourceHash }` objects —
the exact schema the `ws-course-search` plugin's admin "Import embeddings"
upload accepts (see `ws_upsert_embeddings()` in `ws-course-search.php`).
Runs entirely in Node via `@xenova/transformers`, using the same
`Xenova/all-MiniLM-L6-v2` model, mean pooling, and normalization as the
plugin's own browser-side `assets/embeddings.js` — vectors from either
source land in the identical vector space, so this is interchangeable with
clicking "Refresh search embeddings" in the browser.

## When to use this

- The user has a course/product catalog (for this subsidiary or another
  one reusing the same plugin) and wants embeddings computed without
  opening WordPress admin and waiting on the browser to churn through the
  whole catalog.
- The user wants to generate embeddings for a *different* Colibri brand's
  catalog than the one already indexed on a live site.

## Steps

1. Get the catalog into a JSON array. Each item needs at minimum
   `productId` and `name`; `tags` is optional (a comma-joined string, or an
   array of tag values — either is accepted). Ask the user where this data
   comes from if they haven't said (a database export, an API response, a
   CSV to convert) — do not invent catalog content.
2. Install dependencies once, if `node_modules` isn't already present:
   ```
   cd claude-plugins/embeddings-generator && npm install
   ```
3. Run the generator:
   ```
   node scripts/generate-embeddings.js <input.json> <output.json>
   ```
   First run downloads the model (~90MB, cached afterward by
   `@xenova/transformers` in its usual cache directory).
4. Hand `<output.json>` back to the user, or upload it directly if they're
   working against a live site: Settings → WS Course Search → "Import
   embeddings".

## Do not

- Do not hand-write or fabricate `vector` values — they only ever come from
  actually running the model via this script.
- Do not change the model, pooling mode (`mean`), or normalization
  (`normalize: true`) — doing so would produce vectors in a different space
  than the ones the plugin's browser-side code and existing catalog
  embeddings already use, making cosine-similarity comparisons meaningless.
