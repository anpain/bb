import { createFileRoute } from "@tanstack/react-router";
import { handleDownload } from "@/landing/endpoints";

export const Route = createFileRoute("/download/windows")({
  server: {
    handlers: {
      GET: ({ request }) => handleDownload("windows", request),
    },
  },
});
