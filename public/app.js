const $ = (selector) => document.querySelector(selector);

const sessionInput = $("#sessionInput");
const checkBtn = $("#checkBtn");
const clearBtn = $("#clearBtn");
const resultPanel = $("#resultPanel");
const resultStatus = $("#resultStatus");
const resultBody = $("#resultBody");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setBadge(text, type = "muted") {
  resultStatus.textContent = text;
  resultStatus.className = `badge ${type}`;
}

function showResult(status, html, type = "muted") {
  resultPanel.classList.remove("hidden");
  setBadge(status, type);
  resultBody.innerHTML = html;
}

function renderMessage(message, type = "warning") {
  return `<div class="message ${type}">${escapeHtml(message)}</div>`;
}

function planTone(plan) {
  const value = String(plan || "").toLowerCase();
  if (value.includes("plus")) return "plan-plus";
  if (value.includes("team") || value.includes("free")) return "plan-warning";
  return "";
}

function statusType(status, plan) {
  const tone = planTone(plan);
  if (tone === "plan-plus") return "success";
  if (tone === "plan-warning") return "warning";
  if (status === "VERIFIED_PAID") return "success";
  if (status === "VERIFIED_FREE") return "warning";
  if (status === "VERIFIED_DELINQUENT" || status === "VERIFIED_CONFLICT" || status === "VERIFIED_UNKNOWN_PLAN") return "warning";
  return "error";
}

function resultMessage(result) {
  if (result.status === "VERIFIED_PAID") {
    const messageType = planTone(result.plan) === "plan-warning" ? "warning" : "success";
    return renderMessage("РџР»Р°С‚РЅР°СЏ РїРѕРґРїРёСЃРєР° РїРѕРґС‚РІРµСЂР¶РґРµРЅР° РѕС‚РІРµС‚РѕРј endpoint.", messageType);
  }

  if (result.status === "VERIFIED_FREE") {
    return renderMessage("Endpoint РїРѕРґС‚РІРµСЂРґРёР» Р±РµСЃРїР»Р°С‚РЅС‹Р№ РїР»Р°РЅ.", "warning");
  }

  if (result.status === "VERIFIED_DELINQUENT") {
    return renderMessage("Endpoint РѕС‚РІРµС‚РёР», РЅРѕ Р°РєРєР°СѓРЅС‚ РїРѕРјРµС‡РµРЅ РєР°Рє delinquent. РќРµ СЃС‡РёС‚Р°СЋ РїРѕРґРїРёСЃРєСѓ Р°РєС‚РёРІРЅРѕР№.", "warning");
  }

  if (result.status === "VERIFIED_CONFLICT") {
    return renderMessage("Endpoint РІРµСЂРЅСѓР» РєРѕРЅС„Р»РёРєС‚СѓСЋС‰РёРµ РїРѕР»СЏ РїР»Р°РЅР°.", "warning");
  }

  if (result.status === "VERIFIED_UNKNOWN_PLAN") {
    return renderMessage("Endpoint РѕС‚РІРµС‚РёР» JSON, РЅРѕ РёР·РІРµСЃС‚РЅС‹С… РїРѕР»РµР№ РїР»Р°РЅР° РІ РѕС‚РІРµС‚Рµ РЅРµС‚.", "warning");
  }

  return renderMessage(result.message || "РќРё РѕРґРёРЅ endpoint РЅРµ РІРµСЂРЅСѓР» РїСЂРёРіРѕРґРЅС‹Р№ JSON СЃ РїР»Р°РЅРѕРј.", "error");
}

function renderSignals(signals) {
  if (!Array.isArray(signals) || !signals.length) return "<li>РџРѕР»СЏ РїР»Р°РЅР° РЅРµ РЅР°Р№РґРµРЅС‹</li>";

  return signals
    .map((signal) => `<li>${escapeHtml(signal.source)}: <strong class="${planTone(signal.plan)}">${escapeHtml(signal.plan.toUpperCase())}</strong></li>`)
    .join("");
}

function renderProbeRows(probes) {
  if (!Array.isArray(probes) || !probes.length) {
    return "<tr><td colspan=\"7\">РќРµС‚ РїРѕРїС‹С‚РѕРє</td></tr>";
  }

  return probes.map((probe) => {
    const kind = probe.bodyKind || "unknown";
    const status = probe.httpStatus || "fetch";
    const preview = probe.bodyPreview || probe.error || "";
    const previewHtml = preview
      ? `<details><summary>preview</summary><pre>${escapeHtml(preview)}</pre></details>`
      : "";

    return `
      <tr>
        <td>${escapeHtml(probe.id)}</td>
        <td>${escapeHtml(probe.mode)}</td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(kind)}</td>
        <td>${probe.verifiesPlan ? "yes" : "no"}</td>
        <td><strong class="${planTone(probe.plan)}">${escapeHtml((probe.plan || "unknown").toUpperCase())}</strong></td>
        <td>${previewHtml}</td>
      </tr>
    `;
  }).join("");
}

function renderRaw(result) {
  if (!result.raw) return "";
  return `<details><summary>Raw endpoint JSON</summary><pre>${escapeHtml(JSON.stringify(result.raw, null, 2))}</pre></details>`;
}

