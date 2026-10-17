// ISO 4217 minor units (exponent). Default is 2 when absent.
// Sources: ISO 4217 currency code table.
const ZERO: Record<string, true> = {
  BIF: true, CLP: true, DJF: true, GNF: true, ISK: true, JPY: true,
  KMF: true, KRW: true, PYG: true, RWF: true, UGX: true, VND: true,
  VUV: true, XAF: true, XOF: true, XPF: true,
};
const THREE: Record<string, true> = {
  BHD: true, IQD: true, JOD: true, KWD: true, LYD: true, OMR: true, TND: true,
};

export function decimals(code: string): number {
  const c = code.toUpperCase();
  if (ZERO[c]) return 0;
  if (THREE[c]) return 3;
  return 2;
}

export function isCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

// ISO 4217 active codes (for pickers).
export const CURRENCIES: string[] = [
  "AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN",
  "BAM","BBD","BDT","BGN","BHD","BIF","BMD","BND","BOB","BRL",
  "BSD","BTN","BWP","BYN","BZD","CAD","CDF","CHF","CLP","CNY",
  "COP","CRC","CUP","CVE","CZK","DJF","DKK","DOP","DZD","EGP",
  "ERN","ETB","EUR","FJD","FKP","GBP","GEL","GHS","GIP","GMD",
  "GNF","GTQ","GYD","HKD","HNL","HTG","HUF","IDR","ILS","INR",
  "IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF",
  "KPW","KRW","KWD","KYD","KZT","LAK","LBP","LKR","LRD","LSL",
  "LYD","MAD","MDL","MGA","MKD","MMK","MNT","MOP","MRU","MUR",
  "MVR","MWK","MXN","MYR","NAD","NGN","NIO","NOK","NPR","NZD",
  "OMR","PAB","PEN","PGK","PHP","PKR","PLN","PYG","QAR","RON",
  "RSD","RUB","RWF","SAR","SBD","SCR","SDG","SEK","SGD","SHP",
  "SLE","SLL","SOS","SRD","SSP","STN","SVC","SYP","SZL","THB",
  "TJS","TMT","TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX",
  "USD","UYU","UZS","VES","VND","VUV","WST","XAF","XCD","XOF",
  "XPF","YER","ZAR","ZMW","ZWL",
];
