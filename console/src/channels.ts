/**
 * The nineteen traction channels a goal can test (F18.11), after the
 * Bullseye framework in *Traction* by Gabriel Weinberg and Justin Mares.
 *
 * The console's own copy of src/domain/channels.ts, which it cannot import:
 * the same slugs in the same order, held to it by
 * `test/acceptance/goals.test.ts`, with each name in the owner's language.
 */
import { N, t } from './i18n.ts';

export const CHANNELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'targeting_blogs', label: N('Targeting blogs') },
  { value: 'publicity', label: N('Publicity') },
  { value: 'unconventional_pr', label: N('Unconventional PR') },
  { value: 'search_engine_marketing', label: N('Search engine marketing') },
  { value: 'social_and_display_ads', label: N('Social and display ads') },
  { value: 'offline_ads', label: N('Offline ads') },
  { value: 'search_engine_optimization', label: N('Search engine optimization') },
  { value: 'content_marketing', label: N('Content marketing') },
  { value: 'email_marketing', label: N('Email marketing') },
  { value: 'engineering_as_marketing', label: N('Engineering as marketing') },
  { value: 'viral_marketing', label: N('Viral marketing') },
  { value: 'business_development', label: N('Business development') },
  { value: 'sales', label: N('Sales') },
  { value: 'affiliate_programs', label: N('Affiliate programs') },
  { value: 'existing_platforms', label: N('Existing platforms') },
  { value: 'trade_shows', label: N('Trade shows') },
  { value: 'offline_events', label: N('Offline events') },
  { value: 'speaking_engagements', label: N('Speaking engagements') },
  { value: 'community_building', label: N('Community building') },
];

/** A channel's name in the owner's language; the slug itself for one this console does not know. */
export function channelName(slug: string): string {
  const channel = CHANNELS.find((one) => one.value === slug);
  return channel ? t(channel.label) : slug;
}
