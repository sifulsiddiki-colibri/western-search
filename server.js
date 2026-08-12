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
const CATALOG_TTL_MS = 15 * 60 * 1000;

// Semantic matching: runs on Colibri's internal "Mantle" Bedrock gateway
// (an OpenAI-compatible facade in front of Bedrock-hosted OpenAI models —
// direct native bedrock:InvokeModel is explicitly denied for the intern
// role, and this gateway has no embeddings endpoint, only the Responses
// API), so this asks the LLM to directly judge relevance against the
// candidate list rather than comparing embedding vectors. A full-catalog
// call takes ~5-6s, too slow to block the main results, so this is called
// from a separate endpoint the widget fetches after the fast keyword pass
// already rendered.
const MANTLE_BASE_URL = "https://bedrock-mantle.us-east-2.api.aws/openai/v1";
const MANTLE_MODEL = "openai.gpt-5.4";
const MANTLE_PROJECT = "proj_tvmtkugy6lqg5wkhobwy";
const MANTLE_TOKEN_TTL_MS = 30 * 60 * 1000; // conservative; token itself allows up to 12h
const SEMANTIC_RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const SEMANTIC_MAX_RESULTS = 8;

let mantleToken = null;
let mantleTokenFetchedAt = 0;
async function getMantleToken() {
  if (mantleToken && Date.now() - mantleTokenFetchedAt < MANTLE_TOKEN_TTL_MS) {
    return mantleToken;
  }
  const { getToken } = require("@aws/bedrock-token-generator");
  mantleToken = await getToken({
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    },
    region: process.env.AWS_REGION,
  });
  mantleTokenFetchedAt = Date.now();
  return mantleToken;
}

const semanticResultCache = new Map(); // key: `${state}:${q}` -> { relevantIds, fetchedAt }

