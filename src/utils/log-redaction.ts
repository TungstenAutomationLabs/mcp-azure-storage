/**
 * Secret redaction for log records.
 *
 * The structured logger (utils/otel-logger) writes every record to stdout,
 * which Azure Container Apps ships to Log Analytics, and to the OTel log
 * exporter. Messages often carry `err.message` from the Azure SDK, Node or
 * busboy, and attributes are free-form. This module removes credentials
 * before a record reaches either sink:
 *
 *  - an attribute whose NAME marks it as a credential (password, secret,
 *    token, API key, authorization, cookie, SAS signature, account key,
 *    connection string, private key) has its value replaced;
 *  - inside any string (the message and every string attribute value),
 *    Azure connection-string secrets (`AccountKey=`, `SharedAccessSignature=`,
 *    `SharedAccessKey=`), SAS signatures (`sig=`) and bearer tokens are
 *    replaced, keeping the surrounding text for diagnosis.
 *
 * @module utils/log-redaction
 */

/** Replacement for a redacted value. */
export const LOG_REDACTED = "[redacted]";

/** Attribute names whose values are credentials, whatever they contain. */
const SENSITIVE_ATTRIBUTE_NAME =
  /pass(word|wd)?|secret|token|api[-_]?key|authori[sz]ation|cookie|credential|signature|^sig$|^sas$|account[-_]?key|connection[-_]?string|private[-_]?key/i;

/** Secrets embedded in free text, with the part to keep in group 1. */
const SECRET_IN_TEXT: RegExp[] = [
  // Azure connection-string parts: AccountKey=..., SharedAccessSignature=..., SharedAccessKey=...
  /((?:AccountKey|SharedAccessSignature|SharedAccessKey)=)[^;\s"']+/gi,
  // SAS signature, in a URL query (...&sig=...) or a bare SAS token string
  /((?:^|[?&;\s])sig=)[^&;\s"'#]+/gi,
  // Authorization: Bearer <token>
  /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
];

/** Whether an attribute name marks its value as a credential. */
export function isSensitiveAttributeName(name: string): boolean {
  return SENSITIVE_ATTRIBUTE_NAME.test(name);
}

/** Replace credentials embedded in a string, keeping the rest of it. */
export function redactSecretsInText(text: string): string {
  let out = text;
  for (const pattern of SECRET_IN_TEXT) {
    out = out.replace(pattern, `$1${LOG_REDACTED}`);
  }
  return out;
}

/**
 * Return a copy of the attributes with credential values replaced.
 * Numbers and booleans under a non-sensitive name pass through unchanged.
 */
export function redactLogAttributes(
  attributes: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!attributes) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (isSensitiveAttributeName(name)) {
      out[name] = LOG_REDACTED;
    } else if (typeof value === "string") {
      out[name] = redactSecretsInText(value);
    } else {
      out[name] = value;
    }
  }
  return out;
}
