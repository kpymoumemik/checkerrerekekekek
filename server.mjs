#!/usr/bin/env node

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const ENDPOINT = "/backend-api/accounts/check/v4-2023-04-27";
const ENDPOINT_URL = `https://chatgpt.com${ENDPOINT}`;
const PROBE_ENDPOINTS = [
  {
    id: "chatgpt_accounts_check_v4",
    url: "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
    family: "chatgpt",
    verifiesPlan: true,
  },
  {
    id: "chatgpt_accounts_check",
    url: "https://chatgpt.com/backend-api/accounts/check",
    family: "chatgpt",
    verifiesPlan: true,
  },
  {
    id: "chatgpt_auth_session",
    url: "https://chatgpt.com/api/auth/session",
    family: "chatgpt",
    verifiesPlan: true,
  },
  {
    id: "chatgpt_user",
    url: "https://chatgpt.com/backend-api/user",
    family: "chatgpt",
    verifiesPlan: false,
  },
  {
    id: "chatgpt_accounts",
    url: "https://chatgpt.com/backend-api/accounts",
    family: "chatgpt",
    verifiesPlan: true,
  },
  {
    id: "chatgpt_models",
    url: "https://chatgpt.com/backend-api/models",
    family: "chatgpt",
    verifiesPlan: false,
  },
  {
    id: "chat_openai_accounts_check_v4",
    url: "https://chat.openai.com/backend-api/accounts/check/v4-2023-04-27",
    family: "chatgpt",
    verifiesPlan: true,
  },
  {
    id: "chat_openai_auth_session",
    url: "https://chat.openai.com/api/auth/session",
    family: "chatgpt",
    verifiesPlan: true,
  },
  {
    id: "api_models",
    url: "https://api.openai.com/v1/models",
    family: "api",
    verifiesPlan: false,
  },
  {
    id: "api_dashboard_billing_subscription",
    url: "https://api.openai.com/dashboard/billing/subscription",
    family: "api",
    verifiesPlan: false,
  },
  {
    id: "api_dashboard_billing_credit_grants",
    url: "https://api.openai.com/dashboard/billing/credit_grants",
    family: "api",
    verifiesPlan: false,
  },
];
const JOB_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const jobs = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body)
    ? body
    : JSON.stringify(body, null, 2);

  res.writeHead(status, {
    "content-type": typeof body === "string" || Buffer.isBuffer(body)
      ? "text/plain; charset=utf-8"
      : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, body, headers = {}) {
  send(res, status, body, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
}

function allowedCorsOrigin(origin) {
  if (!origin) return "";
  if (origin === "https://chatgpt.com") return origin;
  if (origin === "https://chat.openai.com") return origin;
  if (origin === `http://${HOST}:${PORT}`) return origin;
  if (origin === `http://localhost:${PORT}`) return origin;
  if (origin === `http://127.0.0.1:${PORT}`) return origin;
  return "";
}

function setCors(req, res) {
  const origin = allowedCorsOrigin(req.headers.origin);
  if (!origin) return;

  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", "600");
  res.setHeader("access-control-allow-private-network", "true");
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function createId() {
  return randomBytes(24).toString("base64url");
}

function now() {
  return Date.now();
}

function cleanupJobs() {
  const cutoff = now();
  for (const [id, job] of jobs) {
    if (job.expiresAt <= cutoff) jobs.delete(id);
  }
}

function publicJob(job) {
  return {
    id: job.id,
    createdAt: new Date(job.createdAt).toISOString(),
    expiresAt: new Date(job.expiresAt).toISOString(),
    status: job.status,
    result: job.result || null,
    error: job.error || "",
  };
}

function requireJob(id) {
  cleanupJobs();
  const job = jobs.get(id);
  if (!job) return null;
  return job;
}

function get(object, path) {
  return path.split(".").reduce((value, key) => value == null ? undefined : value[key], object);
}

function firstString(...values) {
  for (const value of values.flat(Infinity)) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstBoolean(...values) {
  for (const value of values.flat(Infinity)) {
    if (typeof value === "boolean") return value;
  }
  return false;
}

function accountItems(data) {
  if (Array.isArray(data?.accounts)) return data.accounts;
  if (data?.accounts && typeof data.accounts === "object") return Object.values(data.accounts);
  return [];
}

function fromAccounts(data, path) {
  return accountItems(data).map((account) => get(account, path)).filter((value) => value != null);
}

function normalizePlan(plan) {
  return String(plan || "unknown").trim().toLowerCase();
}

function isPaidPlan(plan) {
  return Boolean(plan && !["free", "none", "unknown", "no_subscription"].includes(normalizePlan(plan)));
}

function addPlanSignal(signals, source, value) {
  if (typeof value !== "string" || !value.trim()) return;
  signals.push({ source, plan: normalizePlan(value) });
}

function collectPlanSignals(data) {
  const signals = [];

  addPlanSignal(signals, "account.planType", data?.account?.planType);
  addPlanSignal(signals, "account.plan_type", data?.account?.plan_type);
  addPlanSignal(signals, "planType", data?.planType);
  addPlanSignal(signals, "plan_type", data?.plan_type);
  addPlanSignal(signals, "plan.type", data?.plan?.type);
  addPlanSignal(signals, "subscription.plan", data?.subscription?.plan);
  addPlanSignal(signals, "subscription.plan_type", data?.subscription?.plan_type);
  addPlanSignal(signals, "billing.subscription.plan", data?.billing?.subscription?.plan);

  accountItems(data).forEach((account, index) => {
    addPlanSignal(signals, `accounts[${index}].planType`, account?.planType);
    addPlanSignal(signals, `accounts[${index}].plan_type`, account?.plan_type);
    addPlanSignal(signals, `accounts[${index}].account.planType`, account?.account?.planType);
    addPlanSignal(signals, `accounts[${index}].account.plan_type`, account?.account?.plan_type);
    addPlanSignal(signals, `accounts[${index}].account_plan.plan_type`, account?.account_plan?.plan_type);
    addPlanSignal(signals, `accounts[${index}].subscription.plan`, account?.subscription?.plan);
  });

  return signals;
}

function extractAccountId(data) {
  return firstString(
    data?.account?.id,
    data?.account?.account_id,
    fromAccounts(data, "id"),
    fromAccounts(data, "account_id"),
    fromAccounts(data, "account.id"),
    fromAccounts(data, "account.account_id")
  ) || "unknown";
}

function extractBillingFlags(data) {
  return {
    isDelinquent: firstBoolean(
      data?.account?.isDelinquent,
      data?.account?.is_delinquent,
      fromAccounts(data, "isDelinquent"),
      fromAccounts(data, "is_delinquent"),
      fromAccounts(data, "account.isDelinquent"),
      fromAccounts(data, "account.is_delinquent")
    ),
    gracePeriodId: firstString(
      data?.account?.gracePeriodId,
      data?.account?.grace_period_id,
      fromAccounts(data, "gracePeriodId"),
      fromAccounts(data, "grace_period_id"),
      fromAccounts(data, "account.gracePeriodId"),
      fromAccounts(data, "account.grace_period_id")
    ),
  };
}

function extractEmail(data) {
  return firstString(
    data?.user?.email,
    data?.user?.email_address,
    data?.user?.profile?.email,
    data?.profile?.email,
    data?.email,
    data?.account?.email,
    data?.account?.owner?.email,
    data?.account?.account_owner_email,
    fromAccounts(data, "email"),
    fromAccounts(data, "user.email"),
    fromAccounts(data, "profile.email"),
    fromAccounts(data, "account.email"),
    fromAccounts(data, "account.owner.email"),
    fromAccounts(data, "account.account_owner_email")
  ) || "unknown";
}

function normalizePurchaseSource(value) {
  const raw = String(value || "").trim();
  const lower = raw.toLowerCase();

  if (!raw) return "";
  if (lower.includes("google") || lower.includes("play_store") || lower.includes("play store") || lower === "android") return "Google Play";
  if (lower.includes("apple") || lower.includes("app_store") || lower.includes("app store") || lower.includes("itunes") || lower === "ios") return "App Store";
  if (lower.includes("stripe") || lower.includes("card") || lower.includes("credit") || lower.includes("web")) return "Web / card";
  if (lower.includes("paypal")) return "PayPal";
  return raw;
}

function findStringByKeyPattern(value, pattern, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return "";
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKeyPattern(item, pattern, depth + 1, seen);
      if (found) return found;
    }
    return "";
  }

  for (const [key, item] of Object.entries(value)) {
    if (pattern.test(key) && typeof item === "string" && item.trim()) return item.trim();
    if (item && typeof item === "object") {
      const found = findStringByKeyPattern(item, pattern, depth + 1, seen);
      if (found) return found;
    }
  }

  return "";
}

function extractPurchaseSource(data) {
  const raw = firstString(
    data?.entitlement?.purchase_source,
    data?.entitlement?.purchaseSource,
    data?.entitlement?.purchase_platform,
    data?.entitlement?.store,
    data?.entitlement?.store_type,
    data?.entitlement?.payment_provider,
    data?.entitlement?.billing_provider,
    data?.subscription?.purchase_source,
    data?.subscription?.purchaseSource,
    data?.subscription?.purchase_platform,
    data?.subscription?.store,
    data?.subscription?.store_type,
    data?.subscription?.platform,
    data?.subscription?.payment_provider,
    data?.subscription?.billing_provider,
    data?.subscription?.provider,
    data?.subscription?.processor,
    data?.subscription?.gateway,
    data?.account?.entitlement?.purchase_source,
    data?.account?.entitlement?.purchase_platform,
    data?.account?.entitlement?.store,
    data?.account?.entitlement?.store_type,
    data?.account?.entitlement?.payment_provider,
    data?.account?.entitlement?.billing_provider,
    fromAccounts(data, "entitlement.purchase_source"),
    fromAccounts(data, "entitlement.purchaseSource"),
    fromAccounts(data, "entitlement.purchase_platform"),
    fromAccounts(data, "entitlement.store"),
    fromAccounts(data, "entitlement.store_type"),
    fromAccounts(data, "entitlement.payment_provider"),
    fromAccounts(data, "entitlement.billing_provider"),
    fromAccounts(data, "subscription.purchase_source"),
    fromAccounts(data, "subscription.purchaseSource"),
    fromAccounts(data, "subscription.purchase_platform"),
    fromAccounts(data, "subscription.store"),
    fromAccounts(data, "subscription.store_type"),
    fromAccounts(data, "subscription.platform"),
    fromAccounts(data, "subscription.payment_provider"),
    fromAccounts(data, "subscription.billing_provider"),
    fromAccounts(data, "last_active_subscription.purchase_source"),
    fromAccounts(data, "last_active_subscription.purchase_platform"),
    fromAccounts(data, "last_active_subscription.store"),
    findStringByKeyPattern(data, /^(purchase_source|purchaseSource|purchase_platform|purchasePlatform|purchased_from|store|store_type|payment_provider|billing_provider|provider|processor|gateway)$/i)
  );

  return {
    purchaseSource: normalizePurchaseSource(raw),
    purchaseSourceRaw: raw,
  };
}
function extractSubscriptionInfo(data) {
  const purchase = extractPurchaseSource(data);

  return {
    hasActiveSubscription: firstBoolean(
      data?.entitlement?.has_active_subscription,
      data?.subscription?.active,
      data?.subscription?.has_active_subscription,
      data?.account?.has_active_subscription,
      data?.account?.entitlement?.has_active_subscription,
      fromAccounts(data, "has_active_subscription"),
      fromAccounts(data, "entitlement.has_active_subscription"),
      fromAccounts(data, "account.has_active_subscription"),
      fromAccounts(data, "account.entitlement.has_active_subscription")
    ),
    subscriptionId: firstString(
      data?.entitlement?.subscription_id,
      data?.subscription?.id,
      data?.subscription?.subscription_id,
      data?.account?.entitlement?.subscription_id,
      fromAccounts(data, "entitlement.subscription_id"),
      fromAccounts(data, "subscription.id"),
      fromAccounts(data, "subscription.subscription_id"),
      fromAccounts(data, "last_active_subscription.subscription_id"),
      fromAccounts(data, "account.entitlement.subscription_id")
    ),
    subscriptionPlan: firstString(
      data?.entitlement?.subscription_plan,
      data?.subscription?.plan,
      data?.subscription?.plan_type,
      data?.account?.entitlement?.subscription_plan,
      fromAccounts(data, "entitlement.subscription_plan"),
      fromAccounts(data, "subscription.plan"),
      fromAccounts(data, "subscription.plan_type"),
      fromAccounts(data, "account.entitlement.subscription_plan")
    ),
    subscriptionStartedAt: firstString(
      data?.entitlement?.started_at,
      data?.entitlement?.created_at,
      data?.subscription?.started_at,
      data?.subscription?.created_at,
      data?.subscription?.current_period_start,
      fromAccounts(data, "entitlement.started_at"),
      fromAccounts(data, "entitlement.created_at"),
      fromAccounts(data, "subscription.started_at"),
      fromAccounts(data, "subscription.created_at"),
      fromAccounts(data, "subscription.current_period_start")
    ),
    subscriptionRenewsAt: firstString(
      data?.entitlement?.renews_at,
      data?.subscription?.renews_at,
      data?.subscription?.next_billing_date,
      data?.subscription?.current_period_end,
      data?.account?.entitlement?.renews_at,
      fromAccounts(data, "entitlement.renews_at"),
      fromAccounts(data, "subscription.renews_at"),
      fromAccounts(data, "subscription.next_billing_date"),
      fromAccounts(data, "subscription.current_period_end"),
      fromAccounts(data, "account.entitlement.renews_at")
    ),
    subscriptionExpiresAt: firstString(
      data?.entitlement?.expires_at,
      data?.subscription?.expires_at,
      data?.subscription?.expiration_date,
      data?.subscription?.current_period_end,
      data?.account?.entitlement?.expires_at,
      fromAccounts(data, "entitlement.expires_at"),
      fromAccounts(data, "subscription.expires_at"),
      fromAccounts(data, "subscription.expiration_date"),
      fromAccounts(data, "subscription.current_period_end"),
      fromAccounts(data, "account.entitlement.expires_at")
    ),
    billingCurrency: firstString(
      data?.entitlement?.billing_currency,
      data?.subscription?.billing_currency,
      data?.account?.entitlement?.billing_currency,
      fromAccounts(data, "entitlement.billing_currency"),
      fromAccounts(data, "subscription.billing_currency"),
      fromAccounts(data, "account.entitlement.billing_currency")
    ),
    purchaseSource: purchase.purchaseSource,
    purchaseSourceRaw: purchase.purchaseSourceRaw,
    willRenew: firstBoolean(
      data?.entitlement?.will_renew,
      data?.subscription?.will_renew,
      fromAccounts(data, "entitlement.will_renew"),
      fromAccounts(data, "subscription.will_renew"),
      fromAccounts(data, "last_active_subscription.will_renew")
    ),
  };
}

function analyzeEndpointData(data) {
  const signals = collectPlanSignals(data);
  const plans = [...new Set(signals.map((signal) => signal.plan))];
  const primary = signals[0] || { source: "unknown", plan: "unknown" };
  const flags = extractBillingFlags(data);
  const subscription = extractSubscriptionInfo(data);
  let status = "VERIFIED_FREE";

  if (isPaidPlan(primary.plan)) status = "VERIFIED_PAID";
  if (plans.length > 1) status = "VERIFIED_CONFLICT";
  if (flags.isDelinquent) status = "VERIFIED_DELINQUENT";
  if (primary.plan === "unknown") status = "VERIFIED_UNKNOWN_PLAN";

  return {
    status,
    endpoint: ENDPOINT_URL,
    accountId: extractAccountId(data),
    email: extractEmail(data),
    plan: primary.plan,
    planSource: primary.source,
    paid: isPaidPlan(primary.plan),
    isDelinquent: flags.isDelinquent,
    gracePeriodId: flags.gracePeriodId,
    subscription,
    hasConflict: plans.length > 1,
    signals,
    raw: data,
  };
}

function buildCookieHeader(sessionToken) {
  if (!sessionToken) return "";

  const safeToken = String(sessionToken).replace(/[;\r\n]/g, "");
  return [
    `__Secure-next-auth.session-token=${safeToken}`,
    `next-auth.session-token=${safeToken}`,
    "__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com",
  ].join("; ");
}

function baseHeaders(endpoint, accessToken, cookie, mode) {
  const isChatGpt = endpoint.family === "chatgpt";
  const headers = {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  };

  if (isChatGpt) {
    const origin = endpoint.url.startsWith("https://chat.openai.com")
      ? "https://chat.openai.com"
      : "https://chatgpt.com";
    headers.origin = origin;
    headers.referer = `${origin}/`;
    headers["sec-fetch-dest"] = "empty";
    headers["sec-fetch-mode"] = "cors";
    headers["sec-fetch-site"] = "same-origin";
  }

  if (mode.includes("bearer") && accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (mode.includes("cookie") && cookie) headers.cookie = cookie;

  return headers;
}

function authModesFor(endpoint, accessToken, cookie) {
  const modes = [];

  if (accessToken) modes.push("bearer");
  if (accessToken && cookie && endpoint.family === "chatgpt") modes.push("bearer+cookie");
  if (cookie && endpoint.family === "chatgpt") modes.push("cookie");

  return modes;
}

function isJsonContent(contentType) {
  return contentType.toLowerCase().includes("application/json") ||
    contentType.toLowerCase().includes("+json");
}

function classifyBodyPreview(text) {
  const lower = text.toLowerCase();
  if (lower.includes("cf-mitigated") || lower.includes("challenge-platform") || lower.includes("__cf_chl")) {
    return "cloudflare_challenge";
  }
  if (lower.includes("enable javascript and cookies")) return "cloudflare_challenge";
  if (lower.includes("<html")) return "html";
  return "non_json";
}

async function probeEndpoint(endpoint, session, cookie, mode) {
  const accessToken = session.accessToken || session.access_token || "";
  const startedAt = Date.now();

  try {
    const response = await fetch(endpoint.url, {
      method: "GET",
      headers: baseHeaders(endpoint, accessToken, cookie, mode),
      redirect: "follow",
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const probe = {
      id: endpoint.id,
      url: endpoint.url,
      family: endpoint.family,
      verifiesPlan: endpoint.verifiesPlan,
      mode,
      ok: response.ok,
      httpStatus: response.status,
      contentType,
      elapsedMs: Date.now() - startedAt,
      bodyKind: "unknown",
      planSignals: [],
      plan: "unknown",
      data: null,
      bodyPreview: "",
    };

    if (!isJsonContent(contentType)) {
      probe.bodyKind = classifyBodyPreview(text);
      probe.bodyPreview = text.slice(0, 700);
      return probe;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      probe.bodyKind = "invalid_json";
      probe.bodyPreview = text.slice(0, 700);
      return probe;
    }

    const analysis = analyzeEndpointData(data);
    probe.bodyKind = "json";
    probe.data = data;
    probe.planSignals = analysis.signals;
    probe.plan = analysis.plan;
    probe.accountId = analysis.accountId;
    probe.email = analysis.email;
    probe.isDelinquent = analysis.isDelinquent;
    probe.gracePeriodId = analysis.gracePeriodId;
    probe.subscription = analysis.subscription;
    probe.hasConflict = analysis.hasConflict;
    probe.paid = analysis.paid;
    return probe;
  } catch (error) {
    return {
      id: endpoint.id,
      url: endpoint.url,
      family: endpoint.family,
      verifiesPlan: endpoint.verifiesPlan,
      mode,
      ok: false,
      httpStatus: 0,
      contentType: "",
      elapsedMs: Date.now() - startedAt,
      bodyKind: "fetch_error",
      error: error.message || String(error),
      planSignals: [],
      plan: "unknown",
      data: null,
      bodyPreview: "",
    };
  }
}

function chooseBestProbe(probes) {
  return probes.find((probe) =>
    probe.ok &&
    probe.bodyKind === "json" &&
    probe.verifiesPlan &&
    probe.planSignals.length > 0 &&
    probe.plan !== "unknown"
  ) || probes.find((probe) =>
    probe.ok &&
    probe.bodyKind === "json" &&
    probe.planSignals.length > 0 &&
    probe.plan !== "unknown"
  ) || null;
}

function hasSubscriptionData(subscription) {
  return Boolean(subscription && (
    subscription.hasActiveSubscription ||
    subscription.subscriptionId ||
    subscription.subscriptionPlan ||
    subscription.subscriptionStartedAt ||
    subscription.subscriptionRenewsAt ||
    subscription.subscriptionExpiresAt ||
    subscription.purchaseSource
  ));
}

function mergeEndpointMetadata(best, probes) {
  const jsonProbes = probes.filter((probe) => probe.bodyKind === "json");
  const probesByPreference = [
    best,
    ...jsonProbes.filter((probe) => probe !== best && probe.verifiesPlan),
    ...jsonProbes.filter((probe) => probe !== best && !probe.verifiesPlan),
  ].filter(Boolean);

  const email = firstString(
    probesByPreference.map((probe) => probe.email && probe.email !== "unknown" ? probe.email : "")
  );
  const subscriptionProbe = probesByPreference.find((probe) => hasSubscriptionData(probe.subscription));
  const purchaseSourceProbe = probesByPreference.find((probe) => probe.subscription?.purchaseSource);
  const subscription = {
    hasActiveSubscription: false,
    subscriptionId: "",
    subscriptionPlan: "",
    subscriptionStartedAt: "",
    subscriptionRenewsAt: "",
    subscriptionExpiresAt: "",
    billingCurrency: "",
    purchaseSource: "",
    purchaseSourceRaw: "",
    willRenew: false,
    ...(subscriptionProbe?.subscription || {}),
  };

  if (!subscription.purchaseSource && purchaseSourceProbe?.subscription?.purchaseSource) {
    subscription.purchaseSource = purchaseSourceProbe.subscription.purchaseSource;
    subscription.purchaseSourceRaw = purchaseSourceProbe.subscription.purchaseSourceRaw || "";
  }

  return {
    email: email || "unknown",
    subscription,
    subscriptionSourceEndpointId: subscriptionProbe?.id || "",
    purchaseSourceEndpointId: purchaseSourceProbe?.id || "",
    emailSourceEndpointId: probesByPreference.find((probe) => probe.email && probe.email !== "unknown")?.id || "",
  };
}

function resultFromProbe(best, probes) {
  if (!best) {
    return {
      status: "NOT_VERIFIED",
      endpoint: "",
      message: "No probed endpoint returned a usable JSON response.",
      probes,
    };
  }

  const metadata = mergeEndpointMetadata(best, probes);

  if (!best.planSignals.length || best.plan === "unknown") {
    return {
      status: "VERIFIED_UNKNOWN_PLAN",
      endpoint: best.url,
      httpStatus: best.httpStatus,
      sourceEndpointId: best.id,
      sourceMode: best.mode,
      accountId: best.accountId || "unknown",
      email: metadata.email,
      plan: "unknown",
      planSource: "unknown",
      paid: false,
      isDelinquent: Boolean(best.isDelinquent),
      gracePeriodId: best.gracePeriodId || "",
      subscription: metadata.subscription,
      subscriptionSourceEndpointId: metadata.subscriptionSourceEndpointId,
      purchaseSourceEndpointId: metadata.purchaseSourceEndpointId,
      emailSourceEndpointId: metadata.emailSourceEndpointId,
      hasConflict: Boolean(best.hasConflict),
      signals: best.planSignals,
      raw: best.data,
      probes,
    };
  }

  const primary = best.planSignals[0];
  let status = isPaidPlan(primary.plan) ? "VERIFIED_PAID" : "VERIFIED_FREE";

  if (best.hasConflict) status = "VERIFIED_CONFLICT";
  if (best.isDelinquent) status = "VERIFIED_DELINQUENT";

  return {
    status,
    endpoint: best.url,
    httpStatus: best.httpStatus,
    sourceEndpointId: best.id,
    sourceMode: best.mode,
    accountId: best.accountId || "unknown",
    email: metadata.email,
    plan: primary.plan,
    planSource: primary.source,
    paid: isPaidPlan(primary.plan),
    isDelinquent: Boolean(best.isDelinquent),
    gracePeriodId: best.gracePeriodId || "",
    subscription: metadata.subscription,
    subscriptionSourceEndpointId: metadata.subscriptionSourceEndpointId,
    purchaseSourceEndpointId: metadata.purchaseSourceEndpointId,
    emailSourceEndpointId: metadata.emailSourceEndpointId,
    hasConflict: Boolean(best.hasConflict),
    signals: best.planSignals,
    raw: best.data,
    probes,
  };
}

async function runProbes(session) {
  const accessToken = session.accessToken || session.access_token || "";
  const sessionToken = session.sessionToken || session.session_token || "";
  const cookie = buildCookieHeader(sessionToken);

  if (!accessToken && !sessionToken) {
    throw new Error("accessToken/sessionToken not found in JSON.");
  }

  const tasks = [];
  for (const endpoint of PROBE_ENDPOINTS) {
    for (const mode of authModesFor(endpoint, accessToken, cookie)) {
      tasks.push(probeEndpoint(endpoint, session, cookie, mode));
    }
  }

  const probes = await Promise.all(tasks);
  const best = chooseBestProbe(probes);
  return resultFromProbe(best, probes);
}

function resultFromBridgePayload(payload) {
  const statusCode = Number(payload.status || 0);
  const contentType = String(payload.contentType || "");
  const text = String(payload.text || "");
  let data = null;

  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      status: "NOT_VERIFIED",
      endpoint: ENDPOINT_URL,
      httpStatus: statusCode,
      contentType,
      error: "Endpoint did not return JSON.",
      bodyPreview: text.slice(0, 1200),
    };
  }

  if (statusCode < 200 || statusCode >= 300) {
    return {
      status: "NOT_VERIFIED",
      endpoint: ENDPOINT_URL,
      httpStatus: statusCode,
      contentType,
      error: "Endpoint returned a non-2xx JSON response.",
      raw: data,
    };
  }

  return {
    ...analyzeEndpointData(data),
    httpStatus: statusCode,
    contentType,
  };
}

async function serveStatic(req, res, pathname) {
  const safePath = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath)] || "application/octet-stream";
    send(res, 200, body, {
      "content-type": type,
      "cache-control": "no-store",
    });
  } catch (error) {
    send(res, 404, "Not found");
  }
}

