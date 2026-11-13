import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";

import {
  NO_EXPERIMENTS,
  parseForcedFlags,
  type ExperimentBootstrap,
} from "./experiments/flags";
import {
  marketplaceHtmlCacheControl,
  marketplaceResponseStatus,
} from "./marketplace/marketplace-response-status.js";

const handleRequest = createStartHandler(async (context) => {
  const pathname = new URL(context.request.url).pathname;
  const status = marketplaceResponseStatus(
    pathname,
    context.router.state.matches.map((match) => match.loaderData),
  );
  const result = await defaultStreamHandler(context);
  const response = "response" in result ? result.response : result;
  const responseStatus = status ?? response.status;
  const cacheControl = marketplaceHtmlCacheControl(pathname, responseStatus);
  if (status === null && cacheControl === null) return result;
  const headers = new Headers(response.headers);
  if (cacheControl !== null) headers.set("cache-control", cacheControl);
  const updatedResponse = new Response(response.body, {
    status: responseStatus,
    statusText: status === null ? response.statusText : "",
    headers,
  });
  return "response" in result
    ? { ...result, response: updatedResponse }
    : updatedResponse;
});

export default {
  async fetch(request: Request): Promise<Response> {
    const flags =
      request.method === "GET"
        ? parseForcedFlags(new URL(request.url).searchParams)
        : null;
    const experiments =
      flags === null
        ? NO_EXPERIMENTS
        : { distinctID: null, featureFlags: flags, preview: true };
    const response = await handleRequest(request, {
      context: { experiments },
    });
    if (flags === null) return response;
    const headers = new Headers(response.headers);
    headers.set("cache-control", "private, no-cache");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: { experiments: ExperimentBootstrap } };
  }
}
