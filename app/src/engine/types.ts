// Shapes of the static data (built by pipeline/) and of engine input/output.

export type RatePart =
  | { type: 'adv'; pct: number }
  | { type: 'spec'; usd: number; per: string; basis?: string };

export interface Rate {
  kind: 'free' | 'adv' | 'spec' | 'compound' | 'text' | 'additional' | 'nochange';
  parts: RatePart[];
  raw: string;
}

/** One HTS line from data/hts/chNN.json (pipeline/build_hts.py). */
export interface HtsLine {
  code: string;
  digits: string;
  chapter: string;
  indent: number;
  desc: string;
  path: string;
  units: string[];
  general: Rate | null;
  special: { program: string; rate: Rate | null }[];
  other: Rate | null;
  special_raw: string;
  ch99_refs: string[];
  footnotes: string[];
  rate_from: string | null;
}

export interface Rules {
  meta: { revision: string; checked: string };
  groups: { EU: string[]; column2: string[] };
  s301: {
    origin: string[];
    measures: { heading: string; pct: number; from: string | null; to: string | null; suspended: boolean;
      list: string; carve10: string[]; note: '20' | '31' }[];
    exclusions: { heading: string; from: string | null; to: string; subdivision: string;
      items: { codes: string[]; bare: boolean; text: string; line: number | null }[] }[];
  };
  n52: {
    from: string;
    inTransit: InTransit;
    countries: Record<string, {
      rule: 'additive' | 'all_in'; pct: number | null; heading: string | null; target: number | null;
      below: string | null; atOrAbove: string | null; usmcaExempt: boolean;
      exempt: { heading: string; list: string; text: string }[];
    }>;
  };
  n50: { heading: string; pct: number; origin: string[]; from: string; inTransit: InTransit;
    exempt: { heading: string; list: string }[] };
  n51: { origin: string[]; from: string; pct: number; allBlockedBy232Before?: string;
    measures: { heading: string; list: string; blockedBy232: boolean }[] };
  n30: { origin: string[]; measures: { heading: string; pct: number; list: string }[] };
  n41: { list: string; exempt: string[]; years: { from: string; in: number; over: number }[]; to: string };
  sg: { exempt: string[]; brackets: { heading: string; codes: string[]; min: number; max: number; unit: string; usd: number }[] };
  trq: { pointers: Record<string, { program: string; headings: string[] }[]>; lines: Record<string, string> };
  described: { id: string; heading: string; note: string; country: string | null; hts: string[]; question: string;
    autoYes: string[]; autoNo: string[] }[];
  nic: { heading: string; origin: string[]; schedule: { from: string; to: string | null; pct: number }[] };
  /** note 43 drones: start, the (c)(5) small-drone parts date, and CBP's hold on the UK/partner headings */
  n43?: { from: string; partsFrom: string; partnerHold: boolean };
  /** Section 232 polysilicon (PP 11052, note 42): ad valorem by origin + minimum import price per kg or watt */
  poly?: { from: string; deal: string[]; uk: string[]; adv: { general: string; deal: string; uk: string }; cite: string;
    groups: { id: string; label: string; codes: string[]; adValorem: boolean; mip: number; per: 'kg' | 'W'; heading: string; onshoring: boolean }[] };
  expired: string[];
  /** dated changes to `lists`: inside [from, to] a list is the Rev list minus `remove` (exact codes) plus `add` */
  listChanges?: { list: string; from: string | null; to: string | null; add: string[]; remove: string[]; source: string }[];
  /** goods excluded from importation (no duty can be paid), by origin and import date */
  bans?: { origin: string[]; from: string; codes: string[]; label: string; question: string | null; source: string }[];
  cotton: Record<string, number>;   // HTS10 digits -> Cotton Board assessment, cents per kg
  adcvd: { case: string; type: 'AD' | 'CVD'; country: string; product: string; hts: string[]; fr: string | null }[];
  programs: Record<string, { name: string; countries: string[]; in_force: boolean | 'uncertain'; to?: string;
    /** claim-only programs (Y, Z, N): free on any line except `excluded` prefixes; never printed in the Special column */
    anyLine?: boolean; mpfExempt?: boolean; excluded?: string[]; excludedWhy?: string; rule?: string; qiz?: string[] }>;
  lists: Record<string, string[]>;
}

export interface InTransit { loadedBefore: string; enteredBefore: string; modes: string[]; heading: string }

