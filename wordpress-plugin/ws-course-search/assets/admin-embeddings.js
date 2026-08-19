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

  btn.addEventListener("click", async () => {
    running = true;
    btn.disabled = true;
    status.textContent = "Checking what needs embedding…";

    try {
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
