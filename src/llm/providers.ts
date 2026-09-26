/**
 * The model providers an owner can pick from, by name, instead of by address.
 *
 * Every entry is one of the two wire protocols the platform speaks
 * (`models.ts`): Anthropic's Messages API, or an OpenAI-compatible Chat
 * Completions API. The catalogue adds nothing to what a deployment can reach
 * -- "another OpenAI-compatible API" with an address reaches all of these --
 * it saves the owner from looking up an address and a key page, and it is the
 * one list both `npm run setup` and the console offer, so the two cannot
 * drift apart.
 *
 * An address here is the one the provider documents for its compatible API,
 * checked against its documentation in September 2026, and each was asked
 * for its models without a key to see that the route exists; the few read
 * only from Hermes' or OpenClaw's code say so (`checked`). An address with
 * `{placeholders}` is per account (Azure, Bedrock, Cloudflare), and the owner
 * types theirs. A provider that only signs requests with a cloud identity
 * (Vertex's hour-long OAuth tokens) is not here: the platform sends a key, and
 * a key is what an entry promises the owner will be asked for. Subscription
 * logins (Claude, ChatGPT) are for agent CLIs, not here (`settings/agents.ts`).
 */
import type { ModelProvider } from './models.ts';

export interface ModelProviderEntry {
  /** Stable, kebab-case: kept with the owner's choice. */
  id: string;
  name: string;
  /** What it is, in a few words, beside the name, where the name does not say. */
  about?: string;
  /**
   * `plan` is a subscription key sold for coding tools, which works over the
   * same protocol but whose terms may not cover a company run by agents:
   * the console says so before one is saved.
   */
  group: 'lab' | 'router' | 'cloud' | 'plan' | 'local' | 'custom';
  protocol: ModelProvider;
  /** The API's address; absent when the owner types it (their own server, their own deployment). */
  url?: string;
  /** What to type when there is no fixed address. */
  urlExample?: string;
  /** Where a model on the host is found from inside a container. */
  dockerUrl?: string;
  key: 'required' | 'optional' | 'none';
  /** The provider's own page for making a key. */
  keyUrl?: string;
  /** A model it serves, shown as an example; the console lists the rest from the API. */
  example?: string;
  /** Offered by `npm run setup` as well, in this order; the console offers every entry. */
  featured?: true;
  /** `source` when the address was read from Hermes' or OpenClaw's code and not found in the provider's own documentation. */
  checked?: 'source';
}

