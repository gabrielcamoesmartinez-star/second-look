import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { Link } from 'react-router-dom';
import { Logo } from './Logo';

export function Layout({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-black/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-6 px-6">
          <Logo />
          <nav aria-label="Main" className="flex flex-1 gap-4 text-sm">
            {session && <Link to="/audits">Audits</Link>}
          </nav>
          {session ? (
            <button
              type="button"
              onClick={() => void supabase.auth.signOut()}
              className="h-9 rounded-md border border-line px-3 text-sm text-white hover:border-white/50"
            >
              Sign out
            </button>
          ) : (
            <Link to="/login" className="text-sm">Sign in</Link>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
    </div>
  );
}
