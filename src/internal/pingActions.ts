// Buttons on a Ping: the reserved `data.actions` key, checked client-side the
// way `App\Support\PingActionRules` checks it on the server, so a button the
// server would refuse fails here, before any request, with the same reason.
//
// Pinned by docs/contracts/ping-actions.json (test/ping-actions-contract.test.mjs
// replays its limits, label and URL verdicts through these functions).

import { PingRoomError } from '../errors.js';
import { serverJsonByteLength } from './guards.js';

export const MAX_PING_ACTIONS = 3;
export const PING_ACTION_ID_PATTERN = /^[a-z0-9_-]{1,24}$/;
export const MAX_PING_ACTION_LABEL_LENGTH = 26;
export const MAX_PING_ACTION_URL_LENGTH = 2048;
export const MAX_PING_ACTION_BODY_BYTES = 1024;
export const MAX_PING_ACTION_BODY_KEYS = 10;
/** A button can be run only while its Ping is younger than this. */
export const PING_ACTION_RUN_WINDOW_HOURS = 24;
export const PING_ACTION_TYPES = ['open_url', 'webhook'] as const;
export const PING_ACTION_STYLES = ['default', 'primary', 'danger'] as const;

const ACTION_KEYS = new Set(['id', 'label', 'type', 'url', 'style', 'body']);

/** Last labels that never name a public host (server: `NON_PUBLIC_TLDS`). */
const NON_PUBLIC_TLDS = new Set([
  'localhost', 'localdomain', 'local', 'internal', 'lan', 'intranet', 'corp',
  'home', 'arpa', 'onion', 'test', 'invalid', 'example',
]);

/**
 * PingRoom's own notification buttons in their comparison form (see
 * {@link pingActionComparisonForm}): every shipped translation of Pong back,
 * Mute room, Confirm and the claim buttons, plus the bare words. A label equal
 * to one of these is refused. Sorted, equal to `reserved_labels` in the
 * contract fixture.
 */
export const RESERVED_PING_ACTION_LABELS: readonly string[] = [
  'abbrechen', 'abgeben', 'ack', 'acknowledge', 'annuler', 'annulla',
  'balasdenganpong', 'batal', 'benhallederim', 'bestätigen', 'bırak', 'cancel',
  'cancelar', 'cipensoio', 'completato', 'concluir', 'concluído', 'conferma',
  'confirm', 'confirmar', 'confirmer', 'couperlesondusalon', 'dejarlo', 'devolverpong',
  'done', 'erledigt', 'euassumo', 'eucuidodisso', 'fatto', 'fertig',
  'ichübernehme', 'illtakeit', 'i̇ptal', 'jemenoccupe', 'laisser', 'lascia',
  'lepaskan', 'letgo', 'liberar', 'listo', 'meencargoyo', 'meneoccupoio',
  'mute', 'muteroom', 'odayısessizeal', 'onayla', 'pingroom', 'pong',
  'pongback', 'ponggönder', 'pongzurück', 'pongभेजें', 'pongを返す', 'raumstummschalten',
  'renvoyerunpong', 'respondercompong', 'rispondiconpong', 'sahkan', 'sayaambil', 'sayauruskan',
  'selesai', 'senyapkanbilik', 'silenciarsala', 'silenziastanza', 'soltar', 'tamamla',
  'tamamlandı', 'terminé', 'unmute', 'беру', 'готово', 'ответитьpong',
  'отказаться', 'отключитьзвуккомнаты', 'отмена', 'отменить', 'подтвердить', 'явозьмусь',
  'أتخلىعنه', 'إلغاء', 'انجامشد', 'بیصداکردناتاق', 'تأكيد', 'تأیید',
  'تخلَّعنه', 'تم', 'ردبـpong', 'رهاکردن', 'سأتولىالأمر', 'كتمالغرفة',
  'لغو', 'منانجامشمیدهم', 'پاسخباpong', 'छोड़दें', 'छोड़ें', 'पुष्टिकरें',
  'पूराहुआ', 'मैंइसेलेलूँ', 'मैंसंभालूँगा', 'रद्दकरें', 'रूमम्यूटकरें', 'キャンセル',
  'ルームをミュート', '取消', '回复pong', '完了', '完成', '将房间静音',
  '已完成', '引き受ける', '我來處理', '我来', '我来处理', '手放す',
  '放弃', '放棄', '确认', '確認',
];
const RESERVED = new Set(RESERVED_PING_ACTION_LABELS);

