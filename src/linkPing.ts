/**
 * Link pings — make a ping a tappable button that opens a URL.
 *
 * The server convention is two reserved keys inside the structured `data`
 * object: `url` (absolute http(s), <= 2048 chars) and `button_label`
 * (<= 26 chars). This helper builds that fragment with client-side
 * validation so a bad link fails fast instead of at the API boundary:
 *
 *   await pr.broadcast('ab12cd', {
 *     message: 'Build 512 ready',
 *     data: { commit: 'abc123', ...linkPing({ url: 'https://ci.example.com/b/512', buttonLabel: 'Open build' }) },
 *   });
 */

export interface LinkPingInput {
  /** Absolute http(s) URL opened when the recipient taps the link button. Max 2048 chars. */
  url: string;
  /** Text on the link button. Max 26 chars. Defaults to a generic label on-device. */
  buttonLabel?: string;
}

export interface LinkPingData {
  url: string;
  button_label?: string;
  [key: string]: unknown;
}

const URL_MAX = 2048;
const LABEL_MAX = 26;

/** Build the `data` fragment for a link ping. Spread it into a ping's `data` object. */
export function linkPing(input: LinkPingInput): LinkPingData {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new TypeError('linkPing: url is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('linkPing: url must be an absolute http(s) URL');
  }
  if (input.url.length > URL_MAX) {
    throw new TypeError(`linkPing: url must be at most ${URL_MAX} characters`);
  }
  if (input.buttonLabel !== undefined && input.buttonLabel.length > LABEL_MAX) {
    throw new TypeError(`linkPing: buttonLabel must be at most ${LABEL_MAX} characters`);
  }
  const out: LinkPingData = { url: input.url };
  if (input.buttonLabel !== undefined) out.button_label = input.buttonLabel;
  return out;
}
