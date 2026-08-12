import { supabase } from "./supabase-client.js";
import { queueNote, getPendingNotes, markSynced, markFailed } from "./idb-queue.js";

// ------------------------------------------------------------
// Service worker registration — self-updating.
// sw.js caches shell assets cache-first, so a stale registration would
// otherwise keep serving old code indefinitely with no visible sign
// anything's wrong. To fix that: check for a new sw.js on every load
// and whenever the app is foregrounded (bypassing the browser's normal
// once-a-day throttle), and reload once when a new service worker
// actually takes over, so the fresh shell assets it just cached get used.
// ------------------------------------------------------------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/marginalia/sw.js", { scope: "/marginalia/" }).then((reg) => {
    reg.update();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update();
    });
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "TRY_SYNC") syncPendingNotes();
  });

  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
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

  if (prefill.quote) formEl.querySelector("#quote").value = prefill.quote;
  if (prefill.link) formEl.querySelector("#link").value = prefill.link;

  const usedAtEl = formEl.querySelector("#used_at");
  if (usedAtEl && !usedAtEl.value) {
    usedAtEl.value = new Date().toISOString().slice(0, 16);
  }

  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = formEl.querySelector("#sync-status");

    const note = {
      quote: formEl.querySelector("#quote").value.trim(),
      link: formEl.querySelector("#link").value.trim() || null,
      source_type: formEl.querySelector("#source_type").value,
      category_id: hiddenInputEl.value || null,
      context: formEl.querySelector("#context").value.trim() || null,
      source_used_at: usedAtEl ? new Date(usedAtEl.value).toISOString() : new Date().toISOString(),
      client_id: crypto.randomUUID(),
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
    const { client_id, status, queued_at, ...payload } = note;
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
    .order("created_at", { ascending: false })
    .limit(100);
  query = showArchived ? query.not("archived_at", "is", null) : query.is("archived_at", null);

  const { data, error } = await query;
  if (error || !data) return;

  listEl.innerHTML = data
    .map(
      (n) => `
    <div class="note-card${n.archived_at ? " archived" : ""}">
      <div class="quote">${escapeHtml(n.quote)}</div>
      <div class="meta">
        <span>${n.categories?.name ?? "Uncategorised"}</span>
        <span>${n.source_type}</span>
        <span>${new Date(n.source_used_at).toLocaleDateString()}</span>
        ${n.link ? `<a href="${n.link}" target="_blank">link →</a>` : ""}
        <button type="button" class="archive-btn" data-id="${n.id}" data-archive="${n.archived_at ? "0" : "1"}">${n.archived_at ? "Unarchive" : "Archive"}</button>
      </div>
      ${n.context ? `<div class="context">${escapeHtml(n.context)}</div>` : ""}
    </div>`
    )
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
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "notes" }, refreshNotesList)
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "notes" }, refreshNotesList)
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
  const captureView = document.getElementById("view-capture");
  const tabbar = document.querySelector("nav.tabbar");
  const signoutBtn = document.getElementById("signout-btn");
  if (!loginView) return; // capture.html has no auth gate

  loginView.classList.toggle("active", !isAuthed);
  if (tabbar) tabbar.hidden = !isAuthed;
  if (signoutBtn) signoutBtn.hidden = !isAuthed;

  if (isAuthed) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    captureView?.classList.add("active");
    document.querySelectorAll("nav.tabbar button").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === "capture")
    );
  } else {
    captureView?.classList.remove("active");
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
      syncPendingNotes();
      refreshNotesList();
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

const mainCaptureForm = document.getElementById("capture-form");
if (mainCaptureForm && document.getElementById("view-capture")) {
  initCaptureForm({
    formEl: mainCaptureForm,
    onSaved: () => refreshNotesList(),
  });
}

initAuth();
syncPendingNotes();
