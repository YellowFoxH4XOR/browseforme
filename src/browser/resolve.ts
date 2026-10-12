import { JevError, JevUnavailable, pickElement, type PickOutcome } from "../jev";
import { describe, type ElementRecord, type ScanResult } from "./snapshot";
import type { Target } from "./transport";
import { evalJson } from "./world";

export type ResolvedBy = "ref" | "exact" | "words" | "reverse" | "jev";
type Tier = "exact" | "words" | "reverse";

export interface Resolution {
  ref: string;
  by: ResolvedBy;
  p?: number;
  jevMs?: number;
  element?: ElementRecord;
}

export type ResolveResult = Resolution | { error: string; jevMs?: number };

interface Parse {
  t: string;
  roleFilter: string | null;
}

interface LocalMatch {
  tier: Tier | null;
  matches: ElementRecord[];
}

/** Must stay byte-for-byte identical to `norm` in scanner.js: both sides compare these strings. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const LEADING = ["on the ", "on ", "the ", "a ", "an "];

/** Trailing role words, longest first so "text box" is tried before "box". */
const ROLE_SUFFIXES: [string, string][] = [
  ["text field", "textbox"],
  ["text box", "textbox"],
  ["menu item", "menuitem"],
  ["textarea", "textbox"],
  ["menuitem", "menuitem"],
  ["checkbox", "checkbox"],
  ["dropdown", "combobox"],
  ["textbox", "textbox"],
  ["button", "button"],
  ["editor", "textbox"],
  ["option", "menuitem"],
  ["select", "combobox"],
  ["switch", "switch"],
  ["toggle", "switch"],
  ["field", "textbox"],
  ["input", "textbox"],
  ["link", "link"],
  ["btn", "button"],
  ["box", "textbox"],
  ["tab", "tab"],
];

/** Same role families the scanner's `match` accepts for a role filter. */
const ROLE_FAMILY: Record<string, string[]> = {
  textbox: ["textbox", "searchbox", "combobox"],
  menuitem: ["menuitem", "option"],
};

const TIER_RANK: Record<Tier, number> = { exact: 0, words: 1, reverse: 2 };

/**
 * Every reading of the target, most specific first: each trailing role word that fits
 * ("Post text box" → "post"+textbox, "post text"+textbox), then the words with no role filter.
 */
export function parseTargets(target: string): Parse[] {
  let t = norm(target);
  const lead = LEADING.find((prefix) => t.startsWith(prefix) && t.length > prefix.length);
  if (lead) t = t.slice(lead.length);
  const parses: Parse[] = [];
  for (const [suffix, role] of ROLE_SUFFIXES) {
    if (!t.endsWith(" " + suffix)) continue;
    const rest = t.slice(0, -suffix.length - 1).trim();
    if (rest) parses.push({ t: rest, roleFilter: role });
  }
  parses.push({ t, roleFilter: null });
  return parses;
}

function line(element: ElementRecord): string {
  return `@${element.ref} ${describe(element)}`;
}

function noMatch(target: string, scan: ScanResult): string {
  return `No element matches "${target}". Elements:\n${scan.elements.slice(0, 15).map(line).join("\n")}`;
}

/** Runs the in-page tiers for each reading; the first exact hit wins, otherwise the best tier. */
async function bestLocal(target: Target, parses: Parse[]): Promise<{ parse: Parse; local: LocalMatch }> {
  let best: { parse: Parse; local: LocalMatch } | null = null;
  for (const parse of parses) {
    const local = await evalJson<LocalMatch>(target, `__bfm.match(${JSON.stringify(parse.t)}, ${JSON.stringify(parse.roleFilter)})`);
    if (local.tier && (!best?.local.tier || TIER_RANK[local.tier] < TIER_RANK[best.local.tier])) best = { parse, local };
    if (local.tier === "exact") break;
  }
  return best ?? { parse: parses[0], local: { tier: null, matches: [] } };
}

/**
 * Resolves target words to a ref: in-page text tiers first (no network), Jev only when the
 * tiers leave zero or several candidates.
 */
export async function resolveTarget(target: Target, request: string, action: "click" | "type" | "find"): Promise<ResolveResult> {
  const parses = parseTargets(request);
  if (!parses[0].t) return { error: `Empty target "${request}".` };
  let jevMs = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { parse, local } = await bestLocal(target, parses);
    let matches = local.matches;
    if (action !== "find") {
      const enabled = matches.filter((m) => !m.disabled);
      if (enabled.length > 0) matches = enabled;
    }
    const inView = matches.filter((m) => m.inView);
    if (inView.length > 0) matches = inView;
    if (local.tier && matches.length === 1) return { ref: matches[0].ref, by: local.tier, element: matches[0] };

    const scan = await evalJson<ScanResult>(target, "__bfm.scan(200)");
    let pool = matches;
    if (!local.tier) {
      const family = parse.roleFilter ? ROLE_FAMILY[parse.roleFilter] ?? [parse.roleFilter] : null;
      const filtered = family ? scan.elements.filter((e) => family.includes(e.role)) : [];
      pool = filtered.length > 0 ? filtered : scan.elements;
    }

    let outcome: PickOutcome;
    try {
      outcome = await pickElement({ url: scan.url, title: scan.title, action, request, elements: pool });
    } catch (err) {
      if (!(err instanceof JevUnavailable || err instanceof JevError)) throw err;
      if (local.tier) {
        return { error: `Ambiguous target "${request}": ${matches.slice(0, 5).map(line).join(", ")} — pass a ref.`, jevMs };
      }
      return { error: noMatch(request, scan), jevMs };
    }
    jevMs += outcome.ms;
    if (outcome.kind === "pick") {
      const ref = outcome.ref;
      return { ref, by: "jev", p: outcome.p, jevMs, element: pool.find((e) => e.ref === ref) };
    }
    if (outcome.kind === "ambiguous") {
      const listed = outcome.ranked.map(({ ref, p }) => {
        const element = pool.find((e) => e.ref === ref);
        return `${element ? line(element) : `@${ref}`} (${p.toFixed(2)})`;
      });
      return { error: `Ambiguous target "${request}": ${listed.join(", ")} — pass a ref.`, jevMs };
    }
    if (attempt === 0) {
      await Bun.sleep(400);
      continue;
    }
    return { error: noMatch(request, scan), jevMs };
  }
  return { error: `No element matches "${request}".`, jevMs };
}
