export function BrandLogo({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className={`flex items-center justify-center rounded-xl bg-white/15 p-1.5 ring-1 ring-white/25 backdrop-blur ${className}`}>
        <svg viewBox="0 0 40 40" className="h-full w-full" fill="none" aria-hidden="true">
          <path d="M8 29 L17 20 L32 20" stroke="#a5b4fc" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 11 L17 20 L30 11" stroke="#ffffff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="8" cy="11" r="3" fill="#ffffff" />
          <circle cx="8" cy="29" r="3" fill="#a5b4fc" />
          <circle cx="17" cy="20" r="3.8" fill="#ffffff" />
          <circle cx="32" cy="20" r="3" fill="#ffffff" />
          <circle cx="30" cy="11" r="3" fill="#ffffff" />
        </svg>
      </div>
      <div className="leading-none">
        <span className="font-display text-lg font-bold tracking-tight text-white">
          Junction <span className="text-brand-200">IQ</span>
        </span>
      </div>
    </div>
  );
}