export type Mode = 'ocean' | 'air' | 'truck' | 'rail' | 'mail' | 'other';

/** Answers to follow-up questions. Unanswered questions use the question's default. */
export interface Answers {
  metalWeight15?: boolean;   // applicable metal ≥15% of article weight (232 metals, outside ch.72/73/74/76)
  ukMelt95?: boolean;        // ≥95% of the metal melted/poured (smelted/cast) in the UK
  usMelt85?: boolean;        // ≥85% of the metal melted/poured (smelted/cast) in the US
  usContent?: number;        // USD value of US content (USMCA vehicles / mobile equipment)
  ukQuota?: boolean;         // UK car entered within the UK vehicle quota
  chipQualifies?: boolean;   // semiconductor meets note 39's technical test
  polyDocs?: string;         // Proclamation 11052 MIP documentation: 'none' | 'resale_at_or_above' | 'pre_aug6_contract'
  polyOnshoring?: boolean;   // within a Commerce-approved polysilicon onshoring allotment (cl. (6)(c))
  polyThinFilm?: boolean;    // non-silicon thin-film cell/module (8541.4x.0080) with no polysilicon
  chipUse?: string;          // 'none' or the note 39(d) end-use heading 9903.79.03–.09
  pharmaType?: 'patented' | 'generic' | 'clinical' | 'other_pharma' | 'not_pharma';
  craneOldContract?: boolean; // STS crane under a sale contract dated before 2025-04-17, entered before 2027-04-18 (9903.91.16)
  japanLeather?: boolean;    // Japanese leather is dyed/colored/stamped/embossed, or footwear is not an excluded type (9903.41.05/.10)
  autoOffset?: number;       // USD of a manufacturer's import adjustment offset applied to this line (Procl. 10925 / 10984)
  infoMaterial?: boolean;    // informational materials (publications, films, recordings, artworks): note 50/52 exempt
  droneUse?: boolean;        // the article is a drone (UAS) or for use with one
  civilAircraft?: boolean;   // civil-aircraft treatment claimed
  pharmaApplication?: boolean; // for pharmaceutical applications (note 50/52 lists)
  vehiclePart?: boolean;     // a part for a passenger car or light truck (note 33(g) codes cover far more)
  truckPart?: boolean;       // a part for a medium/heavy truck or bus (note 38(i))
  oldVehicle?: boolean;      // vehicle made 25+ years before the year of entry
  droneThermal?: boolean;    // drone with thermal imaging
  mailGift?: boolean;        // mail: bona fide gift within the $100 ($200 from VI/GU/AS) daily limit
  inboundEms?: boolean;      // mail: an Inbound EMS item (the only formally entered mail that pays MPF)
  donation?: boolean;        // donated by a US person to relieve human suffering (9903.05.08 / 9903.05.91)
  pharmaCompany?: string;    // patented pharma company status: 'none' | 'listed' (.61) | 'onshoring' (.64) | 'onshoring_mfn' (.65) | 'specialty' (.66)
  s301Derived?: string;      // note 20(z)-(gg): the 301 heading of the subheading this line's rate is derived from, or 'none'
  qizMade?: boolean;         // made in a designated Qualifying Industrial Zone (program N, Jordan/Egypt)
  droneOver25kg?: boolean;   // a part is for a drone with maximum take-off weight over 25 kg (note 43(c)(2))
  droneExceptUse?: boolean;  // that large drone is for retail delivery, agriculture or sale to the Department of War
  s301Exclusion?: boolean;   // the product matches the Section 301 exclusion's description
  stsCrane?: boolean;        // ship-to-shore gantry crane
  banPackaged?: boolean;     // banned alcohol: packaged for direct consumption (only then is it banned)
  arrivedBeforeBan?: boolean; // goods imported before an import ban started (they can still be entered)
  chassis?: boolean;         // intermodal chassis
  kitchenCabinet?: boolean;  // wooden kitchen cabinet or bathroom vanity (or part)
  quartzInQuota?: boolean;   // quartz surface products entered within the safeguard quota
  meltCountry?: string;      // ISO2 where the steel was melted and poured (ACE requires it on 232 steel lines)
  smeltCountry?: string;     // ISO2 where the aluminum was smelted and cast (ACE requires it on 232 aluminum lines)
  adRate?: number;           // anti-dumping cash-deposit rate % for your exporter
  cvdRate?: number;          // countervailing cash-deposit rate % for your exporter
  certVehicleUse?: 'no' | 'car' | 'truck'; // part certified for US vehicle making/repair (9903.94.07 / 9903.74.09)
  anyMetal?: boolean;        // contains any steel, aluminum or copper (9903.82.01 when not)
  isMhdv?: boolean;          // a medium/heavy road vehicle (not a works truck or off-highway dumper)
  motorcycleUse?: boolean;   // part for making motorcycles in the US (9903.82.13)
  usmcaMetalAllocation?: boolean; // Canadian/Mexican steel or aluminum under a Commerce allocation (9903.82.18/.19)
  equipmentUse?: boolean;    // part used only to make farm/industrial equipment (9903.82.23–.26)
  chineseCraneLink?: boolean; // non-Chinese STS crane with Chinese key components or ownership (9903.91.14)
  ftaInQuota?: boolean;      // entered within the trade-agreement tariff-rate quota
  [component: `comp:${string}`]: number | undefined; // component values and counts for component-priced rates
  [item: `x:${string}`]: boolean | undefined;         // described-product exemption answers
}

