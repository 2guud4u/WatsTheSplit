// minor-unit <-> display helpers
import type { HistoryValue } from "../../shared/wire.ts";
export function decimals(code: string): number {
  const z = "BIF,CLP,DJF,GNF,ISK,JPY,KMF,KRW,PYG,RWF,UGX,VND,VUV,XAF,XOF,XPF";
  const t = "BHD,IQD,JOD,KWD,LYD,OMR,TND";
  if (z.includes(code)) return 0;
  if (t.includes(code)) return 3;
  return 2;
}
// accepts thousands separators: "1,234.56" -> 123456
export const toMinor = (v: string, code: string) =>
  Math.round(parseFloat(v.replace(/,/g, "") || "0") * 10 ** decimals(code));
export const fmt = (minor: number, code: string) =>
  (minor / 10 ** decimals(code)).toFixed(decimals(code)) + " " + code;
export const fmtUnits = (units: number, code: string) =>
  units.toFixed(decimals(code)) + " " + code;

// currency → flag emoji (ISO 3166 country of the currency's primary issuer)
const CC: Record<string, string> = {
  AED:"AE",AFN:"AF",ALL:"AL",AMD:"AM",ANG:"CW",AOA:"AO",ARS:"AR",AUD:"AU",
  AWG:"AW",AZN:"AZ",BAM:"BA",BBD:"BB",BDT:"BD",BGN:"BG",BHD:"BH",BIF:"BI",
  BMD:"BM",BND:"BN",BOB:"BO",BRL:"BR",BSD:"BS",BTN:"BT",BWP:"BW",BYN:"BY",
  BZD:"BZ",CAD:"CA",CDF:"CD",CHF:"CH",CLP:"CL",CNY:"CN",COP:"CO",CRC:"CR",
  CUP:"CU",CVE:"CV",CZK:"CZ",DJF:"DJ",DKK:"DK",DOP:"DO",DZD:"DZ",EGP:"EG",
  ERN:"ER",ETB:"ET",EUR:"EU",FJD:"FJ",FKP:"FK",GBP:"GB",GEL:"GE",GHS:"GH",
  GIP:"GI",GMD:"GM",GNF:"GN",GTQ:"GT",GYD:"GY",HKD:"HK",HNL:"HN",HTG:"HT",
  HUF:"HU",IDR:"ID",ILS:"IL",INR:"IN",IQD:"IQ",IRR:"IR",ISK:"IS",JMD:"JM",
  JOD:"JO",JPY:"JP",KES:"KE",KGS:"KG",KHR:"KH",KMF:"KM",KPW:"KP",KRW:"KR",
  KWD:"KW",KYD:"KY",KZT:"KZ",LAK:"LA",LBP:"LB",LKR:"LK",LRD:"LR",LSL:"LS",
  LYD:"LY",MAD:"MA",MDL:"MD",MGA:"MG",MKD:"MK",MMK:"MM",MNT:"MN",MOP:"MO",
  MRU:"MR",MUR:"MU",MVR:"MV",MWK:"MW",MXN:"MX",MYR:"MY",MZN:"MZ",NAD:"NA",
  NGN:"NG",NIO:"NI",NOK:"NO",NPR:"NP",NZD:"NZ",OMR:"OM",PAB:"PA",PEN:"PE",
  PGK:"PG",PHP:"PH",PKR:"PK",PLN:"PL",PYG:"PY",QAR:"QA",RON:"RO",RSD:"RS",
  RUB:"RU",RWF:"RW",SAR:"SA",SBD:"SB",SCR:"SC",SDG:"SD",SEK:"SE",SGD:"SG",
  SHP:"SH",SLE:"SL",SLL:"SL",SOS:"SO",SRD:"SR",SSP:"SS",STN:"ST",SVC:"SV",
  SYP:"SY",SZL:"SZ",THB:"TH",TJS:"TJ",TMT:"TM",TND:"TN",TOP:"TO",TRY:"TR",
  TTD:"TT",TWD:"TW",TZS:"TZ",UAH:"UA",UGX:"UG",USD:"US",UYU:"UY",UZS:"UZ",
  VES:"VE",VND:"VN",VUV:"VU",WST:"WS",XAF:"CF",XCD:"AG",XOF:"SN",XPF:"PF",
  YER:"YE",ZAR:"ZA",ZMW:"ZM",ZWL:"ZW",
};
export function flag(code: string): string {
  const cc = CC[code];
  if (!cc) return "🏳️";
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export const CATEGORIES: Record<string, string> = {
  Food: "🍽️", Drinks: "🍻", Coffee: "☕", Groceries: "🛒", Transport: "🚕",
  Lodging: "🏨", Activities: "🎟️", Tickets: "🎫", Shopping: "🛍️",
  Souvenirs: "🧸", Fees: "💳", Nightlife: "🌙", Wellness: "💆", Other: "📦",
};
export const catLabel = (c: string | null | undefined) =>
  c ? `${CATEGORIES[c] ?? "📦"} ${c}` : "";

// Render a HistoryValue as a human-readable label.
export const historyValueLabel = (v: HistoryValue | null): string => {
  if (v === null) return "—";
  switch (v.kind) {
    case "text": return v.text === "" ? "—(none)" : v.text;
    case "none": return "—(none)";
    case "amount": return fmt(v.amount_minor, v.currency);
    case "share":
      return v.amount_minor === null ? "—(none)" : fmt(v.amount_minor, v.currency);
    case "member": return v.member_name;
    case "member_flag": return `${v.member_name} ${v.flag ? v.on_label : v.off_label}`;
    case "boolean": return v.value ? "yes" : "no";
    case "split": return v.type === "equal_rest" ? "equal split of remainder" : "proportional";
  }
  return "—";
};

// Render an entry + field as a full sentence.
import type { HistoryEntry } from "../../shared/wire.ts";
const FIELD_NOUN: Record<string, string> = {
  name: "name",
  total_minor: "total",
  payer_member_id: "payer",
  share: "share",
  paid: "paid",
  category: "category",
  currency: "currency",
  split: "split",
  participants: "participants",
  items: "items",
  photos: "photos",
  paid_out: "paid out",
};
export const historyEntrySentence = (e: HistoryEntry): string => {
  const by = e.by ? `${e.by} ` : "";
  if (e.kind === "created") return `${by}created ${e.entity_name}`;
  if (e.kind === "deleted") return `${by}deleted ${e.entity_name}`;
  const field = e.field ?? "";
  const noun = FIELD_NOUN[field] ?? field;
  const old = historyValueLabel(e.old_value);
  const neu = historyValueLabel(e.new_value);

  switch (field) {
    case "name":
      return `${by}renamed ${e.entity_name} to ${neu}`;
    case "total_minor":
      return `${by}set ${e.entity_name}'s total to ${neu}`;
    case "payer_member_id":
      return `${by}set ${e.entity_name}'s payer to ${neu}`;
    case "share": {
      const who = e.new_value?.kind === "share" ? e.new_value.member_name : "";
      if (e.new_value?.kind === "share" && e.new_value.amount_minor === null)
        return `${by}cleared ${who}'s share on ${e.entity_name}`;
      const verb = e.old_value?.kind === "share" && e.old_value.amount_minor === null ? "set" : "changed";
      return `${by}${verb} ${who}'s share on ${e.entity_name} to ${neu}`;
    }
    case "paid": {
      const who = e.new_value?.kind === "member_flag" ? e.new_value.member_name : "";
      const state = e.new_value?.kind === "member_flag"
        ? e.new_value.flag ? e.new_value.on_label : e.new_value.off_label
        : neu;
      const verb = e.new_value?.kind === "member_flag" && e.new_value.flag ? "marked" : "unmarked";
      return `${by}${verb} ${who} ${state} on ${e.entity_name}`;
    }
    case "participants": {
      const who = e.new_value?.kind === "member_flag" ? e.new_value.member_name : "";
      const verb = e.new_value?.kind === "member_flag" ? e.new_value.flag ? "added" : "removed" : "changed";
      return `${by}${verb} ${who} on ${e.entity_name}`;
    }
    case "paid_out":
      return `${by}marked ${e.entity_name} ${neu}`;
    case "split":
      return `${by}split ${e.entity_name} (${neu})`;
    default:
      return `${by}changed ${noun} on ${e.entity_name} from ${old} to ${neu}`;
  }
};

// country name for each currency code (for search)
export const CURRENCY_COUNTRIES: Record<string, string> = {
  AED: "United Arab Emirates",
  AFN: "Afghanistan",
  ALL: "Albania",
  AMD: "Armenia",
  ANG: "Curaçao",
  AOA: "Angola",
  ARS: "Argentina",
  AUD: "Australia",
  AWG: "Aruba",
  AZN: "Azerbaijan",
  BAM: "Bosnia and Herzegovina",
  BBD: "Barbados",
  BDT: "Bangladesh",
  BGN: "Bulgaria",
  BHD: "Bahrain",
  BIF: "Burundi",
  BMD: "Bermuda",
  BND: "Brunei",
  BOB: "Bolivia",
  BRL: "Brazil",
  BSD: "Bahamas",
  BTN: "Bhutan",
  BWP: "Botswana",
  BYN: "Belarus",
  BZD: "Belize",
  CAD: "Canada",
  CDF: "Congo - Kinshasa",
  CHF: "Switzerland",
  CLP: "Chile",
  CNY: "China ",
  COP: "Colombia",
  CRC: "Costa Rica",
  CUP: "Cuba",
  CVE: "Cape Verde",
  CZK: "Czechia",
  DJF: "Djibouti",
  DKK: "Denmark",
  DOP: "Dominican Republic",
  DZD: "Algeria",
  EGP: "Egypt",
  ERN: "Eritrea",
  ETB: "Ethiopia",
  EUR: "European Union",
  FJD: "Fiji",
  FKP: "Falkland Islands",
  GBP: "United Kingdom",
  GEL: "Georgia",
  GHS: "Ghana",
  GIP: "Gibraltar",
  GMD: "Gambia",
  GNF: "Guinea",
  GTQ: "Guatemala",
  GYD: "Guyana",
  HKD: "Hong Kong",
  HNL: "Honduras",
  HTG: "Haiti",
  HUF: "Hungary",
  IDR: "Indonesia",
  ILS: "Israel",
  INR: "India",
  IQD: "Iraq",
  IRR: "Iran",
  ISK: "Iceland",
  JMD: "Jamaica",
  JOD: "Jordan",
  JPY: "Japan",
  KES: "Kenya",
  KGS: "Kyrgyzstan",
  KHR: "Cambodia",
  KMF: "Comoros",
  KPW: "North Korea",
  KRW: "South Korea",
  KWD: "Kuwait",
  KYD: "Cayman Islands",
  KZT: "Kazakhstan",
  LAK: "Laos",
  LBP: "Lebanon",
  LKR: "Sri Lanka",
  LRD: "Liberia",
  LSL: "Lesotho",
  LYD: "Libya",
  MAD: "Morocco",
  MDL: "Moldova",
  MGA: "Madagascar",
  MKD: "North Macedonia",
  MMK: "Myanmar (Burma)",
  MNT: "Mongolia",
  MOP: "Macao",
  MRU: "Mauritania",
  MUR: "Mauritius",
  MVR: "Maldives",
  MWK: "Malawi",
  MXN: "Mexico",
  MYR: "Malaysia",
  MZN: "Mozambique",
  NAD: "Namibia",
  NGN: "Nigeria",
  NIO: "Nicaragua",
  NOK: "Norway",
  NPR: "Nepal",
  NZD: "New Zealand",
  OMR: "Oman",
  PAB: "Panama",
  PEN: "Peru",
  PGK: "Papua New Guinea",
  PHP: "Philippines",
  PKR: "Pakistan",
  PLN: "Poland",
  PYG: "Paraguay",
  QAR: "Qatar",
  RON: "Romania",
  RSD: "Serbia",
  RUB: "Russia",
  RWF: "Rwanda",
  SAR: "Saudi Arabia",
  SBD: "Solomon Islands",
  SCR: "Seychelles",
  SDG: "Sudan",
  SEK: "Sweden",
  SGD: "Singapore",
  SHP: "St. Helena",
  SLE: "Sierra Leone",
  SLL: "Sierra Leone",
  SOS: "Somalia",
  SRD: "Suriname",
  SSP: "South Sudan",
  STN: "São Tomé and Príncipe",
  SVC: "El Salvador",
  SYP: "Syria",
  SZL: "Eswatini",
  THB: "Thailand",
  TJS: "Tajikistan",
  TMT: "Turkmenistan",
  TND: "Tunisia",
  TOP: "Tonga",
  TRY: "Türkiye",
  TTD: "Trinidad and Tobago",
  TWD: "Taiwan",
  TZS: "Tanzania",
  UAH: "Ukraine",
  UGX: "Uganda",
  USD: "United States",
  UYU: "Uruguay",
  UZS: "Uzbekistan",
  VES: "Venezuela",
  VND: "Vietnam",
  VUV: "Vanuatu",
  WST: "Samoa",
  XAF: "Central African Republic",
  XCD: "Antigua and Barbuda",
  XOF: "Senegal",
  XPF: "French Polynesia",
  YER: "Yemen",
  ZAR: "South Africa",
  ZMW: "Zambia",
  ZWL: "Zimbabwe",
};
