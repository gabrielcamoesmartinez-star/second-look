import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/** Stage 1 placeholder home. The full landing page arrives in Stage 5. */
export function Home() {
  const { session } = useAuth();
  return (
    <section className="py-16">
      <h1 className="text-5xl font-medium tracking-[-0.045em]">Your website, checked by AI, judged by people.</h1>
      <p className="mt-4 max-w-xl text-lg text-muted">
        Paste a business website and see what may be costing it enquiries: speed, accessibility and local SEO, measured with real tools.
      </p>
      <Link
        to={session ? '/audits' : '/login'}
        className="mt-8 inline-flex h-11 items-center rounded-md bg-gradient-to-b from-white via-[#e7e7e7] to-[#cfcfcf] px-5 text-sm font-medium text-[#111] no-underline hover:text-[#111]"
      >
        {session ? 'Run an audit' : 'Sign in to run an audit'}
      </Link>
    </section>
  );
}
