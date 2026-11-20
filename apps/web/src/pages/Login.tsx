import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useAuth } from '../lib/auth.tsx';
import { supabase } from '../lib/supabase.ts';

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'error'; message: string };

export function Login() {
  const { session } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const expired = params.get('error') === 'expired';

  if (session) return <Navigate to="/audits" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setState({ kind: 'sending' });
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setState(error ? { kind: 'error', message: friendly(error.message) } : { kind: 'sent', email: email.trim() });
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-3xl font-medium tracking-tight">Sign in</h1>
      <p className="mt-2 text-muted">We'll email you a link. No password needed.</p>

      {expired && state.kind !== 'sent' && (
        <p role="alert" className="mt-6 rounded border border-warn/40 p-3 text-warn">
          That sign-in link has expired or was already used. Send yourself a new one.
        </p>
      )}

      {state.kind === 'sent' ? (
        <div role="status" className="mt-6 rounded border border-line p-4">
          <p>Check your inbox at <span className="font-mono">{state.email}</span> and open the link on this device.</p>
          <button className="mt-3 text-link underline" onClick={() => setState({ kind: 'idle' })}>
            Use a different email
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-3" noValidate>
          <label htmlFor="email" className="block text-sm text-muted">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-line bg-surface px-3 py-2"
            aria-invalid={state.kind === 'error'}
            aria-describedby={state.kind === 'error' ? 'email-error' : undefined}
          />
          {state.kind === 'error' && <p id="email-error" role="alert" className="text-fail">{state.message}</p>}
          <button
            type="submit"
            disabled={state.kind === 'sending' || !/^\S+@\S+\.\S+$/.test(email)}
            aria-busy={state.kind === 'sending'}
            className="rounded bg-white px-4 py-2 font-medium text-black disabled:opacity-50"
          >
            {state.kind === 'sending' ? 'Sending…' : 'Email me a link'}
          </button>
        </form>
      )}
    </main>
  );
}

function friendly(message: string): string {
  if (/rate limit/i.test(message)) return 'Too many sign-in emails. Wait a minute and try again.';
  if (/invalid/i.test(message)) return "That email address doesn't look right.";
  return 'We could not send the email. Try again.';
}
