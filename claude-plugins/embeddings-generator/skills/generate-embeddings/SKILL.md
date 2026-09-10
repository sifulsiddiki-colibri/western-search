---
name: generate-embeddings
description: Generates catalog embeddings for the ws-course-search WordPress plugin's semantic search, for Western Schools or any other subsidiary's course catalog. Use when someone needs to (re)generate the JSON file uploaded on the plugin's Settings page, especially for a subsidiary whose catalog is too large to comfortably compute in one admin's browser tab.
---

# Generate catalog embeddings

This skill runs `scripts/generate-embeddings.mjs`, which computes real
sentence embeddings for a product catalog and writes them out in the exact
JSON shape the `ws-course-search` WordPress plugin's Settings page expects
to upload: `{"items": [{"productId", "sourceHash", "vector"}, ...]}`.

It uses the same model, pooling, and text-building formula as the plugin's
own browser-side embedding code (`Xenova/all-MiniLM-L6-v2`, mean pooling,
normalized, text = `name + ". " + tags`), so vectors generated here are
directly comparable — via cosine similarity — to vectors computed any other
way (the admin's browser, or a different subsidiary's run of this same
script). Don't change the model or text formula here without also changing
`ws_embedding_text()` in `ws-course-search.php` and `embedText()` in
`assets/embeddings.js` — all three must agree.

## Before running

1. **Get the catalog data.** Ask the user for a JSON array of products, one
   object per course/product:
   ```json
   [
     { "productId": "12345", "name": "Course Name", "tags": "optional keywords/description" },
     ...
   ]
   ```
   `tags` is optional; `productId` and `name` are required. If the user has
   the data in another shape (CSV, a database export, a different field
   naming), help them convert it to this shape first — don't guess at field
   mappings silently.
2. **Confirm the output destination** — where the resulting
   `embeddings.json` should be saved, so the user knows where to find it to
   upload via Settings → WS Course Search → "Upload embeddings JSON" on
   their WordPress site.
3. **Check for a previous embeddings file**, if this is a refresh rather
   than a first-time run. Passing one via `--previous` skips
   re-embedding anything whose `sourceHash` hasn't changed — much faster
   for a large catalog where most items are unchanged.

## Running it

From this plugin's directory (`claude-plugins/embeddings-generator/`),
install dependencies once, then run:

```
npm install
node scripts/generate-embeddings.mjs --input /path/to/catalog.json --output /path/to/embeddings.json
```

For an incremental refresh:

```
node scripts/generate-embeddings.mjs --input /path/to/catalog.json --output /path/to/embeddings.json --previous /path/to/old-embeddings.json
```

The first run downloads the embedding model (~30MB, same model the browser
uses) into a local cache — subsequent runs reuse it. A few hundred products
typically takes well under a minute; report progress from the script's
console output as it runs (it logs a running "Embedded X/Y" count).

## After running

Tell the user the output file's path and item count, and remind them it
uploads via **Settings → WS Course Search → "Upload embeddings JSON"** in
their WordPress admin. Don't upload it yourself — this skill only
generates the file; the actual upload happens through the WordPress admin
UI (or someone with site access doing it), since this skill has no
WordPress credentials and shouldn't need any.
