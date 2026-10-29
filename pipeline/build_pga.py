"""Rebuild .claude/skills/us-import-duty/references/pga_flags.json (HTS -> CBP ACE PGA tariff flags).

Stdlib only (+ pdftotext on PATH). Run from the repo root:
    python -I pipeline/build_pga.py [--raw data/raw/pga] [--out FILE] [--asof YYYY-MM-DD]

Inputs are the public files saved under data/raw/pga/ (see data/raw/fetch.log for URL + date of each).
They are untrusted data: this script only reads them (zipfile/xml for .xlsx, csv, pdftotext for .pdf,
regex for saved CSMS .html pages) and never executes anything from them.

What it does
1. Flag dictionary: the CBP "ACE Agency Tariff Code Reference" (March 4, 2026) defines every flag code.
   pdftotext scrambles its table columns, so the definitions are written out below (FLAGS) and the
   script only checks that every code still appears in the PDF text.
2. Per-agency HTS lists (base lists, newest official version found):
   APHIS core AQ1/AQ2/AQX  aphis/aphis_ace-hts-datatable_*.csv          (APHIS, Feb 2026)
   APHIS Lacey Act         aphis/aphis_lacey-act-implementation-schedule.csv (APHIS, Mar 2025) -> AL1/AL2
   CPSC CP1/CP2            cpsc/CPSCGuidanceHTSList...xlsx                (CPSC, Oct 2026)
   NMFS NM8 (SIMP), 370, AMLR, HMS   nmfs/all-*.xlsx (combined list)        (NOAA Fisheries, Oct 2026)
   EPA EH1/EH2 (HFC)       epa/ACE_Tips_for_Filing_EPA_HFCs_03_APR_2025.pdf (CBP, Apr 2025)
   AMS AM1/AM2/AM4/AM6     ams/ams_catair_guidelines_2025-07-01.pdf       (CBP/AMS, Jul 2025)
   AMS AM8 (organic)       ams/csms_am7_to_am8_codes_2026.csv             (CSMS 67645994 + 69068766)
   TTB TB3                 ttb/ttb_trade_filing_instructions_8.0_2022-11.pdf Note 3
   OMC OM1/OM2             omc/OMC_ImplementationGuidance_v2.5_Aug2023.pdf
   stale lists (kept, marked): NHTSA DT1/DT2 (2016/2017), EPA TSCA composite wood (2019), EPA ODS EP1 (2018)
   proxy list: DEA DE1/DE3 from CBP's Master DEA Drug Code HTS reference (export-oriented)
3. CSMS deltas (DELTAS below): explicit HTS-level flag changes announced in CBP Harmonized System Update
   (HSU) and other CSMS messages, applied in date order after the base lists (skipped when older than the
   agency's base list). Each delta's HTS numbers are checked against the saved CSMS page.
4. Normalisation against the current HTS (data/raw/usitc/current/chNN.json):
   - 4/6-digit list entries are expanded to every current 10-digit code (kept also in "prefixes");
   - 8-digit entries are kept as 8-digit keys AND expanded to their current 10-digit codes;
   - a 10-digit code no longer in the HTS is carried to the current 10-digit codes of its 8-digit
     subheading ("successor"); if the 8-digit subheading is gone too, it is dropped and reported.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import glob
import html
import io
import json
import os
import re
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_RAW = os.path.join(ROOT, "data", "raw", "pga")
DEFAULT_HTS = os.path.join(ROOT, "data", "raw", "usitc", "current")
DEFAULT_OUT = os.path.join(ROOT, ".claude", "skills", "us-import-duty", "references", "pga_flags.json")

U = {  # guidance URLs (official pages)
    "cbp_codes": "https://www.cbp.gov/sites/default/files/2026-03/ace_agency_tariff_codes_04march2026_0.pdf",
    "catair": "https://www.cbp.gov/trade/automated/catair",
    "fda": "https://www.fda.gov/industry/import-basics/harmonized-tariff-schedule-and-fd-flags",
    "aphis_core": "https://www.aphis.usda.gov/ace/harmonized-tariff-code-master-correlation-table-aphis-core-message-set",
    "lacey": "https://www.aphis.usda.gov/plant-imports/file-lacey-act-declaration/requirements",
    "cpsc": "https://www.cpsc.gov/eFiling",
    "nmfs": "https://www.fisheries.noaa.gov/resource/outreach-materials/harmonized-tariff-codes-seafood-trade-monitoring-programs",
    "epa_hfc": "https://www.cbp.gov/document/fact-sheets/ace-tips-filing-epa-hfcs",
    "epa_guide": "https://www.cbp.gov/sites/default/files/2025-04/ACE%20CATAIR%20EPA%20Supplemental%20Guidelines%20v18%2004-03-25_508.pdf",
    "epa_ods": "https://www.cbp.gov/sites/default/files/assets/documents/2018-Jun/Tips%20for%20Trade%20when%20filing%20EPA%206-18-2018%20ODS_v2%20508.pdf",
    "epa_tsca": "https://www.epa.gov/sites/default/files/2019-03/documents/final_hts_codes.pdf",
    "ams": "https://www.cbp.gov/sites/default/files/2025-07/AMS%20CATAIR%20Guidelines%207.1.25%20%28508%29_0.pdf",
    "ttb": "https://www.cbp.gov/sites/default/files/assets/documents/2022-Nov/2022%20-%20TTB%20Trade%20Filing%20Instructions_8.0_508c.pdf",
    "nhtsa": "https://www.cbp.gov/sites/default/files/assets/documents/2018-Jan/ACE%20NHTSA%20PGA%20Message%20Set%20IG%20October302017_0.pdf",
    "fws": "https://www.cbp.gov/sites/default/files/assets/documents/2020-Mar/FWS%20ITDS%20Implementation%20Guide%203.30.20.pdf",
    "dea": "https://www.cbp.gov/sites/default/files/2026-04/Implementation_Guide_for_DEA_v2_7-04.01.2026_508.pdf",
    "dea_ref": "https://www.cbp.gov/sites/default/files/2026-03/new_master_dea_drug_code-hts-schedule_b_reference_table_032026_version_1_2.xlsx",
    "omc": "https://www.cbp.gov/sites/default/files/assets/documents/2023-Aug/OMC_ImplementationGuidance%20-%20v2.5_508c_0.pdf",
}

AG = {
    "FDA": "Food and Drug Administration",
    "APHIS": "USDA Animal and Plant Health Inspection Service",
    "FSIS": "USDA Food Safety and Inspection Service",
    "AMS": "USDA Agricultural Marketing Service",
    "EPA": "Environmental Protection Agency",
    "CPSC": "Consumer Product Safety Commission",
    "NHTSA": "National Highway Traffic Safety Administration",
    "TTB": "Alcohol and Tobacco Tax and Trade Bureau",
    "FWS": "U.S. Fish and Wildlife Service",
    "NMFS": "NOAA National Marine Fisheries Service",
    "OMC": "State Dept. Office of Marine Conservation",
    "DEA": "Drug Enforcement Administration",
}

# code: (agency, program, level, disclaim, meaning, url)
# level: "required" = CBP "R" (data must be filed; no disclaim), "may" = CBP "M" (file if regulated, else
# disclaim), "unknown" = pseudo-flag for lists that name the program but not whether M or R.
FLAGS = {
    "FD1": ("FDA", "801(a) BIO/COS/DEV/DRU/FOO/RAD/TOB/VME", "may", "any",
            "FDA may regulate it: file FDA data if FDA-regulated, otherwise disclaim", "fda"),
    "FD2": ("FDA", "801(a) BIO/COS/DEV/DRU/FOO/RAD/TOB/VME", "required", "none",
            "FDA-regulated (not food): FDA entry data must be filed", "fda"),
    "FD3": ("FDA", "801(m) Prior Notice", "may", "any",
            "May be food: if food, file FDA Prior Notice + entry data; if not, disclaim", "fda"),
    "FD4": ("FDA", "801(m) Prior Notice", "required", "none",
            "Food: FDA Prior Notice and entry data must be filed", "fda"),
    "AQ1": ("APHIS", "Core (AAC/APQ/AVS/ABS)", "may", "any",
            "APHIS data needed if a permit/certificate is required for the item; else disclaim", "aphis_core"),
    "AQ2": ("APHIS", "Core (AAC/APQ/AVS/ABS)", "required", "none",
            "APHIS plant/animal health data must be filed", "aphis_core"),
    "AQX": ("APHIS", "Core (AAC/APQ/AVS/ABS)", "may", "not needed",
            "APHIS data may be required; no disclaim needed if not", "aphis_core"),
    "AL1": ("APHIS", "Lacey Act (APL)", "may", "any",
            "Lacey Act plant declaration may be required (plant content)", "lacey"),
    "AL2": ("APHIS", "Lacey Act (APL)", "required", "none",
            "Lacey Act plant declaration (PPQ 505 data) is required", "lacey"),
    "AL1/AL2": ("APHIS", "Lacey Act (APL)", "unknown", "?",
                "On APHIS Lacey Act schedule: plant declaration required for plant content (de minimis/exempt aside)", "lacey"),
    "FS3": ("FSIS", "FSI (all FSIS programs)", "may", "any",
            "May be meat, poultry or egg product: FSIS data if so, else disclaim", "catair"),
    "FS4": ("FSIS", "FSI (all FSIS programs)", "required", "none",
            "Meat, poultry or egg product: FSIS inspection data must be filed", "catair"),
    "AM1": ("AMS", "EG egg products", "may", "any",
            "AMS egg-products data may be required (e.g. inedible egg products)", "ams"),
    "AM2": ("AMS", "EG shell eggs", "required", "none",
            "Shell eggs: AMS data must be filed", "ams"),
    "AM3": ("AMS", "MO marketing orders", "may", "any",
            "AMS marketing-order (8e quality) data may be required", "ams"),
    "AM4": ("AMS", "MO marketing orders", "required", "exemption message sets only",
            "Marketing-order produce: AMS quality inspection data required (seasonal/min-qty exemptions)", "ams"),
    "AM6": ("AMS", "PN peanuts", "required", "none",
            "Peanuts: AMS peanut quality data must be filed", "ams"),
    "AM7": ("AMS", "OR organic", "may", "any",
            "If sold as organic: NOP Import Certificate data may be required", "ams"),
    "AM8": ("AMS", "OR organic", "required", "none",
            "Certified-organic product: NOP Import Certificate data must be filed", "ams"),
    "TB1": ("TTB", "BER/WIN/DSP/TOB", "may", "any",
            "Alcohol or tobacco: TTB data may be required", "ttb"),
    "TB2": ("TTB", "BER/WIN/DSP/TOB", "required", "none",
            "Alcohol or tobacco: TTB data must be filed", "ttb"),
    "TB3": ("TTB", "BER/WIN/DSP/TOB", "may", "A or C only",
            "TTB data may be required; can only be disclaimed with code A or C", "ttb"),
    "EP1": ("EPA", "ODS ozone-depleting substances", "may", "any",
            "May be an ozone-depleting substance: EPA ODS data if so, else disclaim", "epa_guide"),
    "EP2": ("EPA", "ODS ozone-depleting substances", "required", "none",
            "Ozone-depleting substance: EPA ODS data must be filed", "epa_guide"),
    "EP3": ("EPA", "VNE vehicles and engines", "may", "any",
            "May be an engine/vehicle under EPA emission rules: EPA data if so, else disclaim", "epa_guide"),
    "EP4": ("EPA", "VNE vehicles and engines", "required", "none",
            "Vehicle or engine: EPA emissions data must be filed", "epa_guide"),
    "EP5": ("EPA", "PS1/PS2/PS3 pesticides", "may", "any",
            "May be a pesticide or device: EPA pesticide data (NOA) if so, else disclaim", "epa_guide"),
    "EP6": ("EPA", "PS1/PS2/PS3 pesticides", "required", "none",
            "Pesticide: EPA pesticide data must be filed", "epa_guide"),
    "EP7": ("EPA", "TS1 TSCA", "may", "any",
            "TSCA chemical/article (e.g. composite wood): TSCA certification data may be required", "epa_guide"),
    "EP8": ("EPA", "TS1 TSCA", "required", "none",
            "TSCA certification data must be filed", "epa_guide"),
    "EP7/EP8": ("EPA", "TS1 TSCA (composite wood, Title VI)", "unknown", "?",
                "Composite wood: TSCA Title VI import certification may be required (EPA 2019 list)", "epa_tsca"),
    "EH1": ("EPA", "HFC hydrofluorocarbons", "may", "A only",
            "May be a bulk HFC: EPA HFC data if so; only disclaim code A allowed", "epa_hfc"),
    "EH2": ("EPA", "HFC hydrofluorocarbons", "required", "none",
            "Regulated bulk HFC: EPA HFC data (allowance) must be filed", "epa_hfc"),
    "CP1": ("CPSC", "CPS eFiling", "may", "any",
            "CPSC certificate data may be needed if product is under a CPSC rule; else may disclaim", "cpsc"),
    "CP2": ("CPSC", "CPS eFiling", "required", "none",
            "CPSC certificate of compliance data must be eFiled", "cpsc"),
    "DT1": ("NHTSA", "MVS/REI/TPE/OEI/OFF", "may", "A only",
            "May be motor vehicle equipment: NHTSA HS-7 data, or disclaim A if not", "nhtsa"),
    "DT2": ("NHTSA", "MVS/REI/TPE/OEI/OFF", "required", "none",
            "Motor vehicle or regulated equipment: NHTSA HS-7 data must be filed", "nhtsa"),
    "FW1": ("FWS", "FWS wildlife", "may", "C, D or E",
            "May contain wildlife: FWS declaration (3-177) if so, else disclaim", "fws"),
    "FW2": ("FWS", "FWS wildlife", "required", "none",
            "Wildlife product: FWS declaration and clearance data required", "fws"),
    "FW3": ("FWS", "FWS wildlife", "may", "C or D",
            "Wildlife needing FWS clearance; filed in ACE or eDecs (disclaim C/D says where)", "fws"),
    "NM1": ("NMFS", "370 tuna (TTVP)", "may", "any",
            "May contain tuna: NOAA Form 370 data if it does, else disclaim", "nmfs"),
    "NM2": ("NMFS", "370 tuna (TTVP)", "required", "none",
            "Tuna: NOAA Form 370 / tuna tracking data must be filed", "nmfs"),
    "NM1/NM2": ("NMFS", "370 tuna (TTVP)", "unknown", "?",
                "Tuna Tracking (Form 370) program code: NOAA data may or must be filed", "nmfs"),
    "NM3": ("NMFS", "AMR Antarctic marine living resources", "may", "any",
            "May be Antarctic species (toothfish etc.): AMLR data if so", "nmfs"),
    "NM4": ("NMFS", "AMR Antarctic marine living resources", "required", "none",
            "Antarctic marine living resources: AMLR permit/catch data required", "nmfs"),
    "NM3/NM4": ("NMFS", "AMR Antarctic marine living resources", "unknown", "?",
                "Antarctic Marine Living Resources program code: NOAA AMLR data may or must be filed", "nmfs"),
    "NM5": ("NMFS", "HMS highly migratory species", "may", "any",
            "May be swordfish/bluefin tuna etc.: HMS data if so", "nmfs"),
    "NM6": ("NMFS", "HMS highly migratory species", "required", "none",
            "Highly migratory species: HMS permit/document data required", "nmfs"),
    "NM5/NM6": ("NMFS", "HMS highly migratory species", "unknown", "?",
                "Highly Migratory Species program code: NOAA HMS data may or must be filed", "nmfs"),
    "NM8": ("NMFS", "SIM Seafood Import Monitoring", "required", "none",
            "SIMP species: NOAA harvest/landing data and IFTP number must be filed", "nmfs"),
    "OM1": ("OMC", "OMC shrimp/turtle (DS-2031)", "may", "any",
            "Shrimp: State Dept DS-2031 data may be required", "omc"),
    "OM2": ("OMC", "OMC shrimp/turtle (DS-2031)", "required", "none",
            "Shrimp: State Dept DS-2031 data is required", "omc"),
    "OM1/OM2": ("OMC", "OMC shrimp/turtle (DS-2031)", "unknown", "?",
                "Shrimp: State Dept DS-2031 (turtle-safe harvest) declaration program", "omc"),
    "DE1": ("DEA", "DEA controlled substances/listed chemicals", "may", "any",
            "May be a DEA controlled substance or listed chemical: DEA data if so", "dea"),
    "DE3": ("DEA", "MAC regulated machines", "may", "any",
            "May be a tableting/encapsulating machine: DEA regulated-machine data if so", "dea"),
}

# Basis of each flag's HTS assignments in this file.
BASIS = {}  # filled by loaders: code -> set of basis strings

# Explicit HTS-level changes in CSMS messages (date, CSMS#, agency, from, to, [hts]).
# to=None means flag removed. HTS as printed by CBP (dots removed by the script).
DELTAS = [
    ("2022-12-29", "54535154", "FDA", None, "FD1", ["8807.90.3000", "8517.62.0090"]),             # HSU 2230
    ("2024-12-30", "63561519", "FDA", None, "FD1", ["8518.30.2000"]),                             # HSU 2420
    ("2025-02-28", "64273375", "FDA", "FD1", "FD2", ["2404.12.0500", "2404.12.1000", "2404.12.9000"]),  # HSU 2507 (CBP printed '2404.12.900')
    ("2025-04-04", "64683429", "FDA", None, "FD1", ["8507.60.0020"]),                             # HSU 2513
    ("2025-04-18", "64812375", "FDA", None, "FD3", ["2702.10.0000"]),                             # HSU 2516
    ("2025-05-13", "65047297", "FDA", "FD3", "FD1", ["0301.11.0090", "0511.91.0010"]),            # HSU 2518/2519
    ("2025-05-31", "65223125", "FDA", "FD2", None, ["0106.32.0000"]),                             # HSU 2520
    ("2025-12-04", "67032615", "FDA", "FD2", "FD1", ["2941.10.2000"]),                            # HSU 2542
    ("2026-04-05", "68290408", "FDA", "FD3", "FD2", ["3001.90.0150"]),                            # HSU 2607
    ("2026-07-21", "69324417", "FDA", "FD2", "FD1", ["2941.50.0000"]),                            # HSU 2616
    ("2026-08-01", "69440938", "FDA", "FD4", "FD3", ["2103.20.4020", "2103.90.9091"]),            # HSU 2619
    ("2026-08-01", "69440938", "FDA", "FD2", "FD1", ["8419.40.0010", "8419.40.0090"]),
    ("2026-08-01", "69440938", "FDA", "FD1", "FD2", ["2941.90.5030"]),
    ("2025-07-25", "65741173", "APHIS", "AQ1", None, ["2827.39.9010", "2827.39.9050"]),
    ("2026-07-23", "69247555", "FWS", "FW2", "FW1", [
        "0307420020", "0307420040", "0307420060", "0307430010", "0307430022", "0307430024",
        "0307430029", "0307430050", "0307430060", "0307490122", "0307490124", "0307490129",
        "0307490150", "0307490160", "0307510000", "0307520000", "0307590100", "1605546010",
        "1605546020", "1605546030"]),
    ("2026-08-22", "69726413", "FSIS", None, "FS3", ["2106909990", "2106909993", "2106909994"]),  # HSU 2621
    ("2026-08-22", "69726413", "FSIS", "FS4", "FS3", ["0407210030", "0408110000", "0408190000",
                                                       "0408910000", "0408990000"]),
    ("2026-09-29", "70220191", "CPSC", "CP2", "CP1", [
        "2404120510", "2404120590", "2404121010", "2404121090", "3604109010", "8506100010",
        "8506401010", "8506500010", "8506600010", "8506800010", "9613200000", "9404210095",
        "9404291095", "9404299095"]),                                                             # HSU 2625
    ("2026-09-29", "70220191", "CPSC", "CP2", None, ["9613802010"]),
    ("2026-10-14", "70197855", "NMFS", "NM8", None, ["0301.19.0000"]),  # HSU 2626 (CBP printed "0301.19.000")
]
# CBP printed some codes with a digit missing; fix-ups (printed -> intended), checked in the HTS.
DELTA_FIX = {"2404129000": "240412900", "0301190000": "030119000"}

LOG = []


def log(msg):
    LOG.append(msg)
    print(msg, file=sys.stderr)


def digits(s):
    return re.sub(r"\D", "", s or "")


def pdftext(path, raw=False):
    args = ["pdftotext", "-raw" if raw else "-layout", path, "-"]
    out = subprocess.run(args, capture_output=True, check=True).stdout
    return out.decode("utf-8", "replace")


def html_text(path):
    t = open(path, encoding="utf-8", errors="replace").read()
    t = re.sub(r"(?is)<(script|style).*?</\1>", " ", t)
    t = re.sub(r"<[^>]+>", " ", t)
    return html.unescape(t)


NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def read_xlsx(path):
    """{sheet name: [ {col letter: text} ]} using zipfile + ElementTree only."""
    z = zipfile.ZipFile(path)
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            ss.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rmap = {r.get("Id"): r.get("Target") for r in rels}
    out = {}
    for s in wb.find("m:sheets", NS):
        t = rmap[s.get("{%s}id" % NS["r"])].lstrip("/")
        t = t if t.startswith("xl/") else "xl/" + t
        rows = []
        for row in ET.fromstring(z.read(t)).iter("{%s}row" % NS["m"]):
            r = {}
            for c in row.findall("m:c", NS):
                col = re.match(r"[A-Z]+", c.get("r")).group()
                v = c.find("m:v", NS)
                ty = c.get("t")
                if ty == "s" and v is not None:
                    val = ss[int(v.text)]
                elif ty == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
                else:
                    val = v.text if v is not None else ""
                r[col] = (val or "").strip()
            rows.append(r)
        out[s.get("name")] = rows
    return out


def one(raw, pattern):
    hits = sorted(glob.glob(os.path.join(raw, pattern)))
    if not hits:
        raise SystemExit(f"missing input: {pattern} under {raw}")
    return hits[-1]


# ---------------------------------------------------------------- current HTS
def load_hts(hts_dir):
    codes = set()
    desc = {}
    for p in sorted(glob.glob(os.path.join(hts_dir, "ch*.json"))):
        for r in json.load(open(p, encoding="utf-8")):
            d = digits(r.get("htsno"))
            if len(d) in (8, 10):
                codes.add(d)
                desc[d] = r.get("description", "")
    ten = {c for c in codes if len(c) == 10}
    eight = {c for c in codes if len(c) == 8}
    # 8-digit lines without statistical suffixes act as leaves
    has_child = {c[:8] for c in ten}
    leaves8 = {c for c in eight if c not in has_child}
    return ten, eight, leaves8


class Book:
    """Collects (hts key -> {flag}) with source tags and normalises against the HTS."""

    def __init__(self, ten, eight, leaves8):
        self.ten, self.eight, self.leaves8 = ten, eight, leaves8
        self.hts = {}          # key -> set(flags)
        self.prefixes = {}     # short code -> set(flags)
        self.stats = {}        # flag -> counters
        self.dropped = {}      # flag -> [codes]
        self.successor = {}    # flag -> {old: [new]}
        self.not_enforced = {}  # agency -> set(hts) listed by the agency as flagged but not enforced

    def _st(self, flag):
        return self.stats.setdefault(flag, {"listed": 0, "expanded_from_prefix": 0, "successor": 0, "dropped": 0})

    def _put(self, key, flag):
        self.hts.setdefault(key, set()).add(flag)

    def under(self, prefix):
        return sorted([c for c in self.ten if c.startswith(prefix)] +
                      [c for c in self.leaves8 if c.startswith(prefix)])

    def add(self, code, flag, basis):
        BASIS.setdefault(flag, set()).add(basis)
        c = digits(code)
        st = self._st(flag)
        st["listed"] += 1
        if len(c) == 9:  # leading zero dropped by the source
            c = "0" + c
        if len(c) == 10:
            if c in self.ten:
                self._put(c, flag)
                return [c]
            if c[:8] in self.leaves8:
                self._put(c[:8], flag)
                return [c[:8]]
            kids = [k for k in self.ten if k.startswith(c[:8])]
            if kids:
                for k in kids:
                    self._put(k, flag)
                st["successor"] += 1
                self.successor.setdefault(flag, {})[c] = sorted(kids)
                return kids
            st["dropped"] += 1
            self.dropped.setdefault(flag, []).append(c)
            return []
        if len(c) == 8:
            kids = self.under(c)
            if not kids:
                st["dropped"] += 1
                self.dropped.setdefault(flag, []).append(c)
                return []
            self._put(c, flag)  # keep 8-digit key as listed
            for k in kids:
                self._put(k, flag)
            st["expanded_from_prefix"] += len([k for k in kids if k != c])
            return kids
        if len(c) in (4, 6):
            kids = self.under(c)
            if not kids:
                st["dropped"] += 1
                self.dropped.setdefault(flag, []).append(c)
                return []
            self.prefixes.setdefault(c, set()).add(flag)
            for k in kids:
                self._put(k, flag)
            st["expanded_from_prefix"] += len(kids)
            return kids
        log(f"WARN {flag}: unusable code {code!r}")
        return []

    def remove(self, code, flag):
        c = digits(code)
        hit = False
        for k in [c] + ([c[:8]] if len(c) == 10 else []):
            if flag in self.hts.get(k, ()):
                self.hts[k].discard(flag)
                hit = True
        return hit


# ---------------------------------------------------------------- loaders
def load_flag_reference(raw, src):
    p = one(raw, "ace_agency_tariff_codes_*.pdf")
    txt = pdftext(p)
    for code in FLAGS:
        for part in code.split("/"):
            if not re.search(r"\b%s\b" % part, txt):
                log(f"WARN flag {part} not found in {os.path.basename(p)}")
    m = re.search(r"(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}", txt)
    src["CBP"] = {"what": "ACE Agency Tariff Code Reference (flag definitions)", "file": os.path.relpath(p, ROOT),
                  "url": U["cbp_codes"], "version": m.group(0) if m else "?", "fetched": "2026-10-28"}


def load_aphis(raw, book, src):
    p = one(raw, "aphis/aphis_ace-hts-datatable_*.csv")
    rows = list(csv.DictReader(open(p, encoding="utf-8-sig", newline="")))
    per = {}
    for r in rows:
        f = (r.get("APHIS Flag") or "").strip().upper()
        if f == "FLAG NOT ENFORCED":
            book.not_enforced.setdefault("APHIS", set()).add(digits(r["10 digit HTS"]))
            continue
        if f not in ("AQ1", "AQ2", "AQX"):
            continue
        per.setdefault(digits(r["10 digit HTS"]), set()).add(f)
    for c, fs in per.items():
        if len(fs) > 1:  # e.g. 4206.00.13.00 listed both AQ1 and AQ2: keep the stronger
            log(f"APHIS {c}: multiple flags {sorted(fs)} -> keep AQ2" if "AQ2" in fs else f"APHIS {c}: {sorted(fs)}")
            fs = {"AQ2"} if "AQ2" in fs else fs
        for f in fs:
            book.add(c, f, "official-list")
    date = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(p))
    src["APHIS"] = {"what": "APHIS HTS Master Correlation Table for APHIS Core Message Set (ace-hts-datatable.csv)",
                    "file": os.path.relpath(p, ROOT), "url": "https://www.aphis.usda.gov/sites/default/files/ace-hts-datatable.csv",
                    "page": U["aphis_core"], "version": "Last-Modified " + (date.group(1) if date else "?"), "fetched": "2026-10-28",
                    "rows": len(rows),
                    "note": "rows marked 'flag not enforced' (mostly live animals, ch. 1/98) are not in 'hts'; "
                            "they are listed under 'notEnforced' - APHIS still regulates them outside ACE flagging"}
    return date.group(1) if date else "2026-02-10"


def load_lacey(raw, book, src):
    p = one(raw, "aphis/aphis_lacey-act-implementation-schedule.csv")
    data = open(p, "rb").read().decode("cp1252", "replace")
    n = 0
    for r in csv.DictReader(io.StringIO(data)):
        c = digits(r.get("Heading"))
        if c:
            book.add(c, "AL1/AL2", "official-list")
            n += 1
    src["APHIS_Lacey"] = {"what": "APHIS Lacey Act declaration implementation schedule (HTS chapters/headings/articles)",
                          "file": os.path.relpath(p, ROOT),
                          "url": "https://www.aphis.usda.gov/sites/default/files/lacey-act-implementation-schedule.csv",
                          "page": U["lacey"], "version": "Last-Modified 2025-03-26 (Phase VII, eff. 2024-12-01)",
                          "fetched": "2026-10-28", "entries": n,
                          "note": "codes at 4/6/8/10 digits; ACE flags these for Lacey (AL1/AL2) but the list does not say which"}


def load_cpsc(raw, book, src):
    p = one(raw, "cpsc/CPSCGuidanceHTSList*.xlsx")
    wb = read_xlsx(p)
    n = {}
    for sheet in ("CP1", "CP2"):
        for r in wb.get(sheet, [])[1:]:
            f, c = r.get("A", "").upper(), digits(r.get("C"))
            if f == sheet and len(c) >= 8:
                book.add(c, f, "official-list")
                n[f] = n.get(f, 0) + 1
    title = (wb.get("Summary") or [{}])[0].get("A", "")
    m = re.search(r"(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{4}", title)
    src["CPSC"] = {"what": "CPSC Guidance and HTS List for eFiling of Certificates (sheets CP1, CP2)",
                   "file": os.path.relpath(p, ROOT),
                   "url": "https://www.cpsc.gov/s3fs-public/" + os.path.basename(p), "page": U["cpsc"],
                   "version": m.group(0).title() if m else "?", "fetched": "2026-10-28", "rows": n}
    return "2026-09-30"


NMFS_LIST_D = {"0511910090", "1604201000", "1604201500", "1604202000", "1604202500", "1604203000"}


def load_nmfs(raw, book, src):
    # The combined list ("all-<mon>-<year>.xlsx") carries every program per code; the per-program files
    # (simp/ttvp/amlr/hms) are the same codes split up and are kept only for reference.
    files = {"all": "nmfs/all-*.xlsx"}
    prog_flag = {"SIMP": "NM8", "TTVP": "NM1/NM2", "AMLR": "NM3/NM4", "HMS": "NM5/NM6"}
    counts, vers = {}, {}
    for key, pat in files.items():
        p = one(raw, pat)
        rows = list(read_xlsx(p).values())[0]
        m = re.search(r"Updated\s+(\w+\s+\d{4})", rows[0].get("A", "")) if rows else None
        vers[key] = (os.path.relpath(p, ROOT), m.group(1) if m else "?")
        for r in rows[2:]:
            c = digits(r.get("B"))
            progs = [x.strip().upper() for x in re.split(r"[,/]", r.get("E", "")) if x.strip()]
            if len(c) < 8:
                continue
            for pr in progs:
                f = prog_flag.get(pr)
                if not f:
                    continue
                if f == "NM1/NM2" and c in NMFS_LIST_D:
                    f = "NM1"
                book.add(c, f, "official-list")
                counts[f] = counts.get(f, 0) + 1
    src["NMFS"] = {"what": "NOAA Fisheries HTS codes for seafood trade monitoring programs (SIMP, TTVP/370, AMLR, HMS)",
                   "page": U["nmfs"], "files": {k: {"file": v[0], "updated": v[1]} for k, v in vers.items()},
                   "fetched": "2026-10-28", "rows": counts,
                   "note": "CBP flags these codes (CSMS 68916845). Lists name the program, not M vs R, so TTVP/AMLR/HMS "
                           "use pseudo-flags NM1/NM2, NM3/NM4, NM5/NM6; TTVP list D (CBP NMFS IG Jan 2024) = NM1."}
    return "2026-10-01"


def load_epa_hfc(raw, book, src):
    p = one(raw, "epa/ACE_Tips_for_Filing_EPA_HFCs_03_APR_2025.pdf")
    lines = pdftext(p, raw=True).splitlines()
    cur, got = None, {}
    for ln in lines[:260]:
        m = re.match(r"^(\d{4}\.\d{2}(?:\.\d{2,4})?(?:\.\d{2})?)\s", ln)
        if m:
            cur = digits(m.group(1))
        f = re.search(r"\b(EH[12])\s*$", ln.strip())
        if f and cur and cur not in got:
            got[cur] = f.group(1)
            cur = None
    for c, f in got.items():
        book.add(c, f, "official-list")
    src["EPA_HFC"] = {"what": "CBP 'ACE Tips for Filing EPA HFCs' (HTS table with EH1/EH2)", "file": os.path.relpath(p, ROOT),
                      "url": "https://www.cbp.gov/sites/default/files/2025-04/ACE%20Tips%20for%20Filing%20EPA%20HFCs_03_APR_2025_508_0.pdf",
                      "page": U["epa_hfc"], "version": "2025-04-03", "fetched": "2026-10-28",
                      "rows": {f: sum(1 for v in got.values() if v == f) for f in ("EH1", "EH2")},
                      "note": "EPA's own April 2025 deck shows 3827.51 as EH1 in its table but EH2 in an example; CBP's EH1 used"}


def load_epa_stale(raw, book, src):
    p = one(raw, "epa/final_hts_codes_tsca_title6_*.pdf")
    n = 0
    for ln in pdftext(p).splitlines():
        m = re.match(r"^\s*(\d{10})\s", ln)
        if m:
            book.add(m.group(1), "EP7/EP8", "official-list-stale")
            n += 1
    src["EPA_TSCA"] = {"what": "EPA HTS codes that may require TSCA Sec. 13 import certification (composite wood, Title VI)",
                       "file": os.path.relpath(p, ROOT), "url": U["epa_tsca"], "version": "March 2019 (EPA: 'no plans to keep this list current')",
                       "fetched": "2026-10-28", "rows": n}
    p = one(raw, "epa/Tips_EPA_ODS_*.pdf")
    n = 0
    for ln in pdftext(p).splitlines():
        m = re.match(r"^(\d{4}\.\d{2}\.\d{4})\s", ln)
        if m:
            book.add(m.group(1), "EP1", "official-list-stale")
            n += 1
    src["EPA_ODS"] = {"what": "CBP 'Tips for Trade when filing EPA ODS' (codes flagged EP1)", "file": os.path.relpath(p, ROOT),
                      "url": U["epa_ods"], "version": "2018-06-18 (pre-HS2022 codes)", "fetched": "2026-10-28", "rows": n}


def load_ams(raw, book, src):
    p = one(raw, "ams/ams_catair_guidelines_*.pdf")
    t = pdftext(p)
    counts = {}

    def section(start_pat, end_pat):
        s = [m.start() for m in re.finditer(start_pat, t)]
        if len(s) < 2:
            raise SystemExit(f"AMS section not found: {start_pat}")
        a = s[1]  # first hit is the table of contents
        b = re.search(end_pat, t[a:]).start() + a
        return t[a:b]

    mo = section(r"3\.1\.1\.\s+HTS Codes Subject", r"3\.1\.2\.")
    for ln in mo.splitlines():
        m = re.match(r"^\s*(\d{4}\.\d{2}(?:\.\d{2,4})?|\d{9,10})\b", ln)
        if m:
            book.add(m.group(1), "AM4", "official-list")
            counts["AM4"] = counts.get("AM4", 0) + 1
    eg = section(r"4\.1\.1\.\s+HTS Codes Subject", r"4\.1\.2\.")
    req, may = eg.split("Data May be Required")[0], eg.split("Data May be Required")[1]
    for h in re.findall(r"^\s*(\d{4})\s+-", req, re.M):
        book.add(h, "AM2", "official-list")
        counts["AM2"] = counts.get("AM2", 0) + 1
    for h in re.findall(r"^\s*(\d{4})\s+-", may, re.M):
        book.add(h, "AM1", "official-list")
        counts["AM1"] = counts.get("AM1", 0) + 1
    pn = section(r"5\.1\.1\.\s+HTS Codes Subject", r"5\.1\.2\.")
    for c in re.findall(r"^\s*(\d{4}\.\d{2}\.\d{4})\b", pn, re.M):
        book.add(c, "AM6", "official-list")
        counts["AM6"] = counts.get("AM6", 0) + 1
    p2 = one(raw, "ams/csms_am7_to_am8_codes_*.csv")
    for r in csv.DictReader(open(p2, encoding="utf-8")):
        book.add(r["hts10"], "AM8", "official-list-partial")
        counts["AM8"] = counts.get("AM8", 0) + 1
    # check the 29 codes of CSMS 69068766 against the saved page
    h = html_text(one(raw, "ams/csms_69068766_*.html"))
    for r in csv.DictReader(open(p2, encoding="utf-8")):
        if "69068766" in r["source"] and r["hts10"] not in h:
            log(f"WARN AM8 {r['hts10']} not found in CSMS 69068766 page")
    src["AMS"] = {"what": "AMS CATAIR Guidelines (sec. 3.1.1 marketing orders = AM4, 4.1.1 eggs AM2/AM1, 5.1.1 peanuts AM6) "
                          "+ AM7->AM8 organic changes in CSMS 67645994 (2026-02-13, table images transcribed) and 69068766 (2026-07-01)",
                  "file": os.path.relpath(p, ROOT), "url": U["ams"], "version": "July 2025", "fetched": "2026-10-28",
                  "derived_file": os.path.relpath(p2, ROOT), "rows": counts,
                  "note": "Full organic AM7/AM8 list is only downloadable inside ACE (AMS CATAIR 6.1.1); AM3 list not published"}


def load_ttb(raw, book, src):
    p = one(raw, "ttb/ttb_trade_filing_instructions_*.pdf")
    t = pdftext(p)
    i = t.find("Note 3:")
    blk = t[i:i + 1500]
    codes = re.findall(r"^\s*(\d{4}\.\d{2}(?:\.\d{2}\.\d{2})?)\b", blk, re.M)
    for c in codes:
        book.add(c, "TB3", "official-list-partial")
    src["TTB"] = {"what": "TTB Trade Filing Instructions v8.0, Note 3 (HTS that may be disclaimed with code A -> TB3)",
                  "file": os.path.relpath(p, ROOT), "url": U["ttb"], "version": "November 2022", "fetched": "2026-10-28",
                  "rows": len(codes), "note": "Only the TB3 subset is public; TB1/TB2 lists (Appendix C) were removed"}


def load_omc(raw, book, src):
    p = one(raw, "omc/OMC_ImplementationGuidance_*.pdf")
    t = pdftext(p)
    i = t.find("HTS categories covered")
    blk = t[i:t.find("OMC Form DS-2031", i)]
    codes = re.findall(r"^\s*(\d{4}\.\d{2}\.\d{4})\b", blk, re.M)
    for c in codes:
        book.add(c, "OM1/OM2", "official-list-stale")
    src["OMC"] = {"what": "CBP/State OMC Supplemental Implementation Guide v2.5 (shrimp HTS covered by DS-2031)",
                  "file": os.path.relpath(p, ROOT), "url": U["omc"], "version": "August 2023", "fetched": "2026-10-28",
                  "rows": len(codes)}


def load_nhtsa(raw, book, src):
    p = one(raw, "nhtsa/NHTSA_Summary_of_PGA_Message_Set_Processing.pdf")
    allc = []
    for ln in pdftext(p).splitlines():
        m = re.match(r"^\s*(\d{10})\s", ln)
        if m:
            allc.append(m.group(1))
    p2 = one(raw, "nhtsa/ACE_NHTSA_PGA_Message_Set_IG_*.pdf")
    t = pdftext(p2)
    i = t.find("Flagged DT1")
    j = t.find("Matrix", i)
    dt1 = set(re.findall(r"(?<!\d)(\d{10}|98\d{6})(?!\d)", t[i:j]))
    for c in sorted(dt1):
        book.add(c, "DT1", "official-list-stale")
    n2 = 0
    for c in sorted(set(allc) - dt1):
        book.add(c, "DT2", "official-list-stale")
        n2 += 1
    src["NHTSA"] = {"what": "CBP NHTSA Summary of PGA Message Set Processing (appendix: all NHTSA HTS) + NHTSA IG matrix of DT1 codes",
                    "files": [os.path.relpath(p, ROOT), os.path.relpath(p2, ROOT)],
                    "url": "https://www.cbp.gov/sites/default/files/documents/NHTSA%20Summary%20of%20PGA%20Message%20Set%20Processing.pdf",
                    "url_ig": U["nhtsa"], "version": "2016-02-11 / 2017-10-30 (pre-2017 and pre-2022 HTS codes)",
                    "fetched": "2026-10-28", "rows": {"DT1": len(dt1), "DT2": n2},
                    "note": "DT2 = codes in the summary appendix that are not in the DT1 matrix (inferred)"}


def load_dea(raw, book, src):
    p = one(raw, "dea/master_dea_drug_code_hts_schedule_b_reference_*.xlsx")
    wb = read_xlsx(p)
    n = {"DE1": 0, "DE3": 0}
    for sheet, flag in (("Drugs", "DE1"), ("Pill Machines", "DE3")):
        for r in wb.get(sheet, [])[1:]:
            c = digits(r.get("A"))
            if len(c) >= 8:
                book.add(c, flag, "proxy")
                n[flag] += 1
    src["DEA"] = {"what": "CBP Master DEA Drug Code / HTS / Schedule B Reference Table v1.2 (AESTIR Appendix X companion)",
                  "file": os.path.relpath(p, ROOT), "url": U["dea_ref"], "version": "March 2026 v1.2", "fetched": "2026-10-28",
                  "rows": n, "note": "Export-oriented reference; CBP says these codes are not unique to DEA. Used as a proxy for DE1/DE3."}


def apply_deltas(raw, book, src, base_dates):
    pages = {}
    for p in glob.glob(os.path.join(raw, "**", "*.html"), recursive=True):
        m = re.search(r"(?i)csms_(\d{8})", os.path.basename(p))
        if m:
            pages.setdefault(m.group(1), html_text(p))
    applied, skipped = [], []
    for date, csms, agency, frm, to, codes in sorted(DELTAS, key=lambda d: d[0]):
        base = base_dates.get(agency)
        if base and date <= base:
            skipped.append(f"{date} CSMS {csms} {agency} {frm}->{to} ({len(codes)} HTS): older than base list {base}")
            continue
        page = pages.get(csms)
        for c in codes:
            d = digits(c)
            printed = DELTA_FIX.get(d, d)
            if page is None:
                log(f"WARN CSMS {csms} page not saved; delta not verified")
            elif printed not in digits(page) and c not in page:
                log(f"WARN CSMS {csms}: {c} not found on saved page")
            if frm:
                book.remove(d, frm)
            if to:
                book.add(d, to, "csms-delta")
        applied.append({"date": date, "csms": csms, "agency": agency, "from": frm, "to": to,
                        "hts": [digits(c) for c in codes],
                        "url": "https://content.govdelivery.com/accounts/USDHSCBP/bulletins/%x" % int(csms)})
    src["CSMS_deltas"] = {"what": "Explicit HTS flag changes in CBP CSMS messages (mostly Harmonized System Updates)",
                          "dir": "data/raw/pga/cbp/csms_bulletins + agency folders", "applied": applied,
                          "skipped_older_than_base_list": skipped}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=DEFAULT_RAW)
    ap.add_argument("--hts", default=DEFAULT_HTS)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--asof", default=dt.date.today().isoformat())
    a = ap.parse_args()

    ten, eight, leaves8 = load_hts(a.hts)
    book = Book(ten, eight, leaves8)
    src = {}
    load_flag_reference(a.raw, src)
    base = {}
    base["APHIS"] = load_aphis(a.raw, book, src)
    load_lacey(a.raw, book, src)
    base["CPSC"] = load_cpsc(a.raw, book, src)
    base["NMFS"] = load_nmfs(a.raw, book, src)
    load_epa_hfc(a.raw, book, src)
    load_epa_stale(a.raw, book, src)
    load_ams(a.raw, book, src)
    load_ttb(a.raw, book, src)
    load_omc(a.raw, book, src)
    load_nhtsa(a.raw, book, src)
    load_dea(a.raw, book, src)
    apply_deltas(a.raw, book, src, base)

    hts = {k: sorted(v) for k, v in sorted(book.hts.items()) if v}
    used = sorted({f for v in hts.values() for f in v})
    flags = {}
    for code, (ag, prog, level, disc, meaning, url) in FLAGS.items():
        assert len(meaning) <= 120, code
        flags[code] = {"agency": ag, "agencyName": AG[ag], "program": prog, "level": level, "disclaim": disc,
                       "meaning": meaning, "url": U[url],
                       "basis": sorted(BASIS.get(code, [])) or ["no-public-list"],
                       "pseudo": "/" in code}
    per_agency, per_flag = {}, {}
    ten_keys = [k for k in hts if len(k) == 10]
    for k in ten_keys:
        for f in hts[k]:
            per_flag[f] = per_flag.get(f, 0) + 1
        for agcy in {FLAGS[f][0] for f in hts[k]}:
            per_agency[agcy] = per_agency.get(agcy, 0) + 1
    hts_rev = "?"
    rel = os.path.join(os.path.dirname(a.hts.rstrip("/\\")), "releases.json")
    if os.path.exists(rel):
        cur = [r for r in json.load(open(rel, encoding="utf-8")) if r.get("status") == "current"]
        hts_rev = cur[0]["name"] if cur else "?"
    out = {
        "schema": "tariffwiz.pga_flags/1",
        "checked": a.asof,
        "_source": src,
        "_notes": [
            "A flag says CBP's ACE expects (R) or may expect (M) PGA data for that HTS; whether a filing is really "
            "needed depends on the product, its use and the agency's rules. No flag does not mean no agency rules apply.",
            "level: required = CBP 'R'; may = CBP 'M' (file if regulated, else disclaim); unknown = pseudo-flag 'XX1/XX2' "
            "where the official list names the program but not M vs R.",
            "basis: official-list (current agency list), official-list-partial (only part of the agency's flags are "
            "public), official-list-stale (old list, codes carried to current HTS), csms-delta (explicit CSMS change), "
            "proxy (related official table, not the flag list), no-public-list.",
            "No public full list exists for FDA, FSIS, FWS, EPA (except HFC), TTB TB1/TB2, AMS organic AM7, Lacey AL1 vs AL2; "
            "brokers get them from ACE / ABI software vendors.",
        ],
        "_counts": {"hts_keys": len(hts), "hts10_flagged": len(ten_keys), "per_agency_hts10": dict(sorted(per_agency.items())),
                    "per_flag_hts10": dict(sorted(per_flag.items())), "normalisation": book.stats,
                    "hts_revision_checked": hts_rev},
        "_dropped_not_in_current_hts": {f: sorted(v) for f, v in book.dropped.items()},
        "_successors": {f: {o: n for o, n in sorted(v.items())} for f, v in book.successor.items()},
        "flags": flags,
        "prefixes": {k: sorted(v) for k, v in sorted(book.prefixes.items())},
        "notEnforced": {k: sorted(v) for k, v in sorted(book.not_enforced.items())},
        "hts": hts,
    }
    unused = [f for f in FLAGS if f not in used]
    out["_counts"]["flags_without_hts"] = unused
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(json.dumps(out["_counts"], indent=1))
    print(f"wrote {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
