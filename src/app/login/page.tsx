"use client";

import { useState } from "react";
import { Lock, Loader2 } from "lucide-react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Login failed");
      }
      window.location.href = "/";
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: "#0b0d14" }}>
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border p-8"
        style={{ backgroundColor: "#12141d", borderColor: "#1f2333" }}
      >
        <div className="flex items-center gap-2 mb-1">
          <Lock className="w-4 h-4" style={{ color: "#818cf8" }} />
          <h1 className="text-lg font-semibold text-white">Account Intelligence Center</h1>
        </div>
        <p className="text-xs mb-6" style={{ color: "#64748b" }}>
          Enter the app password to continue
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="w-full rounded-lg px-3 py-2 text-sm text-white outline-none border mb-3"
          style={{ backgroundColor: "#0b0d14", borderColor: "#1f2333" }}
        />
        {error && (
          <p className="text-xs mb-3" style={{ color: "#ef4444" }}>{error}</p>
        )}
        <button
          type="submit"
          disabled={loading || !password}
          className="w-full rounded-lg py-2 text-sm font-medium text-white disabled:opacity-50 flex items-center justify-center gap-2"
          style={{ backgroundColor: "#6366f1" }}
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
