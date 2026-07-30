"use client";

import { useCallback, useState } from "react";

const COBALT_API_URL = "https://cobalt-api.meowing.de/";

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

const requestCobalt = async (sourceUrl: string) =>
  fetch(COBALT_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
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
        const apiResponse = await requestCobalt(sourceUrl);

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