export type Ch98Provision = '9801.00.10' | '9802.00.50' | '9802.00.80';
/** deduct: value of the repairs (9802.00.50: duty on the repairs only) or of the US components (9802.00.80: deducted) */
export interface Ch98Claim { provision: Ch98Provision; deduct?: number }

export interface Input {
  hts: string;               // 10-digit HTS, dotted or not
  origin: string;            // ISO 3166-1 alpha-2
  value: number;             // customs (transaction) value, USD
  entryDate: string;         // YYYY-MM-DD — date of entry for consumption
  loadingDate?: string;      // YYYY-MM-DD — date loaded on the vessel (in-transit relief)
  mode: Mode;
  quantity?: number;         // in the line's first unit of quantity
  quantity2?: number;        // second unit, for compound rates per second unit
  claim?: string | null;     // special program claimed (S = USMCA, KR, AU, JO, P = CAFTA-DR…)
  entryValue?: number;       // value that decides formal vs informal when duty is figured on part of it (Chapter 98)
  inEntry?: boolean;         // priced as one line of a multi-line entry (the entry decides formal/informal)
  ch98?: Ch98Claim | null;   // Chapter 98 claim: US goods returned, repairs abroad, US components assembled abroad
  answers?: Answers;
}

export type Family = 'base' | 'ch98' | 'quota' | 'russia' | 'japan_leather' | 's338' | 's301_china' | 's301_brazil' | 's301_forced_labor' | 's301_nicaragua' | 's232' | 's201' | 'adcvd' | 'fee' | 'tax';

export interface Line {
  family: Family;
  heading: string;           // Ch.99 heading, HTS10 for the base line, or fee code
  label: string;             // plain-English name
  rate: string;              // human rate text, e.g. "+25%", "15% all-in", "Free"
  amount: number;            // USD, rounded to cents
  basisValue?: number;       // value the rate applied to, when not the full value
  why: string;               // plain-English reason
  cite: string;              // legal source
  assumed?: string;          // the follow-up answer this line depends on, if defaulted
  interpretation?: string;   // set when the text is ambiguous and we picked the literal reading
}

export interface Question {
  id: keyof Answers | 'quantity' | 'quantity2' | 'claim';
  text: string;
  why: string;
  kind: 'yesno' | 'number' | 'choice' | 'text';
  options?: { value: string; label: string }[];
  defaultValue: string | number | boolean;
  money?: boolean;           // number answers in US dollars
}

export interface Result {
  ok: boolean;
  error?: string;
  line?: HtsLine;
  lines: Line[];             // CBP filing order: Ch.99 lines first, base line last
  fees: Line[];
  duty: number;
  feesTotal: number;
  total: number;
  effectivePct: number;
  questions: Question[];
  notes: string[];           // other charges and caveats
  adcvd: { case: string; type: 'AD' | 'CVD'; product: string; url: string | null; broad: boolean }[]; // orders that may apply (rates are per company)
  entryType: '01' | '03' | '11'; // 01 formal consumption, 03 AD/CVD consumption, 11 informal
  formalRequired?: string;   // a formal entry is required whatever the value (mail rules), with the reason
  mpfBase?: number;          // value the formal MPF is figured on when it isn't the line value (9802.00.80: dutiable part)
  defaults: { id: string; text: string; value: string | number | boolean }[]; // questions answered with defaults
  revision: string;
}
