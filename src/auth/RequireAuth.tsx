import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext.tsx";

/**
 * Gates a route on a live session. Redirects to /sign-in and remembers
 * the location the operator was headed to (via router state), so a
 * completed sign-in — or a 401 that fires mid-session and clears the
 * session out from under an already-mounted route — both land back where
 * the operator actually was, not always at /ask.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const location = useLocation();

  if (session === null) {
    return <Navigate to="/sign-in" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
