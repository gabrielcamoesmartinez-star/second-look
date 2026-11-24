import { AuditRow, AuditStepRow, STEP_NAMES } from '@second-look/shared';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; audit: AuditRow; steps: AuditStepRow[] };

const order = (s: AuditStepRow) => STEP_NAMES.indexOf(s.step);

/** Loads an audit and its steps, then keeps both live over Supabase Realtime. */
export function useAudit(id: string): State {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let audit: AuditRow | null = null;
    let steps: AuditStepRow[] = [];
    const push = () => {
      if (!cancelled && audit) setState({ kind: 'ready', audit, steps: [...steps].sort((a, b) => order(a) - order(b)) });
    };

    const load = async () => {
      const [a, s] = await Promise.all([
        supabase.from('audits').select('*').eq('id', id).maybeSingle(),
        supabase.from('audit_steps').select('*').eq('audit_id', id),
      ]);
      if (cancelled) return;
      if (a.error || s.error) return setState({ kind: 'error', message: 'Could not load this audit. Refresh to try again.' });
      if (!a.data) return setState({ kind: 'error', message: "This audit doesn't exist, or it isn't yours." });
      const parsedAudit = AuditRow.safeParse(a.data);
      const parsedSteps = AuditStepRow.array().safeParse(s.data);
      if (!parsedAudit.success || !parsedSteps.success)
        return setState({ kind: 'error', message: 'This audit has data we could not read.' });
      audit = parsedAudit.data;
      steps = parsedSteps.data;
      push();
    };

    const channel = supabase
      .channel(`audit-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'audits', filter: `id=eq.${id}` }, (p) => {
        const parsed = AuditRow.safeParse(p.new);
        if (parsed.success) {
          audit = parsed.data;
          push();
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_steps', filter: `audit_id=eq.${id}` }, (p) => {
        const parsed = AuditStepRow.safeParse(p.new);
        if (parsed.success) {
          steps = [...steps.filter((x) => x.step !== parsed.data.step), parsed.data];
          push();
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void load(); // load after subscribing so no update is missed
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [id]);

  return state;
}
