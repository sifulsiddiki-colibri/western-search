#!/usr/bin/env node
/**
 * Generates course-catalog embeddings offline, in the exact schema the
 * ws-course-search WordPress plugin's "Import embeddings" upload accepts:
 * { productId, vector[384], sourceHash }[].
 *
 * Uses the same model, pooling, and normalization as the plugin's own
 * browser-side assets/embeddings.js (Xenova/all-MiniLM-L6-v2, quantized,
 * mean pooling, normalized) so vectors from either source land in the
 * identical vector space and are directly comparable via cosine similarity.
 *
 * Usage:
 *   node scripts/generate-embeddings.js <input.json> <output.json>
 *
 * Input: a JSON array of { productId, name, tags } — tags may be a single
 * comma-joined string (the plugin's own tags_raw shape) or an array of tag
 * values.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("@xenova/transformers");

// Must build the exact same source text as assets/embeddings.js's
// embedText() and ws-course-search.php's ws_embedding_text() — name + tags,
// joined the same way — so the same course produces an identical sourceHash
// regardless of which of the three tools generated it.
function embedText(name, tagsRaw) {
  return [name, tagsRaw].filter(Boolean).join(". ");
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.filter(Boolean).join(", ");
  return tags || "";
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    console.error("Usage: node generate-embeddings.js <input.json> <output.json>");
    process.exit(1);
  }

  const items = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
  if (!Array.isArray(items)) {
    throw new Error("Input must be a JSON array of { productId, name, tags }");
  }

  const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: true,
  });

  const output = [];
  for (const [i, item] of items.entries()) {
    if (!item.productId || !item.name) {
      console.warn(`Skipping item ${i}: missing productId or name`);
      continue;
    }
    const tagsRaw = normalizeTags(item.tags);
    const text = embedText(item.name, tagsRaw);
    const sourceHash = crypto.createHash("md5").update(text).digest("hex");

    const result = await extractor(text, { pooling: "mean", normalize: true });
    const vector = Array.from(result.data);

    output.push({ productId: String(item.productId), vector, sourceHash });
    process.stdout.write(`\rEmbedded ${output.length}/${items.length}`);
  }
  process.stdout.write("\n");

  fs.writeFileSync(path.resolve(outputPath), JSON.stringify(output));
  console.log(`Wrote ${output.length} embeddings to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
