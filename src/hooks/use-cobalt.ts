"use client";

import { useCallback, useState } from "react";

const COBALT_API_URL = "https://cobalt-api.meowing.de/";
const COBALT_SESSION_URL = "https://cobalt-api.meowing.de/session";
const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: Record<string, unknown>,
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

interface CobaltLocalProcessing {
  status: "local-processing";
  type: "merge" | "mute" | "audio" | "gif" | "remux";
  service: string;
  tunnel: string[];
  output: {
    type: string;
    filename: string;
  };
}

interface CobaltTunnelResponse {
  status: "tunnel" | "redirect";
  url: string;
  filename: string;
}

interface CobaltErrorResponse {
  status: "error";
  error?: { code?: string };
}

interface CobaltPickerResponse {
  status: "picker";
}

type CobaltResponse =
  | CobaltTunnelResponse
  | CobaltLocalProcessing
  | CobaltErrorResponse
  | CobaltPickerResponse;

const sanitizeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, "");

const buildPayload = (sourceUrl: string) => ({
  url: sourceUrl,
  downloadMode: "audio",
  audioFormat: "mp3",
  audioBitrate: "320",
  localProcessing: "preferred",
  youtubeBetterAudio: true,
});

let turnstileScriptPromise: Promise<void> | null = null;

const loadTurnstileScript = (): Promise<void> => {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Turnstile script"));
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
};

let cachedSitekey: string | null = null;

const getSitekey = async (): Promise<string> => {
  if (cachedSitekey) return cachedSitekey;

  const response = await fetch(COBALT_API_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Cobalt instance info (${response.status})`);
  }
  const data = await response.json();
  const sitekey = data?.cobalt?.turnstileSitekey;
  if (!sitekey) {
    throw new Error("Cobalt instance did not return a turnstileSitekey");
  }
  cachedSitekey = sitekey;
  return sitekey;
};

let turnstileContainer: HTMLDivElement | null = null;
let turnstileWidgetId: string | null = null;

const getTurnstileContainer = (): HTMLDivElement => {
  if (turnstileContainer && document.body.contains(turnstileContainer)) {
    return turnstileContainer;
  }
  const container = document.createElement("div");
  container.id = "cobalt-turnstile-container";
  container.style.position = "fixed";
  container.style.bottom = "16px";
  container.style.right = "16px";
  container.style.zIndex = "2147483647";
  document.body.appendChild(container);
  turnstileContainer = container;
  return container;
};

const solveTurnstile = async (
  container: HTMLElement,
  sitekey: string,
  maxAttempts = 3,
): Promise<string> => {
  let lastError: Error = new Error("Turnstile challenge failed");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (turnstileWidgetId && window.turnstile) {
      try {
        window.turnstile.remove(turnstileWidgetId);
      } catch {}
      turnstileWidgetId = null;
    }
    container.innerHTML = "";

    if (!window.turnstile) {
      throw new Error("Turnstile script not loaded");
    }

    try {
      const token = await new Promise<string>((resolve, reject) => {
        const widgetId = window.turnstile!.render(container, {
          sitekey,
          callback: (t: string) => resolve(t),
          "error-callback": () =>
            reject(new Error("Turnstile challenge failed")),
          "expired-callback": () =>
            reject(new Error("Turnstile challenge expired")),
        });
        turnstileWidgetId = widgetId;
      });
      return token;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  throw lastError;
};

const TOKEN_EXPIRY_BUFFER_S = 30;

let cachedToken: { token: string; exp: number } | null = null;

const getSessionToken = async (): Promise<string> => {
  if (cachedToken && cachedToken.exp > Date.now() / 1000 + TOKEN_EXPIRY_BUFFER_S) {
    return cachedToken.token;
  }

  await loadTurnstileScript();
  const sitekey = await getSitekey();
  const container = getTurnstileContainer();
  const turnstileResponse = await solveTurnstile(container, sitekey);

  const response = await fetch(COBALT_SESSION_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "cf-turnstile-response": turnstileResponse,
    },
  });
  if (!response.ok) {
    throw new Error(`Cobalt session error (${response.status})`);
  }
  const data = await response.json();
  if (!data.token) {
    throw new Error("Cobalt session did not return a token");
  }
  cachedToken = { token: data.token, exp: Date.now() / 1000 + (data.exp ?? 90) };
  return cachedToken.token;
};

const requestCobalt = async (sourceUrl: string, token: string) =>
  fetch(COBALT_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(buildPayload(sourceUrl)),
  });

export const useCobaltImport = () => {
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importFromUrl = useCallback(
    async (
      sourceUrl: string,
    ): Promise<{ blob: Blob; filename: string } | null> => {
      setIsImporting(true);
      setError(null);
      try {
        const token = await getSessionToken();
        let apiResponse = await requestCobalt(sourceUrl, token);

        if (apiResponse.status === 401 || apiResponse.status === 403) {
          cachedToken = null;
          const freshToken = await getSessionToken();
          apiResponse = await requestCobalt(sourceUrl, freshToken);
        }

        if (!apiResponse.ok) {
          throw new Error(`Cobalt API error (${apiResponse.status})`);
        }

        const data: CobaltResponse = await apiResponse.json();

        if (data.status === "error") {
          throw new Error(data.error?.code || "Cobalt could not process this link");
        }

        if (data.status === "tunnel" || data.status === "redirect") {
          const fileResponse = await fetch(data.url);
          if (!fileResponse.ok) {
            throw new Error("Failed to download the resolved audio stream");
          }
          const blob = await fileResponse.blob();
          const filename = sanitizeFilename(data.filename || "youtube-audio.mp3");
          return { blob, filename };
        }

        if (data.status === "local-processing") {
          if (data.type !== "audio" || data.tunnel.length === 0) {
            throw new Error(
              "This link needs client-side merging/remuxing, which isn't supported yet.",
            );
          }
          const fileResponse = await fetch(data.tunnel[0]);
          if (!fileResponse.ok) {
            throw new Error("Failed to download the resolved audio stream");
          }
          const blob = await fileResponse.blob();
          const filename = sanitizeFilename(data.output.filename || "youtube-audio.mp3");
          return { blob, filename };
        }

        throw new Error(
          "This link returned multiple items. Paste a direct video URL instead.",
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to import from link";
        setError(message);
        return null;
      } finally {
        setIsImporting(false);
      }
    },
    [],
  );

  return { importFromUrl, isImporting, error, setError };
};