async function handleCreateJob(req, res) {
  const body = await readJson(req);
  const session = body.session || body;
  const accessToken = session.accessToken || session.access_token || "";
  const sessionToken = session.sessionToken || session.session_token || "";

  if (!accessToken && !sessionToken) {
    sendJson(res, 400, { error: "accessToken/sessionToken not found in JSON." });
    return;
  }

  const id = createId();
  const createdAt = now();
  const job = {
    id,
    createdAt,
    expiresAt: createdAt + JOB_TTL_MS,
    status: "WAITING_FOR_CHATGPT_RUNNER",
    accessToken,
    sessionToken,
    result: null,
    error: "",
  };

  jobs.set(id, job);
  sendJson(res, 201, publicJob(job));
}

async function handleCheck(req, res) {
  const body = await readJson(req);
  const session = body.session || body;
  const result = await runProbes(session);
  sendJson(res, 200, result);
}

async function handleJobConfig(req, res, id) {
  const job = requireJob(id);
  if (!job) {
    sendJson(res, 404, { error: "Job not found or expired." });
    return;
  }

  sendJson(res, 200, {
    id: job.id,
    endpoint: ENDPOINT,
    accessToken: job.accessToken,
    hasSessionToken: Boolean(job.sessionToken),
  });
}

async function handleJobResult(req, res, id) {
  const job = requireJob(id);
  if (!job) {
    sendJson(res, 404, { error: "Job not found or expired." });
    return;
  }

  const payload = await readJson(req);
  job.result = resultFromBridgePayload(payload);
  job.status = job.result.status;
  job.accessToken = "";
  job.sessionToken = "";
  sendJson(res, 200, publicJob(job));
}

function handleGetJob(req, res, id) {
  const job = requireJob(id);
  if (!job) {
    sendJson(res, 404, { error: "Job not found or expired." });
    return;
  }

  sendJson(res, 200, publicJob(job));
}

async function requestHandler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname;

  try {
    if (req.method === "POST" && pathname === "/api/jobs") {
      await handleCreateJob(req, res);
      return;
    }

    if (req.method === "POST" && pathname === "/api/check") {
      await handleCheck(req, res);
      return;
    }

    const configMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/config$/);
    if (req.method === "GET" && configMatch) {
      await handleJobConfig(req, res, configMatch[1]);
      return;
    }

    const resultMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/result$/);
    if (req.method === "POST" && resultMatch) {
      await handleJobResult(req, res, resultMatch[1]);
      return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      handleGetJob(req, res, jobMatch[1]);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error." });
  }
}

const server = createServer(requestHandler);

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`OpenAI checker site: http://${displayHost}:${PORT}`);
});
