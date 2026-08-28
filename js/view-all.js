/**
 * Recreation of the Western Schools "View All Courses" page — same visual
 * theme (see css/view-all.css), but the sidebar search runs the real
 * typo-tolerant + semantic search (server.js's /api/search) instead of the
 * live page's literal keyword search. Landing here with ?searchPhrase=&state=
 * (the shape search-widget.js's buildViewAllUrl produces) auto-runs that
 * query on load.
 *
 * Delivery Method / Instructor filters are computed client-side from the
 * current result set (like the Marketing API's own filters/counts), then
 * applied client-side too — no extra round trip per checkbox click.
 */
(function () {
  const INSTRUCTOR_VISIBLE_COUNT = 8;

  // Same slugification the widget uses (search-widget.js's defaultProductUrl)
  // — duplicated here rather than shared, since this page has no module
  // system to import it from.
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

  function productUrl(product, stateAbbv) {
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

  const CLOCK_ICON = `<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.4"/><path d="M10 6v4l3 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const RX_ICON = `<svg viewBox="0 0 20 20" fill="none"><path d="M5 4v12M5 4h4.5a3 3 0 010 6H5m4 0l6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const CHEVRON_ICON = `<svg viewBox="0 0 12 20" fill="none"><path d="M2 2l8 8-8 8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const SPARKLE_ICON = `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2l1.2 4.8L16 8l-4.8 1.2L10 14l-1.2-4.8L4 8l4.8-1.2L10 2z"/></svg>`;

  const els = {
    stateSelect: document.getElementById("ws-view-state"),
    viewCoursesBtn: document.getElementById("ws-view-courses-btn"),
    heroHeading: document.getElementById("ws-hero-heading"),
    sidebarSearchInput: document.getElementById("ws-sidebar-search-input"),
    sidebarSearchBtn: document.getElementById("ws-sidebar-search-btn"),
    resetFiltersBtn: document.getElementById("ws-reset-filters"),
    deliveryCheckboxes: document.getElementById("ws-delivery-checkboxes"),
    instructorCheckboxes: document.getElementById("ws-instructor-checkboxes"),
    showMoreInstructors: document.getElementById("ws-show-more-instructors"),
    resultsHeading: document.getElementById("ws-results-heading"),
    resultsSub: document.getElementById("ws-results-sub"),
    grid: document.getElementById("ws-course-grid"),
    resultsCount: document.getElementById("ws-results-count"),
  };

  const initialParams = new URLSearchParams(window.location.search);

  const state = {
    query: initialParams.get("searchPhrase") || initialParams.get("q") || "",
    stateAbbv: initialParams.get("state") || "",
    allResults: [],
    lastTotal: 0,
    deliveryFilters: new Set(),
    instructorFilters: new Set(),
    instructorsExpanded: false,
  };

  async function init() {
    els.sidebarSearchInput.value = state.query;
    await loadStates();
    wireEvents();
    if (state.query) {
      runSearch();
    } else {
      showMessage("Enter a search term to see matching courses.");
    }
  }

  function wireEvents() {
    els.viewCoursesBtn.addEventListener("click", () => {
      state.stateAbbv = els.stateSelect.value;
      if (state.stateAbbv) warm(state.stateAbbv);
      runSearch();
    });
    els.sidebarSearchBtn.addEventListener("click", commitSidebarSearch);
    els.sidebarSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commitSidebarSearch();
    });
    els.resetFiltersBtn.addEventListener("click", resetFilters);
    els.showMoreInstructors.addEventListener("click", () => {
      state.instructorsExpanded = !state.instructorsExpanded;
      renderSidebarFilters();
    });
  }

  function commitSidebarSearch() {
    state.query = els.sidebarSearchInput.value.trim();
    runSearch();
  }

  async function loadStates() {
    try {
      const { states } = await fetch("/api/lookups").then((r) => r.json());
      els.stateSelect.innerHTML = "";
      states
        .sort((a, b) => a.stateFullName.localeCompare(b.stateFullName))
        .forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s.stateAbbv;
          opt.textContent = s.stateFullName;
          els.stateSelect.appendChild(opt);
        });
      // The real view-all page defaults its state picker to "United
      // States" (a real, searchable nationwide option, stateAbbv "US") —
      // unlike the homepage search widget, which must always start
      // unselected (see search_default_state memory). This page mirrors
      // the real page's own default, not the widget's rule.
      els.stateSelect.value = state.stateAbbv || "US";
      if (!state.stateAbbv) state.stateAbbv = els.stateSelect.value;
    } catch (err) {
      console.error("view-all: failed to load states", err);
    }
  }

  function warm(stateAbbv) {
    fetch(`/api/warm?${new URLSearchParams({ state: stateAbbv })}`).catch(() => {});
  }

  function updateUrl() {
    const params = new URLSearchParams({ searchPhrase: state.query });
    if (state.stateAbbv) params.set("state", state.stateAbbv);
    history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }

  async function runSearch() {
    if (!state.query) {
      showMessage("Enter a search term to see matching courses.");
      return;
    }
    if (!state.stateAbbv) {
      showMessage("Select a state to see matching courses.");
      return;
    }

    updateUrl();
    els.heroHeading.textContent = `Search Results for "${state.query}"`;
    showLoading();

    const params = new URLSearchParams({
      state: state.stateAbbv,
      q: state.query,
      limit: "200",
    });

    try {
      const res = await fetch(`/api/search?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.allResults = data.products || [];
      state.lastTotal = data.total || state.allResults.length;
      state.deliveryFilters.clear();
      state.instructorFilters.clear();
      state.instructorsExpanded = false;
      renderSidebarFilters();
      renderResults();
    } catch (err) {
      console.error("view-all: search failed", err);
      showMessage("Something went wrong. Please try again.");
    }
  }

  function countBy(items, keyFn) {
    const counts = new Map();
    items.forEach((item) => {
      const key = keyFn(item);
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }

  function renderCheckboxGroup(container, counts, activeSet, onChange, options) {
    const entries = Array.from(counts.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    if (!entries.length) {
      container.innerHTML = `<p class="ws-filter-empty">No filters available.</p>`;
      return entries;
    }
    const visible = options && options.limit ? entries.slice(0, options.limit) : entries;
    container.innerHTML = visible
      .map(
        ([value, count]) => `
          <label class="ws-checkbox-row">
            <input type="checkbox" value="${escapeHtml(value)}" ${
          activeSet.has(value) ? "checked" : ""
        } />
            <span>${escapeHtml(value)}</span>
            <span class="count">(${count})</span>
          </label>
        `
      )
      .join("");
    container.querySelectorAll("input[type=checkbox]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) activeSet.add(input.value);
        else activeSet.delete(input.value);
        onChange();
      });
    });
    return entries;
  }

  function renderSidebarFilters() {
    const deliveryCounts = countBy(state.allResults, (p) => p.deliveryMethod);
    renderCheckboxGroup(els.deliveryCheckboxes, deliveryCounts, state.deliveryFilters, () =>
      renderResults()
    );

    const instructorCounts = countBy(state.allResults, (p) => p.instructor);
    const allInstructors = Array.from(instructorCounts.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    renderCheckboxGroup(
      els.instructorCheckboxes,
      instructorCounts,
      state.instructorFilters,
      () => renderResults(),
      { limit: state.instructorsExpanded ? undefined : INSTRUCTOR_VISIBLE_COUNT }
    );

    const remaining = allInstructors.length - INSTRUCTOR_VISIBLE_COUNT;
    if (remaining > 0) {
      els.showMoreInstructors.hidden = false;
      els.showMoreInstructors.textContent = state.instructorsExpanded
        ? "Show less"
        : `Show ${remaining} more`;
    } else {
      els.showMoreInstructors.hidden = true;
    }
  }

  function resetFilters() {
    state.deliveryFilters.clear();
    state.instructorFilters.clear();
    state.instructorsExpanded = false;
    renderSidebarFilters();
    renderResults();
  }

  function filteredResults() {
    return state.allResults.filter((p) => {
      if (state.deliveryFilters.size && !state.deliveryFilters.has(p.deliveryMethod)) {
        return false;
      }
      if (state.instructorFilters.size && !state.instructorFilters.has(p.instructor)) {
        return false;
      }
      return true;
    });
  }

  function formatCreditBadge(offering) {
    if (!offering) return null;
    if (offering.isMandatory) return { label: "Mandatory", className: "ws-pill--mandatory" };
    return { label: offering.creditType || "Elective", className: "ws-pill--elective" };
  }

  function starString(rating) {
    const rounded = Math.round(rating);
    return "★".repeat(Math.max(0, Math.min(5, rounded))) + "☆".repeat(5 - Math.max(0, Math.min(5, rounded)));
  }

  function cardHtml(product) {
    const offering = (product.offerings || [])[0] || {};
    const credit = formatCreditBadge(offering);
    const url = productUrl(product, state.stateAbbv);
    const rating = Number(offering.rating || 0);

    return `
      <article class="ws-course-card">
        <a class="ws-course-card__link" href="${escapeHtml(url)}">
          <h3 class="ws-course-card__title">${highlightMatch(product.name, state.query)}</h3>
          <div class="ws-course-card__spacer"></div>
          <div class="ws-course-card__badges">
            ${
              product.deliveryMethod
                ? `<span class="ws-pill ws-pill--delivery">${escapeHtml(product.deliveryMethod)}</span>`
                : ""
            }
            ${credit ? `<span class="ws-pill ${credit.className}">${escapeHtml(credit.label)}</span>` : ""}
            ${
              product.matchType === "semantic"
                ? `<span class="ws-pill ws-pill--semantic" title="Suggested by meaning, not exact keyword match">${SPARKLE_ICON}Suggested</span>`
                : ""
            }
          </div>
          <div class="ws-course-card__meta">
            ${
              offering.creditHours != null
                ? `<span>${CLOCK_ICON}${offering.creditHours} HRS</span>`
                : ""
            }
            ${
              offering.secondaryCreditHours
                ? `<span>${RX_ICON}${offering.secondaryCreditHours} HRS</span>`
                : ""
            }
          </div>
          ${
            rating > 0
              ? `<div class="ws-course-card__rating">${rating.toFixed(1)} <span class="stars">${starString(
                  rating
                )}</span></div>`
              : ""
          }
          <div class="ws-course-card__price">${
            product.priceAll != null ? `$${Number(product.priceAll).toFixed(2)}` : ""
          }</div>
          <span class="ws-course-card__chevron">${CHEVRON_ICON}</span>
        </a>
      </article>
    `;
  }

  function renderResults() {
    const results = filteredResults();

    els.resultsHeading.textContent = "More Learning Options";
    els.resultsSub.textContent = state.query
      ? `Results for "${state.query}"${state.stateAbbv ? ` in ${state.stateAbbv}` : ""}`
      : "Explore a growing library of nursing CE courses by experts, for experts.";

    if (!results.length) {
      els.grid.innerHTML = `<p class="ws-results__message">No courses found${
        state.query ? ` for "${escapeHtml(state.query)}"` : ""
      }.</p>`;
      els.resultsCount.textContent = "";
      return;
    }

    els.grid.innerHTML = results.map(cardHtml).join("");
    els.resultsCount.textContent =
      results.length === state.allResults.length
        ? `Showing all ${results.length} item${results.length === 1 ? "" : "s"}.`
        : `Showing ${results.length} of ${state.allResults.length} item${
            state.allResults.length === 1 ? "" : "s"
          }.`;
  }

  function showLoading() {
    els.grid.innerHTML = `<p class="ws-results__message ws-results__message--loading">Searching…</p>`;
    els.resultsCount.textContent = "";
    els.deliveryCheckboxes.innerHTML = "";
    els.instructorCheckboxes.innerHTML = "";
    els.showMoreInstructors.hidden = true;
  }

  function showMessage(message) {
    els.grid.innerHTML = `<p class="ws-results__message">${escapeHtml(message)}</p>`;
    els.resultsCount.textContent = "";
    els.deliveryCheckboxes.innerHTML = "";
    els.instructorCheckboxes.innerHTML = "";
    els.showMoreInstructors.hidden = true;
  }

  init();
})();
