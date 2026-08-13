/**
 * Minimal same-origin proxy + static file server for local testing.
 *
 * The Marketing API sends no Access-Control-Allow-Origin header, so the
 * widget can't call it directly from the browser on any origin other than
 * its own. In production this proxy's job is played by a small WordPress
 * endpoint (PHP REST route or AJAX handler) — this stands in for that so
 * the search can be tested end-to-end today.
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Meilisearch } = require("meilisearch");

const PORT = process.env.PORT || 8080;
const API_BASE = "https://test-api-ms.westernschools.com";
const CATALOG_PAGE_SIZE = 100; // the API's hard per-request cap
const INDEX_TTL_MS = 15 * 60 * 1000; // how long before re-indexing a state+profession
const CANDIDATE_POOL_SIZE = 50; // over-fetched, then relevance-filtered + deduped
const RELEVANCE_THRESHOLD = 0.4; // raw cosine cutoff — see handleSearch

function cosineSim(a, b) {
  // Both vectors are already L2-normalized (Xenova's `normalize: true`),
  // so the dot product IS the cosine similarity.
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// Search runs on a self-hosted Meilisearch instance (community edition,
// free) instead of the earlier Mantle-LLM-judges-relevance approach —
// validated to be both faster (3-16ms vs 1.6-8s) and, once tuned, at least
// as accurate. Query embeddings are still computed locally (Xenova,
// unchanged from the original semantic-search implementation); Meilisearch
// just does the storage/ranking instead of a hand-rolled cosine-similarity
// loop and hand-rolled Levenshtein typo tolerance.
//
// Keyword and semantic matching run as two separate Meilisearch queries
// (see handleSearch) rather than one hybrid call — a blended hybrid score
// dilutes typo matches, since a misspelled query's own embedding is a
// poor match even for the *correct* course.
const MEILI_HOST = process.env.MEILI_HOST || "http://localhost:7700";
const MEILI_API_KEY = process.env.MEILI_API_KEY || "";
const meiliClient = new Meilisearch({ host: MEILI_HOST, apiKey: MEILI_API_KEY });
const meiliIndex = meiliClient.index("courses");
let meiliConfigured = false;
async function ensureMeiliConfigured() {
  if (meiliConfigured) return;
  // .waitTask() matters here — updateSettings() only returns once the task
  // is *enqueued*, not once it's actually applied. Without waiting, a
  // search immediately after this could run against an index whose
  // embedder isn't configured yet (verified: caused an intermittent
  // "0 results" race on a cold index before this fix).
  await meiliIndex
    .updateSettings({
      embedders: { default: { source: "userProvided", dimensions: 384 } },
      filterableAttributes: ["stateAbbv", "licenseTypeId"],
      searchableAttributes: ["name", "instructor", "tags", "description"],
    })
    .waitTask();
  meiliConfigured = true;
}

let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    const { pipeline } = require("@xenova/transformers");
    embedderPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  return embedderPromise;
}
async function embed(text) {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ data: JSON.parse(body), headers: res.headers });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

// License types rarely change — fetched once and reused so every search
// can run across all professions without the browser needing to pick one.
let licenseTypesCache = null;
async function getAllLicenseTypeIds() {
  if (!licenseTypesCache) {
    const { data } = await fetchJson(`${API_BASE}/marketing/licenseTypes`);
    licenseTypesCache = data;
  }
  return licenseTypesCache.map((lt) => lt.licenseTypeId);
}

async function handleLookups(res) {
  try {
    const [licenseTypes, states] = await Promise.all([
      fetchJson(`${API_BASE}/marketing/licenseTypes`).then((r) => r.data),
      fetchJson(`${API_BASE}/marketing/states`).then((r) => r.data),
    ]);
    licenseTypesCache = licenseTypes;
    sendJson(res, 200, { licenseTypes, states });
  } catch (err) {
    sendJson(res, 502, { error: "Failed to load lookups" });
  }
}

async function fetchAllProducts(stateAbbv, licenseTypeId) {
  const products = [];
  let offset = 0;
  while (true) {
    const apiUrl = new URL(`${API_BASE}/marketing/products/withfilters`);
    apiUrl.searchParams.set("stateAbbvs", stateAbbv);
    apiUrl.searchParams.set("licenseTypeIds", licenseTypeId);
    apiUrl.searchParams.set("offset", String(offset));
    apiUrl.searchParams.set("limit", String(CATALOG_PAGE_SIZE));

    const { data, headers } = await fetchJson(apiUrl.toString());
    products.push(...(data.products || []));

    let pagination;
    try {
      pagination = JSON.parse(headers["x-pagination"]);
    } catch (e) {
      break;
    }
    if (!pagination.hasMore || pagination.nextOffset == null) break;
    offset = pagination.nextOffset;
  }
  return products;
}

function stripHtml(html) {
  return (html || "").replace(/<[^>]*>/g, " ");
}

function embeddingText(product) {
  const offering = (product.offerings || [])[0] || {};
  const tags = (offering.tags || []).map((t) => t.tagValue).join(", ");
  return [product.name, tags].filter(Boolean).join(". ");
}

// A product can legitimately appear under multiple states/professions with
// different pricing/approval per combination, so the Meilisearch primary
// key includes state+license — keying by productId alone would let a
// later state's indexing pass silently overwrite an earlier state's data.
function meiliDocId(product, stateAbbv, licenseTypeId) {
  return `${product.productId}_${stateAbbv}_${licenseTypeId}`;
}

const indexedCombos = new Map(); // key: `${state}:${licenseTypeId}` -> last-indexed timestamp

async function ensureIndexed(stateAbbv, licenseTypeId) {
  const key = `${stateAbbv}:${licenseTypeId}`;
  const lastIndexed = indexedCombos.get(key);
  if (lastIndexed && Date.now() - lastIndexed < INDEX_TTL_MS) return;

  await ensureMeiliConfigured();

  // A handful of catalog entries in the test API are broken placeholders
  // (name/description/seoName all null or empty) — not a real, clickable
  // course, so exclude them before they can surface as a search result.
  const products = (await fetchAllProducts(stateAbbv, licenseTypeId)).filter(
    (p) => p.name
  );

  const documents = [];
  for (const product of products) {
    const offering = (product.offerings || [])[0] || {};
    const vector = await embed(embeddingText(product));
    documents.push({
      id: meiliDocId(product, stateAbbv, licenseTypeId),
      name: product.name,
      instructor: product.instructor || "",
      tags: (offering.tags || []).map((t) => t.tagValue),
      description: stripHtml(offering.description).slice(0, 2000),
      stateAbbv,
      licenseTypeId,
      product, // full raw product, returned as-is in search results
      _vectors: { default: vector },
    });
  }

  if (documents.length) {
    // Same reasoning as ensureMeiliConfigured() above — wait for the
    // documents to actually finish indexing, not just get enqueued.
    await meiliIndex.addDocuments(documents, { primaryKey: "id" }).waitTask();
  }
  indexedCombos.set(key, Date.now());
}

async function handleSearch(res, query) {
  const stateAbbv = query.get("state");
  const q = (query.get("q") || "").trim();
  const limit = Number(query.get("limit") || "8");

  if (!stateAbbv) {
    return sendJson(res, 400, { error: "state is required" });
  }
  if (q.length < 2) {
    return sendJson(res, 200, { products: [], total: 0 });
  }

  try {
    const licenseTypeIds = await getAllLicenseTypeIds();
    await Promise.all(
      licenseTypeIds.map((id) =>
        ensureIndexed(stateAbbv, id).catch((err) => {
          console.error(`Failed to index licenseTypeId ${id}:`, err.message);
        })
      )
    );

    // Two separate passes rather than one hybrid query — verified this
    // matters: a blended hybrid score dilutes typo matches (a misspelled
    // query's own embedding is a poor match even for the *correct*
    // course — "cardic" scores only 0.217 raw cosine against "Cardiac
    // Rehabilitation" despite being an obvious intended typo), so keyword
    // matching and semantic rescue need independent relevance rules, not
    // one shared score.

    // Pass 1: pure keyword/typo search. Meilisearch's own native engine
    // handles this reliably (typo tolerance included) — no relevance
    // gating needed, unlike the semantic pass below.
    const keywordResult = await meiliIndex.search(q, {
      filter: `stateAbbv = "${stateAbbv}"`,
      limit: CANDIDATE_POOL_SIZE,
      attributesToRetrieve: ["product"],
    });

    const seen = new Set();
    const products = [];
    for (const hit of keywordResult.hits) {
      const id = hit.product.productId;
      if (seen.has(id)) continue;
      seen.add(id);
      products.push({ ...hit.product, matchType: "keyword" });
    }

    // Pass 2: semantic rescue for queries with no (or weak) keyword
    // overlap, e.g. "back pain course" -> "Low Back Pain" despite "course"
    // not appearing in any title. Gated by raw cosine similarity computed
    // from the retrieved stored vectors — NOT Meilisearch's hybrid
    // _rankingScore, which is normalized relative to the current result
    // set and doesn't behave like an absolute relevance signal (verified:
    // pure gibberish scored 0.61+ on that scale, indistinguishable from
    // genuine matches). Raw cosine reproduces the original calibration:
    // genuine matches 0.4-0.8+, irrelevant/nonsense queries 0.15-0.3.
    const vector = await embed(q);
    const semanticResult = await meiliIndex.search(q, {
      vector,
      hybrid: { embedder: "default", semanticRatio: 1 },
      filter: `stateAbbv = "${stateAbbv}"`,
      limit: CANDIDATE_POOL_SIZE,
      attributesToRetrieve: ["product"],
      retrieveVectors: true,
    });

    let semanticAdditions = 0;
    for (const hit of semanticResult.hits) {
      const id = hit.product.productId;
      if (seen.has(id)) continue;
      const docVector = hit._vectors?.default?.embeddings?.[0];
      const rawCosine = docVector ? cosineSim(vector, docVector) : 0;
      if (rawCosine < RELEVANCE_THRESHOLD) continue;
      seen.add(id);
      products.push({ ...hit.product, matchType: "semantic" });
      semanticAdditions++;
    }

    // estimatedTotalHits is meaningful for the plain-keyword pass (unlike
    // the hybrid/vector case above) — using products.length alone would
    // silently cap broad queries at CANDIDATE_POOL_SIZE instead of
    // reporting how many actually match (verified: a 2-char query hit
    // exactly the pool size, not the true ~100+ match count).
    sendJson(res, 200, {
      products: products.slice(0, limit),
      total: (keywordResult.estimatedTotalHits ?? products.length) + semanticAdditions,
    });
  } catch (err) {
    console.error("Search failed:", err.message);
    sendJson(res, 502, { error: "Search request failed" });
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function serveStatic(res, urlPath) {
  const filePath = path.join(
    __dirname,
    urlPath === "/" ? "index.html" : urlPath
  );
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "text/plain",
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);

  if (parsed.pathname === "/api/lookups") {
    return handleLookups(res);
  }
  if (parsed.pathname === "/api/search") {
    return handleSearch(res, parsed.searchParams);
  }
  serveStatic(res, parsed.pathname);
});

server.listen(PORT, () => {
  console.log(`Search prototype running at http://localhost:${PORT}`);
});
