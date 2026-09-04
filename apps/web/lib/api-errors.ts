import { ScionApiError } from "./api";

export type ApiFailureState = {
  title: string;
  summary: string;
  recommendation: string;
  requestId?: string;
  statusCode?: number;
};

export function describeApiError(error: unknown, context: string): ApiFailureState {
  if (error instanceof ScionApiError) {
    if (error.kind === "timeout") {
      return {
        title: "The request timed out",
        summary: `The site did not finish loading ${context} in time.`,
        recommendation: "Retry the request or narrow the scope of the page.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.kind === "abort") {
      return {
        title: "The request was interrupted",
        summary: `The request for ${context} was cancelled before it completed.`,
        recommendation: "Retry the page. If this repeats, inspect the Worker logs.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.statusCode === 503) {
      return {
        title: "The site is temporarily unavailable",
        summary: `The edge service could not load ${context}.`,
        recommendation: "Retry the page and inspect the Worker logs if it fails again.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.statusCode === 404) {
      return {
        title: "The requested record was not found",
        summary: `The corpus could not find the requested ${context}.`,
        recommendation: "Verify the URL or return to the corpus and select a valid record.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.statusCode === 413) {
      return {
        title: "The request is too large",
        summary: `The site refused ${context} because it exceeded the current safety limit.`,
        recommendation: "Narrow the request scope and retry. Large exports should be filtered before downloading.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.statusCode === 429) {
      return {
        title: "The service is throttling this request",
        summary: `The site is protecting itself under load while serving ${context}.`,
        recommendation: "Retry after a short delay. If this repeats, reduce concurrent heavy requests or tighten the filters.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.kind === "network") {
      return {
        title: "The service could not be reached",
        summary: `The site could not load ${context}.`,
        recommendation: "Retry the page and confirm the Worker is available.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    return {
      title: "The request failed",
      summary: `The site returned an error while loading ${context}.`,
      recommendation: "Retry the page and use the request ID below to inspect the Worker logs if it fails again.",
      requestId: error.requestId,
      statusCode: error.statusCode
    };
  }

  if (error instanceof Error) {
    return {
      title: "This page failed to load",
      summary: `An unexpected error occurred while loading ${context}.`,
      recommendation: "Retry the page. If the error persists, inspect the web server logs.",
    };
  }

  return {
    title: "This page failed to load",
    summary: `An unknown error occurred while loading ${context}.`,
    recommendation: "Retry the page and inspect the server logs if the failure persists."
  };
}

export function isNotFoundApiError(error: unknown): boolean {
  return error instanceof ScionApiError && error.statusCode === 404;
}