export const MODEL_PROVIDERS: readonly ModelProviderEntry[] = [
  { id: 'anthropic', name: 'Anthropic', about: 'Claude, by tier: Haiku, Sonnet, Opus', group: 'lab', protocol: 'anthropic', url: 'https://api.anthropic.com', key: 'required', keyUrl: 'https://platform.claude.com/settings/keys', example: 'claude-sonnet-5', featured: true },
  { id: 'openai', name: 'OpenAI', about: 'GPT models, with an API key', group: 'lab', protocol: 'openai', url: 'https://api.openai.com/v1', key: 'required', keyUrl: 'https://platform.openai.com/api-keys', example: 'gpt-6-sol', featured: true },
  { id: 'openrouter', name: 'OpenRouter', about: 'Models from every lab behind one key', group: 'router', protocol: 'openai', url: 'https://openrouter.ai/api/v1', key: 'required', keyUrl: 'https://openrouter.ai/settings/keys', example: 'anthropic/claude-sonnet-5', featured: true },
  { id: 'google-ai-studio', name: 'Google Gemini', about: 'Gemini, through Google AI Studio', group: 'lab', protocol: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'required', keyUrl: 'https://aistudio.google.com/apikey', example: 'gemini-3.8-flash', featured: true },
  { id: 'ollama', name: 'Ollama', about: 'A model on this machine', group: 'local', protocol: 'openai', url: 'http://localhost:11434/v1', dockerUrl: 'http://host.docker.internal:11434/v1', key: 'none', example: 'gemma4:31b', featured: true },
  { id: 'custom', name: 'Another OpenAI-compatible API', about: 'Any address that speaks Chat Completions', group: 'custom', protocol: 'openai', urlExample: 'https://example.com/v1', key: 'optional', featured: true },
  { id: 'alibaba-dashscope-intl', name: 'Qwen Cloud / DashScope (Singapore, pay-as-you-go)', group: 'lab', protocol: 'openai', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', key: 'required', keyUrl: 'https://modelstudio.console.alibabacloud.com/model/settings/api-key', example: 'qwen3.7-plus' },
  { id: 'alibaba-dashscope-cn', name: 'Qwen / DashScope (China, Beijing, pay-as-you-go)', group: 'lab', protocol: 'openai', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', key: 'required', keyUrl: 'https://bailian.console.aliyun.com/', example: 'qwen3.7-plus' },
  { id: 'alibaba-dashscope-us', name: 'Qwen / DashScope (US, Virginia, pay-as-you-go)', group: 'lab', protocol: 'openai', url: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1', key: 'required', keyUrl: 'https://modelstudio.console.alibabacloud.com/model/settings/api-key', example: 'qwen3.7-plus' },
  { id: 'alibaba-dashscope-workspace', name: 'Qwen / Model Studio (workspace-dedicated domain)', group: 'lab', protocol: 'openai', urlExample: 'https://{workspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1', key: 'required', keyUrl: 'https://modelstudio.console.alibabacloud.com/model/settings/api-key', example: 'qwen3.7-plus' },
  { id: 'xai', name: 'xAI Grok (API key)', group: 'lab', protocol: 'openai', url: 'https://api.x.ai/v1', key: 'required', keyUrl: 'https://console.x.ai/team/default/api-keys', example: 'grok-4.3' },
  { id: 'xiaomi-mimo', name: 'Xiaomi MiMo (pay-as-you-go)', group: 'lab', protocol: 'openai', url: 'https://api.xiaomimimo.com/v1', key: 'required', keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys', example: 'mimo-v2.5-pro' },
  { id: 'tencent-tokenhub', name: 'Tencent Hy / TokenHub (Singapore)', group: 'lab', protocol: 'openai', url: 'https://tokenhub-intl.tencentcloudmaas.com/v1', key: 'required', keyUrl: 'https://console.tencentcloud.com/tokenhub', example: 'deepseek-v4-pro' },
  { id: 'deepseek', name: 'DeepSeek', group: 'lab', protocol: 'openai', url: 'https://api.deepseek.com', key: 'required', keyUrl: 'https://platform.deepseek.com/api_keys', example: 'deepseek-v4-pro' },
  { id: 'deepseek-anthropic', name: 'DeepSeek (Anthropic-compatible)', group: 'lab', protocol: 'anthropic', url: 'https://api.deepseek.com/anthropic', key: 'required', keyUrl: 'https://platform.deepseek.com/api_keys', example: 'deepseek-v4-pro' },
  { id: 'zai', name: 'Z.AI / GLM (global, pay-as-you-go)', group: 'lab', protocol: 'openai', url: 'https://api.z.ai/api/paas/v4', key: 'required', keyUrl: 'https://z.ai/manage-apikey/apikey-list', example: 'glm-5.2' },
  { id: 'zai-anthropic', name: 'Z.AI / GLM (Anthropic-compatible)', group: 'lab', protocol: 'anthropic', url: 'https://api.z.ai/api/anthropic', key: 'required', keyUrl: 'https://z.ai/manage-apikey/apikey-list', example: 'glm-5.2' },
  { id: 'zhipu-bigmodel-cn', name: 'Zhipu BigModel (China)', group: 'lab', protocol: 'openai', url: 'https://open.bigmodel.cn/api/paas/v4', key: 'required', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', example: 'glm-5.2' },
  { id: 'moonshot', name: 'Kimi / Moonshot (global)', group: 'lab', protocol: 'openai', url: 'https://api.moonshot.ai/v1', key: 'required', keyUrl: 'https://platform.kimi.ai/console/api-keys', example: 'kimi-k2.6' },
  { id: 'moonshot-cn', name: 'Kimi / Moonshot (China)', group: 'lab', protocol: 'openai', url: 'https://api.moonshot.cn/v1', key: 'required', keyUrl: 'https://platform.kimi.com/console/api-keys', example: 'kimi-k2.6' },
  { id: 'stepfun', name: 'StepFun (pay-as-you-go, global)', group: 'lab', protocol: 'openai', url: 'https://api.stepfun.ai/v1', key: 'required', keyUrl: 'https://platform.stepfun.ai/interface-key', example: 'step-3.7-flash' },
  { id: 'minimax', name: 'MiniMax (global, Anthropic-compatible)', group: 'lab', protocol: 'anthropic', url: 'https://api.minimax.io/anthropic', key: 'required', keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key', example: 'MiniMax-M2.7' },
  { id: 'minimax-openai', name: 'MiniMax (global, OpenAI-compatible)', group: 'lab', protocol: 'openai', url: 'https://api.minimax.io/v1', key: 'required', keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key', example: 'MiniMax-M2.7' },
  { id: 'minimax-cn', name: 'MiniMax (China, Anthropic-compatible)', group: 'lab', protocol: 'anthropic', url: 'https://api.minimax.cn/anthropic', key: 'required', keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key', example: 'MiniMax-M2.7' },
  { id: 'arcee', name: 'Arcee AI', group: 'lab', protocol: 'openai', url: 'https://api.arcee.ai/api/v1', key: 'required', keyUrl: 'https://platform.arcee.ai/api/api-keys', example: 'trinity-large-preview' },
  { id: 'meta-model-api', name: 'Meta Model API (Muse Spark)', group: 'lab', protocol: 'openai', url: 'https://api.meta.ai/v1', key: 'required', keyUrl: 'https://dev.meta.ai/', example: 'muse-spark-1.2' },
  { id: 'upstage', name: 'Upstage (Solar)', group: 'lab', protocol: 'openai', url: 'https://api.upstage.ai/v1', key: 'required', keyUrl: 'https://console.upstage.ai/api-keys', example: 'solar-pro4' },
  { id: 'nous-portal', name: 'Nous Portal', group: 'lab', protocol: 'openai', url: 'https://inference-api.nousresearch.com/v1', key: 'required', keyUrl: 'https://portal.nousresearch.com/', example: 'anthropic/claude-sonnet-5' },
  { id: 'mistral', name: 'Mistral AI', group: 'lab', protocol: 'openai', url: 'https://api.mistral.ai/v1', key: 'required', keyUrl: 'https://console.mistral.ai/api-keys', example: 'mistral-medium-3-5' },
  { id: 'cohere', name: 'Cohere (Compatibility API)', group: 'lab', protocol: 'openai', url: 'https://api.cohere.ai/compatibility/v1', key: 'required', keyUrl: 'https://dashboard.cohere.com/api-keys', example: 'command-a-03-2025' },
  { id: 'longcat', name: 'Meituan LongCat', group: 'lab', protocol: 'openai', url: 'https://api.longcat.chat/openai/v1', key: 'required', keyUrl: 'https://longcat.chat/platform/api_keys', example: 'LongCat-2.0' },
  { id: 'baidu-qianfan', name: 'Baidu Qianfan (China)', group: 'lab', protocol: 'openai', url: 'https://qianfan.baidubce.com/v2', key: 'required', keyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/apiKey', example: 'ernie-5.1' },
  { id: 'novita', name: 'NovitaAI', group: 'router', protocol: 'openai', url: 'https://api.novita.ai/openai', key: 'required', keyUrl: 'https://novita.ai/settings/key-management', example: 'zai-org/glm-5.3' },
  { id: 'huggingface', name: 'Hugging Face Inference Providers', group: 'router', protocol: 'openai', url: 'https://router.huggingface.co/v1', key: 'required', keyUrl: 'https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write', example: 'zai-org/GLM-5.3' },
  { id: 'kilo-gateway', name: 'Kilo Code (Kilo Gateway)', group: 'router', protocol: 'openai', url: 'https://api.kilo.ai/api/gateway', key: 'required', keyUrl: 'https://app.kilo.ai/profile', example: 'kilo-auto/balanced' },
  { id: 'opencode-zen', name: 'OpenCode Zen (pay-as-you-go)', group: 'router', protocol: 'openai', url: 'https://opencode.ai/zen/v1', key: 'required', keyUrl: 'https://opencode.ai/auth', example: 'glm-5.3' },
  { id: 'opencode-zen-anthropic', name: 'OpenCode Zen (Anthropic-compatible)', group: 'router', protocol: 'anthropic', url: 'https://opencode.ai/zen', key: 'required', keyUrl: 'https://opencode.ai/auth', example: 'claude-sonnet-5' },
  { id: 'vercel-ai-gateway', name: 'Vercel AI Gateway', group: 'router', protocol: 'openai', url: 'https://ai-gateway.vercel.sh/v1', key: 'required', keyUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys', example: 'anthropic/claude-sonnet-5' },
  { id: 'commandcode', name: 'CommandCode Provider API (OpenAI-compatible)', group: 'router', protocol: 'openai', url: 'https://api.commandcode.ai/provider/v1', key: 'required', keyUrl: 'https://commandcode.ai/settings/keys', example: 'zai-org/GLM-5.3' },
  { id: 'commandcode-anthropic', name: 'CommandCode Provider API (Anthropic-compatible)', group: 'router', protocol: 'anthropic', url: 'https://api.commandcode.ai/provider', key: 'required', keyUrl: 'https://commandcode.ai/settings/keys', example: 'claude-sonnet-5' },
  { id: 'perplexity', name: 'Perplexity (Router API)', group: 'router', protocol: 'openai', url: 'https://api.perplexity.ai/router/v1', key: 'required', keyUrl: 'https://console.perplexity.ai/project/keys', example: 'perplexity/kimi-k3' },
  { id: 'venice', name: 'Venice AI', group: 'router', protocol: 'openai', url: 'https://api.venice.ai/api/v1', key: 'required', keyUrl: 'https://venice.ai/settings/api', example: 'kimi-k3' },
  { id: 'chutes', name: 'Chutes', group: 'router', protocol: 'openai', url: 'https://llm.chutes.ai/v1', key: 'required', keyUrl: 'https://chutes.ai/app/settings/api-keys', example: 'zai-org/GLM-5.2-TEE', checked: 'source' },
  { id: 'featherless', name: 'Featherless AI', group: 'router', protocol: 'openai', url: 'https://api.featherless.ai/v1', key: 'required', keyUrl: 'https://featherless.ai/account/api-keys', example: 'zai-org/GLM-5.3' },
  { id: 'synthetic', name: 'Synthetic', group: 'router', protocol: 'openai', url: 'https://api.synthetic.new/openai/v1', key: 'required', keyUrl: 'https://synthetic.new/user-settings/api', example: 'syn:large:text' },
  { id: 'fireworks', name: 'Fireworks AI', group: 'cloud', protocol: 'openai', url: 'https://api.fireworks.ai/inference/v1', key: 'required', keyUrl: 'https://app.fireworks.ai/settings/users/api-keys', example: 'accounts/fireworks/models/glm-5p3' },
  { id: 'nvidia-nim', name: 'NVIDIA NIM (build.nvidia.com)', group: 'cloud', protocol: 'openai', url: 'https://integrate.api.nvidia.com/v1', key: 'required', keyUrl: 'https://build.nvidia.com/settings/api-keys', example: 'nvidia/nemotron-3-super-120b-a12b' },
  { id: 'ollama-cloud', name: 'Ollama Cloud', group: 'cloud', protocol: 'openai', url: 'https://ollama.com/v1', key: 'required', keyUrl: 'https://ollama.com/settings/keys', example: 'glm-5.3' },
  { id: 'gmi-cloud', name: 'GMI Cloud', group: 'cloud', protocol: 'openai', url: 'https://api.gmi-serving.com/v1', key: 'required', keyUrl: 'https://console.gmicloud.ai/user-setting/organization/api-key', example: 'zai-org/GLM-5.2-FP8' },
  { id: 'aws-bedrock-openai', name: 'AWS Bedrock (OpenAI-compatible, bedrock-runtime)', group: 'cloud', protocol: 'openai', urlExample: 'https://bedrock-runtime.{region}.amazonaws.com/openai/v1', key: 'required', keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys', example: 'openai.gpt-oss-120b-1:0' },
  { id: 'aws-bedrock-mantle', name: 'AWS Bedrock (OpenAI-compatible, bedrock-mantle)', group: 'cloud', protocol: 'openai', urlExample: 'https://bedrock-mantle.{region}.api.aws/v1', key: 'required', keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys', example: 'openai.gpt-oss-120b' },
  { id: 'aws-bedrock-anthropic', name: 'AWS Bedrock (Claude via Anthropic Messages)', group: 'cloud', protocol: 'anthropic', urlExample: 'https://bedrock-runtime.{region}.amazonaws.com/anthropic', key: 'required', keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys', example: 'us.anthropic.claude-sonnet-5' },
  { id: 'azure-openai', name: 'Azure OpenAI (v1 API)', group: 'cloud', protocol: 'openai', urlExample: 'https://{resource}.openai.azure.com/openai/v1', key: 'required', keyUrl: 'https://ai.azure.com/', example: 'gpt-6-sol' },
  { id: 'azure-foundry-openai', name: 'Microsoft Foundry (OpenAI-compatible)', group: 'cloud', protocol: 'openai', urlExample: 'https://{resource}.services.ai.azure.com/openai/v1', key: 'required', keyUrl: 'https://ai.azure.com/', example: 'gpt-6-sol' },
  { id: 'azure-foundry-anthropic', name: 'Microsoft Foundry (Claude, Anthropic-compatible)', group: 'cloud', protocol: 'anthropic', urlExample: 'https://{resource}.services.ai.azure.com/anthropic', key: 'required', keyUrl: 'https://ai.azure.com/', example: 'claude-sonnet-5' },
  { id: 'actual-computer', name: 'Actual Computer', group: 'cloud', protocol: 'openai', url: 'https://api.actual.inc/v1', key: 'required', keyUrl: 'https://actual.inc/user/keys' },
  { id: 'deepinfra', name: 'DeepInfra', group: 'cloud', protocol: 'openai', url: 'https://api.deepinfra.com/v1/openai', key: 'required', keyUrl: 'https://deepinfra.com/dash/api_keys', example: 'zai-org/GLM-5.3' },
  { id: 'nebius-token-factory', name: 'Nebius Token Factory', group: 'cloud', protocol: 'openai', url: 'https://api.tokenfactory.nebius.com/v1', key: 'required', keyUrl: 'https://tokenfactory.nebius.com/project/api-keys', example: 'zai-org/GLM-5.1' },
  { id: 'groq', name: 'Groq', group: 'cloud', protocol: 'openai', url: 'https://api.groq.com/openai/v1', key: 'required', keyUrl: 'https://console.groq.com/keys', example: 'qwen/qwen3.8-27b' },
  { id: 'together', name: 'Together AI', group: 'cloud', protocol: 'openai', url: 'https://api.together.ai/v1', key: 'required', keyUrl: 'https://api.together.ai/settings/projects/~current/api-keys', example: 'zai-org/GLM-5.3' },
  { id: 'cerebras', name: 'Cerebras Inference', group: 'cloud', protocol: 'openai', url: 'https://api.cerebras.ai/v1', key: 'required', keyUrl: 'https://cloud.cerebras.ai/platform', example: 'gpt-oss-120b' },
  { id: 'sambanova', name: 'SambaNova Cloud', group: 'cloud', protocol: 'openai', url: 'https://api.sambanova.ai/v1', key: 'required', keyUrl: 'https://cloud.sambanova.ai/apis', example: 'gpt-oss-120b' },
  { id: 'baseten', name: 'Baseten Model APIs', group: 'cloud', protocol: 'openai', url: 'https://inference.baseten.co/v1', key: 'required', keyUrl: 'https://app.baseten.co/settings/api_keys', example: 'zai-org/GLM-5.3' },
  { id: 'byteplus-modelark', name: 'BytePlus ModelArk (international)', group: 'cloud', protocol: 'openai', url: 'https://ark.ap-southeast.bytepluses.com/api/v3', key: 'required', keyUrl: 'https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey', example: 'dola-seed-2-1-turbo-260628' },
  { id: 'volcengine-ark', name: 'Volcano Engine Ark (China)', group: 'cloud', protocol: 'openai', url: 'https://ark.cn-beijing.volces.com/api/v3', key: 'required', keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', example: 'doubao-seed-2-1-pro-260628' },
  { id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', group: 'cloud', protocol: 'openai', urlExample: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1', key: 'required', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', example: '@cf/openai/gpt-oss-20b' },
  { id: 'cloudflare-ai-gateway', name: 'Cloudflare AI Gateway (unified /compat)', group: 'cloud', protocol: 'openai', urlExample: 'https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayId}/compat', key: 'required', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', example: 'openai/gpt-6-sol' },
  { id: 'alibaba-coding-plan', name: 'Qwen / Alibaba Coding Plan (international)', group: 'plan', protocol: 'openai', url: 'https://coding-intl.dashscope.aliyuncs.com/v1', key: 'required', keyUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/coding-plan', example: 'qwen3.6-plus' },
  { id: 'alibaba-coding-plan-cn', name: 'Qwen / Alibaba Coding Plan (China)', group: 'plan', protocol: 'openai', url: 'https://coding.dashscope.aliyuncs.com/v1', key: 'required', keyUrl: 'https://bailian.console.aliyun.com/', example: 'qwen3.6-plus' },
  { id: 'alibaba-token-plan', name: 'Qwen / Alibaba Token Plan (Singapore)', group: 'plan', protocol: 'openai', url: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', key: 'required', keyUrl: 'https://modelstudio.console.alibabacloud.com/', example: 'qwen3.7-plus' },
  { id: 'alibaba-token-plan-cn', name: 'Qwen / Alibaba Token Plan (China, Beijing)', group: 'plan', protocol: 'openai', url: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', key: 'required', keyUrl: 'https://bailian.console.aliyun.com/', example: 'qwen3.7-plus', checked: 'source' },
  { id: 'xiaomi-mimo-token-plan', name: 'Xiaomi MiMo Token Plan (Singapore cluster)', group: 'plan', protocol: 'openai', url: 'https://token-plan-sgp.xiaomimimo.com/v1', key: 'required', keyUrl: 'https://platform.xiaomimimo.com/#/console/plan-manage', example: 'mimo-v2.5-pro' },
  { id: 'tencent-tokenplan', name: 'Tencent Hy / TokenPlan (Singapore)', group: 'plan', protocol: 'openai', url: 'https://tokenhub-intl.tencentcloudmaas.com/plan/v3', key: 'required', keyUrl: 'https://console.tencentcloud.com/tokenhub', example: 'hy3' },
  { id: 'tencent-tokenplan-cn', name: 'Tencent Hy / TokenPlan (China, LKEAP)', group: 'plan', protocol: 'anthropic', url: 'https://api.lkeap.cloud.tencent.com/plan/anthropic', key: 'required', keyUrl: 'https://console.cloud.tencent.com/', example: 'hy3', checked: 'source' },
  { id: 'zai-coding-plan', name: 'Z.AI GLM Coding Plan (global)', group: 'plan', protocol: 'openai', url: 'https://api.z.ai/api/coding/paas/v4', key: 'required', keyUrl: 'https://z.ai/manage-apikey/apikey-list', example: 'glm-5.2' },
  { id: 'zhipu-bigmodel-cn-coding', name: 'Zhipu BigModel Coding Plan (China)', group: 'plan', protocol: 'openai', url: 'https://open.bigmodel.cn/api/coding/paas/v4', key: 'required', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', example: 'glm-5.2', checked: 'source' },
  { id: 'kimi-code', name: 'Kimi Code plan (overseas)', group: 'plan', protocol: 'openai', url: 'https://api.kimi.ai/coding/v1', key: 'required', keyUrl: 'https://www.kimi.com/code/console', example: 'kimi-for-coding' },
  { id: 'kimi-code-anthropic', name: 'Kimi Code plan (overseas, Anthropic-compatible)', group: 'plan', protocol: 'anthropic', url: 'https://api.kimi.ai/coding', key: 'required', keyUrl: 'https://www.kimi.com/code/console', example: 'kimi-for-coding' },
  { id: 'kimi-code-cn', name: 'Kimi Code plan (China)', group: 'plan', protocol: 'openai', url: 'https://api.kimi.com/coding/v1', key: 'required', keyUrl: 'https://www.kimi.com/code/console', example: 'kimi-for-coding' },
  { id: 'stepfun-step-plan', name: 'StepFun Step Plan (global)', group: 'plan', protocol: 'openai', url: 'https://api.stepfun.ai/step_plan/v1', key: 'required', keyUrl: 'https://platform.stepfun.ai/interface-key', example: 'step-3.7-flash' },
  { id: 'stepfun-step-plan-cn', name: 'StepFun Step Plan (China)', group: 'plan', protocol: 'openai', url: 'https://api.stepfun.com/step_plan/v1', key: 'required', keyUrl: 'https://platform.stepfun.com/interface-key', example: 'step-3.7-flash', checked: 'source' },
  { id: 'opencode-go', name: 'OpenCode Go (subscription)', group: 'plan', protocol: 'openai', url: 'https://opencode.ai/zen/go/v1', key: 'required', keyUrl: 'https://opencode.ai/auth', example: 'glm-5.3' },
  { id: 'lmstudio', name: 'LM Studio (local)', group: 'local', protocol: 'openai', url: 'http://localhost:1234/v1', dockerUrl: 'http://host.docker.internal:1234/v1', key: 'optional' },
  { id: 'nvidia-nim-local', name: 'NVIDIA NIM (self-hosted container)', group: 'local', protocol: 'openai', url: 'http://localhost:8000/v1', dockerUrl: 'http://host.docker.internal:8000/v1', key: 'none' },
  { id: 'vllm', name: 'vLLM (local server)', group: 'local', protocol: 'openai', url: 'http://localhost:8000/v1', dockerUrl: 'http://host.docker.internal:8000/v1', key: 'optional' },
  { id: 'llama-cpp', name: 'llama.cpp server (local)', group: 'local', protocol: 'openai', url: 'http://localhost:8080/v1', dockerUrl: 'http://host.docker.internal:8080/v1', key: 'optional' },
  { id: 'sglang', name: 'SGLang (local server)', group: 'local', protocol: 'openai', url: 'http://127.0.0.1:30000/v1', dockerUrl: 'http://host.docker.internal:30000/v1', key: 'optional' },
  { id: 'litellm-proxy', name: 'LiteLLM Proxy (self-hosted gateway)', group: 'local', protocol: 'openai', url: 'http://localhost:4000/v1', dockerUrl: 'http://host.docker.internal:4000/v1', key: 'optional' },
  { id: 'custom-anthropic', name: 'Another Anthropic-compatible API', group: 'custom', protocol: 'anthropic', urlExample: 'https://example.com', about: 'Any address that speaks the Messages API', key: 'optional' },
];

export function modelProvider(id: string): ModelProviderEntry | undefined {
  return MODEL_PROVIDERS.find((entry) => entry.id === id);
}
