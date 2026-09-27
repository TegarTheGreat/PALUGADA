/**
 * The pictures the console draws for companies, roles and the owner.
 *
 * Nothing here is drawn from the letters of a name. A letter says nothing the
 * name beside it does not, and two companies that start with the same one look
 * the same; a picture is recognised before it is read. Every file named here
 * was made for PALUGADA (brand/README.md says how) and ships in
 * `console/public`, because the content security policy loads images from the
 * console's own origin and nowhere else.
 */

/** A company's emblem, in the order they are handed out. */
export const COMPANY_EMBLEMS = [
  'crate', 'rocket', 'sprout', 'coffee', 'shop', 'gem', 'plane', 'bag', 'bolt', 'mountain', 'book', 'globe',
] as const;

/** An agent doing its job, and the plain agents for a role whose name does not say what that is. */
export const ROLE_PICTURES = [
  'coordinator', 'planner', 'builder', 'marketer', 'bookkeeper', 'responder', 'reviewer', 'analyst', 'strategist',
  'researcher', 'writer', 'web', 'engineer', 'sales', 'designer', 'agent', 'agent-teal', 'agent-amber', 'agent-pink',
] as const;

const PLAIN_AGENTS = ['agent', 'agent-teal', 'agent-amber', 'agent-pink'] as const;

/**
 * What a role's name says it does, read from the words of its slug.
 *
 * In order, because names combine: a `qa-reviewer` reviews, a `web-operator`
 * runs the site rather than operations, and `growth-lead` markets rather than
 * coordinates. A word matches by its start, so `writer`, `writing` and
 * `writes` are one job, and `ui` does not match inside `builder`.
 */
const JOBS: readonly (readonly [string, readonly string[]])[] = [
  ['reviewer', ['review', 'qa', 'audit', 'verif', 'check', 'approv', 'quality']],
  ['web', ['web', 'site', 'seo', 'dns', 'domain']],
  ['strategist', ['strateg']],
  ['planner', ['plan', 'roadmap', 'schedul', 'cpo', 'product']],
  ['marketer', ['market', 'growth', 'social', 'brand', 'ads', 'campaign', 'promot', 'cmo']],
  ['sales', ['sales', 'sell', 'deal', 'bizdev', 'partner', 'outreach', 'prospect']],
  ['bookkeeper', ['book', 'financ', 'account', 'ledger', 'tax', 'invoic', 'billing', 'payroll', 'treasur', 'cfo']],
  ['responder', ['support', 'respond', 'care', 'help', 'success', 'service', 'inbox']],
  ['analyst', ['analy', 'data', 'metric', 'insight', 'report', 'forecast']],
  ['researcher', ['research', 'scout', 'discover', 'investigat', 'survey']],
  ['writer', ['writ', 'content', 'copy', 'editor', 'blog', 'newsletter', 'docs']],
  ['designer', ['design', 'creative', 'art', 'visual', 'ux', 'ui', 'illustrat']],
  ['engineer', ['engineer', 'develop', 'dev', 'code', 'coder', 'program', 'platform', 'infra', 'sre', 'backend', 'frontend', 'cto']],
  ['coordinator', ['coordinat', 'manag', 'lead', 'chief', 'head', 'director', 'ceo', 'coo', 'orchestrat', 'dispatch']],
  ['builder', ['build', 'maker', 'make', 'ops', 'operat', 'fulfil', 'deliver', 'produc']],
];

function jobIn(name: string): string | null {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const [picture, starts] of JOBS) {
    if (words.some((word) => starts.some((start) => word.startsWith(start)))) return picture;
  }
  return null;
}

/**
 * A picture for a role, from its slug, or from its title when the slug does
 * not say what it does -- a `worker` who is the CEO is drawn coordinating;
 * the same slug and title always get the same one.
 */
export function rolePicture(slug: string, title?: string | null): string {
  const job = jobIn(slug) ?? (title ? jobIn(title) : null);
  return `/avatars/roles/${job ?? PLAIN_AGENTS[spread(slug) % PLAIN_AGENTS.length]}.webp`;
}

