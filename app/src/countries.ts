// ISO 3166-1 alpha-2 codes; names come from the browser (Intl.DisplayNames).
const CODES = ('AD AE AF AG AI AL AM AO AR AS AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI ' +
  'CK CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FK FM FO FR GA GB GD GE GH GI GL GM GN GQ GR GT ' +
  'GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA ' +
  'MC MD ME MG MH MK ML MM MN MO MR MS MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NZ OM PA PE PF PG PH PK PL PS PT PW PY ' +
  'QA RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UY UZ VA VC VE VG VN VU WS XK YE ZA ZM ZW').split(' ');

const names = new Intl.DisplayNames(['en'], { type: 'region' });
export const COUNTRIES = CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name));
export const countryName = (code: string) => names.of(code) ?? code;

/** Everyday names and non-ISO codes people type: "uk" -> GB, "korea" -> KR (South), "turkey" -> TR, "usa" -> US. */
export const ALIASES: Record<string, string> = {
  uk: 'GB', 'u.k.': 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  korea: 'KR', 'south korea': 'KR', 'republic of korea': 'KR', 'north korea': 'KP', turkey: 'TR', turkiye: 'TR',
  holland: 'NL', czech: 'CZ', 'czech republic': 'CZ', russia: 'RU',
  vietnam: 'VN', 'viet nam': 'VN', taiwan: 'TW', macau: 'MO', burma: 'MM', 'ivory coast': 'CI', uae: 'AE', emirates: 'AE',
  laos: 'LA', syria: 'SY', iran: 'IR', bolivia: 'BO', venezuela: 'VE', tanzania: 'TZ', moldova: 'MD',
  'hong kong': 'HK', 'united states': 'US', usa: 'US', 'mainland china': 'CN', prc: 'CN', 'people\'s republic of china': 'CN',
};
const ISO = new Set(COUNTRIES.map((c) => c.code));
const BY_NAME = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c.code]));
/** A valid ISO2 code for typed text, or '' (e.g. "UK" in a link -> "GB"). */
export function resolveCountry(t: string): string {
  const s = t.trim().toLowerCase();
  if (!s) return '';
  if (ALIASES[s]) return ALIASES[s];
  const up = s.toUpperCase();
  return ISO.has(up) ? up : BY_NAME.get(s) ?? ''; // full English names too ("China", "Germany")
}
