"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Search,
  RefreshCw,
  Target,
  Zap,
} from "lucide-react";

const nav = [
  { href: "/", icon: LayoutDashboard, label: "Daily Priorities" },
  { href: "/account", icon: Search, label: "Account Deep-Dive" },
  { href: "/msi-tracker", icon: RefreshCw, label: "MSI Renewals" },
  { href: "/targets", icon: Target, label: "AIC Targets" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="w-56 flex-shrink-0 flex flex-col border-r"
      style={{ backgroundColor: "#1a1d27", borderColor: "#252836" }}
    >
      {/* Logo */}
      <div className="px-4 py-5 border-b" style={{ borderColor: "#252836" }}>
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: "#6366f1" }}
          >
            <Zap size={14} className="text-white" />
          </div>
          <div>
            <div className="text-xs font-bold text-white leading-tight">Account</div>
            <div className="text-xs font-bold leading-tight" style={{ color: "#6366f1" }}>Intelligence</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-4 space-y-1">
        {nav.map(({ href, icon: Icon, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
              style={{
                backgroundColor: active ? "#6366f120" : "transparent",
                color: active ? "#6366f1" : "#94a3b8",
              }}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t" style={{ borderColor: "#252836" }}>
        <p className="text-xs" style={{ color: "#475569" }}>
          Powered by Claude AI
        </p>
      </div>
    </aside>
  );
}
