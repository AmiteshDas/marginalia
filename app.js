import { supabase } from "./supabase-client.js";
import { queueNote, getPendingNotes, markSynced, markFailed } from "./idb-queue.js";
import { computeMomentum, daysSince, isColdReadingItem } from "./lib/momentum.js";

// ------------------------------------------------------------
// Service worker registration — self-updating.
// sw.js caches shell assets cache-first, so a stale registration would
// otherwise keep serving old code indefinitely with no visible sign
// anything's wrong. To fix that: check for a new sw.js on every load
// and whenever the app is foregrounded (bypassing the browser's normal
// once-a-day throttle). When a new service worker actually takes over,
// show a banner rather than reloading immediately — an unconditional
// reload could silently wipe an in-progress, unsaved capture form.
// ------------------------------------------------------------
if ("serviceWorker" in navigator) {
  // If the page is already controlled at registration time, any later
  // controllerchange is a genuine update. If not, the first activation
  // (clients.claim() on a fresh install) also fires controllerchange —
  // that's not an "update," so it shouldn't prompt one.
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.register("/marginalia/sw.js", { scope: "/marginalia/" }).then((reg) => {
    reg.update();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update();
    });
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "TRY_SYNC") syncPendingNotes();
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    document.getElementById("update-banner")?.removeAttribute("hidden");
  });

  document.getElementById("update-reload-btn")?.addEventListener("click", () => {
    window.location.reload();
  });
}

// ------------------------------------------------------------
// Category management — cached locally, created ad hoc
// ------------------------------------------------------------
let categoriesCache = [];

async function loadCategories() {
  const { data, error } = await supabase.from("categories").select("*").order("name");
  if (!error && data) categoriesCache = data;
  return categoriesCache;
}

async function createCategory(name, excludeFromDigest) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("not signed in");
  const { data, error } = await supabase
    .from("categories")
    .insert({ name, user_id: user.id, exclude_from_digest: excludeFromDigest })
    .select()
    .single();
  if (error) throw error;
  categoriesCache.push(data);
  return data;
}

function renderCategoryPicker(pickerEl, hiddenInputEl) {
  // Clear existing chips except the "+ new" button
  [...pickerEl.querySelectorAll(".category-chip:not(.add-new)")].forEach((el) => el.remove());
  const addBtn = pickerEl.querySelector(".add-new");

  categoriesCache.forEach((cat) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "category-chip";
    chip.textContent = cat.exclude_from_digest ? `${cat.name} (excluded)` : cat.name;
    chip.dataset.id = cat.id;
    chip.style.borderColor = cat.color || "#c9c2b2";
    chip.addEventListener("click", () => {
      pickerEl.querySelectorAll(".category-chip").forEach((c) => c.classList.remove("selected"));
      chip.classList.add("selected");
      hiddenInputEl.value = cat.id;
    });
    pickerEl.insertBefore(chip, addBtn);
  });
}

// ------------------------------------------------------------
// Shelf items — cached so a note can optionally reference the shelf item
// it came from ("From your shelf" dropdown + the "from: X" tag in Notes).
// Includes archived items too (excluded only from the dropdown), so a
// note's source still resolves to a real title after its shelf item is
// silently archived.
// ------------------------------------------------------------
let shelfItemsCache = [];

async function loadShelfItems() {
  const { data, error } = await supabase
    .from("notes")
    .select("id, quote, link, source_type, category_id, archived_at")
    .eq("kind", "shelf")
    .order("last_touched", { ascending: false });
  if (!error && data) shelfItemsCache = data;
  return shelfItemsCache;
}

function renderShelfConnectDropdown(selectEl) {
  if (!selectEl) return;
  const previousValue = selectEl.value;
  selectEl.innerHTML = `<option value="">— none —</option>`;
  shelfItemsCache
    .filter((item) => !item.archived_at)
    .forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.quote;
      selectEl.appendChild(option);
    });
  selectEl.value = [...selectEl.options].some((o) => o.value === previousValue) ? previousValue : "";
}

