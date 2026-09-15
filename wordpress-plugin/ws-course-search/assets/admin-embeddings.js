/**
 * Drives the "Refresh search embeddings" button on Settings -> WS Course
 * Search. Runs entirely in the admin's own browser: fetches which courses
 * need a (re-)computed embedding, computes them via embeddings.js, and
 * POSTs results back in batches so a closed tab only loses unsaved
 * progress, not the whole run.
 */
(function () {
  const config = window.wsEmbeddingsConfig;
  if (!config) return;

  const btn = document.getElementById("ws-refresh-embeddings");
  const status = document.getElementById("ws-embeddings-status");
  if (!btn || !status) return;

  const BATCH_SIZE = 50;
  let running = false;

  window.addEventListener("beforeunload", (e) => {
    if (!running) return;
    e.preventDefault();
    e.returnValue = "";
  });

  async function saveBatch(items) {
    await fetch(`${config.ajaxUrl}?action=ws_search_save_embeddings`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
  }

  // Ensures the catalog actually has data before checking what needs
  // embedding — without this, a state/license combo nobody's ever searched
  // (and WP-Cron's prewarm sweep hasn't reached yet) just looks like "0
  // courses" instead of "not indexed yet". One bounded batch per call
  // (server-side WS_PREWARM_BATCH_SIZE), looped here until done; an
  // already-fresh combo is a cheap no-op server-side, so re-running this on
  // every click costs little even when nothing needed warming.
  async function warmCatalog() {
    let cursor = 0;
    let done = false;
    while (!done) {
      const res = await fetch(
        `${config.ajaxUrl}?action=ws_search_warm_catalog_batch&cursor=${cursor}`
      ).then((r) => r.json());
      if (res.error || !res.total) return;
      cursor = res.cursor;
      done = res.done;
      status.textContent = `Warming catalog… ${cursor}/${res.total} state/license combos checked.`;
    }
  }

  btn.addEventListener("click", async () => {
    running = true;
    btn.disabled = true;
    status.textContent = "Warming catalog…";

    try {
      await warmCatalog();

      status.textContent = "Checking what needs embedding…";
      const needRes = await fetch(
        `${config.ajaxUrl}?action=ws_search_embeddings_needed`
      ).then((r) => r.json());

      if (needRes.locked) {
        status.textContent =
          "Another refresh is already in progress (from this or another admin session). Try again shortly.";
        return;
      }

      const items = needRes.needed || [];
      if (!items.length) {
        status.textContent = `Up to date — all ${needRes.total} courses already embedded.`;
        return;
      }

      const { embed } = await import(config.embeddingsModuleUrl);

      let done = 0;
      let batch = [];
      for (const item of items) {
        const vector = await embed(item.text);
        batch.push({ productId: item.productId, vector, sourceHash: item.sourceHash });
        done++;

        if (batch.length >= BATCH_SIZE || done === items.length) {
          status.textContent = `Embedding ${done}/${items.length}…`;
          await saveBatch(batch);
          batch = [];
        }
      }

      status.textContent = `Done — embedded ${items.length} course${
        items.length === 1 ? "" : "s"
      }.`;
    } catch (err) {
      console.error("WS embedding refresh failed:", err);
      status.textContent = "Something went wrong — check the browser console.";
    } finally {
      running = false;
      btn.disabled = false;
    }
  });
})();
