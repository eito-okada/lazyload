import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  connectGoogleCalendar: () => Promise<void>;
  connectGmail: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// Calendar and Gmail are connected via separate OAuth consents that return
// separate, differently-scoped refresh tokens. We tag which one is in flight so
// onAuthStateChange routes the returned token to the right endpoint instead of
// blindly storing it as the calendar token.
type ConnectIntent = 'calendar' | 'gmail';
const INTENT_KEY = 'lazyload_google_connect_intent';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);

      // A Google refresh token is only present on the session right after the
      // user grants offline access (access_type=offline + prompt=consent). Route
      // it to the calendar or gmail endpoint based on which connect we started.
      // The browser never persists it. Plain sign-in (no intent) is ignored.
      if (session?.provider_refresh_token && session.access_token) {
        const intent = sessionStorage.getItem(INTENT_KEY) as ConnectIntent | null;
        if (intent) {
          sessionStorage.removeItem(INTENT_KEY);
          void storeRefreshToken(intent, session.access_token, session.provider_refresh_token);
        }
      }
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  async function signInWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  }

  // Re-consent with the calendar scope, requesting offline access so Google
  // returns a refresh token. Returns to /settings, where onAuthStateChange picks
  // the token up and posts it to /api/google/connect.
  async function connectGoogleCalendar() {
    sessionStorage.setItem(INTENT_KEY, 'calendar');
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: 'https://www.googleapis.com/auth/calendar.events',
        redirectTo: `${window.location.origin}/settings`,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
  }

  // Re-consent with the gmail.readonly scope (offline), so the server can read
  // the inbox in the background. onAuthStateChange posts the token to
  // /api/gmail/connect — stored separately from the calendar token.
  async function connectGmail() {
    sessionStorage.setItem(INTENT_KEY, 'gmail');
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: 'https://www.googleapis.com/auth/gmail.readonly',
        redirectTo: `${window.location.origin}/settings`,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, signInWithGoogle, connectGoogleCalendar, connectGmail, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

async function storeRefreshToken(
  intent: ConnectIntent,
  accessToken: string,
  refreshToken: string,
) {
  const endpoint = intent === 'gmail' ? '/api/gmail/connect' : '/api/google/connect';
  // The calendar endpoint also records the browser's timezone; gmail ignores it.
  const body =
    intent === 'gmail'
      ? { refreshToken }
      : { refreshToken, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`Failed to store ${intent} refresh token:`, err);
  }
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
