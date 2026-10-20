// Deterministic merchant rules (DESIGN §4): an ordered pattern table
// matched against the uppercased narration — first match wins, so the
// table runs from specific merchants to generic heuristics. Rules are
// the fast, explainable layer: the slow model (S6) only ever sees the
// long tail these patterns and the correction memory both miss.
//
// Order is load-bearing. Examples the tests pin down:
//  - NOTION LABS -> Subscriptions, not Health & Pharmacy ("LABS").
//  - AMAZON FRESH -> Groceries, not Shopping ("AMAZON").
//  - JIO PREPAID RECHARGE -> Utilities & Bills, not Fees ("...CHG...").

import type { Category, Txn } from "../types.js";

export interface Rule {
  name: string;
  pattern: RegExp;
  category: Category;
}

const r = (name: string, source: string, category: Category): Rule => ({
  name,
  pattern: new RegExp(source, "i"),
  category,
});

export const RULES: readonly Rule[] = [
  // Income
  r("salary", "SALARY", "Income"),
  r("interest-credit", "INTEREST (CAPITALISED|CAPITALIZED|CREDIT)|CREDIT INTEREST", "Income"),

  // Rent & Housing
  r("rent", "\\bRENT\\b|HOUSING SOCIETY|MAINTENANCE (CHARGE|BILL)", "Rent & Housing"),

  // Investments (before Subscriptions: "ZERODHA" also appears as ACH D-)
  r(
    "investments",
    "ZERODHA|GROWW|UPSTOX|KUVERA|MUTUAL FUND|\\bSIP\\b|\\bPPF\\b|\\bNPS\\b|COIN DCX|WAZIRX",
    "Investments",
  ),

  // Subscriptions (before Health: NOTION LABS contains "LABS")
  r(
    "subscriptions",
    "NETFLIX|SPOTIFY|NOTION|HOTSTAR|JIOCINEMA|ZEE5|SONYLIV|AUDIBLE|YOUTUBE PREMIUM|AMAZON PRIME|PRIME VIDEO|APPLE\\.COM/BILL|ICLOUD|GOOGLE ONE|MICROSOFT 365|OFFICE 365|ADOBE|CANVA|CHATGPT|OPENAI|ANTHROPIC|CLAUDE|GITHUB|TATA PLAY|DISH ?TV|AIRTEL DTH|LINKEDIN PREMIUM",
    "Subscriptions",
  ),

  // Groceries (before Shopping: AMAZON FRESH / JIOMART)
  r(
    "groceries",
    "BIGBASKET|BLINKIT|ZEPTO|DMART|D[ -]?MART|JIOMART|AMAZON FRESH|FRESHTOHOME|GROFERS|SPENCER|MORE MEGASTORE|NATURES BASKET|INSTAMART|MILKBASKET|COUNTRY DELIGHT",
    "Groceries",
  ),

  // Food & Dining
  r(
    "food",
    "SWIGGY|ZOMATO|CHAI|CAFE|COFFEE|STARBUCKS|MCDONALD|DOMINOS|KFC|PIZZA|BURGER|RESTAURANT|EATERY|DHABA|BAKERY|BIRYANI|DUNKIN|SUBWAY|HALDIRAM|BARBEQUE|FASSOS|REBEL FOODS|EATSURE|MAGGI|TEA\\b",
    "Food & Dining",
  ),

  // Transport (before Utilities: "METRO CARD RECHARGE" is Transport,
  // and before Fees: RECHARGE contains "CHG")
  r(
    "transport",
    "UBER|OLA\\b|RAPIDO|METRO|IRCTC|REDBUS|FASTAG|PETROL|DIESEL|\\bFUEL\\b|HP PETRO|INDIAN OIL|BHARAT PETROLEUM|\\bBPCL\\b|\\bIOCL\\b|SHELL|MAKEMYTRIP|CLEARTRIP|IXIGO|GOIBIBO|INDIGO|AIR INDIA|PARKING",
    "Transport",
  ),

  // Utilities & Bills
  r(
    "utilities",
    "MSEDCL|BESCOM|TANGEDCO|ELECTRICITY|\\bBBPS\\b|WATER BILL|PIPED GAS|MAHANAGAR GAS|HP GAS|INDANE|BHARAT GAS|JIO|AIRTEL|VODAFONE|\\bVI\\b|BSNL|RECHARGE|BROADBAND|FIBERNET|HATHWAY|ACT FIBER|POSTPAID|PREPAID",
    "Utilities & Bills",
  ),

  // Shopping
  r(
    "shopping",
    "AMAZON|FLIPKART|MYNTRA|AJIO|MEESHO|SNAPDEAL|CROMA|VIJAY SALES|RELIANCE DIGITAL|RELIANCE TRENDS|NYKAA|DECATHLON|IKEA|WESTSIDE|PANTALOONS|LIFESTYLE|SHOPPER|TITAN|TANISHQ|LENSCART|FIRSTCRY|MAMAEARTH|PURPLLE",
    "Shopping",
  ),

  // Health & Pharmacy
  r(
    "health",
    "APOLLO|PHARMACY|PHARMEASY|NETMEDS|MEDPLUS|TATA 1MG|\\b1MG\\b|HOSPITAL|CLINIC|DENTAL|DIAGNOSTIC|LABS\\b|LABORATOR|PATHOLOGY|MEDICAL|DOCTOR|HEALTH",
    "Health & Pharmacy",
  ),

  // Entertainment
  r(
    "entertainment",
    "BOOKMYSHOW|PVR|INOX|CINEMA|MOVIE|STEAM|PLAYSTATION|XBOX|NINTENDO|DREAM11|FANTASY|GAMING|\\bGAMES\\b",
    "Entertainment",
  ),

  // Fees & Charges (after RECHARGE-bearing rules on purpose)
  r(
    "fees",
    "AMB CHG|\\bCHARGES?\\b|\\bFEE\\b|PENALTY|\\bFINE\\b|LATE (FEE|CHARGE)|MIN BAL|SERVICE CHARGE|ANNUAL (FEE|CHARGE)|GST",
    "Fees & Charges",
  ),

  // Transfers — heuristics, deliberately last among the specific rules.
  r("atm", "\\bATM\\b|CASH WDL|WDL-", "Transfers"),
  // Person-to-person UPI: "UPI-<NAME>-<digits…>" where no merchant rule
  // above matched — in HDFC narrations a trailing numeric id is how a
  // person's phone/ref number appears; merchants end in a city or brand.
  r("p2p-upi", "^UPI-[A-Z][A-Z .]*-\\d", "Transfers"),
  r("transfer-generic", "P2P|SELF TRANSFER|\\bIMPS\\b|\\bNEFT\\b", "Transfers"),
];

/** The first matching rule's category for a txn, or null on a miss. */
export function applyRules(txn: Txn): Category | null {
  const text = txn.description.toUpperCase();
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return null;
}