function wireShelfConnectDropdown(formEl) {
  const selectEl = formEl.querySelector("#source_item_id");
  if (!selectEl) return;
  selectEl.addEventListener("change", () => {
    const item = shelfItemsCache.find((i) => i.id === selectEl.value);
    if (!item) return;
    // Picking a source deliberately overwrites these — it's meant to save
    // re-typing what the shelf item already has, not just suggest it.
    const linkEl = formEl.querySelector("#link");
    const sourceTypeEl = formEl.querySelector("#source_type");
    const hiddenCategoryEl = formEl.querySelector("#category_id");
    if (linkEl) linkEl.value = item.link ?? "";
    if (sourceTypeEl) sourceTypeEl.value = item.source_type;
    if (hiddenCategoryEl && item.category_id) {
      hiddenCategoryEl.value = item.category_id;
      const pickerEl = formEl.querySelector("#category-picker");
      pickerEl?.querySelectorAll(".category-chip").forEach((c) =>
        c.classList.toggle("selected", c.dataset.id === item.category_id)
      );
    }
  });
}

function wireAddCategory(pickerEl, hiddenInputEl) {
  const addBtn = pickerEl.querySelector(".add-new");
  addBtn.addEventListener("click", async () => {
    const name = prompt("New category name");
    if (!name) return;
    const excludeFromDigest = confirm(
      "Exclude notes in this category from the weekly digest?\n\nOK = exclude, Cancel = include (default)"
    );
    try {
      const cat = await createCategory(name.trim(), excludeFromDigest);
      renderCategoryPicker(pickerEl, hiddenInputEl);
      const chip = [...pickerEl.querySelectorAll(".category-chip")].find(
        (c) => c.dataset.id === cat.id
      );
      chip?.click();
    } catch (err) {
      alert("Couldn't create category — check your connection.");
    }
  });
}

// ------------------------------------------------------------
// Capture form — used by both index.html and capture.html
// ------------------------------------------------------------
export async function initCaptureForm({ formEl, prefill = {}, onSaved } = {}) {
  await loadCategories();

  const pickerEl = formEl.querySelector("#category-picker");
  const hiddenInputEl = formEl.querySelector("#category_id");
  renderCategoryPicker(pickerEl, hiddenInputEl);
  wireAddCategory(pickerEl, hiddenInputEl);

  const sourceItemEl = formEl.querySelector("#source_item_id");
  if (sourceItemEl) {
    await loadShelfItems();
    renderShelfConnectDropdown(sourceItemEl);
    wireShelfConnectDropdown(formEl);
  }

  if (prefill.quote) formEl.querySelector("#quote").value = prefill.quote;
  if (prefill.link) formEl.querySelector("#link").value = prefill.link;

  const usedAtEl = formEl.querySelector("#used_at");
  if (usedAtEl && !usedAtEl.value) {
    usedAtEl.value = new Date().toISOString().slice(0, 16);
  }

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = formEl.querySelector("#sync-status");

    const now = new Date().toISOString();
    const note = {
      quote: formEl.querySelector("#quote").value.trim(),
      link: formEl.querySelector("#link").value.trim() || null,
      source_type: formEl.querySelector("#source_type").value,
      category_id: hiddenInputEl.value || null,
      context: formEl.querySelector("#context").value.trim() || null,
      source_used_at: usedAtEl ? new Date(usedAtEl.value).toISOString() : now,
      client_id: crypto.randomUUID(),
      // Recording a quote means you've already engaged with the source —
      // distinct from the Shelf's "add to read later" flow, which starts
      // items at to_read instead.
      kind: "note",
      status: "done",
      last_touched: now,
      source_item_id: sourceItemEl?.value || null,
    };

    if (!note.quote) return;

    // Always queue locally first — this is the source of truth until synced
    await queueNote(note);
    formEl.reset();
    renderCategoryPicker(pickerEl, hiddenInputEl);

    if (statusEl) {
      statusEl.textContent = "Queued — syncing…";
      statusEl.className = "sync-status pending";
    }

    onSaved?.(note);
    syncPendingNotes();
  });
}