/**
 * What a company's name says it sells, in Indonesian or English.
 *
 * Whole words only: a prefix would draw "Tasty" as a bag because it starts
 * with "tas", and "Lestari" as a lesson because it starts with "les". In
 * order, so "Kopi Nusantara" is coffee before it is the archipelago.
 */
const TRADES: readonly (readonly [(typeof COMPANY_EMBLEMS)[number], readonly string[]])[] = [
  ['coffee', ['kopi', 'coffee', 'cafe', 'kafe', 'teh', 'tea', 'roti', 'bakery', 'kue', 'cake', 'dapur', 'kitchen', 'food', 'foods',
    'makan', 'makanan', 'resto', 'restoran', 'restaurant', 'warung', 'kuliner', 'catering', 'martabak', 'bakso', 'sate']],
  ['shop', ['toko', 'shop', 'store', 'mart', 'market', 'pasar', 'grosir', 'wholesale', 'retail', 'dagang', 'trading', 'minimarket']],
  ['sprout', ['tani', 'farm', 'farms', 'kebun', 'garden', 'hijau', 'green', 'eco', 'organic', 'organik', 'agri', 'agro', 'tanam', 'plant', 'plants']],
  ['bag', ['butik', 'boutique', 'fashion', 'tas', 'bags', 'baju', 'apparel', 'wear', 'batik', 'kain', 'textile', 'tekstil', 'hijab', 'sepatu', 'shoes']],
  ['gem', ['gem', 'gems', 'jewel', 'jewelry', 'perhiasan', 'emas', 'gold', 'luxe', 'luxury', 'beauty', 'cantik', 'kosmetik', 'cosmetics', 'salon', 'spa', 'skincare']],
  ['plane', ['travel', 'tour', 'tours', 'wisata', 'trip', 'kirim', 'shipping', 'cargo', 'kargo', 'logistik', 'logistics', 'express', 'ekspres', 'kurir', 'courier', 'delivery']],
  ['book', ['buku', 'book', 'books', 'belajar', 'learn', 'learning', 'edu', 'education', 'sekolah', 'school', 'kursus', 'course', 'courses',
    'akademi', 'academy', 'les', 'tutor', 'media', 'news', 'berita', 'penerbit', 'publishing', 'pustaka']],
  ['bolt', ['energi', 'energy', 'listrik', 'electric', 'power', 'solar', 'surya', 'charge', 'kilat']],
  ['mountain', ['gunung', 'mountain', 'outdoor', 'adventure', 'petualang', 'camp', 'alam', 'nature', 'properti', 'property', 'estate', 'rumah', 'homes']],
  ['rocket', ['lab', 'labs', 'launch', 'startup', 'tech', 'teknologi', 'technology', 'ai', 'robot', 'robotics', 'digital', 'app', 'apps', 'software', 'studio']],
  ['globe', ['global', 'world', 'dunia', 'international', 'internasional', 'ekspor', 'export', 'exports', 'impor', 'import', 'nusantara', 'indonesia', 'online']],
  ['crate', ['gudang', 'warehouse', 'supply', 'supplies', 'suplai', 'box', 'kotak', 'packaging', 'kemasan', 'palugada', 'serba']],
];

/**
 * A company's emblem: what its name says it sells, or else one chosen from
 * its id, which never changes -- so a company whose name says nothing keeps
 * its emblem when it is renamed, and one renamed from "Kopi" to "Toko" is
 * drawn as what it has become.
 */
export function companyEmblem(company: { id: string; name: string }): string {
  const words = company.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const trade = TRADES.find(([, names]) => words.some((word) => names.includes(word)));
  const emblem = trade ? trade[0] : COMPANY_EMBLEMS[spread(company.id) % COMPANY_EMBLEMS.length]!;
  return `/avatars/companies/${emblem}.webp`;
}

/** The owner, who is one person and is drawn as one. */
export const OWNER_PICTURE = '/avatars/owner.webp';

/**
 * A number from a string that spreads neighbouring strings apart (FNV-1a).
 *
 * Ids made one after another differ in a character or two; a sum of
 * character codes would give them neighbouring emblems, or the same one.
 */
function spread(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
