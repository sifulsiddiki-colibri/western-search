#!/usr/bin/env node
/**
 * Generates catalog embeddings for the ws-course-search WordPress plugin's
 * "upload embeddings JSON" settings-page feature -- usable for any
 * subsidiary's catalog, not just Western Schools.
 *
 * Input:  a JSON array of products: [{ "productId", "name", "tags"? }, ...]
 * Output: { "items": [{ "productId", "sourceHash", "vector" }, ...] }
 *
 * Uses the exact same model/pooling/normalization as the plugin's own
 * browser-side embeddings.js (Xenova/all-MiniLM-L6-v2, mean pooling,
 * normalized) and the same text-building formula as its PHP side's
 * ws_embedding_text() -- [name, tags].filter(Boolean).join(". ") -- so
 * vectors generated here land in the same space as ones computed any
 * other way, and source hashes line up with the plugin's own change
 * detection.
 *
 * Usage:
 *   node generate-embeddings.mjs --input catalog.json --output embeddings.json
 *   node generate-embeddings.mjs --input catalog.json --output embeddings.json --previous old-embeddings.json
 *     (skips items whose sourceHash matches --previous, for incremental refreshes)
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pipeline } from "@xenova/transformers";

function parseArgs(argv) {
  const args = { batchSize: 32 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i];
    else if (a === "--output") args.output = argv[++i];
    else if (a === "--previous") args.previous = argv[++i];
    else if (a === "--batch-size") args.batchSize = parseInt(argv[++i], 10);
  }
  return args;
}

// Must exactly match the PHP side's ws_embedding_text() so a hash computed
// here means the same thing as one computed there.
function embedText(name, tags) {
  return [name, tags].filter(Boolean).join(". ");
}

function sourceHash(text) {
  return createHash("md5").update(text, "utf8").digest("hex");
}

let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
  }
  return embedderPromise;
}

// One pipeline call per batch rather than per item -- meaningfully faster
// for a catalog of any real size (same pattern as server.js's embedBatch()
// in the western-search repo).
async function embedBatch(texts) {
  const extractor = await getEmbedder();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const [count, dim] = output.dims;
  const vectors = [];
  for (let i = 0; i < count; i++) {
    vectors.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
  }
  return vectors;
}

async function loadPreviousHashes(path) {
  if (!path) return new Map();
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    const items = Array.isArray(raw.items) ? raw.items : [];
    return new Map(items.map((item) => [item.productId, item.sourceHash]));
  } catch (err) {
    console.error(
      `Warning: couldn't read --previous file (${path}): ${err.message}. Treating all items as new.`
    );
    return new Map();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    console.error(
      "Usage: node generate-embeddings.mjs --input catalog.json --output embeddings.json [--previous old-embeddings.json] [--batch-size 32]"
    );
    process.exit(1);
  }

  const catalog = JSON.parse(await readFile(args.input, "utf8"));
  if (!Array.isArray(catalog)) {
    console.error('Input must be a JSON array: [{ "productId", "name", "tags"? }, ...]');
    process.exit(1);
  }

  const previousHashes = await loadPreviousHashes(args.previous);

  const pending = [];
  let skipped = 0;
  for (const product of catalog) {
    if (!product || !product.productId || !product.name) {
      console.error(`Skipping malformed entry (needs productId + name): ${JSON.stringify(product)}`);
      continue;
    }
    const text = embedText(product.name, product.tags);
    const hash = sourceHash(text);
    if (previousHashes.get(product.productId) === hash) {
      skipped++;
      continue;
    }
    pending.push({ productId: product.productId, text, sourceHash: hash });
  }

  console.log(
    `${catalog.length} products in catalog, ${skipped} unchanged (skipped), ${pending.length} to embed.`
  );

  const items = [];
  for (let i = 0; i < pending.length; i += args.batchSize) {
    const batch = pending.slice(i, i + args.batchSize);
    const vectors = await embedBatch(batch.map((p) => p.text));
    batch.forEach((p, j) => {
      items.push({ productId: p.productId, sourceHash: p.sourceHash, vector: vectors[j] });
    });
    console.log(`Embedded ${Math.min(i + args.batchSize, pending.length)}/${pending.length}`);
  }

  await writeFile(args.output, JSON.stringify({ items }), "utf8");
  console.log(`Wrote ${items.length} embeddings to ${args.output}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
