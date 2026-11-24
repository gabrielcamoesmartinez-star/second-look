import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/** supabase-js exchanges the code in the URL automatically; this page waits for the session. */
export function AuthCallback() {
  const { session } = useAuth();
  const [timedOut, setTimedOut] = useState(false);
  const urlError = new URLSearchParams(window.location.search).get('error_description');
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 8000);
    return () => clearTimeout(t);
  }, []);
  if (session) return <Navigate to="/audits" replace />;
  if (urlError || timedOut)
    return (
      <section className="py-12" role="alert">
        <h1 className="text-2xl font-medium">That sign-in link didn't work</h1>
        <p className="mt-2 text-muted">{urlError ?? 'It may have expired or already been used.'}</p>
        <Link to="/login" className="mt-4 inline-block">Send a new link</Link>
      </section>
    );
  return <p className="py-12 text-muted" aria-busy="true">Signing you in…</p>;
}
