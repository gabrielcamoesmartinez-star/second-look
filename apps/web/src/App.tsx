import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { configError } from './lib/supabase';
import { Audit } from './pages/Audit';
import { Audits } from './pages/Audits';
import { AuthCallback } from './pages/AuthCallback';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { NotFound } from './pages/NotFound';

export function App() {
  if (configError) return <p role="alert" className="p-8 text-fail">{configError}</p>;
  return (
    <AuthProvider>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/audits" element={<RequireAuth><Audits /></RequireAuth>} />
            <Route path="/audits/:id" element={<RequireAuth><Audit /></RequireAuth>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </AuthProvider>
  );
}
