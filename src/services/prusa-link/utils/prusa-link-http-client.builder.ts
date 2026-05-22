import { DefaultHttpClientBuilder } from "@/shared/default-http-client.builder";
import {
  authorizationHeaderKey,
  wwwAuthenticationHeaderKey,
} from "@/services/octoprint/constants/octoprint-service.constants";
import { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import { generateDigestAuthHeader } from "./digest-auth.util";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

// Per-builder keep-alive agents with maxSockets: 1.
//
// The standalone PrusaLink on a Raspberry Pi (MK3/MK2.5) binds the digest
// nonce to the TCP connection it was issued on. With a *shared* pool the
// 401 challenge could land on socket A and the authenticated retry on
// socket B, so the nonce was invalid and the request 401'd — intermittently,
// depending on which pooled socket each leg grabbed.
//
// Pinning each printer's client to a single keep-alive socket guarantees the
// challenge and its retry (and subsequent nc-incremented requests) ride the
// same connection. Reads are already serialised per printer, so a single
// socket costs no throughput; different printers get different builders and
// therefore different sockets, so they still poll concurrently.
function makeHttpAgent() {
  return new HttpAgent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 1, maxFreeSockets: 1 });
}
function makeHttpsAgent() {
  return new HttpsAgent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 1,
    maxFreeSockets: 1,
    rejectUnauthorized: false, // PrusaLink ships self-signed certs by default
  });
}

export interface DigestAuthInfo {
  realm: string;
  nonce: string;
  qop?: string;
  hasQop: boolean;
  /** "MD5" | "MD5-sess" etc. from the challenge (drives HA1 derivation). */
  algorithm?: string;
  /** Opaque token from the challenge; echoed back verbatim. */
  opaque?: string;
}

/**
 * Parse a WWW-Authenticate Digest challenge into key/value pairs.
 *
 * Hand-rolled because `split(", ")` and `split("=")` both break on real
 * headers: nonces are often base64 (contain `=`), values can include commas
 * inside quotes (e.g. `qop="auth,auth-int"`), and some servers omit the space
 * after commas.
 *
 * Exported for testing.
 */
export function parseDigestChallenge(value: string): Record<string, string> {
  const params: Record<string, string> = {};
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    const keyStart = i;
    while (i < value.length && value[i] !== "=") i++;
    if (i === value.length) break;
    const key = value.slice(keyStart, i).trim().toLowerCase();
    i++; // skip '='

    let val: string;
    if (value[i] === '"') {
      i++;
      const valStart = i;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < value.length) i++;
        i++;
      }
      val = value.slice(valStart, i);
      if (i < value.length) i++; // skip closing quote
    } else {
      const valStart = i;
      while (i < value.length && value[i] !== ",") i++;
      val = value.slice(valStart, i).trim();
    }

    if (key) params[key] = val;
  }
  return params;
}

export class PrusaLinkHttpClientBuilder extends DefaultHttpClientBuilder {
  private readonly maxRetries: number = 1;
  private username?: string;
  private password?: string;
  private authHeaderContext?: DigestAuthInfo;
  private onAuthError?: (error: AxiosError) => void;
  private onAuthSuccess?: (authHeader: string) => void;
  private onRequestRetry?: (error: AxiosError, attemptCount: number) => void;
  // Monotonic per-builder nonce counter. RFC 7616 requires nc to be unique
  // for each request that uses the same nonce — strict servers (Buddy on XL
  // and Core One) drop replays otherwise.
  private nonceCount: number = 0;

  // One agent pair per builder so this client owns its single keep-alive
  // socket (see makeHttpAgent rationale above).
  private readonly httpAgent = makeHttpAgent();
  private readonly httpsAgent = makeHttpsAgent();

