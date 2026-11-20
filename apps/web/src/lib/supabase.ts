import { createClient } from '@supabase/supabase-js';

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;
declare const __AUDITS_PER_USER_PER_DAY__: number;

export const SUPABASE_URL = __SUPABASE_URL__;
export const AUDITS_PER_USER_PER_DAY = __AUDITS_PER_USER_PER_DAY__;
export const isConfigured = SUPABASE_URL.length > 0 && __SUPABASE_ANON_KEY__.length > 0;

export const supabase = createClient(SUPABASE_URL || 'http://not-configured.invalid', __SUPABASE_ANON_KEY__ || 'missing', {
  auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true },
});

export const ARTIFACT_BUCKET = 'audit-artifacts';
