import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout.tsx';
import { AuthProvider, RequireAuth } from './lib/auth.tsx';
import { isConfigured } from './lib/supabase.ts';
import { AuthCallback } from './pages/AuthCallback.tsx';
import { Audits } from './pages/Audits.tsx';
import { Login } from './pages/Login.tsx';
import { Report } from './pages/Report.tsx';
import { Running } from './pages/Running.tsx';
import './index.css';

function App() {
  if (!isConfigured) {
    return (
      <main className="p-8">
        <h1 className="text-2xl">Not configured</h1>
        <p className="mt-2 text-muted">Set SUPABASE_URL and SUPABASE_ANON_KEY (see .env.example) and rebuild.</p>
      </main>
    );
  }
  return (
    <AuthProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            {/* The landing page is Stage 5; until then / goes to the app. */}
            <Route path="/" element={<Navigate to="/audits" replace />} />
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/audits" element={<RequireAuth><Audits /></RequireAuth>} />
            <Route path="/audits/:id/running" element={<RequireAuth><Running /></RequireAuth>} />
            <Route path="/audits/:id" element={<RequireAuth><Report /></RequireAuth>} />
            <Route
              path="*"
              element={
                <main className="p-8">
                  <h1 className="text-2xl">Page not found</h1>
                  <Link to="/audits" className="mt-2 inline-block text-link underline">Go to your audits</Link>
                </main>
              }
            />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AuthProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
