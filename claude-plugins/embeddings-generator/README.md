# embeddings-generator

A Claude Code plugin that generates course-catalog embeddings offline, in
the exact JSON schema the `ws-course-search` WordPress plugin's admin
"Import embeddings" upload accepts: `{ productId, vector[384], sourceHash }[]`.

Built so nobody has to reverse-engineer the plugin's embedding pipeline
(model, pooling, normalization, text-building, hashing) to generate a
compatible file by hand — see `skills/generate-embeddings/SKILL.md` for
when Claude should reach for this, or run it directly:

```
npm install
node scripts/generate-embeddings.js <input.json> <output.json>
```

`<input.json>` is a JSON array of `{ productId, name, tags }` (`tags` is
optional — a comma-joined string or an array of tag values). `<output.json>`
is ready to upload as-is via Settings → WS Course Search → "Import
embeddings" in any site running the plugin.

Uses `Xenova/all-MiniLM-L6-v2` (quantized, mean pooling, normalized) via
`@xenova/transformers` — the same model and settings as the plugin's own
`assets/embeddings.js`, so vectors generated here and vectors computed live
in a browser land in the identical vector space and compare correctly via
cosine similarity.
