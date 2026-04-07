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
        title: "Scion API timed out",
        summary: `The backend did not answer in time while loading ${context}.`,
        recommendation: "Retry the request or narrow the scope of the page if the backend is under load.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.kind === "abort") {
      return {
        title: "Scion API request was interrupted",
        summary: `The request for ${context} was cancelled before it completed.`,
        recommendation: "Retry the page. If this repeats, inspect the web and API logs together.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.statusCode === 503) {
      return {
        title: "Scion backend is unavailable",
        summary: `The API responded, but the backing corpus is unavailable or not ready while loading ${context}.`,
        recommendation: "Check API readiness and Postgres state, then retry this page.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.statusCode === 404) {
      return {
        title: "Requested Scion record was not found",
        summary: `The API could not find the requested ${context}.`,
        recommendation: "Verify the URL or return to the corpus and select a valid record.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.statusCode === 413) {
      return {
        title: "Scion rejected an oversized request",
        summary: `The backend refused ${context} because it exceeded the current safety limit.`,
        recommendation: "Narrow the request scope and retry. Large exports should be filtered before downloading.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.statusCode === 429) {
      return {
        title: "Scion is throttling this request",
        summary: `The backend is protecting itself under load while serving ${context}.`,
        recommendation: "Retry after a short delay. If this repeats, reduce concurrent heavy requests or tighten the filters.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    if (error.kind === "network") {
      return {
        title: "Scion API could not be reached",
        summary: `The web app could not reach the backend while loading ${context}.`,
        recommendation: "Confirm the API process is running and that the configured base URL is correct.",
        requestId: error.requestId,
        statusCode: error.statusCode
      };
    }

    return {
      title: "Scion API request failed",
      summary: `The backend returned an error while loading ${context}.`,
      recommendation: "Retry the page and use the request ID below to inspect the API logs if it fails again.",
      requestId: error.requestId,
      statusCode: error.statusCode
    };
  }

  if (error instanceof Error) {
    return {
      title: "Scion page failed to load",
      summary: `An unexpected error occurred while loading ${context}.`,
      recommendation: "Retry the page. If the error persists, inspect the web server logs.",
    };
  }

  return {
    title: "Scion page failed to load",
    summary: `An unknown error occurred while loading ${context}.`,
    recommendation: "Retry the page and inspect the server logs if the failure persists."
  };
}

export function isNotFoundApiError(error: unknown): boolean {
  return error instanceof ScionApiError && error.statusCode === 404;
}