  public override build<D = any>(): AxiosInstance {
    if (!this.axiosOptions.baseURL) {
      throw new Error("Base URL is required");
    }

    const axiosInstance = super.build<D>();
    // Pin this client to its own single-socket agents so the digest
    // challenge and its authenticated retry always share one connection.
    axiosInstance.defaults.httpAgent = this.httpAgent;
    axiosInstance.defaults.httpsAgent = this.httpsAgent;

    // Add request interceptor for digest auth
    if (this.username && this.password) {
      axiosInstance.interceptors.request.use(async (config) => {
        // If we have auth info, add the digest header
        if (this.authHeaderContext) {
          // The URI signed by the digest must match the path axios actually
          // sends in the request line. axios appends `params` as a query string
          // after `url`, so reconstruct that here — otherwise PrusaLink rejects
          // the digest with 401 (different URI hashes than what it saw).
          const baseUrl = config.url ?? "/";
          const params = config.params ?? {};
          const search = Object.keys(params)
            .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
            .join("&");
          const fullUri = search && !baseUrl.includes("?") ? `${baseUrl}?${search}` : baseUrl;

          const computedDigestHeader = this.generateDigestHeader(config.method?.toUpperCase() ?? "GET", fullUri);

          config.headers[authorizationHeaderKey] = computedDigestHeader;
        }
        return config;
      });

      // Add response interceptor to handle 401s
      axiosInstance.interceptors.response.use(
        (response) => response,
        async (error: AxiosError) => {
          const originalRequest = error.config as AxiosRequestConfig & { _retryCount?: number };

          // If we get a 401 and have credentials but no auth info or retried less than once
          if (
            error.response?.status === 401 &&
            this.username?.length &&
            this.password?.length &&
            (!originalRequest._retryCount || originalRequest._retryCount < this.maxRetries)
          ) {
            // Extract WWW-Authenticate header
            const wwwAuthHeader = error.response.headers[wwwAuthenticationHeaderKey] as string;
            if (wwwAuthHeader) {
              // A stale=true challenge means the nonce expired mid-session.
              // Surface it through the onRequestRetry hook so callers can log
              // it (helps diagnose printers with very short nonce lifetimes).
              const isStale = /\bstale\s*=\s*"?true"?/i.test(wwwAuthHeader);

              // Allow caching the value for reuse
              if (typeof this.onAuthSuccess === "function") {
                this.onAuthSuccess(wwwAuthHeader);
              }

              this.saveParsedAuthHeaderContext(wwwAuthHeader);
              // saveParsedAuthHeaderContext already resets nc when the nonce
              // changes; the `isStale` flag is purely informational below.
              void isStale;

              // A Readable body cannot be replayed — retrying would send an empty body and
              // silently corrupt the upload. Surface the 401 so callers can refresh auth
              // (e.g. with a no-body request) and retry from a fresh stream themselves.
              if (originalRequest.data instanceof Readable) {
                return Promise.reject(error);
              }

              originalRequest._retryCount = (originalRequest._retryCount ?? 0) + 1;

              if (typeof this.onRequestRetry === "function") {
                this.onRequestRetry(error, originalRequest._retryCount);
              }
              return axiosInstance(originalRequest);
            }
          }

          // If this is an auth error, and we have a callback, invoke it
          if (error.response?.status === 401 && this.onAuthError && typeof this.onAuthError === "function") {
            this.onAuthError(error);
          }

          // If we can't handle it, pass the error on
          return Promise.reject(error);
        },
      );
    }

    return axiosInstance;
  }

  public withDigestAuth(
    username?: string,
    password?: string,
    onAuthError?: (error: AxiosError) => void,
    onRequestRetry?: (error: AxiosError, attemptCount: number) => void,
    onAuthSuccess?: (authHeader: string) => void,
  ): this {
    if (!username?.length) {
      throw new Error("username may not be an empty string");
    }
    if (!password?.length) {
      throw new Error("password may not be an empty string");
    }
    if (onAuthError && typeof onAuthError !== "function") {
      throw new Error("onAuthError must be a function");
    }
    if (onAuthSuccess && typeof onAuthSuccess !== "function") {
      throw new Error("onAuthSuccess must be a function");
    }
    if (onRequestRetry && typeof onRequestRetry !== "function") {
      throw new Error("onRequestRetry must be a function");
    }

    this.username = username;
    this.password = password;
    this.onAuthError = onAuthError;
    this.onRequestRetry = onRequestRetry;
    this.onAuthSuccess = onAuthSuccess;

    return this;
  }

  public withAuthHeader(authHeader: string): this {
    if (!authHeader?.length) {
      throw new Error("Digest header may not be an empty string");
    }

    this.saveParsedAuthHeaderContext(authHeader);
    return this;
  }

  private saveParsedAuthHeaderContext(authHeader: string): void {
    const headerValue = authHeader.replace(/^Digest\s+/i, "");
    const authParams = parseDigestChallenge(headerValue);

    // PrusaLink may advertise `qop="auth,auth-int"`. RFC 7616 says the client
    // picks one — we always pick `auth`, since `auth-int` would require us to
    // include a body hash that we don't currently compute (and would break
    // for streaming uploads anyway).
    const rawQop = authParams.qop;
    const selectedQop = rawQop
      ? (rawQop
          .split(",")
          .map((s) => s.trim())
          .find((s) => s.toLowerCase() === "auth") ?? rawQop.split(",")[0].trim())
      : undefined;

    // A fresh nonce starts the nc sequence from 1 again. If we reused the old
    // counter the next request would be `nc=00000005` against a brand-new
    // nonce, which servers treat as a replay attack and refuse.
    const newNonce = authParams.nonce ?? "";
    if (!this.authHeaderContext || this.authHeaderContext.nonce !== newNonce) {
      this.nonceCount = 0;
    }

    this.authHeaderContext = {
      realm: authParams.realm ?? "",
      nonce: newNonce,
      qop: selectedQop,
      hasQop: !!rawQop,
      algorithm: authParams.algorithm,
      opaque: authParams.opaque,
    };
  }

  private generateDigestHeader(method: string, uri: string): string {
    if (!this.authHeaderContext || !this.username || !this.password) {
      throw new Error("Digest auth not properly configured");
    }

    const { realm, nonce, qop, hasQop, algorithm, opaque } = this.authHeaderContext;

    // Increment nc per request; hex-pad to 8 chars as RFC 7616 requires.
    this.nonceCount += 1;
    const nc = this.nonceCount.toString(16).padStart(8, "0");

    // A client nonce is required when qop is present *or* the algorithm is
    // a "-sess" variant (the session HA1 mixes in cnonce).
    const isSess = (algorithm ?? "").toLowerCase().endsWith("-sess");
    const cnonce = hasQop || isSess ? randomBytes(8).toString("hex") : undefined;

    return generateDigestAuthHeader({
      username: this.username,
      password: this.password,
      method,
      uri,
      realm,
      nonce,
      qop: hasQop ? qop : undefined,
      nc: hasQop ? nc : undefined,
      cnonce,
      algorithm,
      opaque,
    });
  }
}