// ------------------------------------------------------------
// Offline queue sync — fires on load, on 'online', and periodically
// (iOS Safari has no Background Sync API, so this covers the gap)
// ------------------------------------------------------------
export async function syncPendingNotes() {
  const pending = await getPendingNotes();
  if (pending.length === 0) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return; // not signed in yet — nothing to sync against

  for (const note of pending) {
    const { client_id, queue_status, queued_at, status, ...rest } = note;
    // A note still queued from before `queue_status` existed has no such
    // field — its `status` is really the old queue-bookkeeping value
    // ("pending"/"failed"), not a valid reading_status, so drop it and let
    // the column default apply instead of inserting garbage into the enum.
    const payload = queue_status ? { ...rest, status } : rest;
    const { error } = await supabase.from("notes").insert({
      ...payload,
      client_id,
      user_id: user.id,
    });
    if (error) {
      // Unique violation on client_id means it's already synced — treat as success
      if (error.code === "23505") await markSynced(client_id);
      else await markFailed(client_id);
    } else {
      await markSynced(client_id);
    }
  }

  const statusEl = document.getElementById("sync-status");
  if (statusEl) {
    statusEl.textContent = "All notes synced.";
    statusEl.className = "sync-status synced";
  }

  refreshNotesList();
}

window.addEventListener("online", syncPendingNotes);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") syncPendingNotes();
});

// ------------------------------------------------------------
// Notes list
// ------------------------------------------------------------
let showArchived = false;

async function archiveNote(id, archive) {
  await supabase
    .from("notes")
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq("id", id);
  refreshNotesList();
}

async function refreshNotesList() {
  const listEl = document.getElementById("notes-list");
  if (!listEl) return;

  let query = supabase
    .from("notes")
    .select("*, categories(name, color)")
    .eq("kind", "note")
    .order("created_at", { ascending: false })
    .limit(100);
  query = showArchived ? query.not("archived_at", "is", null) : query.is("archived_at", null);

  const { data, error } = await query;
  if (error || !data) return;

  listEl.innerHTML = data
    .map((n) => {
      const source = n.source_item_id ? shelfItemsCache.find((i) => i.id === n.source_item_id) : null;
      return `
    <div class="note-card${n.archived_at ? " archived" : ""}">
      <div class="quote">${escapeHtml(n.quote)}</div>
      <div class="meta">
        <span>${n.categories?.name ?? "Uncategorised"}</span>
        <span>${n.source_type}</span>
        <span>${new Date(n.source_used_at).toLocaleDateString()}</span>
        ${n.link ? `<a href="${n.link}" target="_blank">link →</a>` : ""}
        <button type="button" class="archive-btn" data-id="${n.id}" data-archive="${n.archived_at ? "0" : "1"}">${n.archived_at ? "Unarchive" : "Archive"}</button>
      </div>
      ${source ? `<div class="note-source">from: ${escapeHtml(source.quote)}</div>` : ""}
      ${n.context ? `<div class="context">${escapeHtml(n.context)}</div>` : ""}
    </div>`;
    })
    .join("");

  listEl.querySelectorAll(".archive-btn").forEach((btn) => {
    btn.addEventListener("click", () => archiveNote(btn.dataset.id, btn.dataset.archive === "1"));
  });
}

