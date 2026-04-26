const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
const FALLBACK_PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_URL = "https://models.dev/api.json";

export async function enrichWithOnlineMetadata(result, options = {}) {
  const pricingTier = options.pricingTier || "standard";
  const metadata = {
    online: true,
    note: "Fetched public model/pricing metadata only; no local usage data was sent.",
    pricingTier,
    sources: [],
    errors: []
  };

  const [officialPricingResult, fallbackPricingResult, modelsResult] = await Promise.allSettled([
    fetchText(OPENAI_PRICING_URL),
    fetchJson(FALLBACK_PRICING_URL),
    fetchJson(MODELS_URL)
  ]);

  let pricing = new Map();
  let models = new Map();
  let pricingSource = "";

  if (officialPricingResult.status === "fulfilled") {
    const officialPricing = parseOpenAiPricingMarkdown(officialPricingResult.value, pricingTier);
    if (officialPricing.size) {
      metadata.sources.push(OPENAI_PRICING_URL);
      pricing = officialPricing;
      pricingSource = "openai";
    } else {
      metadata.errors.push(`official pricing: no ${pricingTier} token rows found`);
    }
  } else {
    metadata.errors.push(`official pricing: ${officialPricingResult.reason.message}`);
  }

  if (!pricing.size && fallbackPricingResult.status === "fulfilled") {
    metadata.sources.push(FALLBACK_PRICING_URL);
    pricing = flattenFallbackPricing(fallbackPricingResult.value);
    pricingSource = "fallback";
  } else if (!pricing.size && fallbackPricingResult.status === "rejected") {
    metadata.errors.push(`fallback pricing: ${fallbackPricingResult.reason.message}`);
  }

  if (modelsResult.status === "fulfilled") {
    metadata.sources.push(MODELS_URL);
    models = flattenModels(modelsResult.value);
  } else {
    metadata.errors.push(`models: ${modelsResult.reason.message}`);
  }

  let totalCost = 0;
  let pricedModels = 0;

  for (const group of result.groups.model) {
    const modelInfo = findModelInfo(models, group.model);
    const price = findPrice(pricing, group.model);
    if (modelInfo) {
      group.displayName = modelInfo.displayName;
      group.provider = modelInfo.provider;
    }
    if (price) {
      group.estimatedCostUSD = estimateCost(group.usage, price);
      group.pricing = {
        source: price.source || pricingSource || null,
        tier: price.tier || pricingTier,
        inputCostPerMillionTokens: price.inputCostPerMillionTokens ?? null,
        cachedInputCostPerMillionTokens: price.cachedInputCostPerMillionTokens ?? null,
        outputCostPerMillionTokens: price.outputCostPerMillionTokens ?? null,
        inputCostPerToken: price.inputCostPerToken ?? null,
        cachedInputCostPerToken: price.cachedInputCostPerToken ?? null,
        outputCostPerToken: price.outputCostPerToken ?? null,
        reasoningBilledAsOutput: true
      };
      totalCost += group.estimatedCostUSD;
      pricedModels += 1;
    }
  }

  result.summary.estimatedCostUSD = roundMoney(totalCost);
  result.summary.pricedModels = pricedModels;
  result.summary.pricingSource = pricingSource || null;
  result.summary.pricingTier = pricingTier;
  result.metadata = metadata;
  return result;
}

