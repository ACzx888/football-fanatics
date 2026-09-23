import Link from "next/link";

export function SiteNav({ active }: { active: "home" | "history" }) {
  const link = (id: "home" | "history", href: string, label: string) => {
    const on = active === id;
    return (
      <Link
        href={href}
        className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
          on
            ? "bg-accent/20 text-accent ring-1 ring-accent/40"
            : "text-slate-300 hover:bg-white/5 hover:text-white"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <nav className="flex items-center gap-1 rounded-full border border-white/10 bg-black/20 p-1 backdrop-blur">
      {link("home", "/", "Home")}
      {link("history", "/history", "History")}
    </nav>
  );
}
