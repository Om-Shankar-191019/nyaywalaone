import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo } from "react";
import { api } from "../api/client.js";

const AuthContext = createContext(null);

export const dashboardPath = (role) =>
  role === "INSTRUCTOR" ? "/instructor" : "/student";

/**
 * Session state comes from the server (/auth/me), never from localStorage.
 * The tokens are httpOnly cookies, so JavaScript cannot read them - which is
 * the point. A 401 triggers exactly one silent refresh inside api/client.js.
 */
export function AuthProvider({ children }) {
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me"),
    retry: false,
    staleTime: 60_000,
  });

  const loginMutation = useMutation({
    mutationFn: (credentials) => api.post("/auth/login", credentials),
  });
  const logoutMutation = useMutation({
    mutationFn: () => api.post("/auth/logout"),
  });

  /** Seed the session cache from any auth response (login or register). */
  const applySession = useCallback(
    async (data) => {
      queryClient.setQueryData(["me"], {
        user: data.user,
        enrollments: data.enrollments ?? [],
        taughtCount: 0,
      });
      await queryClient.invalidateQueries({ queryKey: ["courses"] });
      return data.user;
    },
    [queryClient],
  );

  const login = useCallback(
    async (credentials) => {
      const data = await loginMutation.mutateAsync(credentials);
      return applySession(data);
    },
    [loginMutation, applySession],
  );

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } finally {
      queryClient.clear();
    }
  }, [logoutMutation, queryClient]);

  const user = meQuery.data?.user ?? null;
  const status = meQuery.isLoading
    ? "loading"
    : user
      ? "authenticated"
      : "anonymous";

  const value = useMemo(
    () => ({
      user,
      enrollments: meQuery.data?.enrollments ?? [],
      status,
      isLoading: meQuery.isLoading,
      login,
      applySession,
      logout,
      isLoggingOut: logoutMutation.isPending,
      refetch: meQuery.refetch,
    }),
    [
      user,
      meQuery.data?.enrollments,
      status,
      meQuery.isLoading,
      login,
      applySession,
      logout,
      logoutMutation.isPending,
      meQuery.refetch,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
