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

const SEARCH_FIELDS = [
  "name",
  "instructor",
  "location.seminarName",
  "location.cityAndState",
  "offerings.description",
  "offerings.productCode",
  "offerings.tags.filterValue",
  "offerings.properties.description",
];

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

// The API's licenseTypeIds param is not a true OR-filter — when repeated,
// it silently only honors the first occurrence. Searching "every
// profession" therefore means one request per license type, merged here.
async function searchOneLicenseType(stateAbbv, licenseTypeId, filter, limit) {
  const apiUrl = new URL(`${API_BASE}/marketing/products/withfilters`);
  apiUrl.searchParams.set("stateAbbvs", stateAbbv);
  apiUrl.searchParams.set("licenseTypeIds", licenseTypeId);
  apiUrl.searchParams.set("filter", filter);
  apiUrl.searchParams.set("offset", "0");
  apiUrl.searchParams.set("limit", limit);

  const { data, headers } = await fetchJson(apiUrl.toString());
  let total = (data.products || []).length;
  try {
    total = JSON.parse(headers["x-pagination"]).total;
  } catch (e) {
    // header missing or malformed — fall back to page length
  }
  return { products: data.products || [], total };
}

async function handleSearch(res, query) {
  const stateAbbv = query.get("state");
  const q = (query.get("q") || "").trim();
  const limit = query.get("limit") || "8";

  if (!stateAbbv) {
    return sendJson(res, 400, { error: "state is required" });
  }
  if (q.length < 2) {
    return sendJson(res, 200, { products: [], total: 0 });
  }

  const filter = `[${SEARCH_FIELDS.map((f) => `${f}~~${q}`).join("||")}]`;

  try {
    const licenseTypeIds = await getAllLicenseTypeIds();
    const perType = await Promise.all(
      licenseTypeIds.map((id) =>
        searchOneLicenseType(stateAbbv, id, filter, limit)
      )
    );

    const seen = new Set();
    const products = [];
    for (const { products: page } of perType) {
      for (const product of page) {
        if (seen.has(product.productId)) continue;
        seen.add(product.productId);
        products.push(product);
      }
    }
    products.sort((a, b) => a.name.localeCompare(b.name));

    const total = perType.reduce((sum, r) => sum + r.total, 0);
    sendJson(res, 200, { products: products.slice(0, Number(limit)), total });
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
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "text/plain" });
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
