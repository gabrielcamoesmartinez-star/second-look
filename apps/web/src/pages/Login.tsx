import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

type Status = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; email: string } | { kind: 'error'; message: string };

export function Login() {
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  if (session) return <Navigate to="/audits" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setStatus({ kind: 'sending' });
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setStatus(error ? { kind: 'error', message: error.message } : { kind: 'sent', email });
  };

  return (
    <section className="mx-auto max-w-md py-12">
      <h1 className="text-3xl font-medium tracking-[-0.04em]">Sign in</h1>
      <p className="mt-2 text-muted">We'll email you a link. No password needed.</p>
      {status.kind === 'sent' ? (
        <p role="status" className="mt-8 rounded-xl border border-line bg-surface p-5">
          Check <strong>{status.email}</strong> for a sign-in link. It expires in one hour.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-8 flex flex-col gap-3">
          <label htmlFor="email" className="text-sm font-semibold">Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={status.kind === 'error' ? 'login-error' : undefined}
            className="h-12 rounded-lg border border-white/25 bg-surface-2 px-4 text-white"
          />
          {status.kind === 'error' && (
            <p id="login-error" role="alert" className="text-sm text-fail">{status.message}</p>
          )}
          <button
            type="submit"
            disabled={status.kind === 'sending'}
            aria-busy={status.kind === 'sending'}
            className="h-12 rounded-md bg-gradient-to-b from-white via-[#e7e7e7] to-[#cfcfcf] font-medium text-[#111] disabled:opacity-60"
          >
            {status.kind === 'sending' ? 'Sending…' : 'Email me a link'}
          </button>
        </form>
      )}
    </section>
  );
}
