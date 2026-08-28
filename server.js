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

const PORT = process.env.PORT || 8080;
const API_BASE = "https://test-api-ms.westernschools.com";
const CATALOG_PAGE_SIZE = 100; // the API's hard per-request cap
// Course catalogs don't change minute-to-minute, so this can be generous —
// a short TTL just means more real users hit the several-second cold-cache
// cost (the Marketing API's own first-page latency) for no real freshness
// benefit. 6h keeps same-day catalog changes visible while making that
// cost rare in practice instead of a recurring "switch state, wait" hit.
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

// Semantic matching runs a small sentence-embedding model locally
// (Xenova/all-MiniLM-L6-v2, via @xenova/transformers) instead of calling
// any embeddings API — genuinely real embeddings, computed in-process,
// no external service and no per-query cost. Calibrated against this
// catalog: genuine matches score 0.4-0.8+, irrelevant/nonsense queries
// sit around 0.15-0.3 raw cosine similarity.
const SEMANTIC_SIMILARITY_THRESHOLD = 0.4;
const SEMANTIC_MIN_QUERY_LENGTH = 4; // too little signal for embeddings below this

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

// One pipeline call for many texts, rather than one embed() call per
// text — measured ~30% faster for a ~370-item catalog. output.dims is
// [texts.length, embeddingDim]; output.data is the flattened result.
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

