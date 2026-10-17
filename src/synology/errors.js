// -----------------------------------------------------------------------------
// SynologyError: every failure of a request to the NAS, with a code the app
// maps to a status, a retry policy or a message. Messages never carry the
// password, the session id or the device token.
//
// The error tables of DSM's Web API are ported from py-synologydsm-api
// (mib1185, MIT, src/synology_dsm/const.py; see THIRD_PARTY_NOTICES.md).
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no TCP connection to the NAS
  TIMEOUT: 'timeout', // the NAS did not answer in time
  TLS_UNTRUSTED: 'tls_untrusted', // certificate refused (self-signed, wrong name...)
  TLS_CHANGED: 'tls_changed', // differs from the certificate trusted on first use
  HTTP: 'http', // an HTTP status other than 200
  BAD_ANSWER: 'bad_answer', // not the JSON or JPEG expected
  TOO_LARGE: 'too_large', // answer above the size cap
  API: 'api', // DSM answered success: false (see `apiCode`)
  NO_API: 'no_api', // the NAS does not offer this API (Surveillance Station missing?)
  NOT_LOGGED_IN: 'not_logged_in', // no session and no login allowed now
  IMAGE_TOO_LARGE: 'image_too_large', // no snapshot under the Gladys limit
});

/** Common error codes of every SYNO.* API. */
export const ERROR_COMMON = Object.freeze({
  100: 'Unknown error',
  101: 'No parameter API, method, or version',
  102: 'API does not exist',
  103: 'API method does not exist',
  104: 'API version not supported',
  105: 'Insufficient user privilege',
  106: 'Session timeout',
  107: 'Session interrupted by duplicate login',
  114: 'Missing required parameters',
  117: 'Unknown internal error',
  119: 'Session id not found',
  120: 'Invalid parameter',
  160: 'Insufficient application privilege',
});

/** Error codes of SYNO.API.Auth. */
export const ERROR_AUTH = Object.freeze({
  400: 'Invalid credentials',
  401: 'Guest or disabled account',
  402: 'Permission denied',
  403: 'One time password not specified',
  404: 'One time password authenticate failed',
  405: 'App portal incorrect',
  406: 'One time password code enforced',
  407: 'Max Tries (if auto blocking is set to true)',
  408: 'Password Expired Can not Change',
  409: 'Password Expired',
  410: 'Password must change',
  411: 'Account Locked',
});

/** Error codes of SYNO.SurveillanceStation.*. */
export const ERROR_SURVEILLANCE = Object.freeze({
  400: 'Execution failed',
  401: 'Invalid parameter',
  402: 'Camera disabled',
  403: 'Insufficient license',
  404: 'Codec activation failed',
  405: 'CMS server connection failed',
  407: 'CMS closed',
  412: 'Need to add license',
  413: 'Reach the maximum of platform',
  414: 'Some events not exist',
  415: 'Message connect failed',
  417: 'Test connection error',
  418: 'Object/VisualStation ID does not exist',
  439: 'Too many items selected',
});

/** Session codes: the SID is no longer valid, a new login may fix it. */
export const SESSION_CODES = new Set([106, 107, 119]);

/** Login refusals that a retry with the same values cannot fix: never retried alone. */
export const AUTH_FINAL = Object.freeze({
  CREDENTIALS: new Set([400, 401, 402, 405, 407, 408, 409, 410, 411]),
  OTP_REQUIRED: 403,
  OTP_FAILED: 404,
  OTP_ENFORCED: 406,
});

export function reasonOfApiCode(api, code) {
  if (ERROR_COMMON[code]) return ERROR_COMMON[code];
  if (api === 'SYNO.API.Auth') return ERROR_AUTH[code] ?? 'Unknown';
  if (String(api).startsWith('SYNO.SurveillanceStation'))
    return ERROR_SURVEILLANCE[code] ?? 'Unknown';
  return 'Unknown';
}

export class SynologyError extends Error {
  constructor(code, message, { api, apiCode, status } = {}) {
    super(message);
    this.name = 'SynologyError';
    this.code = code;
    if (api !== undefined) this.api = api;
    if (apiCode !== undefined) this.apiCode = apiCode;
    if (status !== undefined) this.status = status;
  }

  static fromApi(api, apiCode) {
    return new SynologyError(
      CODES.API,
      `${api}: error ${apiCode} (${reasonOfApiCode(api, apiCode)})`,
      { api, apiCode },
    );
  }
}

/** A login refused for good: wrong password, locked account, 2-step verification. */
export const isFinalAuthError = (err) =>
  err?.code === CODES.API &&
  err.api === 'SYNO.API.Auth' &&
  (AUTH_FINAL.CREDENTIALS.has(err.apiCode) ||
    err.apiCode === AUTH_FINAL.OTP_REQUIRED ||
    err.apiCode === AUTH_FINAL.OTP_FAILED ||
    err.apiCode === AUTH_FINAL.OTP_ENFORCED);

/** The certificate is the problem: retrying alone cannot fix it either. */
export const isTlsError = (err) =>
  err?.code === CODES.TLS_UNTRUSTED || err?.code === CODES.TLS_CHANGED;
