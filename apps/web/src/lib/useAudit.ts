import type { AuditRow, AuditStepRow } from '@second-look/shared';
import { useCallback, useEffect, useState } from 'react';
import { getAudit } from './api.ts';
import { supabase } from './supabase.ts';

/** Loads an audit and keeps it live via Realtime (with a slow poll as a fallback). */
export function useLiveAudit(id: string) {
  const [audit, setAudit] = useState<AuditRow | null>(null);
  const [steps, setSteps] = useState<AuditStepRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await getAudit(id);
      setAudit(r.audit);
      setSteps(r.steps);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    const channel = supabase
      .channel(`audit:${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_steps', filter: `audit_id=eq.${id}` }, () => void refresh())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'audits', filter: `id=eq.${id}` }, () => void refresh())
      .subscribe();
    const poll = setInterval(() => void refresh(), 10_000);
    return () => {
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [id, refresh]);

  return { audit, steps, error, loading, refresh };
}
