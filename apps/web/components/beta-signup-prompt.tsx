"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

const DISMISSED_STORAGE_KEY = "scionBetaPromptDismissedAt";
const SUBMITTED_STORAGE_KEY = "scionBetaPromptSubmittedAt";
const CONSENT_TEXT_VERSION = "beta-interest-v1";
const DEFAULT_PROMPT_DELAY_MS = 90_000;

type SubmitState = "idle" | "submitting" | "success" | "error";

function getPromptDelayMs(): number {
  const rawValue = process.env.NEXT_PUBLIC_SCION_BETA_PROMPT_DELAY_MS;
  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : DEFAULT_PROMPT_DELAY_MS;
}

function hasStoredDecision(): boolean {
  try {
    return Boolean(
      window.localStorage.getItem(DISMISSED_STORAGE_KEY) ||
        window.localStorage.getItem(SUBMITTED_STORAGE_KEY)
    );
  } catch {
    return true;
  }
}

function rememberDecision(key: string): void {
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    // Local persistence is a courtesy; failed storage should not block form use.
  }
}

function readFormField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `scion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function BetaSignupPrompt() {
  const [visible, setVisible] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const closePrompt = useCallback(() => {
    rememberDecision(DISMISSED_STORAGE_KEY);
    setVisible(false);
  }, []);

  useEffect(() => {
    if (hasStoredDecision()) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setVisible(true);
    }, getPromptDelayMs());

    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }

    firstFieldRef.current?.focus();
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePrompt();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closePrompt, visible]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);
    const email = readFormField(formData, "email");

    if (!email) {
      setSubmitState("error");
      setError("Email is required.");
      return;
    }

    setSubmitState("submitting");

    try {
      const response = await fetch("/api/beta-signups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": createRequestId()
        },
        body: JSON.stringify({
          first_name: readFormField(formData, "first_name"),
          last_name: readFormField(formData, "last_name"),
          affiliation: readFormField(formData, "affiliation"),
          email,
          website: readFormField(formData, "website"),
          source_path: `${window.location.pathname}${window.location.search}`,
          consent_text_version: CONSENT_TEXT_VERSION
        })
      });

      if (!response.ok) {
        throw new Error(`signup_failed_${response.status}`);
      }

      rememberDecision(SUBMITTED_STORAGE_KEY);
      setSubmitState("success");
      window.setTimeout(() => setVisible(false), 1200);
    } catch {
      setSubmitState("error");
      setError("We could not save this right now. Please try again.");
    }
  };

  if (!visible) {
    return null;
  }

  const submitting = submitState === "submitting";
  const succeeded = submitState === "success";

  return (
    <div className="beta-signup-overlay" role="presentation">
      <section
        className="beta-signup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="beta-signup-title"
      >
        <button
          type="button"
          className="beta-signup-close"
          aria-label="Close signup form"
          onClick={closePrompt}
        >
          X
        </button>

        <div
          className="beta-signup-image-panel"
          role="img"
          aria-label="Ice patterns on Lake Michigan"
        />

        <div className="beta-signup-content">
          <h2 id="beta-signup-title">Stay in the loop!</h2>
          <p>
            Cell Anatomy is still early. If you would like occasional updates or a chance to beta
            test new features, leave your details below.
          </p>
          <p className="muted beta-signup-promise">
            We will only use this for Cell Anatomy updates and beta invitations. We will not sell
            your information, and you can ask us to remove it anytime.
          </p>

          <form className="beta-signup-form" onSubmit={handleSubmit}>
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              hidden
              className="beta-signup-honeypot"
            />

            <label>
              <span>First name</span>
              <input ref={firstFieldRef} name="first_name" type="text" autoComplete="given-name" />
            </label>

            <label>
              <span>Last name</span>
              <input name="last_name" type="text" autoComplete="family-name" />
            </label>

            <label>
              <span>Affiliation</span>
              <input name="affiliation" type="text" autoComplete="organization" />
            </label>

            <label>
              <span>Email *</span>
              <input
                name="email"
                type="text"
                inputMode="email"
                autoComplete="email"
                pattern="[^ @]+@[^ @]+[.][^ @]+"
                required
              />
            </label>

            {error ? <p className="beta-signup-status beta-signup-error">{error}</p> : null}
            {succeeded ? <p className="beta-signup-status">Saved. Thank you.</p> : null}

            <button type="submit" className="button beta-signup-submit" disabled={submitting || succeeded}>
              {submitting ? "Saving..." : "Keep me posted"}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
