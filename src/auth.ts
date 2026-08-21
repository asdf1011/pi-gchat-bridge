import { createPrivateKey, sign } from "node:crypto";
import fs from "node:fs";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/**
 * Service-account JWT auth: signs an assertion with the private key, exchanges
 * it for an access token (cached until near expiry), and provides an
 * authenticated JSON request helper.
 *
 * NOTE: deliberately avoids `google-auth-library`/`gaxios`: their HTTP stack
 * (node-fetch v2) is broken against Google endpoints on Node >= 22
 * (ERR_STREAM_PREMATURE_CLOSE on gzip responses). We sign and fetch ourselves.
 */
export class ServiceAccountAuth {
  private key: ServiceAccountKey;
  private accessToken: string | undefined;
  private tokenExpiry = 0;

  constructor(
    serviceAccountPath: string,
    private scopes: string[],
  ) {
    this.key = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8")) as ServiceAccountKey;
    if (!this.key.client_email || !this.key.private_key || !this.key.token_uri) {
      throw new Error(`Invalid service account JSON: ${serviceAccountPath}`);
    }
  }

  /** Authenticated JSON request with a Bearer token. Empty bodies are OK. */
  async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    body?: string,
    /** Abort the request after this many ms (e.g. a long-lived pull). */
    timeoutMs?: number,
  ): Promise<unknown> {
    const token = await this.getAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${method} ${url} -> ${res.status}: ${detail.slice(0, 300)}`);
    }
    const raw = await res.text();
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  }

  /**
   * Authenticated binary GET (image/attachment downloads) — returns raw bytes
   * without JSON parsing. No Content-Type header: the payload is arbitrary.
   */
  async requestBuffer(url: string, timeoutMs?: number): Promise<Buffer> {
    const token = await this.getAccessToken();
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`GET ${url} -> ${res.status}: ${detail.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken;
    }
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: this.key.client_email,
      scope: this.scopes.join(" "),
      aud: this.key.token_uri,
      iat: now,
      exp: now + 3600,
    };
    const b64 = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${b64(header)}.${b64(claims)}`;
    const signature = sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(this.key.private_key));

    const res = await fetch(this.key.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature.toString("base64url")}`,
      }),
    });
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      throw new Error(
        `Token exchange failed: ${res.status} ${data.error ?? ""} ${data.error_description ?? ""}`.trim(),
      );
    }
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}