const MESSAGE_PROHIBITED = 'Buttons (data.actions) can only be sent with an ordinary Ping from an agent or an incoming webhook.';

export interface LabelVerdict { label: string; error: string | null }
export interface UrlVerdict { url: string; host: string; error: string | null }

/**
 * The normalized button the server stores: `id` defaulted to `a1`..`a3`, the
 * cleaned label, the host the server derives from the URL.
 */
export interface NormalizedPingAction {
  id: string;
  position: number;
  type: 'open_url' | 'webhook';
  label: string;
  style: 'default' | 'primary' | 'danger';
  url: string;
  host: string;
  body: Record<string, unknown> | null;
}

/** Whether `data` carries the reserved key at all (`null` counts as absent, as on the server). */
export function hasPingActions(data: unknown): data is { actions: unknown } {
  return isPlainObject(data) && data['actions'] !== undefined && data['actions'] !== null;
}

/**
 * The comparison form of a label: compatibility-folded, lowercased, letters,
 * digits and combining marks only. "👍 Pong Back" and "PONG back" are both
 * `pongback`.
 */
export function pingActionComparisonForm(label: string): string {
  return label.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

/**
 * Whether a label holds anything shaped like a destination: a scheme, `www.`,
 * a dotted IPv4 address, or `name.tld` with an alphabetic or punycode TLD,
 * after compatibility folding and with the ideographic full stops browsers
 * treat as dots. `\p{Nd}` where the server writes `\d`: PHP's `/u` patterns
 * match every decimal digit, JavaScript's `\d` only ASCII ones.
 */
export function pingActionLabelLooksLikeAddress(label: string): boolean {
  const folded = label
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[。．｡]/g, '.');

  if (folded.includes('://') || folded.includes('www.')) {
    return true;
  }
  if (/(?<![\p{L}\p{N}])\p{Nd}{1,3}(?:\.\p{Nd}{1,3}){3}(?![\p{L}\p{N}])/u.test(folded)) {
    return true;
  }
  return /(?<![\p{L}\p{N}_-])[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*\.(?:\p{L}{2,}|xn--[a-z0-9-]+)(?![\p{L}\p{N}])/u.test(folded);
}

/**
 * Clean one label the way the server does: NFC; refuse every control,
 * private-use, lone-surrogate and invisible formatting character except the
 * zero-width (non-)joiners and the emoji tag block; collapse spaces; trim;
 * then refuse an empty, overlong, address-shaped or reserved label.
 */
export function cleanPingActionLabel(label: unknown): LabelVerdict {
  if (typeof label !== 'string') {
    return { label: '', error: 'A button needs a label.' };
  }
  if (/\p{Cs}/u.test(label)) {
    // A lone surrogate is not valid text: the server cannot decode it at all.
    return { label: '', error: 'A button needs a label.' };
  }
  let cleaned = label.normalize('NFC');
  if (/[\p{Cc}\p{Zl}\p{Zp}\p{Co}]/u.test(cleaned) || /(?![‌‍\u{E0020}-\u{E007F}])\p{Cf}/u.test(cleaned)) {
    return { label: '', error: 'A button label may not contain line breaks, control characters or invisible formatting characters.' };
  }
  cleaned = cleaned.replace(/\p{Zs}+/gu, ' ').replace(/^ +| +$/g, '');
  if (cleaned === '') {
    return { label: '', error: 'A button needs a label.' };
  }
  if (Array.from(cleaned).length > MAX_PING_ACTION_LABEL_LENGTH) {
    return { label: '', error: `A button label is at most ${MAX_PING_ACTION_LABEL_LENGTH} characters.` };
  }
  if (pingActionLabelLooksLikeAddress(cleaned)) {
    return { label: '', error: 'A button label may not contain a web address, domain name or IP address. The app shows where the button goes.' };
  }
  if (RESERVED.has(pingActionComparisonForm(cleaned))) {
    return { label: '', error: 'That label is one of PingRoom\'s own buttons. Choose another.' };
  }
  return { label: cleaned, error: null };
}

/**
 * A lowercase ASCII hostname of at least two labels whose last label is
 * alphabetic (or punycode) and not a special-use name.
 */
export function isPublicPingActionHostname(host: string): boolean {
  if (host === '' || host.length > 253 || host.endsWith('.')) {
    return false;
  }
  const labels = host.split('.');
  if (labels.length < 2) {
    return false;
  }
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      return false;
    }
  }
  const tld = labels[labels.length - 1] as string;
  return /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld) && !NON_PUBLIC_TLDS.has(tld);
}

