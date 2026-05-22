export interface DigestAuthParams {
  username: string;
  password: string;
  method: string;
  uri: string;
  realm: string;
  nonce: string;
  qop?: string;
  nc?: string;
  cnonce?: string;
  /** From the challenge: "MD5" (default) or "MD5-sess". */
  algorithm?: string;
  /** Opaque value from the challenge; must be echoed back verbatim. */
  opaque?: string;
}
