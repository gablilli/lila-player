"use client";

import { useCallback, useState } from "react";

const COBALT_API_URL = "https://cobalt-api.meowing.de/";
const COBALT_SESSION_URL = "https://cobalt-api.meowing.de/session";

interface CobaltResponse {
  status: "tunnel" | "redirect" | "picker" | "error" | "local-processing";
  url?: string;
  filename?: string;
  error?: { code?: string };
}

interface CobaltSessionResponse {
  token?: string;
}

const sanitizeFilename = (name: string) => name.replace(/[\\/:*?"<>|]/g, "");

let cachedToken: string | null = null;

const getSessionToken = async (): Promise<string> => {
  if (cachedToken) return cachedToken;

  const response = await fetch(COBALT_SESSION_URL, {
    method: "POST",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Cobalt session error (${response.status})`);
  }

  const data: CobaltSessionResponse = await response.json();
  if (!data.token) {
    throw new Error("Cobalt session did not return a token");
  }

  cachedToken = data.token;
  return cachedToken;
};

const buildPayload = (sourceUrl: string) => ({
  url: sourceUrl,
  downloadMode: "audio",
  audioFormat: "mp3",
  audioBitrate: "320",
  localProcessing: "preferred",
  youtubeBetterAudio: true,
});

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

        if (apiResponse.status === 401 || apiResponse.status === 400) {
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

        if (
          (data.status === "tunnel" || data.status === "redirect") &&
          data.url
        ) {
          const fileResponse = await fetch(data.url);
          if (!fileResponse.ok) {
            throw new Error("Failed to download the resolved audio stream");
          }
          const blob = await fileResponse.blob();
          const filename = sanitizeFilename(
            data.filename || "youtube-audio.mp3",
          );
          return { blob, filename };
        }

        if (data.status === "local-processing") {
          throw new Error(
            "This link requires local processing, which isn't supported yet.",
          );
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
