import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type Role = "admin" | "agent" | null;
type Session = { userId: string; email: string | null } | null | undefined;

// In-memory cache so the role lookup can start the moment sign-in succeeds
// (in parallel with page navigation) and is never fetched twice. UI-only:
// every server action still checks permissions on the server.
const roleCache = new Map<string, Promise<Role>>();

export function prefetchRole(userId: string): Promise<Role> {
  let p = roleCache.get(userId);
  if (!p) {
    p = (async () => {
      const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
      const roles = (data ?? []).map((r) => r.role as string);
      return roles.includes("admin") ? "admin" : roles.includes("agent") ? "agent" : null;
    })();
    p.catch(() => roleCache.delete(userId));
    roleCache.set(userId, p);
  }
  return p;
}

export function clearRoleCache() {
  roleCache.clear();
}

export function useSession() {
  const [session, setSession] = useState<Session>(undefined); // undefined = loading

  useEffect(() => {
    const apply = (s: { user: { id: string; email?: string | null } } | null) =>
      setSession((prev) => {
        if (!s) return null;
        // Keep the same object on token refreshes to avoid re-running effects.
        if (prev && prev.userId === s.user.id) return prev;
        return { userId: s.user.id, email: s.user.email ?? null };
      });
    supabase.auth.getSession().then(({ data }) => apply(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => apply(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return session;
}

export function useRole(existingSession?: Session): { role: Role; loading: boolean } {
  const ownSession = useSession();
  const session = existingSession !== undefined ? existingSession : ownSession;
  const userId = session?.userId;
  const [state, setState] = useState<{ userId?: string; role: Role }>({ role: null });

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    prefetchRole(userId).then((role) => {
      if (!cancelled) setState({ userId, role });
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (session === undefined) return { role: null, loading: true };
  if (session === null) return { role: null, loading: false };
  return { role: state.userId === userId ? state.role : null, loading: state.userId !== userId };
}