/**
 * The URL rules for both button types, and the host the server derives:
 * `https://`, printable ASCII only, a bare hostname as the authority (and a
 * port for a link only), a public hostname. An internationalized domain must
 * arrive as punycode. The server checks a webhook target again when it
 * delivers (DNS, private addresses), which this cannot.
 */
export function pingActionUrlVerdict(url: unknown, type: string): UrlVerdict {
  const refuse = (error: string): UrlVerdict => ({ url: '', host: '', error });

  if (typeof url !== 'string' || url === '') {
    return refuse('A button needs a url.');
  }
  if (new TextEncoder().encode(url).length > MAX_PING_ACTION_URL_LENGTH) {
    return refuse(`A button url is at most ${MAX_PING_ACTION_URL_LENGTH} characters.`);
  }
  if (!url.startsWith('https://')) {
    return refuse('A button url must start with https://.');
  }
  if (!/^[\x21-\x7E]+$/.test(url) || url.includes('\\')) {
    return refuse('A button url may contain only printable ASCII characters: percent-encode the rest, and give an internationalized domain in its punycode (xn--) form.');
  }

  const rest = url.slice('https://'.length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(authority);
  if (!match) {
    return refuse('A button url needs a plain hostname: no user name or password, no IP address in brackets.');
  }
  const host = (match[1] as string).toLowerCase();
  const port = match[2];
  if (port !== undefined) {
    if (type === 'webhook') {
      return refuse('A webhook button url cannot name a port: deliveries go to the standard HTTPS port.');
    }
    if (Number(port) < 1 || Number(port) > 65535) {
      return refuse('A button url has an invalid port.');
    }
  }
  if (!isPublicPingActionHostname(host)) {
    return refuse('A button url needs a public hostname such as example.com: no IP address, localhost or internal name.');
  }

  // A second reading must name the same host, as the server's parse_url does.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('A button url must be a valid https URL.');
  }
  if (parsed.hostname !== host || parsed.username !== '' || parsed.password !== '') {
    return refuse('A button url must be a valid https URL.');
  }
  return { url, host, error: null };
}

/**
 * A webhook button's `body`: a JSON object of at most 10 top-level keys and
 * 1024 bytes as PHP's escaped json_encode measures it. An object whose keys
 * are exactly "0", "1", ... is a list to the server.
 */
export function pingActionBodyProblem(body: unknown): string | null {
  if (!isPlainObject(body) || isPhpList(body)) {
    return 'A webhook button body must be a JSON object.';
  }
  const keys = Object.keys(body);
  if (keys.length > MAX_PING_ACTION_BODY_KEYS) {
    return `A webhook button body takes at most ${MAX_PING_ACTION_BODY_KEYS} keys.`;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(body);
  } catch {
    return 'A webhook button body must be valid UTF-8 JSON.';
  }
  if (serverJsonByteLength(encoded) > MAX_PING_ACTION_BODY_BYTES) {
    return `A webhook button body must not exceed ${MAX_PING_ACTION_BODY_BYTES} bytes.`;
  }
  return null;
}

/**
 * Validate and clean a `data.actions` value as the server's
 * `PingActionRules::normalize()` does. `errors` maps a field
 * (`data.actions.1.label`) to its refusal and is empty only when every button
 * is valid.
 */
