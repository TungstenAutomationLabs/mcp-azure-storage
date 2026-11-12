/**
 * Secret redaction for log records: the logger's security boundary.
 *
 * The structured logger (utils/otel-logger) writes every record to stdout,
 * which Azure Container Apps ships to Log Analytics, and to the OTel log
 * exporter. Messages often carry `err.message` or `err.stack` from the Azure
 * SDK, Node or busboy, and attributes are free-form. Before a record reaches
 * either sink:
 *
 *  - an attribute (at any depth) whose NAME marks it as a credential
 *    (password, secret, token, API key, authorization, cookie, SAS
 *    signature, account key, connection string, private key) has its value
 *    replaced;
 *  - inside every string (the message, attribute values, nested values,
 *    error messages and stacks) Azure connection-string secrets
 *    (`AccountKey=`, `SharedAccessSignature=`, `SharedAccessKey=`), SAS and
 *    other secret query parameters (`sig=`, `token=`, `password=` ...),
 *    credentials in a URL (`https://user:pass@host`) and bearer tokens are
 *    replaced, keeping the surrounding text for diagnosis;
 *  - objects, arrays and errors are redacted recursively and flattened to a
 *    JSON string, so every attribute the sinks receive is a primitive.
 *    Circular references and depth beyond MAX_DEPTH are cut, never thrown.
 *
 * Callers are expected to pass non-sensitive diagnostics; this boundary is
 * the second line of defence, not a reason to log request bodies.
 *
 * @module utils/log-redaction
 */

/** Replacement for a redacted value. */
export const LOG_REDACTED = "[redacted]";

/** Nesting depth beyond which values are replaced by a marker. */
const MAX_DEPTH = 6;

/** Attribute names whose values are credentials, whatever they contain. */
const SENSITIVE_ATTRIBUTE_NAME =
  /pass(word|wd)?|secret|token|api[-_]?key|authori[sz]ation|cookie|credential|signature|^sig$|^sas$|account[-_]?key|connection[-_]?string|private[-_]?key/i;

/** Secrets embedded in free text, with the part to keep in group 1. */
const SECRET_IN_TEXT: RegExp[] = [
  // Azure connection-string parts: AccountKey=..., SharedAccessSignature=..., SharedAccessKey=...
  /((?:AccountKey|SharedAccessSignature|SharedAccessKey)=)[^;\s"']+/gi,
  // Secret query parameters, in a URL (...&sig=...) or a bare SAS token string
  /((?:^|[?&;\s])(?:sig|signature|token|access_token|refresh_token|id_token|password|pwd|secret|client_secret|api[-_]?key|key)=)[^&;\s"'#]+/gi,
  // Credentials in a URL: scheme://user:password@host
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi,
  // Authorization: Bearer <token> / Basic <credentials>
  /((?:Bearer|Basic)\s+)[A-Za-z0-9\-._~+/]+=*/gi,
];

/** Whether an attribute name marks its value as a credential. */
export function isSensitiveAttributeName(name: string): boolean {
  return SENSITIVE_ATTRIBUTE_NAME.test(name);
}

/** Replace credentials embedded in a string, keeping the rest of it. */
export function redactSecretsInText(text: string): string {
  let out = text;
  for (const pattern of SECRET_IN_TEXT) {
    out = out.replace(pattern, (_match, keep: string) =>
      // URL userinfo keeps scheme and marks the removed part
      keep.endsWith("//") ? `${keep}${LOG_REDACTED}@` : `${keep}${LOG_REDACTED}`,
    );
  }
  return out;
}

/** A primitive attribute value, as the sinks accept. */
export type LogAttributeValue = string | number | boolean;

/**
 * Redact any value into a JSON-safe structure: strings are scanned,
 * credential-named keys replaced, errors reduced to name, message and
 * stack, and cycles and excess depth cut.
 */
function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecretsInText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return `[${typeof value}]`;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: redactSecretsInText(String(value.message)),
      };
      if (typeof value.stack === "string") out.stack = redactSecretsInText(value.stack);
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveAttributeName(k) ? LOG_REDACTED : redactValue(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Redact one attribute value and reduce it to a primitive. */
function toSafeAttribute(value: unknown): LogAttributeValue {
  const redacted = redactValue(value, 0, new WeakSet());
  if (typeof redacted === "string" || typeof redacted === "number" || typeof redacted === "boolean") {
    return redacted;
  }
  if (redacted === null || redacted === undefined) return String(redacted);
  return JSON.stringify(redacted);
}

/**
 * Return a copy of the attributes with credential values replaced and every
 * value reduced to a primitive. Numbers and booleans under a non-sensitive
 * name pass through unchanged.
 */
export function redactLogAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, LogAttributeValue> | undefined {
  if (!attributes) return undefined;
  const out: Record<string, LogAttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    out[name] = isSensitiveAttributeName(name) ? LOG_REDACTED : toSafeAttribute(value);
  }
  return out;
}

/** Redact a log message of any runtime type into a string. */
export function redactLogMessage(message: unknown): string {
  const safe = toSafeAttribute(message);
  return typeof safe === "string" ? safe : String(safe);
}