document.getElementById("toggle-archived")?.addEventListener("click", (e) => {
  showArchived = !showArchived;
  e.target.textContent = showArchived ? "Show active" : "Show archived";
  refreshNotesList();
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// A form that starts collapsed behind a toggle link, to keep a page from
// growing tall once it's mostly a list — used for both the Notes capture
// form and the Shelf's "add another" form.
function wireCollapsibleForm(toggleId, formId) {
  const toggleBtn = document.getElementById(toggleId);
  const formEl = document.getElementById(formId);
  if (!toggleBtn || !formEl) return null;
  const openLabel = toggleBtn.textContent;

  toggleBtn.addEventListener("click", () => {
    formEl.hidden = !formEl.hidden;
    toggleBtn.textContent = formEl.hidden ? openLabel : "Hide form";
  });

  return {
    collapse() {
      formEl.hidden = true;
      toggleBtn.textContent = openLabel;
    },
  };
}

// ------------------------------------------------------------
// Reading dashboard — status/last_touched lifecycle on top of notes.
// Starting an item is an explicit action; last_touched is stamped only
// on those explicit actions, never inferred from viewing the dashboard.
// ------------------------------------------------------------
const TO_READ_CAP = 5;
let toReadExpanded = false;

async function startReading(id) {
  await supabase
    .from("notes")
    .update({ status: "reading", last_touched: new Date().toISOString() })
    .eq("id", id);
  refreshReadingDashboard();
}

async function markProgress(id) {
  await supabase.from("notes").update({ last_touched: new Date().toISOString() }).eq("id", id);
  refreshReadingDashboard();
}

async function markDone(id) {
  await supabase
    .from("notes")
    .update({ status: "done", last_touched: new Date().toISOString() })
    .eq("id", id);
  refreshReadingDashboard();
}

// "Add to Shelf" — the queuing counterpart to the quote-capture form.
// Different mindframe, different form: no quote required, since you
// haven't read this yet. Inserts directly (no offline queue) since this
// is an in-app action, not a share-sheet capture.
function initShelfForm() {
  const formEl = document.getElementById("add-to-shelf-form");
  if (!formEl) return;

  const pickerEl = document.getElementById("shelf-category-picker");
  const hiddenInputEl = document.getElementById("shelf_category_id");
  renderCategoryPicker(pickerEl, hiddenInputEl);
  wireAddCategory(pickerEl, hiddenInputEl);

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = document.getElementById("shelf-sync-status");
    const title = document.getElementById("shelf_title").value.trim();
    if (!title) return;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const now = new Date().toISOString();
    const { error } = await supabase.from("notes").insert({
      quote: title,
      link: document.getElementById("shelf_link").value.trim() || null,
      source_type: document.getElementById("shelf_source_type").value,
      category_id: hiddenInputEl.value || null,
      context: document.getElementById("shelf_context").value.trim() || null,
      source_used_at: now,
      kind: "shelf",
      status: "to_read",
      last_touched: now,
      client_id: crypto.randomUUID(),
      user_id: user.id,
    });

    if (error) {
      if (statusEl) statusEl.textContent = "Couldn't add — check your connection.";
      return;
    }

    formEl.reset();
    renderCategoryPicker(pickerEl, hiddenInputEl);
    if (statusEl) statusEl.textContent = "Added to shelf.";
    await loadShelfItems();
    renderShelfConnectDropdown(document.getElementById("source_item_id"));
    refreshReadingDashboard();
    shelfFormToggle?.collapse();
  });
}

function momentumPill(item) {
  const momentum = computeMomentum(item.last_touched);
  return `<span class="momentum-pill momentum-${momentum}">${momentum}</span>`;
}

function readingCard(item) {
  const days = daysSince(item.last_touched);
  return `
    <div class="reading-card">
      <div class="reading-card-title">${escapeHtml(item.quote)}</div>
      <div class="reading-card-meta">
        <span>${item.source_type}</span>
        <span>${item.categories?.name ?? "Uncategorised"}</span>
        ${momentumPill(item)}
        <span>${days}d ago</span>
      </div>
      <div class="reading-card-actions">
        <button type="button" class="link-action" data-action="progress" data-id="${item.id}">Mark progress</button>
        <button type="button" class="link-action" data-action="done" data-id="${item.id}">Mark done</button>
      </div>
    </div>`;
}

function toReadRow(item, now = new Date()) {
  const stillWantThis = !!item.resurfaced_at;
  return `
    <div class="to-read-row">
      <div class="to-read-title">${escapeHtml(item.quote)}</div>
      <div class="to-read-meta">
        <span>${item.source_type}</span>
        <span>${item.categories?.name ?? "Uncategorised"}</span>
        <span>${daysSince(item.source_used_at, now)}d in queue</span>
        ${stillWantThis ? `<span class="resurface-flag">Still want to read this?</span>` : ""}
        <button type="button" class="link-action" data-action="start" data-id="${item.id}">Start reading</button>
      </div>
    </div>`;
}

