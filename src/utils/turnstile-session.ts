const COBALT_API_URL = "https://cobalt-api.meowing.de/";
const COBALT_SESSION_URL = "https://cobalt-api.meowing.de/session";
const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      remove: (widgetId: string) => void;
    };
  }
}

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
  const response = await fetch(COBALT_API_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Failed to fetch Cobalt instance info (${response.status})`);
  const data = await response.json();
  const sitekey = data?.cobalt?.turnstileSitekey;
  if (!sitekey) throw new Error("Cobalt instance did not return a turnstileSitekey");
  cachedSitekey = sitekey;
  return sitekey;
};

let turnstileContainer: HTMLDivElement | null = null;
let turnstileWidgetId: string | null = null;

const getTurnstileContainer = (): HTMLDivElement => {
  if (turnstileContainer && document.body.contains(turnstileContainer)) return turnstileContainer;
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

const solveTurnstile = async (container: HTMLElement, sitekey: string): Promise<string> => {
  if (turnstileWidgetId && window.turnstile) {
    try { window.turnstile.remove(turnstileWidgetId); } catch {}
    turnstileWidgetId = null;
  }
  container.innerHTML = "";
  if (!window.turnstile) throw new Error("Turnstile script not loaded");
  return new Promise((resolve, reject) => {
    const widgetId = window.turnstile!.render(container, {
      sitekey,
      callback: (t: string) => resolve(t),
      "error-callback": () => reject(new Error("Turnstile challenge failed")),
      "expired-callback": () => reject(new Error("Turnstile challenge expired")),
    });
    turnstileWidgetId = widgetId;
  });
};

export default async function getTurnstileSessionToken(): Promise<string> {
  await loadTurnstileScript();
  const sitekey = await getSitekey();
  const container = getTurnstileContainer();
  const turnstileResponse = await solveTurnstile(container, sitekey);

  const response = await fetch(COBALT_SESSION_URL, {
    method: "POST",
    headers: { Accept: "application/json", "cf-turnstile-response": turnstileResponse },
  });
  if (!response.ok) throw new Error(`Cobalt session error (${response.status})`);
  const data = await response.json();
  if (!data.token) throw new Error("Cobalt session did not return a token");
  return data.token;
}
