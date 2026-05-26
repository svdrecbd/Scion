"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type AuthUser = {
  user_id: string;
  primary_email: string;
  display_name?: string | null;
  created_at: string;
};

type AuthSession = {
  session_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent?: string | null;
  ip_address?: string | null;
  current: boolean;
  remember: boolean;
};

type AuthDevice = {
  device_id: string;
  device_name: string;
  platform?: string | null;
  created_at: string;
  expires_at: string;
  last_seen_at?: string | null;
  current: boolean;
};

type AuthMeResponse = {
  authenticated: boolean;
  user?: AuthUser | null;
  session?: AuthSession | null;
};

type AuthSessionsResponse = {
  sessions: AuthSession[];
};

type AuthDevicesResponse = {
  devices: AuthDevice[];
};

type Stage = "email" | "code";

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    // Keep the fallback message below.
  }

  if (!response.ok) {
    throw new Error(payload?.detail || `${response.status} ${response.statusText}`);
  }

  return payload as T;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function AccountClient() {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [currentSession, setCurrentSession] = useState<AuthSession | null>(null);
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [devices, setDevices] = useState<AuthDevice[]>([]);
  const [pairCode, setPairCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const signedIn = Boolean(user);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at)),
    [sessions]
  );

  const refreshAccount = async () => {
    const me = await readJson<AuthMeResponse>("/api/auth/me");
    if (!me.authenticated || !me.user) {
      setUser(null);
      setCurrentSession(null);
      setSessions([]);
      setDevices([]);
      return;
    }

    setUser(me.user);
    setCurrentSession(me.session || null);
    const sessionPayload = await readJson<AuthSessionsResponse>("/api/auth/sessions");
    setSessions(sessionPayload.sessions);
    const devicePayload = await readJson<AuthDevicesResponse>("/api/auth/devices");
    setDevices(devicePayload.devices);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    refreshAccount()
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setCurrentSession(null);
          setSessions([]);
          setDevices([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedPairCode = params.get("pair");
    if (requestedPairCode) {
      setPairCode(requestedPairCode);
      setStatus("Sign in, then approve the Workbench pairing code.");
    }
  }, []);

  const requestCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatus(null);
    try {
      await readJson("/api/auth/login/start", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setStage("code");
      setStatus("Check your email for a login code.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a login code.");
    } finally {
      setSubmitting(false);
    }
  };

  const verifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatus(null);
    try {
      await readJson("/api/auth/login/verify", {
        method: "POST",
        body: JSON.stringify({ email, code, remember }),
      });
      setCode("");
      setStage("email");
      await refreshAccount();
      setStatus("Signed in.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify that login code.");
    } finally {
      setSubmitting(false);
    }
  };

  const logout = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await readJson("/api/auth/logout", { method: "POST", body: "{}" });
      setUser(null);
      setCurrentSession(null);
      setSessions([]);
      setDevices([]);
      setStatus("Signed out.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out.");
    } finally {
      setSubmitting(false);
    }
  };

  const approvePairing = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    setPairing(true);
    setError(null);
    setStatus(null);
    try {
      const payload = await readJson<{ status: string; device_name: string; platform?: string | null }>(
        "/api/auth/devices/pairing/approve",
        {
          method: "POST",
          body: JSON.stringify({ user_code: pairCode }),
        }
      );
      await refreshAccount();
      setStatus(`Approved ${payload.device_name}. Return to Workbench to finish connecting.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve that pairing code.");
    } finally {
      setPairing(false);
    }
  };

  const revokeDevice = async (deviceId: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await readJson(`/api/auth/devices/${deviceId}`, { method: "DELETE" });
      await refreshAccount();
      setStatus("Device revoked.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke that device.");
    } finally {
      setSubmitting(false);
    }
  };

  const revokeSession = async (sessionId: string) => {
    setSubmitting(true);
    setError(null);
    try {
      await readJson(`/api/auth/sessions/${sessionId}`, { method: "DELETE" });
      await refreshAccount();
      setStatus("Session revoked.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke that session.");
    } finally {
      setSubmitting(false);
    }
  };

  const exportAccount = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload = await readJson<Record<string, unknown>>("/api/auth/account/export");
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "cell-anatomy-account-export.json";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setStatus("Account export prepared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export account data.");
    } finally {
      setSubmitting(false);
    }
  };

  const deleteAccount = async () => {
    if (!window.confirm("Delete this Cell Anatomy account and sign out? This removes account sessions and saved account state.")) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await readJson("/api/auth/account", { method: "DELETE" });
      setUser(null);
      setCurrentSession(null);
      setSessions([]);
      setDevices([]);
      setStatus("Account deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete account.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main>
        <section className="panel">
          <div className="kicker">Account</div>
          <p className="muted">Checking account session...</p>
        </section>
      </main>
    );
  }

  return (
    <main>
      <section className="hero" style={{ marginBottom: 24 }}>
        <div className="kicker">Account</div>
        <h1>{signedIn ? "Manage Your Cell Anatomy Account" : "Sign In to Cell Anatomy"}</h1>
        <p>
          Accounts use email codes instead of passwords. Atlas can keep you signed in, and Workbench
          sync can be paired later without requiring third-party OAuth.
        </p>
      </section>

      {status ? (
        <section className="panel" style={{ marginBottom: 16, borderColor: "var(--atlas-blue)" }}>
          <p style={{ margin: 0 }}>{status}</p>
        </section>
      ) : null}

      {error ? (
        <section className="panel" style={{ marginBottom: 16, borderColor: "var(--atlas-orange)" }}>
          <p style={{ margin: 0 }}>{error}</p>
        </section>
      ) : null}

      {!signedIn ? (
        <section className="panel" style={{ maxWidth: 560 }}>
          {pairCode ? (
            <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
              Workbench pairing code <strong>{pairCode}</strong> is waiting. Sign in first, then
              approve the device.
            </p>
          ) : null}
          {stage === "email" ? (
            <form onSubmit={requestCode} style={{ display: "grid", gap: 14 }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="kicker" style={{ margin: 0 }}>Email</span>
                <input
                  className="search-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <button className="button" type="submit" disabled={submitting}>
                {submitting ? "Sending..." : "Send Login Code"}
              </button>
            </form>
          ) : (
            <form onSubmit={verifyCode} style={{ display: "grid", gap: 14 }}>
              <div>
                <span className="kicker" style={{ margin: 0 }}>Email</span>
                <p className="muted" style={{ margin: "4px 0 0" }}>{email}</p>
              </div>
              <label style={{ display: "grid", gap: 6 }}>
                <span className="kicker" style={{ margin: 0 }}>Login Code</span>
                <input
                  className="search-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Keep me signed in on this browser
              </label>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="button" type="submit" disabled={submitting}>
                  {submitting ? "Signing in..." : "Sign In"}
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={submitting}
                  onClick={() => {
                    setStage("email");
                    setCode("");
                  }}
                >
                  Use Another Email
                </button>
              </div>
            </form>
          )}
        </section>
      ) : (
        <div className="panel-grid two">
          <section className="panel">
            <h2 className="section-title">Profile</h2>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <span className="kicker" style={{ margin: 0 }}>Signed In As</span>
                <p style={{ margin: "4px 0 0", fontSize: "1.25rem" }}>{user?.primary_email}</p>
              </div>
              <div>
                <span className="kicker" style={{ margin: 0 }}>Account Created</span>
                <p className="muted" style={{ margin: "4px 0 0" }}>
                  {user ? formatDate(user.created_at) : ""}
                </p>
              </div>
              <button className="button" type="button" disabled={submitting} onClick={logout}>
                Sign Out
              </button>
            </div>
          </section>

          <section className="panel">
            <h2 className="section-title">Current Session</h2>
            {currentSession ? (
              <div style={{ display: "grid", gap: 10 }}>
                <p className="muted" style={{ margin: 0 }}>
                  Last seen {formatDate(currentSession.last_seen_at)}
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  Expires {formatDate(currentSession.expires_at)}
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  {currentSession.remember ? "Remembered browser" : "Standard browser session"}
                </p>
              </div>
            ) : null}
          </section>

          <section className="panel" style={{ gridColumn: "1 / -1" }}>
            <h2 className="section-title">Pair Workbench</h2>
            <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
              Enter the pairing code shown in Workbench to connect this account. Pairing creates a
              revocable first-party device token; it does not upload local volume data.
            </p>
            <form onSubmit={approvePairing} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                className="search-input"
                value={pairCode}
                onChange={(event) => setPairCode(event.target.value.toUpperCase())}
                placeholder="PAIR-CODE"
                style={{ maxWidth: 240 }}
              />
              <button className="button" type="submit" disabled={pairing || !pairCode.trim()}>
                {pairing ? "Approving..." : "Approve Workbench"}
              </button>
            </form>
          </section>

          <section className="panel" style={{ gridColumn: "1 / -1" }}>
            <h2 className="section-title">Paired Devices</h2>
            {devices.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No Workbench devices are connected.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {devices.map((device) => (
                  <article key={device.device_id} className="panel" style={{ background: "var(--background)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <strong>{device.device_name}</strong>
                      <span className="muted">{device.platform || "Workbench"}</span>
                    </div>
                    <p className="muted" style={{ margin: "8px 0" }}>
                      {device.last_seen_at
                        ? `Last seen ${formatDate(device.last_seen_at)}.`
                        : `Paired ${formatDate(device.created_at)}.`}{" "}
                      Expires {formatDate(device.expires_at)}.
                    </p>
                    <button
                      className="button"
                      type="button"
                      disabled={submitting}
                      onClick={() => revokeDevice(device.device_id)}
                    >
                      Revoke Device
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel" style={{ gridColumn: "1 / -1" }}>
            <h2 className="section-title">Active Browser Sessions</h2>
            <div style={{ display: "grid", gap: 10 }}>
              {sortedSessions.map((session) => (
                <article
                  key={session.session_id}
                  className="panel"
                  style={{ background: "var(--background)", display: "grid", gap: 8 }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <strong>{session.current ? "Current browser" : "Browser session"}</strong>
                    <span className="muted">{session.remember ? "Remembered" : "Standard"}</span>
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    Last seen {formatDate(session.last_seen_at)}. Expires {formatDate(session.expires_at)}.
                  </p>
                  {session.user_agent ? (
                    <p className="muted" style={{ margin: 0, overflowWrap: "anywhere" }}>
                      {session.user_agent}
                    </p>
                  ) : null}
                  <div>
                    <button
                      className="button"
                      type="button"
                      disabled={submitting}
                      onClick={() => revokeSession(session.session_id)}
                    >
                      {session.current ? "Sign Out This Session" : "Revoke Session"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel" style={{ gridColumn: "1 / -1" }}>
            <h2 className="section-title">Account Data</h2>
            <p className="muted" style={{ marginTop: 0, lineHeight: 1.6 }}>
              Export the account record and saved account state as JSON, or delete the account and
              clear active sessions. Raw Workbench volume data is not stored here.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="button" type="button" disabled={submitting} onClick={exportAccount}>
                Export Account JSON
              </button>
              <button className="button" type="button" disabled={submitting} onClick={deleteAccount}>
                Delete Account
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
