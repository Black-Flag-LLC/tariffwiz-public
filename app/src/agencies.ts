/** Agencies whose public HTS flag lists are missing or stale: hint by product type (labelled as a hint, never as a flag).
 *  EPA pesticides (ACE program PST, flags EP5/EP6): CBP flagged ~750 codes in 2025 (CSMS #65868872) but never published
 *  the list, so headings where pesticides and pesticide devices are common get a "likely" hint (Zac 2026-10-29). */
export interface AgencyHint { agency: string; name: string; text: string; url: string }

/** Pesticides and pesticide devices: 3808 pesticides/disinfectants, 8421 filters and purifiers (antimicrobial water and air
 *  filters, UV/ozone purifiers) and their parts, 8543.70 UV/ozone generators and electronic pest repellers, 8539.49 UV lamps. */
export const PESTICIDE_HEADINGS = /^(3808|8421|854370|853949)/;

export function likelyAgencies(d: string): AgencyHint[] {
  const ch = Number(d.slice(0, 2));
  const out: AgencyHint[] = [];
  const fda = { agency: 'FDA', name: 'Food and Drug Administration', url: 'https://www.fda.gov/industry/import-program-food-and-drug-administration-fda' };
  if ((ch >= 1 && ch <= 24 && ch !== 6) || ch === 21) out.push({ ...fda, text: 'Food and drink need FDA prior notice (facility registration for the maker) and may be examined.' });
  else if (ch === 30) out.push({ ...fda, text: 'Drugs need FDA listing and approval.' });
  else if (ch === 33) out.push({ ...fda, text: 'Cosmetics are FDA-regulated (facility registration and product listing).' });
  else if (/^90(18|19|20|21|22)/.test(d)) out.push({ ...fda, text: 'Medical devices need FDA registration and listing.' });
  else if (/^(8516|8528|8539|8543|9013)/.test(d)) out.push({ ...fda, text: 'Electronics that emit radiation (microwaves, TVs, lasers) need FDA radiation-safety reporting.' });
  if (/^22(03|04|05|06|08)/.test(d) || ch === 24) out.push({ agency: 'TTB', name: 'Alcohol and Tobacco Tax and Trade Bureau', text: 'Importer permit, label approval (COLA) for alcohol; tobacco permits.', url: 'https://www.ttb.gov/importers' });
  if (/^(8703|8704|8711|8407|8408)/.test(d)) {
    out.push({ agency: 'EPA', name: 'Environmental Protection Agency', text: 'Vehicles and engines need EPA emissions conformity (EPA Form 3520-1 or 3520-21).', url: 'https://www.epa.gov/importing-vehicles-and-engines' });
    if (/^(8703|8704|8711)/.test(d)) out.push({ agency: 'NHTSA', name: 'National Highway Traffic Safety Administration', text: 'Vehicles need safety-standard conformity (HS-7 declaration).', url: 'https://www.nhtsa.gov/importing-vehicle' });
  }
  if (PESTICIDE_HEADINGS.test(d)) out.push({ agency: 'EPA-PST', name: 'Environmental Protection Agency (pesticides)',
    text: 'If it is a pesticide or a pesticide device (e.g. an antimicrobial water or air filter, a UV or ozone purifier, a pest repeller), file EPA pesticide data (ACE program PST, flag EP5/EP6: Notice of Arrival, EPA Form 3540-1); otherwise disclaim. EPA flags these codes in ACE but does not publish the list.',
    url: 'https://www.epa.gov/compliance/importing-and-exporting-pesticides-and-devices' });
  return out;
}
