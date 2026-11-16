import { createFileRoute, useNavigate, useRouter, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { prefetchRole } from "@/hooks/use-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({ meta: [{ title: "Sign in — AiDialX Lite" }] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const router = useRouter();
  // Download the dialer page in the background while the agent types.
  useEffect(() => {
    void router.preloadRoute({ to: "/dialer" }).catch(() => {});
  }, [router]);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    let timeoutId: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = window.setTimeout(
        () => reject(new Error("Sign-in timed out. Please check your connection and try again.")),
        20000,
      );
    });

    try {
      if (mode === "signin") {
        const { data, error } = await Promise.race([
          supabase.auth.signInWithPassword({ email, password }),
          timeout,
        ]);
        if (error) setError(formatAuthError(error.message));
        else {
          if (data.user) void prefetchRole(data.user.id);
          void navigate({ to: "/dialer", replace: true });
        }
      } else {
        const { data, error } = await Promise.race([
          supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.origin },
          }),
          timeout,
        ]);
        if (error) setError(formatAuthError(error.message));
        else if (data.session) void navigate({ to: "/dialer", replace: true });
        else setInfo("Account created. Check your email to confirm, or sign in if confirmation is disabled.");
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to sign in. Please try again.";
      setError(formatAuthError(message));
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border p-6">
        <div>
          <h1 className="text-xl font-semibold">{mode === "signin" ? "Sign in" : "Sign up"}</h1>
          <p className="text-sm text-muted-foreground">Agent & admin console.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {info && <p className="text-sm text-muted-foreground">{info}</p>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Sign up"}
        </Button>
      </form>
    </div>
  );
}

function formatAuthError(message: string) {
  return message.toLowerCase().includes("failed to fetch")
    ? "Could not reach the sign-in service. Please try again."
    : message;
}