function topicRollup(items) {
  const counts = new Map();
  for (const item of items) {
    const name = item.categories?.name ?? "Uncategorised";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return `<p class="reading-empty">Nothing tagged yet.</p>`;
  return `<div class="topic-rollup">${sorted
    .map(([name, count]) => `<span class="topic-rollup-row"><span>${escapeHtml(name)}</span><span>${count}</span></span>`)
    .join("")}</div>`;
}

async function refreshReadingDashboard() {
  const view = document.getElementById("view-reading");
  if (!view) return;

  const { data, error } = await supabase
    .from("notes")
    .select("*, categories(name, color)")
    .eq("kind", "shelf")
    .is("archived_at", null)
    .order("last_touched", { ascending: false });
  if (error || !data) return;

  const reading = data.filter((n) => n.status === "reading");
  const toRead = data.filter((n) => n.status === "to_read");
  const activeForTopics = data.filter((n) => n.status !== "done");

  const coldItems = reading.filter((n) => isColdReadingItem(n));
  const calloutEl = document.getElementById("cold-callout");
  if (calloutEl) {
    calloutEl.hidden = coldItems.length === 0;
    if (coldItems.length > 0) {
      calloutEl.innerHTML = `<strong>${coldItems.length} item${coldItems.length === 1 ? "" : "s"} gone cold.</strong> It's been 21+ days since you touched ${coldItems.length === 1 ? "it" : "them"}.`;
    }
  }

  const readingListEl = document.getElementById("reading-list");
  if (readingListEl) {
    readingListEl.innerHTML =
      reading.length > 0
        ? reading.map(readingCard).join("")
        : `<p class="reading-empty">Nothing in progress — start something from To Read.</p>`;
  }

  const toReadListEl = document.getElementById("to-read-list");
  const toReadMoreBtn = document.getElementById("to-read-more");
  if (toReadListEl) {
    const shown = toReadExpanded ? toRead : toRead.slice(0, TO_READ_CAP);
    toReadListEl.innerHTML =
      shown.length > 0
        ? shown.map((item) => toReadRow(item)).join("")
        : `<p class="reading-empty">Nothing queued.</p>`;
    if (toReadMoreBtn) {
      const remaining = toRead.length - shown.length;
      toReadMoreBtn.hidden = toReadExpanded || remaining <= 0;
      toReadMoreBtn.textContent = `+${remaining} more`;
    }
  }

  const rollupEl = document.getElementById("topic-rollup");
  if (rollupEl) rollupEl.innerHTML = topicRollup(activeForTopics);

  view.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { action, id } = btn.dataset;
      if (action === "start") startReading(id);
      if (action === "progress") markProgress(id);
      if (action === "done") markDone(id);
    });
  });
}

document.getElementById("to-read-more")?.addEventListener("click", () => {
  toReadExpanded = true;
  refreshReadingDashboard();
});

// ------------------------------------------------------------
// Digest view
// ------------------------------------------------------------
async function refreshDigest() {
  const el = document.getElementById("digest-content");
  if (!el) return;

  const { data, error } = await supabase
    .from("digests")
    .select("*")
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    el.innerHTML = `<p class="digest-empty">No digest yet — the first one lands Saturday at 10am.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="digest-card">
      <h2>Week of ${new Date(data.week_start).toLocaleDateString()}</h2>
      <div class="range">${data.note_count} notes · ${new Date(data.week_start).toLocaleDateString()} – ${new Date(data.week_end).toLocaleDateString()}</div>
      <div class="summary">${escapeHtml(data.summary)}</div>
    </div>`;
}

// ------------------------------------------------------------
// Realtime — new notes and digests appear live across devices
// ------------------------------------------------------------
supabase
  .channel("notes-changes")
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "notes" }, async () => {
    await loadShelfItems();
    renderShelfConnectDropdown(document.getElementById("source_item_id"));
    refreshNotesList();
    refreshReadingDashboard();
  })
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "notes" }, async () => {
    await loadShelfItems();
    renderShelfConnectDropdown(document.getElementById("source_item_id"));
    refreshNotesList();
    refreshReadingDashboard();
  })
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "digests" }, refreshDigest)
  .subscribe();

// ------------------------------------------------------------
// Auth — emailed one-time code (index.html only; capture.html queues
// offline and syncs later when the user opens index.html signed in).
// A typed code is used instead of a clickable magic link because a
// standalone home-screen PWA on iOS has storage isolated from Safari,
// so a session started by tapping the link in Mail (which opens in
// Safari) never reaches the installed app. Some email providers'
// link-scanners also pre-visit and burn single-use magic links before
// the user ever clicks them. A code typed directly into the app avoids
// both problems.
// ------------------------------------------------------------
function setAuthedUI(isAuthed) {
  const loginView = document.getElementById("view-login");
  const notesView = document.getElementById("view-notes");
  const tabbar = document.querySelector("nav.tabbar");
  const signoutBtn = document.getElementById("signout-btn");
  if (!loginView) return; // capture.html has no auth gate

  loginView.classList.toggle("active", !isAuthed);
  if (tabbar) tabbar.hidden = !isAuthed;
  if (signoutBtn) signoutBtn.hidden = !isAuthed;

  if (isAuthed) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    notesView?.classList.add("active");
    document.querySelectorAll("nav.tabbar button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === "notes")
    );
  } else {
    notesView?.classList.remove("active");
    const loginForm = document.getElementById("login-form");
    const codeForm = document.getElementById("login-code-form");
    if (loginForm && codeForm) {
      codeForm.hidden = true;
      codeForm.reset();
      loginForm.hidden = false;
      loginForm.reset();
    }
  }
}

