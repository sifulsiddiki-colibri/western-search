# ws-embeddings-generator

A Claude Code plugin that generates catalog embeddings for the
`ws-course-search` WordPress plugin's semantic search — for Western
Schools or any other Colibri subsidiary's course catalog.

The Western Schools instance of `ws-course-search` computes embeddings in
the admin's own browser (Settings → WS Course Search → "Refresh search
embeddings"). That's fine for a few hundred products, but doesn't scale
well to a much larger subsidiary catalog, or to generating embeddings
without someone sitting at a browser tab waiting for it to finish. This
plugin does the same computation offline instead, and produces a JSON file
that uploads through the same Settings page's **"Upload embeddings JSON"**
file input.

## Compatibility

Uses the exact same model, pooling, and text-building formula as the
plugin's own browser-side code:

- Model: `Xenova/all-MiniLM-L6-v2`, quantized, via `@xenova/transformers`
- Pooling: mean, normalized
- Embedding text: `[name, tags].filter(Boolean).join(". ")` — matches
  `ws_embedding_text()` in `ws-course-search.php` and `embedText()` in
  `assets/embeddings.js` exactly, so a `sourceHash` computed here means the
  same thing as one computed by the plugin itself.

If any of those three ever change in the plugin, this script needs the
matching change too, or vectors/hashes generated here stop being
comparable to ones computed any other way.

## Usage

Either invoke the `generate-embeddings` skill in Claude Code (see
`skills/generate-embeddings/SKILL.md`), or run the script directly:

```
npm install
node scripts/generate-embeddings.mjs --input catalog.json --output embeddings.json
```

**Input** (`catalog.json`) — a JSON array of products:

```json
[
  { "productId": "12345", "name": "Course Name", "tags": "optional keywords" }
]
```

`tags` is optional; `productId` and `name` are required — anything missing
either is skipped with a warning, not silently dropped.

**Output** (`embeddings.json`) — ready to upload as-is:

```json
{
  "items": [
    { "productId": "12345", "sourceHash": "...", "vector": [0.01, -0.02, ...] }
  ]
}
```

For an incremental refresh (skip items that haven't changed since a
previous run):

```
node scripts/generate-embeddings.mjs --input catalog.json --output embeddings.json --previous old-embeddings.json
```

Then upload `embeddings.json` via **Settings → WS Course Search → Upload
embeddings JSON** in the target WordPress site's admin.

## What this doesn't do

- Doesn't talk to WordPress at all — no credentials, no upload. It only
  produces a file; a human uploads it.
- Doesn't fetch catalog data from anywhere — the input JSON has to be
  provided already extracted from whatever system holds that subsidiary's
  product data (a Marketing API, a database export, a spreadsheet turned
  into JSON, etc.).
