/**
 * Where the owner is, kept in the address bar.
 *
 * `#/home` is the portfolio; `#/c/<company>/<page>` a page of one company;
 * `#/c/<company>/settings/<section>` a section of its settings;
 * `#/deployment/<section>` what the whole deployment runs on, which belongs
 * to no company and is reachable before there is one. In the hash
 * rather than the path so the server has one page to serve, and in the
 * address at all so that a reload, the back button and a shared link all
 * land where the owner was.
 */
import { useEffect, useState } from 'react';

export const COMPANY_PAGES = ['inbox', 'overview', 'work', 'team', 'memory', 'money', 'history', 'settings'] as const;
export type CompanyPage = (typeof COMPANY_PAGES)[number];

export const SETTINGS_SECTIONS = ['company', 'language', 'safeguards', 'skills', 'bundles', 'devices', 'security'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEPLOYMENT_SECTIONS = ['model', 'agents'] as const;
export type DeploymentSection = (typeof DEPLOYMENT_SECTIONS)[number];

export type Route =
  | { kind: 'home' }
  | { kind: 'deployment'; section: DeploymentSection }
  | { kind: 'company'; companyId: string; page: CompanyPage; section: SettingsSection; item: string | null };

export function parse(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'c' && parts[1]) {
    const page = (COMPANY_PAGES as readonly string[]).includes(parts[2] ?? '') ? parts[2] as CompanyPage : 'inbox';
    const section = (SETTINGS_SECTIONS as readonly string[]).includes(parts[3] ?? '') ? parts[3] as SettingsSection : 'company';
    return { kind: 'company', companyId: parts[1], page, section, item: new URLSearchParams(query).get('item') };
  }
  if (parts[0] === 'deployment') {
    const section = (DEPLOYMENT_SECTIONS as readonly string[]).includes(parts[1] ?? '') ? parts[1] as DeploymentSection : 'model';
    return { kind: 'deployment', section };
  }
  return { kind: 'home' };
}

export function href(route: Route): string {
  if (route.kind === 'home') return '#/home';
  if (route.kind === 'deployment') return `#/deployment/${route.section}`;
  const base = `#/c/${route.companyId}/${route.page}`;
  const withSection = route.page === 'settings' ? `${base}/${route.section}` : base;
  return route.item ? `${withSection}?item=${encodeURIComponent(route.item)}` : withSection;
}

/**
 * Moves to `route`. `replace` for a move the back button should not stop at:
 * the inbox opening the next item by itself, a drawer closing.
 */
export function go(route: Route, options: { replace?: boolean } = {}): void {
  const next = href(route);
  if (window.location.hash === next) return;
  if (options.replace) {
    window.history.replaceState(null, '', next);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = next;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const changed = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return route;
}

/**
 * A notification's link: `/?company=<id>&item=<id>`. Turned into a route
 * once, on the first draw, and the query dropped, so a reload does not keep
 * jumping back to an item that has since been decided.
 */
export function takeLinkedRoute(): void {
  const query = new URLSearchParams(window.location.search);
  const companyId = query.get('company');
  if (!companyId) return;
  const item = query.get('item');
  // A notice that work finished links to the task, in the company's work (0059).
  const task = query.get('task');
  window.history.replaceState(null, '', `${window.location.pathname}${href(task
    ? { kind: 'company', companyId, page: 'work', section: 'company', item: task }
    : { kind: 'company', companyId, page: 'inbox', section: 'company', item })}`);
}
