/**
 * Western Schools course search widget.
 * Framework-free — designed to drop into the WordPress theme via a single
 * <div id="ws-course-search"></div> + this script tag.
 *
 * Renders as an always-visible hero search box (per the Search v2 design),
 * not a click-to-open modal. No external search service — keyword/typo
 * matching runs entirely server-side (an in-process cache + Levenshtein
 * scorer). Semantic ("meaning-based") matching's *storage/comparison* also
 * runs server-side, but the embeddings themselves come from wherever the
 * backend can actually compute them: server.js computes both catalog and
 * query embeddings itself (Node, via @xenova/transformers) and returns
 * both match types in one fast call; the WordPress plugin has no Node
 * process, so its *query* embedding is computed right here in the browser
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
  const SEARCH_ENDPOINT = WP_CONFIG
    ? `${WP_CONFIG.ajaxUrl}?action=ws_search`
    : "/api/search";
  const LOOKUPS_ENDPOINT = WP_CONFIG
    ? `${WP_CONFIG.ajaxUrl}?action=ws_search_lookups`
    : "/api/lookups";
  const WARM_ENDPOINT = WP_CONFIG
    ? `${WP_CONFIG.ajaxUrl}?action=ws_search_warm`
    : "/api/warm";
  // Only meaningful under WordPress (WP_CONFIG) — server.js has no
  // equivalent endpoint since it already returns semantic matches in the
  // main /api/search response.
  const SEMANTIC_ENDPOINT = WP_CONFIG
    ? `${WP_CONFIG.ajaxUrl}?action=ws_search_semantic`
    : null;

  const DEBOUNCE_MS = 150;
  const MIN_QUERY_LENGTH = 2;
  const SEMANTIC_MIN_QUERY_LENGTH = 4; // matches WS_SEMANTIC_MIN_QUERY_LENGTH on the PHP side.
  const TYPEAHEAD_LIMIT = 7;
  const EXPANDED_LIMIT = 50;
  const STORAGE_KEY = "wsSearchContext";
  const RECENT_KEY = "wsSearchRecent";
  const MAX_RECENT = 5;

  // Every DOM id the widget generates for itself (the results list, recent
  // searches, etc.) is derived from this root id — so it has to be unique
  // whenever there's more than one instance on a page, even if whatever
  // embedded the widget forgot to set one.
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

  // Only meaningful under WordPress (WP_CONFIG.viewAllBase) — the local Node
  // prototype has no such page and keeps expanding the dropdown in place.
  function buildViewAllUrl(baseUrl, professionSlug, query, stateAbbv) {
    const params = new URLSearchParams({ searchPhrase: query });
    if (stateAbbv) params.set("state", stateAbbv);
    return `${baseUrl}/${professionSlug}/view-all/?${params.toString()}`;
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
  const PIN_ICON = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 18s6-5.686 6-10a6 6 0 10-12 0c0 4.314 6 10 6 10z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="10" cy="8" r="2" stroke="currentColor" stroke-width="1.4"/></svg>`;

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
      this.professionSlug = this.options.defaultProfession || "nursing";
      // Namespaced by container id so two instances on the same page never
      // share "recent searches" or a remembered state — each is its own
      // independent widget, per the multi-instance requirement.
      this.storageKey = `${STORAGE_KEY}:${this.root.id}`;
      this.recentKey = `${RECENT_KEY}:${this.root.id}`;

      this.context = this.loadContext();
      this.recent = this.loadRecent();

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
        this.clearBtn.hidden = false;
        this.runSearch();
      }
    }

    // Starts on the "Select your state" placeholder (per the Search v2
    // design) unless a state was already chosen in a prior visit
    // (localStorage) or the embedder explicitly passed a defaultState
    // option — no hardcoded fallback state.
    loadContext() {
      try {
        const saved = JSON.parse(localStorage.getItem(this.storageKey) || "{}");
        return { stateAbbv: saved.stateAbbv || this.options.defaultState || "" };
      } catch (e) {
        return { stateAbbv: this.options.defaultState || "" };
      }
    }

    saveContext() {
      localStorage.setItem(this.storageKey, JSON.stringify(this.context));
    }

    loadRecent() {
      try {
        return JSON.parse(localStorage.getItem(this.recentKey) || "[]");
      } catch (e) {
        return [];
      }
    }

    saveRecent(query) {
      this.recent = [query, ...this.recent.filter((q) => q !== query)].slice(
        0,
        MAX_RECENT
      );
      localStorage.setItem(this.recentKey, JSON.stringify(this.recent));
      this.renderRecent();
    }

    clearRecent() {
      this.recent = [];
      localStorage.removeItem(this.recentKey);
      this.renderRecent();
    }

    render() {
      // Derived from the (unique) container id — otherwise every instance
      // on the page would render the same hardcoded "ws-search-results"
      // id, which is invalid HTML and makes aria-owns ambiguous once
      // there's more than one.
      const resultsId = `${this.root.id}-results`;
      this.root.innerHTML = `
        <div class="ws-search-hero">
          <p class="ws-search__eyebrow"></p>
          <h2 class="ws-search__heading">What are you looking to learn today?</h2>
          <p class="ws-search__subheading">Search our full library of board-approved courses, bundles, and membership plans.</p>

          <div class="ws-search__panel">
            <div class="ws-search__controls">
              <div class="ws-search__state-wrap">
                <span class="ws-search__state-icon">${PIN_ICON}</span>
                <select class="ws-search__state" aria-label="State">
                  <option value="">Select your state</option>
                </select>
                <span class="ws-search__select-measure" aria-hidden="true"></span>
              </div>
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
                <button type="button" class="ws-search__clear" hidden>Clear</button>
              </div>
              <button type="button" class="ws-search__submit">${SEARCH_ICON}<span>Search</span></button>
            </div>

            <div class="ws-search__dropdown">
              <div class="ws-search__recent" hidden>
                <div class="ws-search__recent-header">
                  <span>Recent searches</span>
                  <button type="button" class="ws-search__recent-clear">Clear</button>
                </div>
                <div class="ws-search__recent-pills"></div>
              </div>

              <ul class="ws-search__results" id="${resultsId}" hidden></ul>
            </div>
          </div>
        </div>
      `;

      this.stateSelect = this.root.querySelector(".ws-search__state");
      this.selectMeasureEl = this.root.querySelector(".ws-search__select-measure");
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
        this.sizeStateSelect();
        if (this.context.stateAbbv) this.warmState(this.context.stateAbbv);
        // A state that hasn't been searched in a while pays a real,
        // several-second indexing cost (see ensureIndexed on the
        // backend) before results come back — show that a search is in
        // flight instead of leaving the previous state's stale results
        // sitting there looking frozen.
        if (this.input.value.trim()) this.showLoading();
        this.runSearch();
      });
      this.sizeStateSelect();
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
      this.submitBtn.addEventListener("click", () => {
        if (this.goToViewAll(this.input.value.trim())) return;
        this.runSearch(false, true);
      });
      document.addEventListener("click", (e) => {
        if (!this.root.contains(e.target)) this.closeResults();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !this.resultsEl.hidden) this.closeResults();
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
          this.runSearch(false, true);
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

        this.eyebrowEl.textContent = `Search CE courses across ${licenseTypes.length} professions`;

        if (this.context.stateAbbv)
          this.stateSelect.value = this.context.stateAbbv;
        this.sizeStateSelect();
      } catch (err) {
        console.error("WSCourseSearch: failed to load lookups", err);
      }
    }

    // Native <select> elements size to their widest *option*, not the
    // currently selected one, so "Florida" and "District of Columbia"
    // otherwise render at the same fixed width. Measuring the selected
    // option's text in a hidden span and applying that as an explicit
    // width lets the field shrink/grow with the actual selection.
    sizeStateSelect() {
      const selected = this.stateSelect.options[this.stateSelect.selectedIndex];
      this.selectMeasureEl.textContent = selected ? selected.textContent : "";
      const textWidth = this.selectMeasureEl.offsetWidth;
      const CHROME_WIDTH = 38 + 34 + 2; // pin-icon padding-left + padding-right (incl. arrow) + border
      this.stateSelect.style.width = `${textWidth + CHROME_WIDTH}px`;
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

    // Navigates to the "view all results" page instead of expanding the
    // dropdown further. Under WordPress this goes to WP_CONFIG.viewAllBase
    // (the WP_VIEW_ALL_BASE-configured page). Locally (this repo's Node
    // prototype has no such WP config), options.viewAllPageUrl points at
    // view-all.html instead, using a flat query string rather than the
    // WP path shape buildViewAllUrl produces. Returns false (does nothing)
    // if neither is configured, so callers can fall through to the
    // existing inline-expand behavior.
    goToViewAll(query) {
      if (!query) return false;

      if (this.options.viewAllPageUrl) {
        this.saveRecent(query);
        const params = new URLSearchParams({ searchPhrase: query });
        if (this.context.stateAbbv) params.set("state", this.context.stateAbbv);
        window.location.href = `${this.options.viewAllPageUrl}?${params.toString()}`;
        return true;
      }

      if (!WP_CONFIG || !WP_CONFIG.viewAllBase) return false;
      this.saveRecent(query);
      window.location.href = buildViewAllUrl(
        WP_CONFIG.viewAllBase,
        this.professionSlug,
        query,
        this.context.stateAbbv
      );
      return true;
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
          this.saveRecent(this.input.value.trim());
          window.location.href = this.buildProductUrl(
            this.lastResults[this.activeIndex],
            this.context.stateAbbv
          );
        } else if (this.goToViewAll(this.input.value.trim())) {
          e.preventDefault();
        } else {
          this.runSearch(false, true);
        }
      }
    }

    updateActiveItem(items) {
      items.forEach((item, i) =>
        item.classList.toggle("is-active", i === this.activeIndex)
      );
      const active = items[this.activeIndex];
      if (active) active.scrollIntoView({ block: "nearest" });
    }

    // `explicit` distinguishes a deliberate commit (Enter, Search button,
    // clicking a result/pill) from the automatic debounced search that
    // runs while the user is still typing — only explicit commits get
    // saved to "recent searches", otherwise every intermediate keystroke
    // ("ca", "car", "card", ...) would clutter that list.
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
      this.recentEl.hidden = true;

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
        if (explicit) this.saveRecent(query);
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

      if (!this.lastResults.length) {
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

      this.resultsEl.innerHTML = rows + footer;

      const seeAllBtn = this.resultsEl.querySelector(".ws-search__see-all");
      if (seeAllBtn) {
        seeAllBtn.addEventListener("click", () => {
          if (this.goToViewAll(query)) return;
          this.runSearch(true, true);
        });
      }
      this.resultsEl.querySelectorAll(".ws-search__result a").forEach((a) => {
        a.addEventListener("click", () => this.saveRecent(query));
      });

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
