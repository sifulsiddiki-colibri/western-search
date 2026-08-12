/**
 * Western Schools course search widget.
 * Framework-free — designed to drop into the WordPress theme via a single
 * <div id="ws-course-search"></div> + this script tag.
 *
 * Fast keyword/typo-tolerant search renders immediately from /api/search;
 * AI-judged semantic suggestions merge in separately from
 * /api/search/semantic once that (slower, LLM-backed) call resolves.
 */
(function () {
  // Same-origin backend — server.js's /api/* routes when running standalone
  // (this repo's local prototype), or WordPress's admin-ajax.php when
  // wp_localize_script has set up window.wsSearchConfig (the ws-course-search
  // plugin). Either way the Marketing API itself sends no CORS headers, so
  // the browser can never call it directly — something same-origin always
  // sits in between.
  const WP_CONFIG = typeof wsSearchConfig !== "undefined" ? wsSearchConfig : null;
  const SEARCH_ENDPOINT = WP_CONFIG
    ? `${WP_CONFIG.ajaxUrl}?action=ws_search`
    : "/api/search";
  const SEMANTIC_ENDPOINT = WP_CONFIG
    ? `${WP_CONFIG.ajaxUrl}?action=ws_search_semantic`
    : "/api/search/semantic";
  const LOOKUPS_ENDPOINT = WP_CONFIG
    ? `${WP_CONFIG.ajaxUrl}?action=ws_search_lookups`
    : "/api/lookups";

  const DEBOUNCE_MS = 150;
  const MIN_QUERY_LENGTH = 2;
  const MIN_SEMANTIC_QUERY_LENGTH = 4;
  const TYPEAHEAD_LIMIT = 7;
  const EXPANDED_LIMIT = 50;
  const STORAGE_KEY = "wsSearchContext";
  const RECENT_KEY = "wsSearchRecent";
  const MAX_RECENT = 5;

  function withParams(endpoint, params) {
    const joiner = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}${joiner}${params.toString()}`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function highlightMatch(text, query) {
    const safeText = escapeHtml(text);
    if (!query) return safeText;
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return safeText;
    const before = escapeHtml(text.slice(0, idx));
    const match = escapeHtml(text.slice(idx, idx + query.length));
    const after = escapeHtml(text.slice(idx + query.length));
    return `${before}<mark>${match}</mark>${after}`;
  }

  // Confirmed live pattern: westernschools.com/{profession}/courses/{slug}/?state={ST}
  // e.g. westernschools.com/nursing/courses/behavioral-health-course-bundle-15-hours/?state=US
  // Only the "nursing" profession segment is confirmed — the other two are
  // a best-guess slugification pending a check against the live site.
  const PROFESSION_SLUGS = {
    Nursing: "nursing",
    "Certified Nursing Assistant": "certified-nursing-assistant",
    "Child Abuse Recognition": "child-abuse-recognition",
  };

  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function defaultProductUrl(product, stateAbbv) {
    const offering = (product.offerings || [])[0];
    const licenseType = offering && offering.licenseType;
    const professionSlug = licenseType
      ? PROFESSION_SLUGS[licenseType] || slugify(licenseType)
      : "courses";
    const courseSlug = slugify(product.seoName || String(product.itemId));
    const state = stateAbbv || "US";
    return `https://www.westernschools.com/${professionSlug}/courses/${courseSlug}/?state=${encodeURIComponent(
      state
    )}`;
  }

  function formatMeta(product) {
    const offering = (product.offerings || [])[0];
    const parts = [product.deliveryMethod];
    if (offering && offering.creditHours != null) {
      parts.push(
        `${offering.creditHours} CE hr${offering.creditHours === 1 ? "" : "s"}`
      );
    }
    if (product.priceAll != null) {
      parts.push(`$${Number(product.priceAll).toFixed(2)}`);
    }
    return parts.filter(Boolean).join(" · ");
  }

  function creditBadge(product) {
    const offering = (product.offerings || [])[0];
    if (!offering) return { label: "", mandatory: false };
    if (offering.isMandatory) return { label: "Mandatory", mandatory: true };
    return { label: offering.creditType || "Elective", mandatory: false };
  }

  const SEARCH_ICON = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="9" cy="9" r="6.5" stroke="currentColor" stroke-width="1.6"/><path d="M18 18L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  const CLOCK_ICON = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.4"/><path d="M10 6v4l3 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const SPARKLE_ICON = `<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10 2l1.2 4.8L16 8l-4.8 1.2L10 14l-1.2-4.8L4 8l4.8-1.2L10 2z"/><path d="M16 13l.6 2.4L19 16l-2.4.6L16 19l-.6-2.4L13 16l2.4-.6L16 13z"/></svg>`;

  class WSCourseSearch {
    constructor(root, options) {
      this.root = root;
      this.options = options || {};
      this.abortController = null;
      this.semanticAbortController = null;
      this.semanticStatus = "idle"; // idle | loading | done
      this.debounceTimer = null;
      this.activeIndex = -1;
      this.lastResults = [];
      this.lastTotal = 0;
      this.expanded = false;
      this.buildProductUrl = this.options.buildProductUrl || defaultProductUrl;

      this.context = this.loadContext();
      this.recent = this.loadRecent();

      this.render();
      this.loadLookups().then(() => this.applyInitialQuery());
    }

    applyInitialQuery() {
      const q = new URLSearchParams(window.location.search).get("q");
      if (q) {
        this.input.value = q;
        this.clearBtn.hidden = false;
        this.runSearch();
      }
    }

    loadContext() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        return { stateAbbv: saved.stateAbbv || this.options.defaultState || "" };
      } catch (e) {
        return { stateAbbv: this.options.defaultState || "" };
      }
    }

    saveContext() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.context));
    }

    loadRecent() {
      try {
        return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      } catch (e) {
        return [];
      }
    }

    saveRecent(query) {
      this.recent = [query, ...this.recent.filter((q) => q !== query)].slice(
        0,
        MAX_RECENT
      );
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
      this.renderRecent();
    }

    clearRecent() {
      this.recent = [];
      localStorage.removeItem(RECENT_KEY);
      this.renderRecent();
    }

    render() {
      this.root.innerHTML = `
        <div class="ws-search">
          <p class="ws-search__eyebrow"></p>
          <h2 class="ws-search__heading">What do you need to complete?</h2>

          <div class="ws-search__controls">
            <div class="ws-search__field-group">
              <label>State</label>
              <select class="ws-search__state" aria-label="State">
                <option value="">All states</option>
              </select>
            </div>
            <div class="ws-search__input-wrap">
              <span class="ws-search__input-icon">${SEARCH_ICON}</span>
              <input
                type="text"
                class="ws-search__input"
                placeholder="Try &quot;cardiac&quot; or &quot;ethics&quot;"
                aria-label="Search courses"
                autocomplete="off"
                role="combobox"
                aria-expanded="false"
                aria-owns="ws-search-results"
              />
              <button type="button" class="ws-search__clear" hidden>Clear</button>
            </div>
            <button type="button" class="ws-search__submit">Search</button>
          </div>

          <div class="ws-search__recent" hidden>
            <div class="ws-search__recent-header">
              <span>Recent searches</span>
              <button type="button" class="ws-search__recent-clear">Clear</button>
            </div>
            <div class="ws-search__recent-pills"></div>
          </div>

          <ul class="ws-search__results" id="ws-search-results" hidden></ul>
        </div>
      `;

      this.stateSelect = this.root.querySelector(".ws-search__state");
      this.input = this.root.querySelector(".ws-search__input");
      this.clearBtn = this.root.querySelector(".ws-search__clear");
      this.submitBtn = this.root.querySelector(".ws-search__submit");
      this.resultsEl = this.root.querySelector(".ws-search__results");
      this.eyebrowEl = this.root.querySelector(".ws-search__eyebrow");
      this.recentEl = this.root.querySelector(".ws-search__recent");
      this.recentPillsEl = this.root.querySelector(".ws-search__recent-pills");

      this.stateSelect.addEventListener("change", () => {
        this.context.stateAbbv = this.stateSelect.value;
        this.saveContext();
        this.runSearch();
      });
      this.input.addEventListener("input", () => this.onInput());
      this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
      this.input.addEventListener("focus", () => {
        if (!this.input.value.trim()) this.renderRecent();
      });
      this.clearBtn.addEventListener("click", () => {
        this.input.value = "";
        this.onInput();
        this.input.focus();
      });
      this.submitBtn.addEventListener("click", () => this.runSearch());
      document.addEventListener("click", (e) => {
        if (!this.root.contains(e.target)) this.closeResults();
      });

      this.renderRecent();
    }

    renderRecent() {
      if (!this.recent.length || this.input.value.trim()) {
        this.recentEl.hidden = true;
        return;
      }
      this.recentPillsEl.innerHTML = this.recent
        .map(
          (q) => `
            <button type="button" class="ws-search__pill" data-query="${escapeHtml(
              q
            )}">${CLOCK_ICON}${escapeHtml(q)}</button>
          `
        )
        .join("");
      this.recentEl.hidden = false;

      this.recentPillsEl.querySelectorAll(".ws-search__pill").forEach((pill) => {
        pill.addEventListener("click", () => {
          this.input.value = pill.dataset.query;
          this.runSearch();
        });
      });

      this.recentEl
        .querySelector(".ws-search__recent-clear")
        .onclick = () => this.clearRecent();
    }

    async loadLookups() {
      try {
        const { licenseTypes, states } = await fetch(LOOKUPS_ENDPOINT).then(
          (r) => r.json()
        );

        states
          .sort((a, b) => a.stateFullName.localeCompare(b.stateFullName))
          .forEach((s) => {
            const opt = document.createElement("option");
            opt.value = s.stateAbbv;
            opt.textContent = s.stateFullName;
            this.stateSelect.appendChild(opt);
          });

        this.eyebrowEl.textContent = `Search courses across ${licenseTypes.length} professions`;

        if (this.context.stateAbbv)
          this.stateSelect.value = this.context.stateAbbv;
      } catch (err) {
        console.error("WSCourseSearch: failed to load lookups", err);
      }
    }

    onInput() {
      clearTimeout(this.debounceTimer);
      const query = this.input.value.trim();
      this.clearBtn.hidden = !query;

      if (!query) {
        this.closeResults();
        this.renderRecent();
        return;
      }
      if (query.length < MIN_QUERY_LENGTH) {
        this.closeResults();
        return;
      }

      this.showLoading();
      this.debounceTimer = setTimeout(() => this.runSearch(), DEBOUNCE_MS);
    }

    onKeyDown(e) {
      const items = this.resultsEl.querySelectorAll(".ws-search__result");
      if (!items.length) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.activeIndex = Math.min(this.activeIndex + 1, items.length - 1);
        this.updateActiveItem(items);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.activeIndex = Math.max(this.activeIndex - 1, 0);
        this.updateActiveItem(items);
      } else if (e.key === "Enter") {
        if (this.activeIndex >= 0 && this.lastResults[this.activeIndex]) {
          e.preventDefault();
          window.location.href = this.buildProductUrl(
            this.lastResults[this.activeIndex],
            this.context.stateAbbv
          );
        } else {
          this.runSearch();
        }
      } else if (e.key === "Escape") {
        this.closeResults();
      }
    }

    updateActiveItem(items) {
      items.forEach((item, i) =>
        item.classList.toggle("is-active", i === this.activeIndex)
      );
      const active = items[this.activeIndex];
      if (active) active.scrollIntoView({ block: "nearest" });
    }

    async runSearch(expand) {
      const query = this.input.value.trim();
      if (query.length < MIN_QUERY_LENGTH) {
        this.closeResults();
        return;
      }

      if (!this.context.stateAbbv) {
        this.showMessage("Select a state to search.");
        return;
      }

      this.expanded = !!expand;
      this.recentEl.hidden = true;

      if (this.abortController) this.abortController.abort();
      this.abortController = new AbortController();
      if (this.semanticAbortController) this.semanticAbortController.abort();
      this.semanticStatus = "idle";

      this.root.classList.add("is-loading");

      const params = new URLSearchParams({
        state: this.context.stateAbbv,
        q: query,
        offset: "0",
        limit: String(this.expanded ? EXPANDED_LIMIT : TYPEAHEAD_LIMIT),
      });

      try {
        const res = await fetch(withParams(SEARCH_ENDPOINT, params), {
          signal: this.abortController.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.lastResults = data.products || [];
        this.lastTotal = data.total || this.lastResults.length;
        this.saveRecent(query);
        this.renderResults(query);
        this.fetchSemanticResults(query);
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("WSCourseSearch: search failed", err);
        this.showMessage("Something went wrong. Please try again.");
      } finally {
        this.root.classList.remove("is-loading");
      }
    }

    // Runs separately from the main keyword search above — the LLM
    // relevance call it hits can take several seconds against the full
    // catalog, so keyword results render immediately and this merges in
    // "Suggested" additions whenever it resolves, without blocking them.
    async fetchSemanticResults(query) {
      if (query.length < MIN_SEMANTIC_QUERY_LENGTH) return;

      if (this.semanticAbortController) this.semanticAbortController.abort();
      this.semanticAbortController = new AbortController();
      const signal = this.semanticAbortController.signal;
      const requestedState = this.context.stateAbbv;

      this.semanticStatus = "loading";
      this.renderResults(query);

      try {
        const params = new URLSearchParams({ state: requestedState, q: query });
        const res = await fetch(withParams(SEMANTIC_ENDPOINT, params), {
          signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // The query or state may have changed while this was in flight.
        if (
          this.input.value.trim() !== query ||
          this.context.stateAbbv !== requestedState
        ) {
          return;
        }

        const existingIds = new Set(this.lastResults.map((p) => p.productId));
        const additions = (data.products || []).filter(
          (p) => !existingIds.has(p.productId)
        );
        this.lastResults = [...this.lastResults, ...additions];
        this.semanticStatus = "done";
        this.renderResults(query);
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("WSCourseSearch: semantic search failed", err);
        this.semanticStatus = "done";
        this.renderResults(query);
      }
    }

    renderResults(query) {
      this.activeIndex = -1;

      const loadingRow =
        this.semanticStatus === "loading"
          ? `<li class="ws-search__message ws-search__message--loading">Finding AI suggestions…</li>`
          : "";

      if (!this.lastResults.length) {
        if (this.semanticStatus === "loading") {
          // Keyword pass found nothing (e.g. "back pain course" has no
          // literal keyword overlap), but the semantic pass is still
          // running — don't dead-end into "no results" while it's in
          // flight, since it may still find something.
          this.resultsEl.innerHTML = loadingRow;
          this.resultsEl.hidden = false;
          this.input.setAttribute("aria-expanded", "true");
          return;
        }
        this.showMessage(`No courses found for "${escapeHtml(query)}".`);
        return;
      }

      const rows = this.lastResults
        .map((product, i) => {
          const url = this.buildProductUrl(product, this.context.stateAbbv);
          const badge = creditBadge(product);

          return `
            <li class="ws-search__result" data-index="${i}">
              <a href="${escapeHtml(url)}">
                ${
                  badge.label
                    ? `<span class="ws-search__badge${
                        badge.mandatory ? " is-mandatory" : ""
                      }">${escapeHtml(badge.label)}</span>`
                    : ""
                }
                <span class="ws-search__result-text">
                  <span class="ws-search__result-name">${highlightMatch(
                    product.name,
                    query
                  )}</span>
                  <span class="ws-search__result-meta">${escapeHtml(
                    formatMeta(product)
                  )}</span>
                </span>
                ${
                  product.matchType === "semantic"
                    ? `<span class="ws-search__semantic-tag" title="Suggested by meaning, not exact keyword match">${SPARKLE_ICON}Suggested</span>`
                    : ""
                }
              </a>
            </li>
          `;
        })
        .join("");

      const footer =
        !this.expanded && this.lastTotal > this.lastResults.length
          ? `<li class="ws-search__footer">
               <button type="button" class="ws-search__see-all">
                 ${SEARCH_ICON} See all ${this.lastTotal} results for "${escapeHtml(
                   query
                 )}"
               </button>
             </li>`
          : "";

      this.resultsEl.innerHTML = rows + footer + loadingRow;

      const seeAllBtn = this.resultsEl.querySelector(".ws-search__see-all");
      if (seeAllBtn) {
        seeAllBtn.addEventListener("click", () => this.runSearch(true));
      }

      this.resultsEl.hidden = false;
      this.input.setAttribute("aria-expanded", "true");
    }

    showMessage(message) {
      this.lastResults = [];
      this.resultsEl.innerHTML = `<li class="ws-search__message">${escapeHtml(
        message
      )}</li>`;
      this.resultsEl.hidden = false;
    }

    showLoading() {
      // Opens the panel the instant a valid query exists, instead of
      // leaving a dead pause while the debounce/network round trip runs.
      this.recentEl.hidden = true;
      this.resultsEl.innerHTML = `<li class="ws-search__message ws-search__message--loading">Searching…</li>`;
      this.resultsEl.hidden = false;
      this.input.setAttribute("aria-expanded", "true");
    }

    closeResults() {
      this.resultsEl.hidden = true;
      this.resultsEl.innerHTML = "";
      this.activeIndex = -1;
      this.input.setAttribute("aria-expanded", "false");
    }
  }

  window.WSCourseSearch = {
    init(selector, options) {
      const root = document.querySelector(selector);
      if (!root) {
        console.error(`WSCourseSearch: no element matches "${selector}"`);
        return null;
      }
      return new WSCourseSearch(root, options);
    },
  };
})();
