import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../lib/auth.tsx';
import { supabase } from '../lib/supabase.ts';

/** Stage 1 plain header. The designed AppHeader arrives in Stage 4. */
export function Layout({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return (
    <>
      <header className="sticky top-0 flex items-center justify-between border-b border-line bg-black/90 px-6 py-3">
        <Link to="/audits" className="font-medium">Second <span className="italic text-muted">look</span></Link>
        {session && (
          <nav className="flex items-center gap-4 text-sm">
            <Link to="/audits">Audits</Link>
            <span className="text-dim">{session.user.email}</span>
            <button className="text-link underline" onClick={() => void supabase.auth.signOut()}>Sign out</button>
          </nav>
        )}
      </header>
      {children}
    </>
  );
}
