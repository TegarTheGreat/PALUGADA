/**
 * MCP servers the console offers by name, so the owner picks one and signs in
 * or pastes a key, instead of finding an address and how its token is sent.
 *
 * Each entry is what its vendor's own documentation said in September 2026:
 * the streamable HTTP address, how PALUGADA is let in, and where a key or a
 * client is made. Where the vendor publishes OAuth metadata with a
 * registration endpoint, that metadata was read; none was signed in to, and
 * none was called with a live key.
 *
 * Three ways in, and a server may offer more than one:
 * - `signIn: 'registers'`: the server registers PALUGADA as a client itself
 *   (RFC 7591), so the owner only signs in, in a new tab.
 * - `signIn: 'client'`: the vendor registers no client on request. The owner
 *   makes one at `clientUrl`, with PALUGADA's return address, and pastes its
 *   ID and secret before signing in.
 * - `key`: a token the owner pastes. `optional` where signing in is the other
 *   way.
 *
 * Left out on purpose: Vercel, Figma and Canva publish a registration
 * endpoint but accept only clients they have approved, so a sign-in from here
 * would be refused; Google Workspace's servers are a developer preview that
 * needs enrolment; and a server whose documented address did not answer as
 * documented. A preset only fills the form -- the owner still looks at the
 * tools, allows each one and chooses its tier, and the rules are the same as
 * for any other server.
 */
import type { TokenIn } from './mcp.ts';