async function judgeRelevance(query, candidates) {
  const token = await getMantleToken();
  const res = await fetch(`${MANTLE_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "OpenAI-Project": MANTLE_PROJECT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MANTLE_MODEL,
      input: `Query: "${query}"\n\nCandidate courses (id: name):\n${candidates
        .map((c) => `${c.id}: ${c.name}`)
        .join("\n")}\n\nReturn at most ${SEMANTIC_MAX_RESULTS} course ids that are genuinely relevant to the query's meaning, even without exact keyword overlap, ordered from most to least relevant. If nothing is genuinely relevant, return an empty list rather than guessing.`,
      text: {
        format: {
          type: "json_schema",
          name: "relevant_courses",
          schema: {
            type: "object",
            properties: {
              relevantIds: { type: "array", items: { type: "string" } },
            },
            required: ["relevantIds"],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Mantle request failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = data.output?.[0]?.content?.[0]?.text;
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.relevantIds) ? parsed.relevantIds : [];
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

// The Marketing API's own filter (`~~`) is a literal substring match with
// no typo tolerance — "cardic" finds nothing even though "Cardiac..." is
// right there. Instead of relying on it, we cache each state+profession's
// full catalog in memory (paginating past the API's 100-per-request cap)
// and do our own tokenized, typo-tolerant matching against it. This also
// fixes the licenseTypeIds "first value wins" quirk, since each profession
// gets its own cached catalog fetched with a single license type.
const catalogCache = new Map(); // key: `${state}:${licenseTypeId}` -> { products, fetchedAt }

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

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Typo tolerance is scoped to short, curated fields (title/instructor/tags/
// code) — fuzzy-matching every word in a 200+ word description caused
// accidental edit-distance-1 collisions with unrelated courses (e.g.
// "cardic" matched dozens of courses that merely mention "cardiac" in
// passing). Descriptions still get literal substring matching, just not
// fuzzy, to keep the "match text buried in the description" behavior
// without the noise.
function buildSearchableTokens(product) {
  const offering = (product.offerings || [])[0] || {};
  const tagValues = (offering.tags || []).map((t) => t.tagValue).join(" ");
  const titleText = [
    product.name,
    product.instructor,
    offering.productCode,
    tagValues,
  ]
    .filter(Boolean)
    .join(" ");
  const descriptionText = [
    stripHtml(offering.description),
    stripHtml(offering.properties && offering.properties.description),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    titleTokens: tokenize(titleText),
    descriptionTokens: tokenize(descriptionText),
  };
}

async function getCatalog(stateAbbv, licenseTypeId) {
  const key = `${stateAbbv}:${licenseTypeId}`;
  const cached = catalogCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return cached.products;
  }
  // A handful of catalog entries in the test API are broken placeholders
  // (name/description/seoName all null or empty) — not a real, clickable
  // course, so exclude them before they can surface as a search result.
  const products = (await fetchAllProducts(stateAbbv, licenseTypeId)).filter(
    (p) => p.name
  );
  for (const p of products) {
    p.__tokens = buildSearchableTokens(p);
  }
  catalogCache.set(key, { products, fetchedAt: Date.now() });
  return products;
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

  const queryTokens = tokenize(q);

  try {
    const licenseTypeIds = await getAllLicenseTypeIds();
    const catalogs = await Promise.all(
      licenseTypeIds.map((id) =>
        getCatalog(stateAbbv, id).catch((err) => {
          console.error(`Failed to load catalog for licenseTypeId ${id}:`, err.message);
          return [];
        })
      )
    );

    const seen = new Set();
    const keywordMatches = [];
    for (const catalog of catalogs) {
      for (const product of catalog) {
        if (seen.has(product.productId)) continue;
        if (!productMatchesQuery(product.__tokens, queryTokens)) continue;
        seen.add(product.productId);
        keywordMatches.push(product);
      }
    }
    keywordMatches.sort((a, b) => a.name.localeCompare(b.name));

    const products = keywordMatches.map((p) => ({ ...p, matchType: "keyword" }));

    sendJson(res, 200, {
      products: products.slice(0, limit).map(({ __tokens, ...p }) => p),
      total: products.length,
    });
  } catch (err) {
    sendJson(res, 502, { error: "Search request failed" });
  }
}

// Separate, slower endpoint: the LLM relevance-judging call takes ~5-6s
// against the full catalog, so the widget calls this after the fast
// keyword pass above has already rendered, and merges results in when
// they arrive rather than blocking the initial response.
async function handleSemanticSearch(res, query) {
  const stateAbbv = query.get("state");
  const q = (query.get("q") || "").trim();

  if (!stateAbbv) {
    return sendJson(res, 400, { error: "state is required" });
  }
  if (q.length < 4) {
    return sendJson(res, 200, { products: [] });
  }

  const cacheKey = `${stateAbbv}:${q.toLowerCase()}`;
  const cached = semanticResultCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < SEMANTIC_RESULT_CACHE_TTL_MS) {
    return sendJson(res, 200, { products: cached.products });
  }

  try {
    const licenseTypeIds = await getAllLicenseTypeIds();
    const catalogs = await Promise.all(
      licenseTypeIds.map((id) =>
        getCatalog(stateAbbv, id).catch((err) => {
          console.error(`Failed to load catalog for licenseTypeId ${id}:`, err.message);
          return [];
        })
      )
    );

    const byId = new Map();
    for (const catalog of catalogs) {
      for (const product of catalog) byId.set(product.productId, product);
    }
    const candidates = Array.from(byId.values()).map((p) => ({
      id: p.productId,
      name: p.name,
    }));

    const relevantIds = await judgeRelevance(q, candidates);
    const products = relevantIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((p) => ({ ...p, matchType: "semantic" }));

    const clean = products.map(({ __tokens, ...p }) => p);
    semanticResultCache.set(cacheKey, { products: clean, fetchedAt: Date.now() });
    sendJson(res, 200, { products: clean });
  } catch (err) {
    console.error("Semantic search failed:", err.message);
    // Progressive enhancement — the fast keyword results already
    // rendered, so a failure here should be quiet, not break the page.
    sendJson(res, 200, { products: [] });
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
  if (parsed.pathname === "/api/search/semantic") {
    return handleSemanticSearch(res, parsed.searchParams);
  }
  serveStatic(res, parsed.pathname);
});

server.listen(PORT, () => {
  console.log(`Search prototype running at http://localhost:${PORT}`);
});