function estimateCost(usage, price) {
  const inputCost = numberFrom(price.inputCostPerToken);
  const cachedInputCost = numberFrom(price.cachedInputCostPerToken ?? price.inputCostPerToken);
  const outputCost = numberFrom(price.outputCostPerToken);
  const cachedInputTokens = usage.cachedInputTokens || 0;
  const uncachedInputTokens = Math.max(0, (usage.inputTokens || 0) - cachedInputTokens);
  const cost = uncachedInputTokens * inputCost
    + cachedInputTokens * cachedInputCost
    + ((usage.outputTokens || 0) + (usage.reasoningOutputTokens || 0)) * outputCost;
  return roundMoney(cost);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { accept: "text/markdown,text/plain,text/html" },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

export function parseOpenAiPricingMarkdown(markdown, tier = "standard") {
  const map = new Map();
  const tierPattern = new RegExp(`data-content-switcher-pane data-value="${escapeRegex(tier)}"[\\s\\S]*?tier="${escapeRegex(tier)}"[\\s\\S]*?rows=\\{\\[([\\s\\S]*?)\\]\\}`, "i");
  const match = markdown.match(tierPattern);
  if (!match) return map;

  for (const rowMatch of match[1].matchAll(/\[\s*"([^"]+)"\s*,\s*([^,\]\n]+)\s*,\s*([^,\]\n]+)\s*,\s*([^,\]\n]+)\s*\]/g)) {
    const model = normalizeOpenAiModelName(rowMatch[1]);
    const input = priceNumber(rowMatch[2]);
    const cachedInput = priceNumber(rowMatch[3]);
    const output = priceNumber(rowMatch[4]);
    if (!model || input === null || output === null) continue;
    map.set(normalizeModelId(model), priceRecord({
      source: "openai",
      tier,
      input,
      cachedInput: cachedInput ?? input,
      output
    }));
  }

  return map;
}

function flattenFallbackPricing(data) {
  const map = new Map();
  if (!data || typeof data !== "object") return map;
  for (const [id, value] of Object.entries(data)) {
    if (!value || typeof value !== "object") continue;
    if ("input_cost_per_token" in value || "output_cost_per_token" in value) {
      const inputPerToken = numberFrom(value.input_cost_per_token);
      const cachedPerToken = numberFrom(value.cache_read_input_token_cost ?? value.input_cost_per_token);
      const outputPerToken = numberFrom(value.output_cost_per_token);
      map.set(normalizeModelId(id), {
        source: "fallback",
        tier: "standard",
        inputCostPerToken: inputPerToken,
        cachedInputCostPerToken: cachedPerToken,
        outputCostPerToken: outputPerToken,
        inputCostPerMillionTokens: inputPerToken * 1_000_000,
        cachedInputCostPerMillionTokens: cachedPerToken * 1_000_000,
        outputCostPerMillionTokens: outputPerToken * 1_000_000
      });
    }
  }
  return map;
}

function flattenModels(data) {
  const map = new Map();

  function visit(node, key = "", provider = "") {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, "", provider);
      return;
    }

    const nextProvider = stringValue(node.provider)
      || stringValue(node.provider_id)
      || stringValue(node.providerId)
      || provider;
    const id = stringValue(node.id)
      || stringValue(node.model)
      || (looksLikeModelId(key) ? key : "");

    if (id) {
      map.set(normalizeModelId(id), {
        id,
        displayName: stringValue(node.display_name)
          || stringValue(node.displayName)
          || stringValue(node.name)
          || id,
        provider: nextProvider || ""
      });
    }

    for (const [childKey, child] of Object.entries(node)) {
      const childProvider = childKey === "models" ? nextProvider : nextProvider || (looksLikeProviderKey(childKey) ? childKey : "");
      visit(child, childKey, childProvider);
    }
  }

  visit(data);
  return map;
}

function findPrice(pricing, model) {
  for (const candidate of modelCandidates(model)) {
    const price = pricing.get(candidate);
    if (price) return price;
  }
  return null;
}

function findModelInfo(models, model) {
  for (const candidate of modelCandidates(model)) {
    const info = models.get(candidate);
    if (info) return info;
  }
  return null;
}

function modelCandidates(model) {
  const normalized = normalizeModelId(model);
  const stripped = normalized.split("/").at(-1);
  return [
    normalized,
    stripped,
    `openai/${stripped}`,
    `openrouter/${stripped}`
  ];
}

function normalizeModelId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeOpenAiModelName(value) {
  return String(value || "")
    .replace(/\s*\([^)]*\)\s*/g, "")
    .trim()
    .toLowerCase();
}

function priceRecord({ source, tier, input, cachedInput, output }) {
  return {
    source,
    tier,
    inputCostPerMillionTokens: input,
    cachedInputCostPerMillionTokens: cachedInput,
    outputCostPerMillionTokens: output,
    inputCostPerToken: input / 1_000_000,
    cachedInputCostPerToken: cachedInput / 1_000_000,
    outputCostPerToken: output / 1_000_000
  };
}

function priceNumber(value) {
  const normalized = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!normalized || normalized === "-" || normalized.toLowerCase() === "null") return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 1000000) / 1000000;
}

function looksLikeModelId(value) {
  return /gpt|claude|gemini|llama|mistral|qwen|deepseek|o\d|codex/i.test(value);
}

function looksLikeProviderKey(value) {
  return /openai|anthropic|google|meta|mistral|xai|deepseek|openrouter/i.test(value);
}