export interface McpPreset {
  /** Also the server's name here, so each tool is `mcp.<id>.<tool>`. */
  id: string;
  name: string;
  about: string;
  url: string;
  tokenIn?: TokenIn;
  key: 'required' | 'optional' | 'none';
  keyUrl?: string;
  /** Which kind of key, when the vendor offers several and only one works. */
  keyHint?: string;
  /** How the owner signs in instead of pasting a key, when they can. */
  signIn?: 'registers' | 'client';
  /** Where the owner registers a client, for `signIn: 'client'`. */
  clientUrl?: string;
  /** For a server the owner runs: the command that starts it. */
  run?: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'github', name: 'GitHub', about: 'Repositories, issues and pull requests', url: 'https://api.githubcopilot.com/mcp/',
    key: 'optional', keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    keyHint: 'A fine-grained personal access token, limited to the repositories and permissions roles need.',
    signIn: 'client', clientUrl: 'https://github.com/settings/applications/new',
  },
  {
    id: 'notion', name: 'Notion', about: 'Pages, databases and comments', url: 'https://mcp.notion.com/mcp',
    key: 'none', signIn: 'registers',
  },
  {
    id: 'linear', name: 'Linear', about: 'Issues and projects', url: 'https://mcp.linear.app/mcp',
    key: 'optional', keyUrl: 'https://linear.app/settings/account/security', keyHint: 'A personal API key.',
    signIn: 'registers',
  },
  {
    id: 'atlassian', name: 'Atlassian', about: 'Jira and Confluence', url: 'https://mcp.atlassian.com/v2/mcp',
    key: 'optional', keyHint: 'An API key for a service account, which an organisation admin makes; a personal token is refused.',
    signIn: 'registers',
  },
  {
    id: 'airtable', name: 'Airtable', about: 'Bases, tables and records', url: 'https://mcp.airtable.com/mcp',
    key: 'optional', keyUrl: 'https://airtable.com/create/tokens', signIn: 'registers',
  },
  {
    id: 'monday', name: 'monday.com', about: 'Boards, items and updates', url: 'https://mcp.monday.com/mcp',
    key: 'optional', keyHint: 'A personal API token, from the Developers section of your profile.', signIn: 'registers',
  },
  {
    id: 'asana', name: 'Asana', about: 'Projects and tasks', url: 'https://mcp.asana.com/v2/mcp',
    key: 'none', signIn: 'client', clientUrl: 'https://app.asana.com/0/my-apps',
  },
  {
    id: 'slack', name: 'Slack', about: 'Channels, messages and search', url: 'https://mcp.slack.com/mcp',
    key: 'none', signIn: 'client', clientUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'hubspot', name: 'HubSpot', about: 'Contacts, companies and deals', url: 'https://mcp.hubspot.com',
    key: 'none', signIn: 'client', clientUrl: 'https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server',
  },
  {
    id: 'intercom', name: 'Intercom', about: 'Conversations and contacts', url: 'https://mcp.intercom.com/mcp',
    key: 'optional', keyHint: 'An access token from an app in your Developer Hub.', signIn: 'registers',
  },
  {
    id: 'box', name: 'Box', about: 'Files and folders', url: 'https://mcp.box.com',
    key: 'none', signIn: 'client', clientUrl: 'https://app.box.com/developers/console',
  },
  {
    id: 'webflow', name: 'Webflow', about: 'Sites, pages and CMS collections', url: 'https://mcp.webflow.com/mcp',
    key: 'none', signIn: 'registers',
  },
  {
    id: 'stripe', name: 'Stripe', about: 'Payments, customers and invoices', url: 'https://mcp.stripe.com',
    key: 'optional', keyUrl: 'https://dashboard.stripe.com/apikeys',
    keyHint: 'A restricted key tagged for agents: from 31 October 2026 Stripe refuses a secret key here.',
    signIn: 'registers',
  },
  {
    id: 'square', name: 'Square', about: 'Payments, orders and catalogue', url: 'https://mcp.squareup.com/mcp',
    key: 'none', signIn: 'registers',
  },
  {
    id: 'resend', name: 'Resend', about: 'Email sending and domains', url: 'https://mcp.resend.com/mcp',
    key: 'optional', keyUrl: 'https://resend.com/api-keys', signIn: 'registers',
  },
  {
    id: 'sentry', name: 'Sentry', about: 'Errors and performance', url: 'https://mcp.sentry.dev/mcp',
    tokenIn: { scheme: 'Sentry-Bearer' }, key: 'optional', keyHint: 'A user auth token from Sentry\'s settings.',
    signIn: 'registers',
  },
  {
    id: 'cloudflare', name: 'Cloudflare', about: 'Your Cloudflare account', url: 'https://mcp.cloudflare.com/mcp',
    key: 'optional', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', signIn: 'registers',
  },
  {
    id: 'supabase', name: 'Supabase', about: 'Projects, databases and functions', url: 'https://mcp.supabase.com/mcp',
    key: 'optional', keyUrl: 'https://supabase.com/dashboard/account/tokens', signIn: 'registers',
  },
  {
    id: 'neon', name: 'Neon', about: 'Postgres databases', url: 'https://mcp.neon.tech/mcp',
    key: 'optional', keyUrl: 'https://neon.com/docs/manage/api-keys', signIn: 'registers',
  },
  {
    id: 'zapier', name: 'Zapier', about: 'Other apps, through the actions you set up in Zapier', url: 'https://mcp.zapier.com/api/v1/connect',
    key: 'optional', keyUrl: 'https://mcp.zapier.com', signIn: 'registers',
  },
  {
    id: 'apify', name: 'Apify', about: 'Ready-made scrapers and automations', url: 'https://mcp.apify.com',
    key: 'required', keyUrl: 'https://console.apify.com/settings/integrations',
  },
  {
    id: 'huggingface', name: 'Hugging Face', about: 'Models, datasets and Spaces', url: 'https://huggingface.co/mcp',
    key: 'required', keyUrl: 'https://huggingface.co/settings/tokens',
  },
  {
    id: 'context7', name: 'Context7', about: 'Current documentation for code libraries', url: 'https://mcp.context7.com/mcp',
    key: 'required', keyUrl: 'https://context7.com/dashboard',
  },
  {
    id: 'firecrawl', name: 'Firecrawl', about: 'Scrape, crawl and search the web', url: 'https://mcp.firecrawl.dev/v2/mcp',
    key: 'required', keyUrl: 'https://www.firecrawl.dev/app/api-keys',
  },
  {
    id: 'tavily', name: 'Tavily', about: 'Search built for agents', url: 'https://mcp.tavily.com/mcp/',
    key: 'required', keyUrl: 'https://app.tavily.com/home',
  },
  {
    id: 'exa', name: 'Exa', about: 'Search by meaning', url: 'https://mcp.exa.ai/mcp',
    tokenIn: { header: 'x-api-key' }, key: 'required', keyUrl: 'https://dashboard.exa.ai/api-keys',
  },
  {
    id: 'browserbase', name: 'Browserbase', about: 'A browser in the cloud', url: 'https://mcp.browserbase.com/mcp',
    tokenIn: { query: 'browserbaseApiKey' }, key: 'required', keyUrl: 'https://www.browserbase.com/overview',
  },
  {
    // Checked end to end: version 0.0.82 drove Chromium for a task, its
    // navigation read back in the same session.
    id: 'playwright', name: 'Playwright', about: 'A real browser, on a machine of yours', url: 'http://localhost:8931/mcp',
    key: 'none', run: 'npx @playwright/mcp@0.0.82 --port 8931 --headless',
  },
];
