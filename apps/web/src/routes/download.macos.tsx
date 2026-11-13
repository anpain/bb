import { createFileRoute } from "@tanstack/react-router";
import { handleDownload } from "@/landing/endpoints";

export const Route = createFileRoute("/download/macos")({
  server: {
    handlers: {
      GET: ({ request }) => handleDownload("macos", request),
    },
  },
});
