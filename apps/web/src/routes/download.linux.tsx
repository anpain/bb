import { createFileRoute } from "@tanstack/react-router";
import { handleDownload } from "@/landing/endpoints";

export const Route = createFileRoute("/download/linux")({
  server: {
    handlers: {
      GET: ({ request }) => handleDownload("linux", request),
    },
  },
});