async function initAuth() {
  const loginForm = document.getElementById("login-form");
  const codeForm = document.getElementById("login-code-form");
  let pendingEmail = "";

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = loginForm.querySelector("#login-email").value.trim();
      const statusEl = document.getElementById("login-status");
      if (!email) return;
      statusEl.textContent = "Sending…";
      statusEl.className = "sync-status";
      const { error } = await supabase.auth.signInWithOtp({ email });
      if (error) {
        statusEl.textContent = "Couldn't send code — try again.";
        statusEl.className = "sync-status";
        return;
      }
      pendingEmail = email;
      statusEl.textContent = "";
      loginForm.hidden = true;
      codeForm.hidden = false;
      codeForm.querySelector("#login-code").focus();
    });
  }

  if (codeForm) {
    codeForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = codeForm.querySelector("#login-code").value.trim();
      const statusEl = document.getElementById("login-code-status");
      if (!token) return;
      statusEl.textContent = "Verifying…";
      statusEl.className = "sync-status";
      const { error } = await supabase.auth.verifyOtp({
        email: pendingEmail,
        token,
        type: "email",
      });
      if (error) {
        statusEl.textContent = "Wrong or expired code — try again.";
        statusEl.className = "sync-status";
      }
      // On success, onAuthStateChange below swaps the view — nothing more to do here.
    });

    document.getElementById("login-code-back")?.addEventListener("click", () => {
      codeForm.hidden = true;
      codeForm.reset();
      document.getElementById("login-code-status").textContent = "";
      loginForm.hidden = false;
    });
  }

  document.getElementById("signout-btn")?.addEventListener("click", () => supabase.auth.signOut());

  supabase.auth.onAuthStateChange(async (_event, session) => {
    setAuthedUI(!!session?.user);
    if (session?.user) {
      await loadCategories();
      const pickerEl = document.getElementById("category-picker");
      const hiddenInputEl = document.getElementById("category_id");
      if (pickerEl && hiddenInputEl) renderCategoryPicker(pickerEl, hiddenInputEl);
      const shelfPickerEl = document.getElementById("shelf-category-picker");
      const shelfHiddenInputEl = document.getElementById("shelf_category_id");
      if (shelfPickerEl && shelfHiddenInputEl) renderCategoryPicker(shelfPickerEl, shelfHiddenInputEl);
      await loadShelfItems();
      renderShelfConnectDropdown(document.getElementById("source_item_id"));
      syncPendingNotes();
      refreshNotesList();
      refreshReadingDashboard();
      refreshDigest();
    }
  });

  const { data: { session } } = await supabase.auth.getSession();
  setAuthedUI(!!session?.user);
}

// ------------------------------------------------------------
// Tab navigation (index.html only — capture.html is single-view)
// ------------------------------------------------------------
const tabbar = document.querySelector("nav.tabbar");
if (tabbar) {
  tabbar.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      tabbar.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      const view = document.getElementById(`view-${btn.dataset.view}`);
      view.classList.add("active");
      if (btn.dataset.view === "notes") refreshNotesList();
      if (btn.dataset.view === "reading") refreshReadingDashboard();
      if (btn.dataset.view === "digest") refreshDigest();
    });
  });
}

// ------------------------------------------------------------
// Boot (index.html)
// ------------------------------------------------------------
const dateEl = document.getElementById("today");
if (dateEl) {
  dateEl.textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

const notesFormToggle = wireCollapsibleForm("toggle-capture-form", "capture-form");
const shelfFormToggle = wireCollapsibleForm("toggle-shelf-form", "add-to-shelf-form");

const mainCaptureForm = document.getElementById("capture-form");
if (mainCaptureForm && document.getElementById("view-notes")) {
  initCaptureForm({
    formEl: mainCaptureForm,
    onSaved: () => {
      refreshNotesList();
      notesFormToggle?.collapse();
    },
  });
}

initShelfForm();

initAuth();
syncPendingNotes();
