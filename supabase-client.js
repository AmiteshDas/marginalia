// Fill these in from Supabase → Project Settings → API.
// The anon key is safe to expose client-side; RLS policies do the real gatekeeping.
export const SUPABASE_URL = "https://endbioovbvynyfcoiutl.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_FUpOmrXLRohqvmMML1f_0Q_q42zvoOm";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 5 } },
});
