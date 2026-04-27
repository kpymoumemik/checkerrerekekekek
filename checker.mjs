#!/usr/bin/env node

const ENDPOINT = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";

function usage() {
  return `Usage:
  node checker.mjs session.json
  cat session.json | node checker.mjs
  node checker.mjs session.json --raw
  node checker.mjs session.json --json

The checker uses only the endpoint response for the verdict.
Session JSON fields such as account.planType are intentionally ignored.`;
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const file = argv.find((arg) => !arg.startsWith("--"));

  return {
    file,
    raw: flags.has("--raw"),
    json: flags.has("--json"),
    help: flags.has("--help") || flags.has("-h"),
  };
}

async function readInput(file) {
  if (file && file !== "-") {
    return await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
  }

  if (process.stdin.isTTY) {
    throw new Error("No session JSON provided.\n\n" + usage());
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function get(object, path) {
  return path.split(".").reduce((value, key) => {
    if (value == null) return undefined;
    return value[key];
  }, object);
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

function buildCookieHeader(sessionToken) {
  if (!sessionToken) return "";

  const encoded = String(sessionToken).replace(/[;\r\n]/g, "");
  return [
    `__Secure-next-auth.session-token=${encoded}`,
    `next-auth.session-token=${encoded}`,
    "__Secure-next-auth.callback-url=https%3A%2F%2Fchatgpt.com",
  ].join("; ");
}

function buildAttempts(session) {
  const accessToken = session.accessToken || session.access_token;
  const sessionToken = session.sessionToken || session.session_token;
  const cookie = buildCookieHeader(sessionToken);
  const commonHeaders = {
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0",
    Referer: "https://chatgpt.com/",
  };
  const attempts = [];

  if (accessToken) {
    attempts.push({
      name: "bearer",
      headers: {
        ...commonHeaders,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  if (accessToken && cookie) {
    attempts.push({
      name: "bearer+session-cookie",
      headers: {
        ...commonHeaders,
        Authorization: `Bearer ${accessToken}`,
        Cookie: cookie,
      },
    });
  }

  if (cookie) {
    attempts.push({
      name: "session-cookie",
      headers: {
        ...commonHeaders,
        Cookie: cookie,
      },
    });
  }

  return attempts;
}

async function fetchEndpoint(session) {
  const attempts = buildAttempts(session);
  if (!attempts.length) {
    throw new Error("accessToken/sessionToken not found in session JSON.");
  }

  const logs = [];

  for (const attempt of attempts) {
    let response;
    let text = "";

    try {
      response = await fetch(ENDPOINT, {
        method: "GET",
        headers: attempt.headers,
        redirect: "follow",
      });
      text = await response.text();
    } catch (error) {
      logs.push({
        attempt: attempt.name,
        ok: false,
        error: error.message || String(error),
      });
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    const log = {
      attempt: attempt.name,
      ok: response.ok,
      status: response.status,
      contentType,
    };

    try {
      const data = JSON.parse(text);
      return {
        verified: response.ok,
        endpoint: ENDPOINT,
        attempt: attempt.name,
        status: response.status,
        contentType,
        data,
        logs: [...logs, log],
      };
    } catch (error) {
      logs.push({
        ...log,
        bodyPreview: text.slice(0, 500),
      });
    }
  }

  return {
    verified: false,
    endpoint: ENDPOINT,
    logs,
  };
}

function analyzeEndpointData(data) {
  const signals = collectPlanSignals(data);
  const plans = [...new Set(signals.map((signal) => signal.plan))];
  const primary = signals[0] || { source: "unknown", plan: "unknown" };
  const flags = extractBillingFlags(data);

  return {
    accountId: extractAccountId(data),
    plan: primary.plan,
    planSource: primary.source,
    paid: isPaidPlan(primary.plan),
    isDelinquent: flags.isDelinquent,
    gracePeriodId: flags.gracePeriodId,
    hasConflict: plans.length > 1,
    signals,
  };
}

function buildResult(endpointResult) {
  if (!endpointResult.data || !endpointResult.verified) {
    return {
      status: "NOT_VERIFIED",
      endpoint: endpointResult.endpoint,
      logs: endpointResult.logs,
    };
  }

  const analysis = analyzeEndpointData(endpointResult.data);
  let status = "VERIFIED_FREE";

  if (analysis.paid) status = "VERIFIED_PAID";
  if (analysis.hasConflict) status = "VERIFIED_CONFLICT";
  if (analysis.isDelinquent) status = "VERIFIED_DELINQUENT";
  if (analysis.plan === "unknown") status = "VERIFIED_UNKNOWN_PLAN";

  return {
    status,
    endpoint: endpointResult.endpoint,
    httpStatus: endpointResult.status,
    attempt: endpointResult.attempt,
    ...analysis,
    logs: endpointResult.logs,
    raw: endpointResult.data,
  };
}

function printHuman(result, options) {
  console.log(`STATUS: ${result.status}`);
  console.log(`ENDPOINT: ${result.endpoint}`);

  if (result.status === "NOT_VERIFIED") {
    console.log("RESULT: endpoint did not return a verified JSON response");
    console.log("DETAILS:");
    for (const log of result.logs || []) {
      const parts = [
        `- ${log.attempt}`,
        log.status ? `HTTP ${log.status}` : "",
        log.contentType ? log.contentType : "",
        log.error ? `error=${log.error}` : "",
      ].filter(Boolean);
      console.log(parts.join(" | "));
      if (log.bodyPreview) console.log(`  body: ${log.bodyPreview.replace(/\s+/g, " ").slice(0, 240)}`);
    }
    return;
  }

  console.log(`HTTP: ${result.httpStatus}`);
  console.log(`ATTEMPT: ${result.attempt}`);
  console.log(`ACCOUNT_ID: ${result.accountId}`);
  console.log(`PLAN: ${result.plan.toUpperCase()}`);
  console.log(`PLAN_SOURCE: ${result.planSource}`);
  console.log(`PAID: ${result.paid ? "yes" : "no"}`);
  console.log(`DELINQUENT: ${result.isDelinquent ? "yes" : "no"}`);
  if (result.gracePeriodId) console.log(`GRACE_PERIOD_ID: ${result.gracePeriodId}`);
  console.log(`CONFLICT: ${result.hasConflict ? "yes" : "no"}`);
  console.log("SIGNALS:");

  if (result.signals.length) {
    for (const signal of result.signals) {
      console.log(`- ${signal.source}: ${signal.plan.toUpperCase()}`);
    }
  } else {
    console.log("- no known plan fields found in endpoint JSON");
  }

  if (options.raw) {
    console.log("RAW_ENDPOINT_JSON:");
    console.log(JSON.stringify(result.raw, null, 2));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const input = await readInput(options.file);
  const session = JSON.parse(input);
  const endpointResult = await fetchEndpoint(session);
  const result = buildResult(endpointResult);

  if (options.json) {
    const { raw, ...safeResult } = options.raw ? result : { ...result, raw: undefined };
    console.log(JSON.stringify(options.raw ? result : safeResult, null, 2));
    return;
  }

  printHuman(result, options);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
