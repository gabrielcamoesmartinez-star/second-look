import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <section className="py-16">
      <h1 className="text-4xl font-medium tracking-[-0.04em]">Page not found</h1>
      <p className="mt-2 text-muted">That address doesn't match anything here.</p>
      <Link to="/" className="mt-4 inline-block">Go to the home page</Link>
    </section>
  );
}
