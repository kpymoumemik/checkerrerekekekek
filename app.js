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

function statusType(status) {
  if (status === "VERIFIED_PAID" || status === "VERIFIED_FREE") return "success";
  if (status === "VERIFIED_DELINQUENT" || status === "VERIFIED_CONFLICT" || status === "VERIFIED_UNKNOWN_PLAN") return "warning";
  return "error";
}

function resultMessage(result) {
  if (result.status === "VERIFIED_PAID") {
    return renderMessage("Платная подписка подтверждена ответом endpoint.", "success");
  }

  if (result.status === "VERIFIED_FREE") {
    return renderMessage("Endpoint подтвердил бесплатный план.", "warning");
  }

  if (result.status === "VERIFIED_DELINQUENT") {
    return renderMessage("Endpoint ответил, но аккаунт помечен как delinquent. Не считаю подписку активной.", "warning");
  }

  if (result.status === "VERIFIED_CONFLICT") {
    return renderMessage("Endpoint вернул конфликтующие поля плана.", "warning");
  }

  if (result.status === "VERIFIED_UNKNOWN_PLAN") {
    return renderMessage("Endpoint ответил JSON, но известных полей плана в ответе нет.", "warning");
  }

  return renderMessage(result.message || "Ни один endpoint не вернул пригодный JSON с планом.", "error");
}

function renderSignals(signals) {
  if (!Array.isArray(signals) || !signals.length) return "<li>Поля плана не найдены</li>";

  return signals
    .map((signal) => `<li>${escapeHtml(signal.source)}: <strong>${escapeHtml(signal.plan.toUpperCase())}</strong></li>`)
    .join("");
}

function renderProbeRows(probes) {
  if (!Array.isArray(probes) || !probes.length) {
    return "<tr><td colspan=\"7\">Нет попыток</td></tr>";
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
        <td>${escapeHtml((probe.plan || "unknown").toUpperCase())}</td>
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
  const rows = [
    ["Active subscription", active ? "yes" : "no"],
    ["Subscription ID", subscription.subscriptionId || "unknown"],
    ["Subscription plan", subscription.subscriptionPlan || "unknown"],
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
          <div class="metric">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>
        `).join("")}
      </div>
    </details>
  `;
}

function renderResult(result) {
  const type = statusType(result.status);
  const probes = Array.isArray(result.probes) ? result.probes : [];
  const cloudflareCount = probes.filter((probe) => probe.bodyKind === "cloudflare_challenge").length;
  const cloudflareNote = cloudflareCount
    ? renderMessage(`${cloudflareCount} попыток получили Cloudflare challenge/HTML вместо JSON. Это блокировка на стороне endpoint-а, а не ошибка парсинга.`, "warning")
    : "";

  showResult(result.status, `
    ${resultMessage(result)}
    ${cloudflareNote}
    <div class="result-grid">
      <div class="metric"><span>Endpoint</span><strong>${escapeHtml(result.sourceEndpointId || result.endpoint || "none")}</strong></div>
      <div class="metric"><span>HTTP</span><strong>${escapeHtml(result.httpStatus || "none")}</strong></div>
      <div class="metric"><span>Mode</span><strong>${escapeHtml(result.sourceMode || "none")}</strong></div>
      <div class="metric"><span>Email</span><strong>${escapeHtml(result.email || "unknown")}</strong></div>
      <div class="metric"><span>Plan</span><strong>${escapeHtml((result.plan || "unknown").toUpperCase())}</strong></div>
      <div class="metric"><span>Paid</span><strong>${result.paid ? "yes" : "no"}</strong></div>
      <div class="metric"><span>Delinquent</span><strong>${result.isDelinquent ? "yes" : "no"}</strong></div>
      <div class="metric"><span>Subscription date source</span><strong>${escapeHtml(result.subscriptionSourceEndpointId || "unknown")}</strong></div>
    </div>
    ${result.gracePeriodId ? `<p><strong>Grace period:</strong> ${escapeHtml(result.gracePeriodId)}</p>` : ""}
    ${result.emailSourceEndpointId ? `<p><strong>Email source:</strong> ${escapeHtml(result.emailSourceEndpointId)}</p>` : ""}
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
  checkBtn.textContent = "Проверяю...";
  showResult("checking", renderMessage("Backend перебирает endpoint-ы. Обычно это занимает несколько секунд.", "warning"), "muted");

  try {
    const raw = sessionInput.value.trim();
    if (!raw) throw new Error("Вставь session JSON.");
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
    checkBtn.textContent = "Проверить endpoint-ы";
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
