const VOLUME_ENGINE_BASE_URL = "http://127.0.0.1:8080";
const VOLUME_ENGINE_TOKEN_HEADER = "X-CAOS-Volume-Token";

let tokenPromise: Promise<string | null> | null = null;

const readNativeToken = async (): Promise<string | null> => {
  if (typeof window === "undefined" || !(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    return null;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const token = await invoke<string>("get_volume_engine_auth_token");
  return token.trim() || null;
};

export const getVolumeEngineAuthToken = (): Promise<string | null> => {
  if (!tokenPromise) tokenPromise = readNativeToken();
  return tokenPromise;
};

export const fetchVolumeEngine = async (
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<Response> => {
  const token = await getVolumeEngineAuthToken();
  const url = pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `${VOLUME_ENGINE_BASE_URL}${pathOrUrl}`;
  const headers = new Headers(init.headers);
  if (token) headers.set(VOLUME_ENGINE_TOKEN_HEADER, token);
  return fetch(url, { ...init, headers });
};
