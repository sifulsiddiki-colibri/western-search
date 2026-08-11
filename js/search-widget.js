/**
 * Western Schools course search widget.
 * Framework-free — designed to drop into the WordPress theme via a single
 * <div id="ws-course-search"></div> + this script tag.
 *
 * Scope: plain free-text search against the Marketing API's course catalog.
 * No AI/semantic matching — that's a separate, later phase.
 */
(function () {
  // Same-origin proxy (server.js locally; a WordPress endpoint in
  // production) — the Marketing API sends no CORS headers, so the browser
  // can't call it directly from any other origin.
  const SEARCH_ENDPOINT = "/api/search";
  const LOOKUPS_ENDPOINT = "/api/lookups";

  const DEBOUNCE_MS = 300;
  const MIN_QUERY_LENGTH = 2;
  const RESULT_LIMIT = 8;
  const STORAGE_KEY = "wsSearchContext";

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

  // Placeholder — confirm the real course URL pattern with the web team
  // before this ships. Falls back to a search-friendly slug in the meantime.
  function defaultProductUrl(product) {
    return `/courses/${product.seoName || product.itemId}`;
  }

  function formatPrice(product) {
    if (product.priceAll == null) return "";
    return `$${Number(product.priceAll).toFixed(2)}`;
  }

  function formatCreditHours(product) {
    const offering = (product.offerings || [])[0];
    if (!offering || offering.creditHours == null) return "";
    return `${offering.creditHours} ${offering.creditType || "credit"} hr${
      offering.creditHours === 1 ? "" : "s"
    }`;
  }

  class WSCourseSearch {
    constructor(root, options) {
      this.root = root;
      this.options = options || {};
      this.abortController = null;
      this.debounceTimer = null;
      this.activeIndex = -1;
      this.lastResults = [];
      this.lastQuery = "";
      this.buildProductUrl = this.options.buildProductUrl || defaultProductUrl;

      this.context = this.loadContext();

      this.render();
      this.loadLookups();
    }

    loadContext() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        return {
          stateAbbv: saved.stateAbbv || this.options.defaultState || "",
          licenseTypeId:
            saved.licenseTypeId || this.options.defaultLicenseTypeId || "",
        };
      } catch (e) {
        return {
          stateAbbv: this.options.defaultState || "",
          licenseTypeId: this.options.defaultLicenseTypeId || "",
        };
      }
    }

    saveContext() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.context));
    }

    render() {
      this.root.innerHTML = `
        <div class="ws-search">
          <div class="ws-search__context">
            <select class="ws-search__state" aria-label="State">
              <option value="">State…</option>
            </select>
            <select class="ws-search__license" aria-label="License type">
              <option value="">License type…</option>
            </select>
          </div>
          <div class="ws-search__field">
            <input
              type="text"
              class="ws-search__input"
              placeholder="Search courses, e.g. &quot;cardiac&quot;"
              aria-label="Search courses"
              autocomplete="off"
              role="combobox"
              aria-expanded="false"
              aria-owns="ws-search-results"
            />
            <div class="ws-search__spinner" hidden></div>
          </div>
          <ul class="ws-search__results" id="ws-search-results" hidden></ul>
        </div>
      `;

      this.stateSelect = this.root.querySelector(".ws-search__state");
      this.licenseSelect = this.root.querySelector(".ws-search__license");
      this.input = this.root.querySelector(".ws-search__input");
      this.spinner = this.root.querySelector(".ws-search__spinner");
      this.resultsEl = this.root.querySelector(".ws-search__results");

      this.stateSelect.addEventListener("change", () => {
        this.context.stateAbbv = this.stateSelect.value;
        this.saveContext();
        this.runSearch();
      });
      this.licenseSelect.addEventListener("change", () => {
        this.context.licenseTypeId = this.licenseSelect.value;
        this.saveContext();
        this.runSearch();
      });
      this.input.addEventListener("input", () => this.onInput());
      this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
      document.addEventListener("click", (e) => {
        if (!this.root.contains(e.target)) this.closeResults();
      });
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

        licenseTypes.forEach((lt) => {
          const opt = document.createElement("option");
          opt.value = lt.licenseTypeId;
          opt.textContent = lt.licenseTypeName;
          this.licenseSelect.appendChild(opt);
        });

        if (this.context.stateAbbv)
          this.stateSelect.value = this.context.stateAbbv;
        if (this.context.licenseTypeId)
          this.licenseSelect.value = this.context.licenseTypeId;
      } catch (err) {
        console.error("WSCourseSearch: failed to load lookups", err);
      }
    }

    onInput() {
      clearTimeout(this.debounceTimer);
      const query = this.input.value.trim();

      if (query.length < MIN_QUERY_LENGTH) {
        this.closeResults();
        return;
      }

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
            this.lastResults[this.activeIndex]
          );
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

    async runSearch() {
      const query = this.input.value.trim();
      if (query.length < MIN_QUERY_LENGTH) {
        this.closeResults();
        return;
      }

      if (!this.context.stateAbbv || !this.context.licenseTypeId) {
        this.showMessage("Select a state and license type to search.");
        return;
      }

      if (this.abortController) this.abortController.abort();
      this.abortController = new AbortController();

      this.lastQuery = query;
      this.spinner.hidden = false;

      const params = new URLSearchParams({
        state: this.context.stateAbbv,
        licenseTypeId: this.context.licenseTypeId,
        q: query,
        offset: "0",
        limit: String(RESULT_LIMIT),
      });

      try {
        const res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
          signal: this.abortController.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.lastResults = data.products || [];
        this.renderResults(query);
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("WSCourseSearch: search failed", err);
        this.showMessage("Something went wrong. Please try again.");
      } finally {
        this.spinner.hidden = true;
      }
    }

    renderResults(query) {
      this.activeIndex = -1;

      if (!this.lastResults.length) {
        this.showMessage(`No courses found for "${escapeHtml(query)}".`);
        return;
      }

      this.resultsEl.innerHTML = this.lastResults
        .map((product, i) => {
          const url = this.buildProductUrl(product);
          const meta = [
            product.deliveryMethod,
            formatCreditHours(product),
            formatPrice(product),
          ]
            .filter(Boolean)
            .join(" · ");

          return `
            <li class="ws-search__result" data-index="${i}">
              <a href="${escapeHtml(url)}">
                <span class="ws-search__result-name">${highlightMatch(
                  product.name,
                  query
                )}</span>
                <span class="ws-search__result-meta">${escapeHtml(meta)}</span>
              </a>
            </li>
          `;
        })
        .join("");

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
