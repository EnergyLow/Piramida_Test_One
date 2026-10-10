import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://btyejqlyvoajcdufpesf.supabase.co";
const SUPABASE_KEY = "sb_publishable_TndnkyQrmhQP8AEAeMShRw_abXL0Lbj";

export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);