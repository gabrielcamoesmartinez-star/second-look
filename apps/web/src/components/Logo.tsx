import { Link } from 'react-router-dom';

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="12" r="7" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="15" cy="12" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 5.68A7 7 0 0 1 12 18.32A7 7 0 0 1 12 5.68Z" fill="currentColor" />
    </svg>
  );
}

export function Logo() {
  return (
    <Link to="/" className="inline-flex items-center gap-2 text-white no-underline hover:text-white">
      <LogoMark />
      <span className="text-[15.5px] font-medium tracking-[-0.04em]">
        Second<span className="text-[1.12em] italic text-muted" style={{ fontFamily: '"Instrument Serif", serif' }}>look</span>
      </span>
    </Link>
  );
}
