# Marginalia — setup guide

A note-taking PWA for quotes and links you want to remember, with a Saturday
10am digest that pulls out themes across the week.

## 1. Supabase

1. Create a project at supabase.com.
2. Run `supabase-schema.sql` in the SQL editor. This creates `categories`,
   `notes` (append-only — no update/delete policy), `digests`, and RLS
   policies scoped to `auth.uid()`.
3. Enable **Email (magic link)** auth under Authentication → Providers.
4. Copy your Project URL and anon key into `public/supabase-client.js`.
5. If you already ran `supabase-schema.sql` against a project with real data
   in it, also run `supabase-migration-002-archive-and-digest-exclude.sql` —
   it adds note archiving and per-category digest exclusion without
   dropping any tables. New projects get both from `supabase-schema.sql`
   directly and can skip this step.

## 2. Weekly digest function

1. Install the Supabase CLI, then from the project root:
   ```
   supabase functions deploy weekly-digest
   supabase secrets set GEMINI_API_KEY=your-key-here
   ```
2. Get a free Gemini API key at aistudio.google.com/apikey.
3. (Optional) Email each user their own digest using your existing Resend
   connection — add these secrets too:
   ```
   supabase secrets set RESEND_API_KEY=your-resend-key
   supabase secrets set DIGEST_EMAIL_FROM="Marginalia <onboarding@resend.dev>"
   ```
   The function looks up each user's email from Supabase Auth (via the
   service role key it already has) and sends their digest there — so as
   you add more users, each one gets their own, not just you.
   `DIGEST_EMAIL_FROM` defaults to Resend's shared `onboarding@resend.dev`
   sender if you don't set it — swap in your own verified domain once you
   have one. If `RESEND_API_KEY` isn't set, the function just skips
   emailing and keeps writing to `digests` as before.
4. Schedule it for Saturday 10:00 (your timezone) using `pg_cron` — in the
   SQL editor:
   ```sql
   select cron.schedule(
     'weekly-digest-saturday',
     '0 10 * * 6',  -- 10:00 every Saturday, in the DB's configured timezone
     $$
     select net.http_post(
       url := 'https://YOUR-PROJECT.functions.supabase.co/weekly-digest',
       headers := '{"Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb
     );
     $$
   );
   ```
   Set the Postgres timezone first if needed: `alter database postgres set timezone to 'Europe/London';`

## 3. Hosting — GitHub Pages

1. Create a repo called `marginalia` (public or private — Pages works either way
   on a paid plan; must be public on the free plan).
2. Push this project so `public/` sits at the repo root, or configure Pages to
   serve from `/public` — either works, just be consistent with the paths below.
3. In repo Settings → Pages, set the source branch and folder, save.
4. Your app will be live at `https://YOUR-USERNAME.github.io/marginalia/`.

This is a **project page**, separate from any existing `YOUR-USERNAME.github.io`
user page — they coexist without conflict. All paths in this project
(`manifest.json`, `sw.js`, `app.js`) are already set for the `/marginalia/`
subpath. If you rename the repo, update those three files to match, or the
service worker and share-target will silently fail.

(Vercel, Netlify, or Cloudflare Pages also work fine and are arguably simpler —
each gives you a root-level URL with no subpath rewriting needed. GitHub Pages
was chosen here since you already have one page live and know the workflow.)

## 4. Icons

Add `icons/icon-192.png`, `icons/icon-512.png`, and `icons/icon-512-maskable.png`
to `public/icons/`. Any square PNG works to start.

## 5. Capture on iOS

iOS Safari PWAs don't reliably support the Web Share Target API, so
`share_target` in the manifest will work on Android but not iPhone. Two
iOS-native fallbacks:

**Option A — Shortcuts (recommended).** Create a Shortcut:
`Get Text from Input` → `Open URL`: `https://YOUR-USERNAME.github.io/marginalia/capture.html?text=[Shortcut Input]&url=[Shortcut Input]`.
Add it to the Share Sheet in Shortcuts settings. Now "Marginalia" appears
as a share option from Safari, Books, and anywhere else with a share sheet.

**Option B — Bookmarklet.** Add a bookmark with this as the URL, then
trigger it from Safari's share sheet or bookmarks bar while reading:
```
javascript:(function(){var s=window.getSelection().toString();window.location='https://YOUR-USERNAME.github.io/marginalia/capture.html?text='+encodeURIComponent(s)+'&url='+encodeURIComponent(location.href);})();
```

Either way, `capture.html` pre-fills the quote and link, you pick a category,
and it queues locally — syncing the moment there's a connection.

## 6. Web Push (optional, for the Saturday notification)

Requires the PWA added to the home screen and iOS 16.4+. You'll need to:
1. Generate VAPID keys.
2. Store push subscriptions in a new `push_subscriptions` table (not yet
   in the schema — add it when you're ready to wire this up).
3. Call the Web Push protocol from the `weekly-digest` function after
   writing the digest row.

This is left as a deliberate next step — the in-app digest view works
without it, so you can ship the core loop first and layer push on after.
