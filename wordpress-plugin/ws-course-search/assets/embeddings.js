/**
 * Computes sentence embeddings entirely in the browser — no external
 * embeddings API, no Meilisearch, no server-side model. Used both by the
 * admin-triggered catalog embedding refresh (admin-embeddings.js) and by
 * the live search widget when computing a query's own embedding.
 *
 * All model/runtime assets are self-hosted (see assets/vendor/ and
 * assets/models/, copied from @xenova/transformers's own local cache) —
 * nothing is fetched from an external CDN.
 */
import { pipeline, env } from "./vendor/transformers.min.js";

const config = window.wsEmbeddingsConfig || {};

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = config.modelsUrl || "";
env.backends.onnx.wasm.wasmPaths = config.wasmUrl || "";

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
  }
  return extractorPromise;
}

// name + tags — must exactly match the PHP side's ws_embedding_text() so
// catalog and query embeddings land in the same vector space.
export function embedText(name, tagsRaw) {
  return [name, tagsRaw].filter(Boolean).join(". ");
}

export async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}
