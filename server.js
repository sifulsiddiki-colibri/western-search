/**
 * Minimal same-origin proxy + static file server for local testing.
 *
 * The Marketing API sends no Access-Control-Allow-Origin header, so the
 * widget can't call it directly from the browser on any origin other than
 * its own. In production this proxy's job is played by a small WordPress
 * endpoint (PHP REST route or AJAX handler) — this stands in for that so
 * the search can be tested end-to-end today. Zero npm dependencies.
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
  const products = await fetchAllProducts(stateAbbv, licenseTypeId);
  products.forEach((p) => {
    p.__tokens = buildSearchableTokens(p);
  });
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
    const products = [];
    for (const catalog of catalogs) {
      for (const product of catalog) {
        if (seen.has(product.productId)) continue;
        if (!productMatchesQuery(product.__tokens, queryTokens)) continue;
        seen.add(product.productId);
        products.push(product);
      }
    }
    products.sort((a, b) => a.name.localeCompare(b.name));

    sendJson(res, 200, {
      products: products.slice(0, limit).map(({ __tokens, ...p }) => p),
      total: products.length,
    });
  } catch (err) {
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