function cosineSim(a, b) {
  // Both vectors are already L2-normalized (Xenova's `normalize: true`),
  // so the dot product IS the cosine similarity.
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function embeddingText(product) {
  const offering = (product.offerings || [])[0] || {};
  const tags = (offering.tags || []).map((t) => t.tagValue).join(", ");
  return [product.name, tags].filter(Boolean).join(". ");
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
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

function productsPageUrl(stateAbbv, licenseTypeId, offset) {
  const apiUrl = new URL(`${API_BASE}/marketing/products/withfilters`);
  apiUrl.searchParams.set("stateAbbvs", stateAbbv);
  apiUrl.searchParams.set("licenseTypeIds", licenseTypeId);
  apiUrl.searchParams.set("offset", String(offset));
  apiUrl.searchParams.set("limit", String(CATALOG_PAGE_SIZE));
  return apiUrl.toString();
}

// The first page's latency dominates (the Marketing API's own ~3.8s cold
// first-response cost) — once it tells us the total count, the remaining
// pages are independent requests and don't need to wait on each other.
async function fetchAllProducts(stateAbbv, licenseTypeId) {
  const first = await fetchJson(productsPageUrl(stateAbbv, licenseTypeId, 0));
  const products = [...(first.data.products || [])];

  let pagination;
  try {
    pagination = JSON.parse(first.headers["x-pagination"]);
  } catch (e) {
    return products;
  }

  const total = pagination.total ?? products.length;
  const remainingOffsets = [];
  for (let offset = CATALOG_PAGE_SIZE; offset < total; offset += CATALOG_PAGE_SIZE) {
    remainingOffsets.push(offset);
  }

  const pages = await Promise.all(
    remainingOffsets.map((offset) =>
      fetchJson(productsPageUrl(stateAbbv, licenseTypeId, offset))
    )
  );
  for (const page of pages) products.push(...(page.data.products || []));

  return products;
}

function stripHtml(html) {
  return (html || "").replace(/<[^>]*>/g, " ");
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Typo tolerance is scoped to short, curated fields (title/instructor/tags)
// — fuzzy-matching every word in a full description caused accidental
// edit-distance collisions with unrelated courses (a misspelled query
// matching dozens of courses that merely mention the correct word in
// passing, verified during initial tuning). Descriptions still get literal
// substring matching, just not fuzzy, to keep "match text buried in the
// description" behavior without that noise.
function buildSearchableTokens(product) {
  const offering = (product.offerings || [])[0] || {};
  const tagValues = (offering.tags || []).map((t) => t.tagValue).join(" ");
  const titleText = [product.name, product.instructor, tagValues]
    .filter(Boolean)
    .join(" ");
  const descriptionText = stripHtml(offering.description);
  return {
    titleTokens: tokenize(titleText),
    descriptionTokens: tokenize(descriptionText),
  };
}

// Standard DP Levenshtein edit distance.
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

// Scales allowed typos with query-token length, matching common
// typo-tolerant search conventions (Algolia/Elasticsearch use similar bands).
function allowedTypos(len) {
  if (len <= 4) return 0;
  if (len <= 8) return 1;
  return 2;
}

function productMatchesQuery({ titleTokens, descriptionTokens }, queryTokens) {
  return queryTokens.every((qt) => {
    const inTitle = titleTokens.some((t) => {
      // t.includes(qt) only — NOT qt.includes(t). The reverse direction
      // means any short common word (e.g. "a") is trivially a substring
      // of almost any query, matching nearly everything.
      if (t.includes(qt)) return true;
      const maxDist = allowedTypos(qt.length);
      return maxDist > 0 && levenshtein(qt, t) <= maxDist;
    });
    if (inTitle) return true;
    return descriptionTokens.some((t) => t.includes(qt));
  });
}

// The widget/frontend only ever reads a handful of fields off the stored
// product (see defaultProductUrl/formatMeta/creditBadge in
// search-widget.js) — sending the Marketing API's full raw object back to
// the browser instead (full HTML description, tracking-link-laden text,
// unused metadata) roughly doubled every response's size for no
// functional benefit.
function trimProduct(product) {
  const offering = (product.offerings || [])[0] || {};
  return {
    productId: product.productId,
    itemId: product.itemId,
    name: product.name,
    seoName: product.seoName,
    deliveryMethod: product.deliveryMethod,
    priceAll: product.priceAll,
    instructor: product.instructor,
    offerings: [
      {
        licenseType: offering.licenseType,
        creditHours: offering.creditHours,
        secondaryCreditHours: offering.secondaryCreditHours,
        isMandatory: offering.isMandatory,
        creditType: offering.creditType,
        rating: offering.rating,
      },
    ],
  };
}

// In-process catalog cache — no external search service. Keyed by
// state+profession since the same course can carry different pricing/
// approval per combination. A few hundred products per combo is small
// enough that scanning the whole cached list per search (rather than
// building any kind of index structure) is still comfortably fast.
const catalogCache = new Map(); // key: `${state}:${licenseTypeId}` -> { products, cachedAt }
const inFlightLoads = new Map(); // key -> in-progress load Promise

// Called both when a state is first selected (fire-and-forget prefetch)
// and from an actual search — those can race for the same state, so a
// second concurrent call awaits the same in-progress work instead of
// redundantly re-fetching the same catalog.
async function ensureCatalogReady(stateAbbv, licenseTypeId) {
  const key = `${stateAbbv}:${licenseTypeId}`;
  const cached = catalogCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CATALOG_TTL_MS) return;

  const inFlight = inFlightLoads.get(key);
  if (inFlight) return inFlight;

  const promise = loadCatalog(stateAbbv, licenseTypeId, key).finally(() => {
    inFlightLoads.delete(key);
  });
  inFlightLoads.set(key, promise);
  return promise;
}

async function loadCatalog(stateAbbv, licenseTypeId, key) {
  // A handful of catalog entries in the test API are broken placeholders
  // (name/description/seoName all null or empty) — not a real, clickable
  // course, so exclude them before they can surface as a search result.
  const products = (await fetchAllProducts(stateAbbv, licenseTypeId)).filter(
    (p) => p.name
  );

  // Batched (one pipeline call for all texts) rather than one embed() call
  // per product — measured ~30% faster for a ~370-product catalog.
  const vectors = products.length
    ? await embedBatch(products.map(embeddingText))
    : [];

  products.forEach((product, i) => {
    product.__tokens = buildSearchableTokens(product);
    product.__embedding = vectors[i];
  });

  catalogCache.set(key, { products, cachedAt: Date.now() });
}

function getCachedCatalog(stateAbbv, licenseTypeId) {
  const cached = catalogCache.get(`${stateAbbv}:${licenseTypeId}`);
  return cached ? cached.products : [];
}

// Warming a never-before-searched state costs several real seconds — not
// from anything in this code, but from the Marketing API itself: its
// *first* response for a fresh state+profession query takes ~3.8s
// (measured directly), vs ~200-350ms for subsequent paginated pages.
// Nothing to optimize there since it's an external dependency, but the
// cost doesn't have to land on the user's actual search — this endpoint
// lets the widget kick off warming the moment a state is picked, so it
// usually finishes while the user is still typing their query instead of
// blocking the search itself.
async function handleWarm(res, query) {
  const stateAbbv = query.get("state");
  if (!stateAbbv) {
    return sendJson(res, 400, { error: "state is required" });
  }
  try {
    const licenseTypeIds = await getAllLicenseTypeIds();
    await Promise.all(
      licenseTypeIds.map((id) =>
        ensureCatalogReady(stateAbbv, id).catch((err) => {
          console.error(`Failed to warm licenseTypeId ${id}:`, err.message);
        })
      )
    );
    sendJson(res, 200, { warmed: true });
  } catch (err) {
    sendJson(res, 502, { error: "Warm request failed" });
  }
}

// The on-demand "warm on state select" above still means the *first ever*
// visitor to a given state, in a freshly-started process, pays the full
// several-second Marketing API + embedding cost. Proactively warming every
// state in the background at startup (and again each TTL window) means
// that by the time a real visitor picks a state, it's almost always
// already cached — this is what actually makes the cold-start cost
// disappear in practice, not further optimizing the on-demand path itself.
const WARM_ALL_CONCURRENCY = 5; // bounded so this doesn't hammer the Marketing API
async function warmAllStatesInBackground() {
  try {
    const [{ data: states }, licenseTypeIds] = await Promise.all([
      fetchJson(`${API_BASE}/marketing/states`),
      getAllLicenseTypeIds(),
    ]);

    const combos = [];
    for (const s of states) {
      for (const id of licenseTypeIds) combos.push([s.stateAbbv, id]);
    }

    let nextIndex = 0;
    let completed = 0;
    async function worker() {
      while (nextIndex < combos.length) {
        const [stateAbbv, licenseTypeId] = combos[nextIndex++];
        try {
          await ensureCatalogReady(stateAbbv, licenseTypeId);
        } catch (err) {
          console.error(
            `Background pre-warm failed for ${stateAbbv}/${licenseTypeId}:`,
            err.message
          );
        }
        completed++;
      }
    }

    console.log(`Background pre-warm starting: ${combos.length} state+profession combos...`);
    await Promise.all(
      Array.from({ length: WARM_ALL_CONCURRENCY }, () => worker())
    );
    console.log(`Background pre-warm complete: ${completed}/${combos.length} combos cached.`);
  } catch (err) {
    console.error("Background pre-warm failed to start:", err.message);
  }
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
        ensureCatalogReady(stateAbbv, id).catch((err) => {
          console.error(`Failed to load catalog for licenseTypeId ${id}:`, err.message);
        })
      )
    );

    // Two independent passes rather than one blended score — a misspelled
    // query's own embedding is a poor match even for the *correct* course
    // ("cardic" scores only ~0.22 raw cosine against "Cardiac
    // Rehabilitation" despite being an obvious intended typo), so keyword
    // matching and semantic rescue need separate relevance rules.
    const queryTokens = tokenize(q);
    const seen = new Set();
    const keywordMatches = [];
    for (const id of licenseTypeIds) {
      for (const product of getCachedCatalog(stateAbbv, id)) {
        if (seen.has(product.productId)) continue;
        if (!productMatchesQuery(product.__tokens, queryTokens)) continue;
        seen.add(product.productId);
        keywordMatches.push({ ...trimProduct(product), matchType: "keyword" });
      }
    }
    keywordMatches.sort((a, b) => a.name.localeCompare(b.name));

    // Semantic rescue for queries with no (or weak) keyword overlap, e.g.
    // "back pain course" -> "Low Back Pain" despite "course" not appearing
    // in any title. Only added for products the keyword pass missed,
    // ranked by similarity, and only above a threshold calibrated against
    // this catalog — a query with no genuine semantic match correctly
    // returns nothing extra rather than forcing in a weak one.
    let semanticMatches = [];
    if (q.length >= SEMANTIC_MIN_QUERY_LENGTH) {
      const queryVector = await embed(q);
      const scored = [];
      for (const id of licenseTypeIds) {
        for (const product of getCachedCatalog(stateAbbv, id)) {
          if (seen.has(product.productId)) continue;
          if (!product.__embedding) continue;
          const score = cosineSim(queryVector, product.__embedding);
          if (score >= SEMANTIC_SIMILARITY_THRESHOLD) {
            scored.push({ product, score });
          }
        }
      }
      scored.sort((a, b) => b.score - a.score);
      semanticMatches = scored.map(({ product }) => {
        seen.add(product.productId);
        return { ...trimProduct(product), matchType: "semantic" };
      });
    }

    const products = [...keywordMatches, ...semanticMatches];

    sendJson(res, 200, {
      products: products.slice(0, limit),
      total: products.length,
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
  if (parsed.pathname === "/api/warm") {
    return handleWarm(res, parsed.searchParams);
  }
  if (parsed.pathname === "/api/search") {
    return handleSearch(res, parsed.searchParams);
  }
  serveStatic(res, parsed.pathname);
});

server.listen(PORT, () => {
  console.log(`Search prototype running at http://localhost:${PORT}`);
  warmAllStatesInBackground();
  setInterval(warmAllStatesInBackground, CATALOG_TTL_MS);
});