function renderSubscription(subscription = {}) {
  const active = Boolean(subscription.hasActiveSubscription);
  const subscriptionPlanTone = planTone(subscription.subscriptionPlan);
  const rows = [
    ["Active subscription", active ? "yes" : "no"],
    ["Subscription ID", subscription.subscriptionId || "unknown"],
    ["Subscription plan", subscription.subscriptionPlan || "unknown"],
    ["Subscription source", subscription.purchaseSource || "unknown"],
    ["Source raw value", subscription.purchaseSourceRaw || "unknown"],
    ["Started at", subscription.subscriptionStartedAt || "unknown"],
    ["Renews at", subscription.subscriptionRenewsAt || "unknown"],
    ["Expires at", subscription.subscriptionExpiresAt || "unknown"],
    ["Will renew", subscription.willRenew ? "yes" : "no"],
    ["Billing currency", subscription.billingCurrency || "unknown"],
  ];

  return `
    <details open>
      <summary>Subscription details from endpoint</summary>
      <div class="result-grid detail-grid">
        ${rows.map(([label, value]) => `
          <div class="metric ${label === "Subscription plan" ? subscriptionPlanTone : ""}">
            <span>${escapeHtml(label)}</span>
            <strong class="${label === "Subscription plan" ? subscriptionPlanTone : ""}">${escapeHtml(value)}</strong>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function renderResult(result) {
  const type = statusType(result.status, result.plan);
  const resultPlanTone = planTone(result.plan);
  const probes = Array.isArray(result.probes) ? result.probes : [];
  const cloudflareCount = probes.filter((probe) => probe.bodyKind === "cloudflare_challenge").length;
  const cloudflareNote = cloudflareCount
    ? renderMessage(`${cloudflareCount} РїРѕРїС‹С‚РѕРє РїРѕР»СѓС‡РёР»Рё Cloudflare challenge/HTML РІРјРµСЃС‚Рѕ JSON. Р­С‚Рѕ Р±Р»РѕРєРёСЂРѕРІРєР° РЅР° СЃС‚РѕСЂРѕРЅРµ endpoint-Р°, Р° РЅРµ РѕС€РёР±РєР° РїР°СЂСЃРёРЅРіР°.`, "warning")
    : "";

  showResult(result.status, `
    ${resultMessage(result)}
    ${cloudflareNote}
    <div class="result-grid">
      <div class="metric"><span>Endpoint</span><strong>${escapeHtml(result.sourceEndpointId || result.endpoint || "none")}</strong></div>
      <div class="metric"><span>HTTP</span><strong>${escapeHtml(result.httpStatus || "none")}</strong></div>
      <div class="metric"><span>Mode</span><strong>${escapeHtml(result.sourceMode || "none")}</strong></div>
      <div class="metric"><span>Email</span><strong>${escapeHtml(result.email || "unknown")}</strong></div>
      <div class="metric ${resultPlanTone}"><span>Plan</span><strong class="${resultPlanTone}">${escapeHtml((result.plan || "unknown").toUpperCase())}</strong></div>
      <div class="metric"><span>Paid</span><strong>${result.paid ? "yes" : "no"}</strong></div>
      <div class="metric"><span>Delinquent</span><strong>${result.isDelinquent ? "yes" : "no"}</strong></div>
      <div class="metric"><span>Subscription date source</span><strong>${escapeHtml(result.subscriptionSourceEndpointId || "unknown")}</strong></div>
    </div>
    ${result.gracePeriodId ? `<p><strong>Grace period:</strong> ${escapeHtml(result.gracePeriodId)}</p>` : ""}
    ${result.emailSourceEndpointId ? `<p><strong>Email source:</strong> ${escapeHtml(result.emailSourceEndpointId)}</p>` : ""}
    ${result.purchaseSourceEndpointId ? `<p><strong>Payment source endpoint:</strong> ${escapeHtml(result.purchaseSourceEndpointId)}</p>` : ""}
    ${renderSubscription(result.subscription)}
    <details open><summary>Plan signals from selected endpoint</summary><ul>${renderSignals(result.signals)}</ul></details>
    ${renderRaw(result)}
    <details open>
      <summary>All endpoint attempts</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Auth</th>
              <th>HTTP</th>
              <th>Body</th>
              <th>Plan endpoint</th>
              <th>Plan</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>${renderProbeRows(probes)}</tbody>
        </table>
      </div>
    </details>
  `, type);
}

async function checkSession() {
  checkBtn.disabled = true;
  checkBtn.textContent = "Wait...";
  showResult("checking", renderMessage("Wait...", "warning"), "muted");

  try {
    const raw = sessionInput.value.trim();
    if (!raw) throw new Error("Р’СЃС‚Р°РІСЊ session JSON.");
    const session = JSON.parse(raw);
    const response = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    renderResult(result);
  } catch (error) {
    showResult("error", renderMessage(error.message || String(error), "error"), "error");
  } finally {
    checkBtn.disabled = false;
    checkBtn.textContent = "Check";
  }
}

function clearAll() {
  sessionInput.value = "";
  resultPanel.classList.add("hidden");
  resultBody.innerHTML = "";
  setBadge("empty", "muted");
  sessionInput.focus();
}

checkBtn.addEventListener("click", checkSession);
clearBtn.addEventListener("click", clearAll);
