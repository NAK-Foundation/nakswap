/**
 * The app is sandbox-only: there is no sign-in, no wallet, and no roles.
 * This module is intentionally inert and retained only so stale imports do not
 * break the build. New code must not depend on it.
 */
export function useAuth() {
  return {
    principal: null,
    isAuthenticated: false,
    isInitializing: false,
    isLoggingIn: false,
    isLoginError: false,
    loginError: undefined,
    isAdmin: false,
    isOperator: false,
    role: null,
    isLoadingRole: false,
    signIn: () => undefined,
    signOut: () => undefined,
  };
}
