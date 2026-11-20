import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '../lib/auth.tsx';

/** Supabase exchanges the PKCE code automatically (detectSessionInUrl). We only handle errors. */
export function AuthCallback() {
  const { session } = useAuth();
  const [failed, setFailed] = useState(false);
  const params = new URLSearchParams(window.location.search + window.location.hash.replace(/^#/, '&'));
  const errorCode = params.get('error_code') ?? params.get('error');

  useEffect(() => {
    const t = setTimeout(() => setFailed(true), 8000);
    return () => clearTimeout(t);
  }, []);

  if (errorCode) return <Navigate to="/login?error=expired" replace />;
  if (session) return <Navigate to="/audits" replace />;
  if (failed) return <Navigate to="/login?error=expired" replace />;
  return <p aria-busy="true" className="p-8 text-muted">Signing you in…</p>;
}
