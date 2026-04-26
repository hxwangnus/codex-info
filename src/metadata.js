const PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MODELS_URL = "https://models.dev/api.json";

export async function enrichWithOnlineMetadata(result, options = {}) {
  const metadata = {
    online: true,
    note: "Fetched public model/pricing metadata only; no local usage data was sent.",
    sources: [],
    errors: []
  };

  const [pricingResult, modelsResult] = await Promise.allSettled([
    fetchJson(PRICING_URL),
    fetchJson(MODELS_URL)
  ]);

  let pricing = new Map();
  let models = new Map();

  if (pricingResult.status === "fulfilled") {
    metadata.sources.push(PRICING_URL);
    pricing = flattenPricing(pricingResult.value);
  } else {
    metadata.errors.push(`pricing: ${pricingResult.reason.message}`);
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
        inputCostPerToken: price.input_cost_per_token ?? null,
        cachedInputCostPerToken: price.cache_read_input_token_cost ?? null,
        outputCostPerToken: price.output_cost_per_token ?? null
      };
      totalCost += group.estimatedCostUSD;
      pricedModels += 1;
    }
  }

  result.summary.estimatedCostUSD = roundMoney(totalCost);
  result.summary.pricedModels = pricedModels;
  result.metadata = metadata;
  return result;
}

function estimateCost(usage, price) {
  const inputCost = numberFrom(price.input_cost_per_token);
  const cachedInputCost = numberFrom(price.cache_read_input_token_cost ?? price.input_cost_per_token);
  const outputCost = numberFrom(price.output_cost_per_token);
  const cachedInputTokens = usage.cachedInputTokens || 0;
  const uncachedInputTokens = Math.max(0, (usage.inputTokens || 0) - cachedInputTokens);
  const cost = uncachedInputTokens * inputCost
    + cachedInputTokens * cachedInputCost
    + (usage.outputTokens || 0) * outputCost;
  return roundMoney(cost);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function flattenPricing(data) {
  const map = new Map();
  if (!data || typeof data !== "object") return map;
  for (const [id, value] of Object.entries(data)) {
    if (!value || typeof value !== "object") continue;
    if ("input_cost_per_token" in value || "output_cost_per_token" in value) {
      map.set(normalizeModelId(id), value);
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
