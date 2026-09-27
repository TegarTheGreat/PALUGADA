/**
 * MCP servers the console offers by name, so the owner picks one and pastes
 * a key instead of finding an address and how its token is sent.
 *
 * Each entry is what its vendor's own documentation said in September 2026:
 * the streamable HTTP address, where the token goes, and where one is made.
 * None was called with a live key. Servers that take only OAuth (Notion,
 * Vercel) are not here: this client sends a token it is given and runs no
 * sign-in flow. A preset only fills the form -- the owner still looks at the
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
  key: 'required' | 'none';
  keyUrl?: string;
  /** Which kind of key, when the vendor offers several and only one works. */
  keyHint?: string;
  /** For a server the owner runs: the command that starts it. */
  run?: string;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'github', name: 'GitHub', about: 'Repositories, issues and pull requests', url: 'https://api.githubcopilot.com/mcp/',
    key: 'required', keyUrl: 'https://github.com/settings/personal-access-tokens/new',
    keyHint: 'A fine-grained personal access token, limited to the repositories and permissions roles need.',
  },
  {
    id: 'linear', name: 'Linear', about: 'Issues and projects', url: 'https://mcp.linear.app/mcp',
    key: 'required', keyUrl: 'https://linear.app/settings/account/security', keyHint: 'A personal API key.',
  },
  {
    id: 'stripe', name: 'Stripe', about: 'Payments, customers and invoices', url: 'https://mcp.stripe.com',
    key: 'required', keyUrl: 'https://dashboard.stripe.com/apikeys',
    keyHint: 'A restricted key tagged for agents: from 31 October 2026 Stripe refuses a secret key here.',
  },
  {
    id: 'atlassian', name: 'Atlassian', about: 'Jira and Confluence', url: 'https://mcp.atlassian.com/v2/mcp',
    key: 'required', keyHint: 'An API key for a service account, which an organisation admin makes; a personal token is refused.',
  },
  {
    id: 'sentry', name: 'Sentry', about: 'Errors and performance', url: 'https://mcp.sentry.dev/mcp',
    tokenIn: { scheme: 'Sentry-Bearer' }, key: 'required', keyHint: 'A user auth token from Sentry\'s settings.',
  },
  {
    id: 'cloudflare', name: 'Cloudflare', about: 'Your Cloudflare account', url: 'https://mcp.cloudflare.com/mcp',
    key: 'required', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  {
    id: 'neon', name: 'Neon', about: 'Postgres databases', url: 'https://mcp.neon.tech/mcp',
    key: 'required', keyUrl: 'https://neon.com/docs/manage/api-keys',
  },
  {
    id: 'zapier', name: 'Zapier', about: 'Other apps, through the actions you set up in Zapier', url: 'https://mcp.zapier.com/api/v1/connect',
    key: 'required', keyUrl: 'https://mcp.zapier.com',
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
