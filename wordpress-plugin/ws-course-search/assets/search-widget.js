/**
 * Western Schools course search widget.
 * Framework-free — designed to drop into the WordPress theme via a single
 * <div id="ws-course-search"></div> + this script tag.
 *
 * Search Concierge v2.1 ("no search button") interaction: no submit button,
 * no "view all results" page redirect — results render live in a dropdown
 * panel as the visitor types, and clicking a result IS the destination.
 * State is picked from a plain dropdown button + full list (not a
 * type-ahead field), matching search_concierge_no_button.html's demo.
 *
 * No external search service — keyword/typo matching runs entirely
 * server-side (an in-process cache + Levenshtein scorer). Semantic
 * ("meaning-based") matching's *storage/comparison* also runs server-side,
 * but the embeddings themselves come from wherever the backend can
 * actually compute them: server.js computes both catalog and query
 * embeddings itself (Node, via @xenova/transformers) and returns both
 * match types in one fast call; the WordPress plugin has no Node process,
 * so its *query* embedding is computed right here in the browser
 * (embeddings.js, same underlying model) and sent up as a second,
 * non-blocking request after keyword results already rendered — see
 * runSemanticRescue() below. Either way, semantic compute never delays the
 * fast keyword path.
 */
(function () {
  // Same-origin backend — server.js's /api/* routes when running standalone
  // (this repo's local prototype), or WordPress's admin-ajax.php when
  // wp_localize_script has set up window.wsSearchConfig (the ws-course-search
  // plugin). Either way the Marketing API itself sends no CORS headers, so
  // the browser can never call it directly — something same-origin always
  // sits in between.
  const WP_CONFIG = typeof wsSearchConfig !== "undefined" ? wsSearchConfig : null;
  // Under WordPress this calls the plugin's real REST API
  // (ws-course-search/v1/*, registered in ws_search_register_rest_routes())
  // per the architecture doc's "WordPress REST endpoint" component — not
  // admin-ajax.php, which is what these called before and what the ajax
  // actions of the same name still exist for backward compatibility.
  const SEARCH_ENDPOINT = WP_CONFIG ? `${WP_CONFIG.restUrl}search` : "/api/search";
  const LOOKUPS_ENDPOINT = WP_CONFIG ? `${WP_CONFIG.restUrl}lookups` : "/api/lookups";
  const WARM_ENDPOINT = WP_CONFIG ? `${WP_CONFIG.restUrl}warm` : "/api/warm";
  // Only meaningful under WordPress (WP_CONFIG) — server.js has no
  // equivalent endpoint since it already returns semantic matches in the
  // main /api/search response.
  const SEMANTIC_ENDPOINT = WP_CONFIG
    ? `${WP_CONFIG.ajaxUrl}?action=ws_search_semantic`
    : null;
  // Only meaningful under WordPress — search-term analytics is a WP-plugin
  // deliverable (see architecture doc §8); the local Node prototype has no
  // matching /api/log-search route.
  const LOG_TERM_ENDPOINT = WP_CONFIG
    ? `${WP_CONFIG.ajaxUrl}?action=ws_search_log_term`
    : null;

  const DEBOUNCE_MS = 500;
  const MIN_QUERY_LENGTH = 3;
  const SEMANTIC_MIN_QUERY_LENGTH = 4; // matches WS_SEMANTIC_MIN_QUERY_LENGTH on the PHP side.
  const TYPEAHEAD_LIMIT = 7;
  const EXPANDED_LIMIT = 50;

  // Every DOM id the widget generates for itself (the results list, the
  // state list, etc.) is derived from this root id — so it has to be
  // unique whenever there's more than one instance on a page, even if
  // whatever embedded the widget forgot to set one.
  let autoIdCounter = 0;
  function ensureUniqueId(root) {
    if (!root.id) {
      autoIdCounter += 1;
      root.id = `ws-course-search-auto-${autoIdCounter}`;
    }
    return root.id;
  }

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

  // Credit hours + price only — delivery method is its own badge now (see
  // deliveryBadgeClass()), so repeating it in this meta line would just be
  // redundant with what's already shown to the left of the title.
  function formatMeta(product) {
    const offering = (product.offerings || [])[0];
    const parts = [];
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

  // One real badge per course: delivery method (Online/Video/Podcast/
  // Package/Membership), matching westernschools.com's own "Delivery
  // Methods" filter facet — not a made-up label. Credit type (Elective vs
  // Non-Credit) was dropped in this design: the real catalog is almost
  // entirely Elective, so it would read the same on nearly every row and
  // tell a scanning visitor nothing; delivery method actually varies.
  function deliveryBadgeClass(product) {
    const method = (product.deliveryMethod || "").toLowerCase();
    if (["video", "podcast", "online", "package", "membership"].includes(method)) {
      return `ws-search__badge--${method}`;
    }
    return "";
  }

  const SEARCH_ICON = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="9" cy="9" r="6.5" stroke="currentColor" stroke-width="1.6"/><path d="M18 18L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
  const SPARKLE_ICON = `<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10 2l1.2 4.8L16 8l-4.8 1.2L10 14l-1.2-4.8L4 8l4.8-1.2L10 2z"/><path d="M16 13l.6 2.4L19 16l-2.4.6L16 19l-.6-2.4L13 16l2.4-.6L16 13z"/></svg>`;
  const PIN_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="15" height="15" stroke="currentColor" stroke-width="2"><path d="M12 22s7-7.58 7-12.5A7 7 0 0 0 5 9.5C5 14.42 12 22 12 22z"/><circle cx="12" cy="9.5" r="2.5"/></svg>`;
  const CHEVRON_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>`;

  class WSCourseSearch {
    constructor(root, options) {
      this.root = root;
      // The PHP side (ws_search_render_widget()) already assigns each
      // instance a wp_unique_id()'d container, but this stays independent
      // of that — the widget's own multi-instance-safety shouldn't rely
      // on the caller having done the right thing.
      ensureUniqueId(this.root);
      this.options = options || {};
      this.abortController = null;
      this.semanticAbortController = null;
      this.debounceTimer = null;
      this.activeIndex = -1;
      this.lastResults = [];
      this.lastTotal = 0;
      this.expanded = false;
      this.buildProductUrl = this.options.buildProductUrl || defaultProductUrl;
      this.states = []; // populated by loadLookups(); the state menu is built once that resolves.

      this.context = this.loadContext();

      this.render();
      if (this.context.stateAbbv) this.warmState(this.context.stateAbbv);
      this.loadLookups().then(() => this.applyInitialQuery());
    }

    // Indexing a state a user hasn't searched yet costs several real
    // seconds (the Marketing API's own first-response latency, not
    // anything on our end) — firing this the moment a state is known,
    // rather than waiting for an actual search, means that cost usually
    // lands while the user is still typing instead of blocking results.
    // Fire-and-forget: a failure here just means the next real search
    // pays the indexing cost itself, same as before this existed.
    warmState(stateAbbv) {
      fetch(withParams(WARM_ENDPOINT, new URLSearchParams({ state: stateAbbv }))).catch(
        () => {}
      );
    }

    applyInitialQuery() {
      const q = new URLSearchParams(window.location.search).get("q");
      if (q) {
        this.input.value = q;
        this.runSearch();
      }
    }

    // Always starts on the "Select your state" placeholder (per the
    // Search v2 design and an explicit, repeated product requirement) —
    // never restored from a prior visit, only from the embedder
    // explicitly passing a defaultState option (e.g. a state-specific
    // listings page). No hardcoded fallback state either way.
    loadContext() {
      return { stateAbbv: this.options.defaultState || "" };
    }

    // Analytics only — every call site is already an "explicit commit"
    // (Enter, picking a result), never a raw keystroke, so this piggybacks
    // on that instead of needing its own debounce. Fire-and-forget: a
    // dropped log shouldn't ever block or visibly affect the search
    // itself. keepalive is required, not decorative — every call site
    // immediately triggers a same-tick navigation (a result link's default
    // click), which would otherwise abort a normal in-flight fetch before
    // it reaches the server.
    logSearchTerm(query) {
      if (!LOG_TERM_ENDPOINT || !query) return;
      fetch(LOG_TERM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          stateAbbv: this.context.stateAbbv,
          resultCount: this.lastTotal,
        }),
        keepalive: true,
      }).catch(() => {});
    }

    render() {
      // Derived from the (unique) container id — otherwise every instance
      // on the page would render the same hardcoded ids, which is invalid
      // HTML and makes aria-owns ambiguous once there's more than one.
      const resultsId = `${this.root.id}-results`;
      const stateListId = `${this.root.id}-state-list`;
      // Per the "state is already established by context" decision — a
      // caller that already knows the state (e.g. a state-specific
      // listings page) can pass hideStateField + defaultState and skip
      // asking the visitor again.
      const stateFieldHtml = this.options.hideStateField
        ? ""
        : `
              <div class="ws-search__state-wrap">
                <button
                  type="button"
                  class="ws-search__state-btn"
                  aria-haspopup="listbox"
                  aria-expanded="false"
                  aria-owns="${stateListId}"
                >
                  <span class="ws-search__state-btn-label">
                    <span class="ws-search__state-icon">${PIN_ICON}</span>
                    <span class="ws-search__state-btn-text">Select your state</span>
                  </span>
                  <span class="ws-search__state-chevron">${CHEVRON_ICON}</span>
                </button>
                <ul class="ws-search__state-list" id="${stateListId}" role="listbox" hidden></ul>
              </div>`;
      this.root.innerHTML = `
        <div class="ws-search-hero">
          <div class="ws-search__panel">
            <div class="ws-search__controls">
              ${stateFieldHtml}
              <div class="ws-search__input-wrap">
                <span class="ws-search__input-icon">${SEARCH_ICON}</span>
                <input
                  type="text"
                  class="ws-search__input"
                  placeholder="Search by course, topics, or license type"
                  aria-label="Search courses"
                  autocomplete="off"
                  role="combobox"
                  aria-expanded="false"
                  aria-owns="${resultsId}"
                />
              </div>
            </div>

            <div class="ws-search__dropdown">
              <ul class="ws-search__results" id="${resultsId}" hidden></ul>
            </div>
          </div>
        </div>
      `;

      this.stateBtn = this.root.querySelector(".ws-search__state-btn");
      this.stateLabel = this.root.querySelector(".ws-search__state-btn-text");
      this.stateListEl = this.root.querySelector(".ws-search__state-list");
      this.input = this.root.querySelector(".ws-search__input");
      this.resultsEl = this.root.querySelector(".ws-search__results");

      if (this.stateBtn) {
        this.stateBtn.addEventListener("click", () => this.toggleStateMenu());
      }

      this.input.addEventListener("input", () => this.onInput());
      this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
      document.addEventListener("click", (e) => {
        if (!this.root.contains(e.target)) {
          this.closeResults();
          this.closeStateMenu();
        }
      });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (!this.resultsEl.hidden) this.closeResults();
        if (this.stateListEl && !this.stateListEl.hidden) this.closeStateMenu();
      });
    }

    // Built once real states are known (loadLookups()) — a plain
    // click-to-open full list, not a type-ahead filter: with ~50 states
    // total, scrolling a short list is simpler than typing to narrow it,
    // and it can never reflow the search bar's width the way a type-ahead
    // field's changing content could.
    buildStateMenu() {
      if (!this.stateListEl) return;
      this.stateListEl.innerHTML = this.states
        .map(
          (s) => `
            <li class="ws-search__state-option" role="presentation">
              <button type="button" role="option" data-state="${escapeHtml(s.stateAbbv)}">
                ${escapeHtml(s.stateFullName)}
              </button>
            </li>
          `
        )
        .join("");
      this.stateListEl.querySelectorAll(".ws-search__state-option button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const state = this.states.find((s) => s.stateAbbv === btn.getAttribute("data-state"));
          if (state) this.selectState(state);
        });
      });
      this.updateSelectedStateOption();
    }

    updateSelectedStateOption() {
      if (!this.stateListEl) return;
      this.stateListEl.querySelectorAll(".ws-search__state-option").forEach((li) => {
        const btn = li.querySelector("button");
        li.classList.toggle("is-selected", btn && btn.getAttribute("data-state") === this.context.stateAbbv);
      });
    }

    toggleStateMenu() {
      if (!this.stateListEl) return;
      const willShow = this.stateListEl.hidden;
      this.stateListEl.hidden = !willShow;
      this.stateBtn.setAttribute("aria-expanded", String(willShow));
    }

    closeStateMenu() {
      if (!this.stateListEl) return;
      this.stateListEl.hidden = true;
      this.stateBtn.setAttribute("aria-expanded", "false");
    }

    // Selecting a state — save context, update the button label, warm the
    // state's catalog, and re-run the current search (same downstream
    // effect the old type-ahead field's "change" handling had).
    selectState(state) {
      this.context.stateAbbv = state.stateAbbv;
      this.stateLabel.textContent = state.stateFullName;
      this.updateSelectedStateOption();
      this.closeStateMenu();
      this.warmState(state.stateAbbv);
      if (this.input.value.trim()) this.showLoading();
      this.runSearch();
    }

    async loadLookups() {
      try {
        const { states } = await fetch(LOOKUPS_ENDPOINT).then((r) => r.json());

        this.states = states.sort((a, b) => a.stateFullName.localeCompare(b.stateFullName));
        this.buildStateMenu();

        // Pre-fill from an explicit defaultState option, same as before —
        // just resolving the abbreviation to a display name for the
        // button label instead of a <select>'s value.
        if (this.context.stateAbbv && this.stateLabel) {
          const match = this.states.find((s) => s.stateAbbv === this.context.stateAbbv);
          this.stateLabel.textContent = match ? match.stateFullName : this.context.stateAbbv;
        }
      } catch (err) {
        console.error("WSCourseSearch: failed to load lookups", err);
      }
    }

    onInput() {
      clearTimeout(this.debounceTimer);
      const query = this.input.value.trim();

      if (!query || query.length < MIN_QUERY_LENGTH) {
        this.closeResults();
        return;
      }

      this.showLoading();
      this.debounceTimer = setTimeout(() => this.runSearch(), DEBOUNCE_MS);
    }

    onKeyDown(e) {
      const items = this.resultsEl.querySelectorAll(".ws-search__result");
      if (e.key === "Enter") {
        if (this.activeIndex >= 0 && this.lastResults[this.activeIndex]) {
          e.preventDefault();
          this.logSearchTerm(this.input.value.trim());
          window.location.href = this.buildProductUrl(
            this.lastResults[this.activeIndex],
            this.context.stateAbbv
          );
        } else if (this.input.value.trim()) {
          // No result is highlighted yet — with no separate "view all"
          // destination in this design, Enter just does the same thing
          // the "see all" link does: expand the results already showing.
          e.preventDefault();
          this.runSearch(true, true);
        }
        return;
      }
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.activeIndex = Math.min(this.activeIndex + 1, items.length - 1);
        this.updateActiveItem(items);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.activeIndex = Math.max(this.activeIndex - 1, 0);
        this.updateActiveItem(items);
      }
    }

    updateActiveItem(items) {
      items.forEach((item, i) =>
        item.classList.toggle("is-active", i === this.activeIndex)
      );
      const active = items[this.activeIndex];
      if (active) active.scrollIntoView({ block: "nearest" });
    }

    // `explicit` distinguishes a deliberate commit (Enter, clicking a
    // result) from the automatic debounced search that runs while the
    // user is still typing — only explicit commits get logged, otherwise
    // every intermediate keystroke ("ca", "car", "card", ...) would
    // clutter the search-term log.
    async runSearch(expand, explicit) {
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

      if (this.abortController) this.abortController.abort();
      this.abortController = new AbortController();

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
        if (explicit) this.logSearchTerm(query);
        this.renderResults(query);

        // Fire-and-forget: only meaningful when SEMANTIC_ENDPOINT exists
        // (WordPress) — server.js's own /api/search already returned
        // semantic matches above, so this immediately no-ops there.
        if (SEMANTIC_ENDPOINT && WP_CONFIG.semanticEnabled) {
          this.runSemanticRescue(query);
        }
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("WSCourseSearch: search failed", err);
        this.showMessage("Something went wrong. Please try again.");
      } finally {
        this.root.classList.remove("is-loading");
      }
    }

    // Computes the query's embedding right here in the browser (the
    // WordPress plugin has no server-side embedding model to call) and
    // sends it up for a plain cosine-similarity comparison against
    // precomputed catalog vectors. Runs *after* keyword results are
    // already on screen, and merges in as a late addition — never blocks
    // or delays the fast keyword path, since embedding compute alone can
    // take longer than the whole keyword round trip.
    async runSemanticRescue(query) {
      if (query.length < SEMANTIC_MIN_QUERY_LENGTH) return;

      if (this.semanticAbortController) this.semanticAbortController.abort();
      const controller = new AbortController();
      this.semanticAbortController = controller;

      const stillCurrent = () =>
        !controller.signal.aborted && this.input.value.trim() === query;

      try {
        const { embed } = await import(WP_CONFIG.embeddingsModuleUrl);
        if (!stillCurrent()) return;

        const vector = await embed(query);
        if (!stillCurrent()) return;

        const params = new URLSearchParams({
          state: this.context.stateAbbv,
          q: query,
          vector: JSON.stringify(vector),
          exclude: this.lastResults.map((p) => p.productId).join(","),
          limit: String(this.expanded ? EXPANDED_LIMIT : TYPEAHEAD_LIMIT),
        });

        const res = await fetch(withParams(SEMANTIC_ENDPOINT, params), {
          signal: controller.signal,
        });
        if (!res.ok || !stillCurrent()) return;

        const data = await res.json();
        const additions = data.products || [];
        if (!additions.length || !stillCurrent()) return;

        this.lastResults = [...this.lastResults, ...additions];
        this.renderResults(query);
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("WSCourseSearch: semantic rescue failed", err);
      }
    }

    renderResults(query) {
      this.activeIndex = -1;
      // Fired for a zero-result render too (with an empty productCodes) —
      // a listener that filtered CL2 down to a previous search's matches
      // needs to hear about a since-typed query matching nothing, not just
      // successful ones.
      this.emitResults(query);

      if (!this.lastResults.length) {
        this.showMessage(`No courses found for "${escapeHtml(query)}".`);
        return;
      }

      const rows = this.lastResults
        .map((product, i) => {
          const url = this.buildProductUrl(product, this.context.stateAbbv);
          const badgeClass = deliveryBadgeClass(product);

          return `
            <li class="ws-search__result" data-index="${i}">
              <a href="${escapeHtml(url)}">
                ${
                  product.deliveryMethod
                    ? `<span class="ws-search__badge ${badgeClass}">${escapeHtml(
                        product.deliveryMethod.toUpperCase()
                      )}</span>`
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
                 See all ${this.lastTotal} results for "${escapeHtml(query)}"
               </button>
             </li>`
          : "";

      this.resultsEl.innerHTML =
        `<li class="ws-search__results-head">Courses</li>` + rows + footer;

      const seeAllBtn = this.resultsEl.querySelector(".ws-search__see-all");
      if (seeAllBtn) {
        seeAllBtn.addEventListener("click", () => this.runSearch(true, true));
      }
      this.resultsEl.querySelectorAll(".ws-search__result a").forEach((a) => {
        a.addEventListener("click", () => this.logSearchTerm(query));
      });

      this.resultsEl.hidden = false;
      this.input.setAttribute("aria-expanded", "true");
    }

    // Lets anything embedding the widget (analytics, other WP blocks on the
    // same page) react to a completed search without reaching into the
    // widget's internals — fired from the root element so multiple
    // instances on one page stay distinguishable via event.target.
    emitResults(query) {
      this.root.dispatchEvent(
        new CustomEvent("ws-search:results", {
          bubbles: true,
          detail: {
            query,
            stateAbbv: this.context.stateAbbv,
            productCodes: this.lastResults.map((p) => p.productId),
            ts: Date.now(),
          },
        })
      );
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
      this.resultsEl.innerHTML = `<li class="ws-search__message">Searching…</li>`;
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
