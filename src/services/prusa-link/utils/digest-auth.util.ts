import { createHash } from "node:crypto";
import { DigestAuthParams } from "@/services/prusa-link/utils/digest-auth.params";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

export function generateDigestAuthHeader(params: DigestAuthParams): string {
  const { username, password, method, uri, realm, nonce, qop, nc, cnonce, algorithm, opaque } = params;

  const algo = (algorithm ?? "MD5").trim();
  const isSess = algo.toLowerCase() === "md5-sess";

  // RFC 7616 §3.4.2: for the "-sess" variant the secret is re-hashed with
  // the nonce + client nonce. PrusaLink on the Raspberry Pi (MK3) advertises
  // algorithm="MD5-sess", so computing plain MD5 HA1 produced a wrong
  // response and the printer rejected every request with 401.
  let ha1 = md5(`${username}:${realm}:${password}`);
  if (isSess) {
    ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  }
  const ha2 = md5(`${method}:${uri}`);

  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);

  // Build the header. `algorithm` and `opaque` are echoed back when the
  // server sent them — some implementations (PrusaLink included) validate
  // that the opaque round-trips unchanged.
  const parts = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  parts.push(`response="${response}"`);
  if (algorithm) parts.push(`algorithm=${algo}`);
  if (opaque) parts.push(`opaque="${opaque}"`);

  return `Digest ${parts.join(", ")}`;
}
