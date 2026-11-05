/**
 * The traction channels a company can test for customers (F18.11).
 *
 * After the Bullseye framework in *Traction* by Gabriel Weinberg and Justin
 * Mares: every way a startup has found customers falls in one of nineteen
 * channels, and the most promising is often the one a company's competitors
 * neglect, so each is considered before any is dismissed. A goal names the
 * channel it tests (`goals.channel`, 0136); which ring a channel is in --
 * possible, probable, working -- is read from the goals that name it, never
 * stored.
 *
 * The names and order are the 2015 Portfolio edition's ("How Any Startup Can
 * Achieve Explosive Customer Growth"), which tractionbook.com points to. The
 * 2014 edition has the same nineteen in another order, starting with viral
 * marketing and public relations, and calls publicity "Public Relations
 * (PR)". The descriptions are PALUGADA's own words, not the book's.
 *
 * The slugs are also the CHECK on `goals.channel` in migration 0136, and the
 * console's own list (console/src/channels.ts), which
 * `test/acceptance/goals.test.ts` holds to this one.
 */

export interface Channel {
  slug: ChannelSlug;
  /** Its name, as a run and the owner are told it. */
  label: string;
  /** What working the channel means, as a phrase that follows its name. */
  about: string;
}

export const CHANNEL_SLUGS = [
  'targeting_blogs',
  'publicity',
  'unconventional_pr',
  'search_engine_marketing',
  'social_and_display_ads',
  'offline_ads',
  'search_engine_optimization',
  'content_marketing',
  'email_marketing',
  'engineering_as_marketing',
  'viral_marketing',
  'business_development',
  'sales',
  'affiliate_programs',
  'existing_platforms',
  'trade_shows',
  'offline_events',
  'speaking_engagements',
  'community_building',
] as const;

export type ChannelSlug = (typeof CHANNEL_SLUGS)[number];

const ABOUT: Record<ChannelSlug, Omit<Channel, 'slug'>> = {
  targeting_blogs: { label: 'Targeting blogs', about: 'being written about by the small blogs and newsletters the customers already read' },
  publicity: { label: 'Publicity', about: 'coverage in newspapers, magazines, television and the larger sites' },
  unconventional_pr: { label: 'Unconventional PR', about: 'a stunt or a gesture remarkable enough that people pass it on and the press follows' },
  search_engine_marketing: { label: 'Search engine marketing', about: 'paid ads shown to people searching for what the company sells' },
  social_and_display_ads: { label: 'Social and display ads', about: 'paid ads on social networks and on the sites the customers visit' },
  offline_ads: { label: 'Offline ads', about: 'print, radio, television, billboards, flyers and other ads away from the screen' },
  search_engine_optimization: { label: 'Search engine optimization', about: 'being found without paying, for the searches the customers make' },
  content_marketing: { label: 'Content marketing', about: "the company's own articles, guides and videos, published to bring customers back to it" },
  email_marketing: { label: 'Email marketing', about: 'letters to people who asked for them, to win, keep and bring back customers' },
  engineering_as_marketing: { label: 'Engineering as marketing', about: 'a free tool, calculator or small site that the customers want and that leads to the product' },
  viral_marketing: { label: 'Viral marketing', about: 'customers bringing in other customers, through invitations, sharing and referrals' },
  business_development: { label: 'Business development', about: 'partnerships with another company that reaches the same customers' },
  sales: { label: 'Sales', about: 'finding, talking to and closing customers one by one' },
  affiliate_programs: { label: 'Affiliate programs', about: 'paying others a share of each sale they send' },
  existing_platforms: { label: 'Existing platforms', about: 'being found inside a large platform: an app store, a marketplace, a social network' },
  trade_shows: { label: 'Trade shows', about: "meeting buyers at their industry's exhibitions" },
  offline_events: { label: 'Offline events', about: 'running or sponsoring meetups, workshops and conferences' },
  speaking_engagements: { label: 'Speaking engagements', about: 'talks at events the customers attend' },
  community_building: { label: 'Community building', about: 'a community of customers who help one another and bring in more' },
};

/** The nineteen, in the book's order. */
export const CHANNELS: readonly Channel[] = CHANNEL_SLUGS.map((slug) => ({ slug, ...ABOUT[slug] }));

export function isChannel(value: unknown): value is ChannelSlug {
  return typeof value === 'string' && (CHANNEL_SLUGS as readonly string[]).includes(value);
}

/** A channel as a run is told it: its name, and what working it means. */
export function channelSaid(slug: ChannelSlug): string {
  const channel = CHANNELS.find((one) => one.slug === slug)!;
  return `${channel.label}: ${channel.about}`;
}
