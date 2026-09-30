/**
 * Fuzzy English team-name matching across HKJC ↔ external sources.
 * Never uses odds. Pure string / alias heuristics.
 */

const STRIP_WORDS = new Set([
  "fc",
  "cf",
  "afc",
  "sc",
  "ac",
  "as",
  "ss",
  "sv",
  "fk",
  "sk",
  "bk",
  "if",
  "united",
  "city",
  "town",
  "club",
  "the",
  "de",
  "del",
  "la",
  "el",
  "calcio",
  "sporting",
  "sports",
  "football",
  "soccer",
]);

/** Common HKJC ↔ world-name aliases (normalized keys). */
const ALIASES: Record<string, string[]> = {
  "korea republic am": ["south korea u23", "korea republic u23", "south korea am", "korea u23"],
  "china am": ["china u23", "china pr u23", "china am"],
  "new york red bulls": ["red bull new york", "ny red bulls", "new york rb"],
  "st louis city sc": ["st louis city", "saint louis city"],
  "st vincent and grenadines": [
    "saint vincent and the grenadines",
    "st vincent & grenadines",
    "saint vincent and grenadines",
  ],
  belize: ["belize"],
  "montevideo city torque": ["torque", "montevideo city"],
  penarol: ["club atletico penarol", "ca penarol", "peñarol"],
  "o higgins": ["ohiggins", "o'higgins", "cd o higgins"],
  "deportes concepcion": ["deporte concepcion", "concepcion"],
  "lyon women": [
    "olympique lyonnais women",
    "lyon w",
    "ol lyon women",
    "olympique lyonnais (w)",
    "ol lyonnes",
    "ol lyonnes women",
    "lyonnes",
  ],
  "chelsea women": ["chelsea w", "chelsea (w)", "chelsea fc women"],
  "bayern munich women": [
    "bayern munchen women",
    "bayern (w)",
    "fc bayern women",
    "bayern munich (w)",
    "bayern munchen (w)",
  ],
  "benfica women": ["benfica w", "benfica (w)", "sl benfica women"],
  "liverpool women": ["liverpool w", "liverpool (w)", "liverpool fc women"],
  "birmingham women": ["birmingham w", "birmingham (w)", "birmingham city women"],
  "sparta prague women": [
    "sparta prague w",
    "sparta praha women",
    "sparta prague (w)",
    "sparta prague",
    "sparta praha",
  ],
  "farul women": [
    "farul constanta women",
    "farul w",
    "farul (w)",
    "farul constanta",
    "farul constanta",
  ],
  "argentina": ["argentina"],
  "bolivia": ["bolivia"],
  "south africa": ["south africa", "bafana bafana"],
  "eritrea": ["eritrea"],
  "al wahda": ["al-wahda", "al wahda abu dhabi", "alwehda"],
  "al dhafra": ["al-dhafra", "aldhafra"],
  "sharjah fc": ["sharjah", "al sharjah"],
  "hatta club": ["hatta", "hatta fc"],
  "dubai united fc": ["dubai united", "dubai utd"],
  baniyas: ["baniyas sc", "baniyas club"],
  "new mexico utd": ["new mexico united", "nm united"],
  "sporting club jacksonville": [
    "jacksonville",
    "sporting jacksonville",
    "jax sc",
    "sporting jax",
    "sc jacksonville",
  ],
  brooklyn: ["brooklyn fc", "brooklyn"],
  "detroit city": ["detroit city fc"],
  "plaza colonia": ["plaza colonia", "club plaza colonia"],
  "las vegas lights": ["las vegas lights fc", "lv lights"],
  "rhode island fc": ["rhode island"],
  "indy eleven": ["indy 11"],
  "detroit city": ["detroit city fc"],
  "miami fc": ["miami"],
  "brooklyn fc": ["brooklyn"],
  "fc tulsa": ["tulsa", "tulsa roughnecks"],
  "sacramento republic": ["sacramento republic fc", "sacramento"],
  "plaza colonia": ["plaza colonia"],
  "defensor sporting": ["defensor", "defensor sporting club"],
};

export function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

export function normalizeTeamName(raw: string): string {
  let s = stripDiacritics(raw || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  // Women / U21 markers → keep as tokens for matching
  s = s
    .replace(/\bwomen\b/g, "women")
    .replace(/\b\(w\)\b/g, "women")
    .replace(/\blyonnes\b/g, "lyon women") // FotMob OL Lyonnes (W)
    .replace(/\bw\b$/g, "women")
    .replace(/\bu 21\b/g, "u21")
    .replace(/\bu21\b/g, "u21")
    .replace(/\bu 23\b/g, "u23")
    .replace(/\bam\b$/g, "u23"); // HKJC "AM" ≈ Asian Games / U23
  return s.replace(/\s+/g, " ").trim();
}

function tokens(name: string): string[] {
  return normalizeTeamName(name)
    .split(" ")
    .filter((t) => t && !STRIP_WORDS.has(t));
}

function aliasKeys(name: string): string[] {
  const n = normalizeTeamName(name);
  const out = new Set<string>([n]);
  if (ALIASES[n]) {
    for (const a of ALIASES[n]) out.add(normalizeTeamName(a));
  }
  // Reverse lookup
  for (const [k, vals] of Object.entries(ALIASES)) {
    if (normalizeTeamName(k) === n || vals.some((v) => normalizeTeamName(v) === n)) {
      out.add(normalizeTeamName(k));
      for (const v of vals) out.add(normalizeTeamName(v));
    }
  }
  return [...out];
}

/** Dice / token Jaccard similarity in [0,1]. */
export function nameSimilarity(a: string, b: string): number {
  const ka = aliasKeys(a);
  const kb = aliasKeys(b);
  for (const x of ka) {
    for (const y of kb) {
      if (x === y) return 1;
    }
  }
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  // Bonus if one normalized string contains the other core
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  const contains =
    (na.length >= 4 && nb.includes(na)) || (nb.length >= 4 && na.includes(nb))
      ? 0.15
      : 0;
  return Math.min(1, jaccard + contains);
}

export type RankedMatch<T> = { item: T; score: number; name: string };

/**
 * Pick best candidate by fuzzy English name. Optional country/league hint
 * boosts when candidate.meta includes the hint substring.
 */
export function bestNameMatch<T>(
  query: string,
  candidates: Array<{ name: string; item: T; hint?: string }>,
  opts?: { minScore?: number; leagueHint?: string }
): RankedMatch<T> | null {
  const min = opts?.minScore ?? 0.62;
  const hint = (opts?.leagueHint || "").toLowerCase();
  let best: RankedMatch<T> | null = null;
  for (const c of candidates) {
    let score = nameSimilarity(query, c.name);
    if (hint && c.hint && c.hint.toLowerCase().includes(hint.slice(0, 6))) {
      score = Math.min(1, score + 0.05);
    }
    if (!best || score > best.score) {
      best = { item: c.item, score, name: c.name };
    }
  }
  if (!best || best.score < min) return null;
  return best;
}