export function normalizePingActions(actions: unknown): { actions: NormalizedPingAction[]; errors: Record<string, string> } {
  if (!Array.isArray(actions)) {
    return { actions: [], errors: { 'data.actions': 'Buttons (data.actions) must be a list.' } };
  }
  if (actions.length === 0 || actions.length > MAX_PING_ACTIONS) {
    return { actions: [], errors: { 'data.actions': `A Ping takes 1 to ${MAX_PING_ACTIONS} buttons.` } };
  }

  const errors: Record<string, string> = {};
  const normalized: NormalizedPingAction[] = [];
  const seen = new Set<string>();

  actions.forEach((action: unknown, index: number) => {
    const field = `data.actions.${index}`;
    const before = Object.keys(errors).length;

    if (!isPlainObject(action) || (Object.keys(action).length > 0 && isPhpList(action))) {
      errors[field] = 'Each button must be an object.';
      return;
    }
    const unknown = Object.keys(action).filter((key) => !ACTION_KEYS.has(key));
    if (unknown.length > 0) {
      errors[field] = `Unknown button field: ${unknown.join(', ')}.`;
      return;
    }

    const id = action['id'] ?? `a${index + 1}`;
    if (typeof id !== 'string' || !PING_ACTION_ID_PATTERN.test(id)) {
      errors[`${field}.id`] = 'A button id is 1 to 24 characters: lowercase letters, digits, "-" and "_".';
    } else if (seen.has(id)) {
      errors[`${field}.id`] = 'Each button on a Ping needs its own id.';
    } else {
      seen.add(id);
    }

    let type = action['type'];
    if (typeof type !== 'string' || !(PING_ACTION_TYPES as readonly string[]).includes(type)) {
      errors[`${field}.type`] = 'A button type is open_url or webhook.';
      type = null;
    }

    const style = action['style'] ?? 'default';
    if (typeof style !== 'string' || !(PING_ACTION_STYLES as readonly string[]).includes(style)) {
      errors[`${field}.style`] = 'A button style is default, primary or danger.';
    }

    const label = cleanPingActionLabel(action['label']);
    if (label.error !== null) {
      errors[`${field}.label`] = label.error;
    }

    const url = pingActionUrlVerdict(action['url'], typeof type === 'string' ? type : 'open_url');
    if (url.error !== null) {
      errors[`${field}.url`] = url.error;
    }

    const body = action['body'] ?? null;
    if (body !== null) {
      const problem = type === 'webhook' ? pingActionBodyProblem(body) : 'Only a webhook button takes a body.';
      if (problem !== null) {
        errors[`${field}.body`] = problem;
      }
    }

    if (Object.keys(errors).length !== before) {
      return;
    }

    normalized.push({
      id: id as string,
      position: index,
      type: type as NormalizedPingAction['type'],
      label: label.label,
      style: style as NormalizedPingAction['style'],
      url: url.url,
      host: url.host,
      body: isPlainObject(body) && Object.keys(body).length > 0 ? body : null,
    });
  });

  return Object.keys(errors).length === 0 ? { actions: normalized, errors: {} } : { actions: [], errors };
}

/**
 * Refuse a `data` whose buttons the server would refuse, naming every field.
 * A no-op without `data.actions`.
 */
export function assertPingActionsData(data: unknown): void {
  if (!hasPingActions(data)) {
    return;
  }
  const { errors } = normalizePingActions(data.actions);
  const entries = Object.entries(errors);
  if (entries.length > 0) {
    throw new PingRoomError(
      `Invalid buttons: ${entries.map(([field, message]) => `${field}: ${message}`).join(' ')}`,
      { code: 'invalid_data' },
    );
  }
}

/**
 * Refuse `data.actions` on a route that never carries buttons (a Question, a
 * handoff, an approval, a live-progress stream, a replacement, a quick-action
 * press). The server answers 422 there; this says so before the request.
 */
export function refusePingActionsData(data: unknown, where: string): void {
  if (!isPlainObject(data) || data['actions'] === undefined || data['actions'] === null) {
    return;
  }
  throw new PingRoomError(`${where} cannot carry buttons. ${MESSAGE_PROHIBITED}`, { code: 'invalid_data' });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** PHP decodes an object keyed "0", "1", ... in order as a list. */
function isPhpList(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key, index) => key === String(index));
}
