// Supabase Edge Function: weekly-digest
// Triggered by a cron schedule (Saturday 10:00) — see /supabase/README.md for setup.
// Reads the past 7 days of notes, asks Gemini for a thematic summary,
// writes the result to `digests`, and (optionally) sends a Web Push notification.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

// Optional — email delivery of the digest via Resend, sent to each user's
// own account email. If RESEND_API_KEY isn't set, the function just skips
// sending and keeps writing to `digests` as before.
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const DIGEST_EMAIL_FROM = Deno.env.get("DIGEST_EMAIL_FROM") ?? "Marginalia <onboarding@resend.dev>";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function startOfWeekWindow(now = new Date()) {
  // 7-day window ending "now" (the Saturday 10am run time)
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  return { start, end };
}

function categoryBreakdown(notes: any[]): string {
  const counts = new Map<string, number>();
  for (const n of notes) {
    const cat = n.categories?.name ?? "Uncategorised";
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} — ${count} note${count === 1 ? "" : "s"}`)
    .join("\n");
}

async function buildDigestPrompt(notes: any[]) {
  const lines = notes.map((n) => {
    const cat = n.categories?.name ?? "Uncategorised";
    return `- [${cat} / ${n.source_type}] "${n.quote}" — context: ${n.context ?? "none"} (${n.link ?? "no link"})`;
  });

  return `You are summarising one week of reading notes for a single reader.
Below is a list of quotes they saved this week, each tagged with its category and source type.

${lines.join("\n")}

Write a digest with two plain-text sections, no markdown symbols (no #, no **, no bullet dashes made of asterisks — use "-" for list items).

THEMES
List 2-4 real themes. Each one must be a concrete, specific claim tied directly to what's actually in the notes above — reference the actual subject matter, not a vague abstraction like "the intersection of ideas" or "a tapestry of thought." If a theme only really applies to one note, say so plainly instead of stretching it to cover others.

CONNECTIONS
Only include this section if there is a genuine, specific link between two or more notes from different categories — something a reader would find surprising and true, not a generic thread like "both relate to human experience." If no such link exists, omit this section entirely rather than manufacturing one.

Keep language plain and direct — short sentences, concrete nouns, no filler ("In this digest we will..."), no dense abstract phrasing. If the notes are too sparse to say anything real, say so plainly instead of forcing content.`;
}

async function callGemini(prompt: string): Promise<string> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );
  if (!resp.ok) {
    throw new Error(`Gemini API error: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "No summary generated.";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendDigestEmail(toEmail: string, summary: string, weekStart: string, weekEnd: string, noteCount: number) {
  if (!RESEND_API_KEY) return;

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="margin-bottom: 4px;">Your Marginalia digest</h2>
      <p style="color: #666; margin-top: 0;">${weekStart} – ${weekEnd} · ${noteCount} note${noteCount === 1 ? "" : "s"}</p>
      <p style="white-space: pre-wrap; line-height: 1.5;">${escapeHtml(summary)}</p>
    </div>
  `;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: DIGEST_EMAIL_FROM,
      to: toEmail,
      subject: `Marginalia digest: ${weekStart} – ${weekEnd}`,
      html,
    }),
  });

  if (!resp.ok) {
    // Don't fail the whole run over an email hiccup — the digest is already saved.
    console.error(`Resend email failed for ${toEmail}: ${resp.status} ${await resp.text()}`);
  }
}

Deno.serve(async (_req) => {
  try {
    const { start, end } = startOfWeekWindow();

    const { data: allNotes, error } = await supabase
      .from("notes")
      .select("id, quote, link, source_type, context, category_id, user_id, categories(name, exclude_from_digest)")
      .gte("created_at", start.toISOString())
      .lte("created_at", end.toISOString())
      .order("created_at", { ascending: true });

    if (error) throw error;

    // Categories marked exclude_from_digest are left out of the summary
    // entirely, even though they still show up in the Notes list.
    const notes = (allNotes ?? []).filter((n) => !n.categories?.exclude_from_digest);

    if (notes.length === 0) {
      return new Response(JSON.stringify({ message: "No notes this week — skipping digest." }), {
        status: 200,
      });
    }

    // Group by user in case of future multi-user use
    const byUser = new Map<string, any[]>();
    for (const n of notes) {
      if (!byUser.has(n.user_id)) byUser.set(n.user_id, []);
      byUser.get(n.user_id)!.push(n);
    }

    const results = [];
    for (const [userId, userNotes] of byUser) {
      const prompt = await buildDigestPrompt(userNotes);
      const llmSummary = await callGemini(prompt);
      const summary = `CATEGORIES THIS WEEK\n${categoryBreakdown(userNotes)}\n\n${llmSummary}`;

      const { error: insertError } = await supabase.from("digests").upsert(
        {
          user_id: userId,
          week_start: start.toISOString().slice(0, 10),
          week_end: end.toISOString().slice(0, 10),
          summary,
          note_count: userNotes.length,
        },
        { onConflict: "user_id,week_start" }
      );
      if (insertError) throw insertError;

      const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);
      if (userError) {
        console.error(`Could not look up email for user ${userId}: ${userError.message}`);
      } else if (userData.user.email) {
        await sendDigestEmail(
          userData.user.email,
          summary,
          start.toISOString().slice(0, 10),
          end.toISOString().slice(0, 10),
          userNotes.length
        );
      }

      // Web Push notification hook — wire in a push subscription table
      // and call your push-send logic here once notifications are set up.

      results.push({ userId, noteCount: userNotes.length });
    }

    return new Response(JSON.stringify({ digestsCreated: results }), { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
