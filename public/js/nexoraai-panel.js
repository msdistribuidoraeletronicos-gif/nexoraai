// ==========================================================
//  AUTENTICAÇÃO BÁSICA (token do Supabase)
// ==========================================================
if (!localStorage.getItem("nexoraai_token")) {
  window.location.href = "/";
}

// URL do backend (como está rodando tudo no mesmo domínio/porta, pode ficar vazio)
const API_BASE_URL = "";

// ==========================================================
//  HELPERS GERAIS
// ==========================================================
function $(id) { return document.getElementById(id); }

function safeJSONParse(val, fb) {
  try { return JSON.parse(val) ?? fb; } catch { return fb; }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function nowISO() { return new Date().toISOString(); }

function formatDateTimeBR(iso) {
  return new Date(iso).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function toast(msg, type = "info") {
  const d = document.createElement("div");
  d.className =
    "fixed bottom-5 right-5 z-50 px-4 py-3 rounded-2xl shadow-lg border text-sm " +
    (type === "error"
      ? "bg-red-50 border-red-200 text-red-800"
      : type === "success"
      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
      : "bg-slate-50 border-slate-200 text-slate-800");
  d.innerHTML = `<span>${escapeHtml(msg)}</span>`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2600);
}

// ==========================================================
//  STORAGE POR USUÁRIO (brands e generations)
// ==========================================================
function currentUserId() {
  return localStorage.getItem("nexoraai_user_id") || "anon";
}

function brandsKey() {
  return `nexoraai_${currentUserId()}_brands_v2`;
}

function generationsKey() {
  return `nexoraai_${currentUserId()}_generations_v2`;
}

function getBrands() {
  return safeJSONParse(localStorage.getItem(brandsKey()), []);
}

function setBrands(b) {
  localStorage.setItem(brandsKey(), JSON.stringify(b));
}

function getGenerations() {
  return safeJSONParse(localStorage.getItem(generationsKey()), []);
}

function setGenerations(items) {
  // limita a 20 últimos e remove imagem dos mais antigos p/ não lotar localStorage
  let trimmed = items.slice(0, 20).map((g, idx) => {
    if (idx === 0) return g;
    const clone = { ...g };
    delete clone.imageUrl;
    return clone;
  });

  try {
    localStorage.setItem(generationsKey(), JSON.stringify(trimmed));
  } catch (e) {
    console.warn("Histórico grande demais, tentando reduzir", e);
    try {
      const minimal = trimmed.slice(0, 5).map((g) => {
        const c = { ...g };
        delete c.imageUrl;
        return c;
      });
      localStorage.setItem(generationsKey(), JSON.stringify(minimal));
    } catch (e2) {
      console.error("Falha ao salvar histórico, limpando", e2);
      localStorage.removeItem(generationsKey());
    }
  }
}

// ==========================================================
//  PERFIL + PLANO (Supabase)
// ==========================================================
function syncUserName() {
  const name = localStorage.getItem("nexoraai_user_name") || "Usuário";
  document.querySelectorAll("[data-user-name]").forEach((el) => {
    el.textContent = name;
  });
}

function syncPlanBadgesFromLocal() {
  const raw = localStorage.getItem("nexoraai_plan");
  const labelSidebar = document.getElementById("planLabel");
  const labelProfileSmall = document.getElementById("planLabelProfile");
  const badgeProfile = document.getElementById("profilePlanBadge");
  const badgeBilling = document.getElementById("billingPlanBadge");
  const infoBilling = document.getElementById("billingPlanInfo");

  if (labelSidebar && labelProfileSmall) {
    labelProfileSmall.textContent = labelSidebar.textContent;
  }

  if (!raw) {
    if (badgeProfile) badgeProfile.textContent = "Pro R$ 49,90/mês";
    if (badgeBilling) badgeBilling.textContent = "Pro";
    if (infoBilling)
      infoBilling.textContent =
        "Não encontramos informações do plano ainda. Clique em “Atualizar status” para buscar no servidor.";
    return;
  }

  try {
    const plan = JSON.parse(raw);
    let short = "Pro";

    if (plan.status === "trial") {
      short = "Teste";
      if (infoBilling)
        infoBilling.textContent = `Você está em período de teste (${plan.daysLeft} dia(s) restantes). Depois disso, o plano vira Pro por R$ 49,90/mês.`;
    } else if (plan.status === "expired") {
      short = "Expirado";
      if (infoBilling)
        infoBilling.textContent =
          "Seu período de teste acabou. Renove para continuar usando a plataforma.";
    } else {
      if (infoBilling)
        infoBilling.textContent =
          "Seu plano Pro está ativo. Obrigado por apoiar o projeto! 🎉";
    }

    if (badgeProfile) badgeProfile.textContent = short;
    if (badgeBilling) badgeBilling.textContent = short;
  } catch (e) {
    console.error("Erro ao ler plano:", e);
  }
}

function updatePlanLabel(plan) {
  const el = document.getElementById("planLabel");
  if (!el) return;

  if (!plan) {
    el.textContent = "NexoraAI Pro";
    el.className = "text-xs text-slate-400";
    return;
  }

  if (plan.status === "trial") {
    el.textContent = `Teste (${plan.daysLeft} dia(s))`;
    el.className = "text-xs text-blue-500 font-medium";
  } else if (plan.status === "expired") {
    el.textContent = "Plano expirado";
    el.className = "text-xs text-red-500 font-bold";
  } else {
    el.textContent = "NexoraAI Pro";
    el.className = "text-xs text-slate-400";
  }

  syncPlanBadgesFromLocal();
}

function checkPlanOnLoad() {
  const raw = localStorage.getItem("nexoraai_plan");
  if (!raw) return;
  try {
    const plan = JSON.parse(raw);
    if (plan.status === "expired") {
      toast("Seu período de teste acabou. Assine o plano Pro para continuar.", "error");
      openBillingSection();
    }
  } catch (e) {
    console.error("Erro ao verificar plano:", e);
  }
}

function fetchPlanStatus() {
  const token = localStorage.getItem("nexoraai_token");
  if (!token) return;

  const baseUrl = API_BASE_URL || "";
  fetch(`${baseUrl}/auth/plan`, {
    method: "GET",
    headers: { Authorization: "Bearer " + token },
  })
    .then((r) => r.json())
    .then((data) => {
      if (!data.ok) return;
      const plan = data.plan;
      localStorage.setItem("nexoraai_plan", JSON.stringify(plan || {}));
      if (data.user && data.user.email) {
        localStorage.setItem("nexoraai_user_email", data.user.email);
      }
      updatePlanLabel(plan);
      checkPlanOnLoad();
    })
    .catch((err) => {
      console.error("Erro ao buscar plano:", err);
    });
}

function checkPlanBeforeGenerate() {
  const raw = localStorage.getItem("nexoraai_plan");
  if (!raw) return true; // se não soubermos, deixa gerar

  try {
    const plan = JSON.parse(raw);
    if (plan.status === "expired") {
      toast("Seu período de teste acabou. Assine o plano Pro para continuar.", "error");
      openBillingSection();
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function logoutStratAI() {
  try {
    localStorage.removeItem("nexoraai_token");
    localStorage.removeItem("nexoraai_user_id");
    localStorage.removeItem("nexoraai_user_name");
    localStorage.removeItem("nexoraai_user_email");
    localStorage.removeItem("nexoraai_plan");
    localStorage.removeItem(brandsKey());
    localStorage.removeItem(generationsKey());
  } catch (e) {
    console.error("Erro ao limpar storage:", e);
  }
  window.location.href = "/";
}

function openProfileSection() {
  showSection("profile");
  loadProfileData();
}

window.loadProfileData = function () {
  const name = localStorage.getItem("nexoraai_user_name") || "";
  const email = localStorage.getItem("nexoraai_user_email") || "";

  const nameInput = $("profileNameInput");
  const emailInput = $("profileEmailInput");

  if (nameInput) nameInput.value = name;
  if (emailInput) emailInput.value = email;
};

window.saveUserProfile = function () {
  const nameInput = $("profileNameInput");
  const newName = nameInput ? nameInput.value.trim() : "";

  if (!newName) {
    toast("Por favor, digite um nome válido.", "error");
    return;
  }

  localStorage.setItem("nexoraai_user_name", newName);

  document.querySelectorAll("[data-user-name]").forEach((el) => {
    el.textContent = newName;
  });

  toast("Perfil atualizado com sucesso!", "success");
};

function openBillingSection() {
  syncPlanBadgesFromLocal();
  showSection("billing");
}

// ==========================================================
//  CONFIGURAÇÃO INICIAL DE PERFIL / BOTÕES
// ==========================================================
document.addEventListener("DOMContentLoaded", () => {
  syncUserName();

  const gearBtn = document.getElementById("userSettingsBtn");
  const profilePanel = document.getElementById("userProfilePanel");
  const btnLogout = document.getElementById("btnLogout");
  const planLabel = document.getElementById("planLabel");
  const planLabelProfile = document.getElementById("planLabelProfile");
  const btnProfile = document.getElementById("btnProfile");
  const btnBilling = document.getElementById("btnBilling");
  const btnProfileSave = document.getElementById("btnProfileSave");
  const btnBillingRefresh = document.getElementById("btnBillingRefresh");
  const btnBillingCheckout = document.getElementById("btnBillingCheckout");

  if (planLabel && planLabelProfile) {
    planLabelProfile.textContent = planLabel.textContent;
  }

  if (gearBtn && profilePanel) {
    gearBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      profilePanel.classList.toggle("hidden");
    });

    document.addEventListener("click", (ev) => {
      if (
        !profilePanel.classList.contains("hidden") &&
        !profilePanel.contains(ev.target) &&
        !gearBtn.contains(ev.target)
      ) {
        profilePanel.classList.add("hidden");
      }
    });
  }

  if (btnLogout) btnLogout.addEventListener("click", (ev) => {
    ev.preventDefault();
    logoutStratAI();
  });

  if (btnProfile) btnProfile.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (profilePanel) profilePanel.classList.add("hidden");
    openProfileSection();
  });

  if (btnBilling) btnBilling.addEventListener("click", (ev) => {
    ev.preventDefault();
    if (profilePanel) profilePanel.classList.add("hidden");
    openBillingSection();
  });

  if (btnProfileSave) {
    btnProfileSave.addEventListener("click", () => {
      saveUserProfile();
    });
  }

  if (btnBillingRefresh) {
    btnBillingRefresh.addEventListener("click", () => {
      fetchPlanStatus();
      setTimeout(syncPlanBadgesFromLocal, 500);
    });
  }

  // 🔹 AGORA APENAS REDIRECIONA PARA /checkout
  if (btnBillingCheckout) {
    btnBillingCheckout.addEventListener("click", () => {
      window.location.href = "/checkout";
    });
  }
});

// ==========================================================
//  FILE INPUT STATUS
// ==========================================================
document.addEventListener("DOMContentLoaded", () => {
  const setups = [
    { inputId: "referenceImages", statusId: "fileStatus" },
    { inputId: "personalReferenceImages", statusId: "personalFileStatus" },
  ];

  setups.forEach(({ inputId, statusId }) => {
    const fileInput = $(inputId);
    if (!fileInput) return;
    fileInput.addEventListener("change", (e) => {
      const count = e.target.files.length;
      const status = $(statusId);
      if (status) {
        status.textContent =
          count > 0 ? `${count} imagem(ns) selecionada(s)` : "";
      }
    });
  });
});

// ==========================================================
//  NAVEGAÇÃO ENTRE SEÇÕES
// ==========================================================
let selectedContentType = null;
let currentGeneratedId = null;
let lastTemplateImageUrl = null;
let lastPersonalResult = null;
let allowNoBrandJustThisGeneration = false;

window.openCreateCommercial = function () {
  showSection("create");
  hydrateCreateBrandSelect();
};

window.openCreatePersonal = function () {
  showSection("create-personal");
};

window.showSection = function (sectionId) {
  const sections = [
    "dashboard",
    "brands",
    "create-mode",
    "create",
    "create-personal",
    "templates",
    "history",
    "profile",
    "billing",
  ];

  sections.forEach((id) => {
    const el = $(id);
    if (!el) return;
    if (id === sectionId) el.classList.remove("hidden-section");
    else el.classList.add("hidden-section");
  });

  const navActiveKey =
    sectionId === "create-mode" ||
    sectionId === "create" ||
    sectionId === "create-personal"
      ? "create"
      : sectionId;

  document.querySelectorAll(".sidebar-item[data-section]").forEach((item) => {
    const target = item.getAttribute("data-section");
    item.classList.toggle("active", target === navActiveKey);
  });

  if (sectionId === "brands") renderBrands();
  if (sectionId === "create") hydrateCreateBrandSelect();
  if (sectionId === "history") renderHistory();
  if (sectionId === "profile") loadProfileData();
  refreshDashboard();
};

function setupSidebarNavigation() {
  document.querySelectorAll(".sidebar-item[data-section]").forEach((item) => {
    item.addEventListener("click", () => {
      const target = item.getAttribute("data-section") || "dashboard";
      const sectionId = target === "create" ? "create-mode" : target;
      showSection(sectionId);
    });
  });
}

// ==========================================================
//  API STATUS
// ==========================================================
async function checkAPI() {
  const badge = $("apiStatus");
  if (!badge) return;
  try {
    const r = await fetch(`${API_BASE_URL}/health`, { method: "GET" });
    if (!r.ok) throw new Error("bad");
    badge.textContent = "online";
    badge.className =
      "px-2 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/25 text-emerald-200";
  } catch {
    badge.textContent = "offline";
    badge.className =
      "px-2 py-1 rounded-full bg-red-500/15 border border-red-500/25 text-red-200";
  }
}

// ==========================================================
//  SVG FALLBACK
// ==========================================================
function svgDataURI({ title, subtitle }) {
  const safeT = (title || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeS = (subtitle || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#2563eb"/>
          <stop offset="1" stop-color="#4f46e5"/>
        </linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#0b1220" flood-opacity="0.35"/>
        </filter>
      </defs>
      <rect width="1080" height="1080" fill="url(#g)"/>
      <circle cx="980" cy="120" r="220" fill="rgba(255,255,255,0.12)"/>
      <circle cx="120" cy="980" r="260" fill="rgba(255,255,255,0.10)"/>
      <rect x="90" y="220" width="900" height="640" rx="48" fill="rgba(255,255,255,0.14)" filter="url(#shadow)"/>
      <text x="140" y="360" font-family="Inter, Arial" font-size="56" fill="#ffffff" font-weight="700">${safeT}</text>
      <text x="140" y="430" font-family="Inter, Arial" font-size="30" fill="rgba(255,255,255,0.92)" font-weight="500">${safeS}</text>
      <text x="140" y="800" font-family="Inter, Arial" font-size="26" fill="rgba(255,255,255,0.85)">Gerado pelo NexoraAI • Visual provisório</text>
    </svg>
  `.trim();

  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

// ==========================================================
//  FLYER POR ARROBA
// ==========================================================
window.generateFlyerFromHandle = async function () {
  if (!checkPlanBeforeGenerate()) return;

  const input = $("igHandleInput");
  const statusEl = $("igHandleStatus");
  const resultBox = $("templatesResult");
  if (!input) return;

  const raw = (input.value || "").trim();
  if (!raw) {
    toast("Informe o arroba do Instagram.", "error");
    input.focus();
    return;
  }
  const cleanHandle = raw.replace(/^@+/, "");

  if (statusEl)
    statusEl.textContent = `Gerando flyer para @${cleanHandle}...`;

  if (resultBox) {
    resultBox.innerHTML = `
      <div class="flex flex-col items-center text-center animate-pulse text-slate-500">
        <div class="w-12 h-12 rounded-2xl bg-blue-50 border border-blue-200 flex items-center justify-center mb-3">
          <i class="fa-solid fa-circle-notch fa-spin text-blue-600"></i>
        </div>
        <p class="text-sm font-semibold">Gerando imagem a partir do perfil @${cleanHandle}…</p>
      </div>
    `;
  }

  try {
    const r = await fetch(`${API_BASE_URL}/api/templates/ig-flyer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: cleanHandle }),
    });
    const data = await r.json();

    if (!r.ok || !data?.ok) {
      throw new Error(data?.error || "Erro ao gerar flyer.");
    }
    if (!data.imageUrl) {
      throw new Error("Resposta sem imagem.");
    }

    lastTemplateImageUrl = data.imageUrl;

    if (resultBox) {
      resultBox.innerHTML = `
        <div class="w-full flex flex-col gap-3">
          <div class="rounded-2xl border border-slate-200 overflow-hidden bg-slate-50">
            <img src="${data.imageUrl}" alt="Flyer gerado" class="w-full h-auto block rounded-2xl" />
          </div>
          <button type="button" onclick="downloadTemplateImage()" class="self-start text-xs px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100">
            <i class="fa-solid fa-download"></i> Baixar imagem
          </button>
        </div>
      `;
    }
    if (statusEl) statusEl.textContent = `Flyer gerado para @${cleanHandle}.`;
    toast("Flyer gerado com sucesso!", "success");
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = "Erro ao gerar flyer.";
    if (resultBox) {
      resultBox.innerHTML = `
        <div class="text-center text-sm text-red-600">
          Ocorreu um erro ao gerar a imagem.
        </div>
      `;
    }
    toast(e.message || "Erro ao gerar flyer.", "error");
  }
};

window.downloadTemplateImage = function () {
  if (!lastTemplateImageUrl) {
    toast("Nenhuma imagem para baixar.", "error");
    return;
  }
  const a = document.createElement("a");
  a.href = lastTemplateImageUrl;
  a.download = `nexoraai_instagram_${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// ==========================================================
//  MARCAS
// ==========================================================
function normalizeBrandPayload() {
  const id =
    (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random();

  return {
    id,
    name: ($("brandName")?.value || "").trim(),
    niche: ($("brandNiche")?.value || "Negócio Local").trim(),
    audience: ($("brandAudience")?.value || "").trim(),
    tone: ($("brandTone")?.value || "Profissional").trim(),
    goal: ($("brandGoal")?.value || "Vender").trim(),
    createdAt: nowISO(),
  };
}

window.saveBrand = function () {
  const brand = normalizeBrandPayload();
  if (!brand.name) {
    toast("Preencha o nome da marca.", "error");
    $("brandName")?.focus();
    return;
  }
  const brands = getBrands();
  brands.unshift(brand);
  setBrands(brands);

  if ($("brandName")) $("brandName").value = "";
  if ($("brandNiche")) $("brandNiche").value = "";
  if ($("brandAudience")) $("brandAudience").value = "";

  renderBrands();
  hydrateCreateBrandSelect();
  refreshDashboard();
  toast("Marca salva com sucesso!", "success");
};

window.clearBrands = function () {
  if (!confirm("Tem certeza que deseja apagar todas as marcas?")) return;
  setBrands([]);
  renderBrands();
  hydrateCreateBrandSelect();
  refreshDashboard();
  toast("Marcas removidas.", "success");
};

window.removeBrand = function (id) {
  const brands = getBrands().filter((b) => b.id !== id);
  setBrands(brands);
  renderBrands();
  hydrateCreateBrandSelect();
  refreshDashboard();
  toast("Marca removida.", "success");
};

function renderBrands() {
  const list = $("brandList");
  if (!list) return;
  const brands = getBrands();
  if (!brands.length) {
    list.innerHTML =
      '<li class="text-sm text-slate-500">Nenhuma marca cadastrada ainda.</li>';
    return;
  }

  list.innerHTML = brands
    .map(
      (b) => `
      <li class="border border-slate-200 rounded-2xl p-4 bg-slate-50/40">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="font-bold text-slate-900">${escapeHtml(b.name)}</p>
            <p class="text-xs text-slate-600 mt-1">
              <span class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white border border-slate-200">
                <i class="fa-solid fa-tag text-slate-500"></i>
                ${escapeHtml(b.niche)}
              </span>
              <span class="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white border border-slate-200">
                <i class="fa-solid fa-microphone text-slate-500"></i>
                ${escapeHtml(b.tone)}
              </span>
              <span class="ml-2 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white border border-slate-200">
                <i class="fa-solid fa-bullseye text-slate-500"></i>
                ${escapeHtml(b.goal)}
              </span>
            </p>
            <p class="text-xs text-slate-500 mt-2">
              <i class="fa-regular fa-clock"></i> ${formatDateTimeBR(b.createdAt)}
            </p>
            ${
              b.audience
                ? `<p class="text-sm text-slate-700 mt-3 leading-relaxed"><strong>Público:</strong> ${escapeHtml(
                    b.audience
                  )}</p>`
                : ""
            }
          </div>
          <button class="text-xs px-3 py-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-100 text-slate-700"
            onclick="removeBrand('${b.id}')">
            <i class="fa-solid fa-trash"></i> Remover
          </button>
        </div>
      </li>
    `
    )
    .join("");
}

function hydrateCreateBrandSelect() {
  const sel = $("createBrandSelect");
  const hint = $("brandHint");
  if (!sel) return;
  const brands = getBrands();

  sel.innerHTML = "";
  if (!brands.length) {
    const opt = document.createElement("option");
    opt.textContent = "Nenhuma marca cadastrada";
    opt.value = "";
    sel.appendChild(opt);
    sel.disabled = true;
    if (hint)
      hint.textContent =
        "Cadastre uma marca em “Minhas Marcas” para personalizar.";
    return;
  }

  sel.disabled = false;
  if (hint)
    hint.textContent =
      "Escolha uma marca para puxar tom e objetivo automaticamente (se quiser).";

  const placeholder = document.createElement("option");
  placeholder.textContent = "Selecione uma marca...";
  placeholder.value = "";
  sel.appendChild(placeholder);

  brands.forEach((b) => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = `${b.name} • ${b.niche}`;
    sel.appendChild(opt);
  });
}

// ==========================================================
//  TIPO DE CONTEÚDO (BOTÕES)
// ==========================================================
function setupContentTypeButtons() {
  document.querySelectorAll(".content-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".content-type-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedContentType = btn.dataset.content || null;
      const hint = $("typeHint");
      if (hint) {
        hint.textContent = selectedContentType
          ? `Tipo selecionado: ${labelContentType(selectedContentType)}`
          : "Selecione um tipo para continuar.";
      }
    });
  });
}

function labelContentType(type) {
  const map = {
    instagram: "Post Instagram",
    facebook: "Post Facebook",
    site: "Para Site",
    video: "Roteiro Vídeo",
    copy: "Copy Vendas",
    personal: "Conteúdo Pessoal",
  };
  return map[type] || type;
}

function getSelectedBrand() {
  const id = $("createBrandSelect")?.value;
  if (!id) return null;
  return getBrands().find((b) => b.id === id) || null;
}

// ==========================================================
//  FALLBACK DE CAPTION LOCAL
// ==========================================================
function buildLocalPost({ brand, objective, briefing, type }) {
  const bName = brand?.name || "Sua marca";
  const niche = brand?.niche || "negócio local";

  const ctaByObj = {
    Vender: "📲 Chame no WhatsApp e garanta o seu agora!",
    Engajar: "💬 Comente aqui e marque alguém que precisa ver isso!",
    Educar: "💾 Salve este post e compartilhe com alguém que vai se beneficiar!",
  };

  const cta = ctaByObj[objective] || "Fale com a gente.";

  const hashtags = [
    `#${bName.replace(/\s+/g, "")}`,
    `#${niche.replace(/\s+/g, "")}`,
    "#conteudoestrategico",
    "#marketingdigital",
    type === "instagram" ? "#instagrambrasil" : "",
    type === "facebook" ? "#facebookmarketing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const caption = `🔥 ${bName}\n\n${briefing}\n\n✅ Feito especialmente para ${niche}.\n${cta}\n\n${hashtags}`;

  const img = svgDataURI({
    title:
      objective === "Vender"
        ? "Oferta em destaque"
        : objective === "Educar"
        ? "Dica prática"
        : "Conteúdo do dia",
    subtitle:
      briefing.length > 60 ? briefing.slice(0, 60) + "…" : briefing,
  });

  return { caption, imageUrl: img };
}

function buildPersonalLocalPost({ personalType, objective, briefing }) {
  const title =
    objective === "Convidar pessoas"
      ? "Você é meu convidado!"
      : objective === "Agradecer"
      ? "Muito obrigado(a)!"
      : objective === "Homenagear alguém"
      ? "Homenagem especial"
      : "Momento especial";

  const subtitle =
    briefing.length > 60 ? briefing.slice(0, 60) + "…" : briefing || personalType;

  const caption = `💜 ${personalType}\n\n${briefing}\n\nObjetivo: ${objective}.\nCompartilhe com quem faz parte desse momento.`;

  const img = svgDataURI({ title, subtitle });
  return { caption, imageUrl: img };
}

// ==========================================================
//  LOADING UI
// ==========================================================
function setLoadingUI(on) {
  const resultArea = $("resultArea");
  const finalContent = $("finalContent");
  if (on) {
    if (finalContent) finalContent.classList.add("hidden");
    if (resultArea) {
      resultArea.classList.remove("hidden");
      resultArea.innerHTML = `
        <div class="animate-pulse flex flex-col items-center text-center">
          <div class="w-14 h-14 rounded-3xl bg-blue-50 border border-blue-200 flex items-center justify-center mx-auto mb-4">
            <i class="fa-solid fa-circle-notch fa-spin text-2xl text-blue-600"></i>
          </div>
          <p class="font-semibold text-slate-700">Gerando post completo…</p>
          <p class="text-sm text-slate-500 mt-1">Legenda + hashtags + visual</p>
        </div>
      `;
    }
  } else {
    if (resultArea) resultArea.classList.add("hidden");
    if (finalContent) finalContent.classList.remove("hidden");
  }
}

function setPersonalLoadingUI(on) {
  const resultArea = $("personalResultArea");
  const finalContent = $("personalFinalContent");
  if (on) {
    if (finalContent) finalContent.classList.add("hidden");
    if (resultArea) {
      resultArea.classList.remove("hidden");
      resultArea.innerHTML = `
        <div class="animate-pulse flex flex-col items-center text-center">
          <div class="w-14 h-14 rounded-3xl bg-purple-50 border border-purple-200 flex items-center justify-center mx-auto mb-4">
            <i class="fa-solid fa-circle-notch fa-spin text-2xl text-purple-600"></i>
          </div>
          <p class="font-semibold text-slate-700">Gerando arte pessoal…</p>
          <p class="text-sm text-slate-500 mt-1">Legenda + visual personalizado</p>
        </div>
      `;
    }
  } else {
    if (resultArea) resultArea.classList.add("hidden");
    if (finalContent) finalContent.classList.remove("hidden");
  }
}

// ==========================================================
//  GERAÇÃO PESSOAL
// ==========================================================
window.generatePersonalPost = async function () {
  if (!checkPlanBeforeGenerate()) return;

  const typeSelect = $("personalTypeSelect");
  const objectiveSel = $("personalObjectiveSelect");
  const briefingEl = $("personalBriefingInput");
  const fileInput = $("personalReferenceImages");
  const recreateCheck = $("personalRecreateCheck");

  const custom = ($("personalTypeCustom")?.value || "").trim();
  const personalType = custom || (typeSelect?.value || "").trim();
  const objective = objectiveSel?.value || "Compartilhar momento";
  const briefing = (briefingEl?.value || "").trim();

  if (!personalType) {
    toast("Selecione ou escreva o tipo de conteúdo pessoal.", "error");
    typeSelect?.focus();
    return;
  }
  if (!briefing) {
    toast("Descreva o que você quer comunicar no briefing.", "error");
    briefingEl?.focus();
    return;
  }

  setPersonalLoadingUI(true);

  const brand = {
    name: `Pessoal - ${personalType}`,
    niche: personalType,
    audience: "Uso pessoal, amigos e familiares",
    tone: "Humanizado",
    goal: objective,
  };

  let result = null;

  try {
    const fd = new FormData();
    fd.append("brand", JSON.stringify(brand));
    fd.append("objective", objective);
    fd.append("briefing", briefing);
    fd.append("contentType", "personal");

    if (recreateCheck && recreateCheck.checked) {
      fd.append("recreateMode", "true");
    }
    if (fileInput && fileInput.files.length > 0) {
      const max = Math.min(fileInput.files.length, 3);
      for (let i = 0; i < max; i++) {
        fd.append("referenceImages", fileInput.files[i]);
      }
    }

    const r = await fetch(`${API_BASE_URL}/api/generate-post`, {
      method: "POST",
      body: fd,
    });

    if (r.ok) {
      const payload = await r.json();
      if (payload?.ok && payload.caption) {
        const fallbackVisual = buildPersonalLocalPost({
          personalType,
          objective,
          briefing,
        });
        result = {
          caption: payload.caption,
          imageUrl: payload.imageUrl || fallbackVisual.imageUrl,
        };
        if (!payload.imageUrl) {
          toast(
            "Imagem da IA falhou, gerando visual provisório (pessoal).",
            "info"
          );
        }
      } else if (payload && !payload.ok) {
        toast(
          "Erro no backend: " +
            (payload.error || "Falha ao gerar conteúdo."),
          "error"
        );
      }
    }
  } catch (e) {
    console.warn("Erro backend (pessoal), usando fallback local.", e);
  }

  if (!result) {
    result = buildPersonalLocalPost({ personalType, objective, briefing });
    toast("Backend indisponível (pessoal). Usei fallback local.", "info");
  }

  lastPersonalResult = {
    ...result,
    personalType,
    objective,
    briefing,
  };

  const id =
    (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random();

  const item = {
    id,
    createdAt: nowISO(),
    brandId: null,
    brandName: `Pessoal - ${personalType}`,
    platform: "personal",
    mode: "personal",
    objective,
    briefing,
    caption: result.caption,
    imageUrl: result.imageUrl,
    personalType,
  };

  const items = getGenerations();
  items.unshift(item);
  setGenerations(items);

  $("personalPreviewImage").src = result.imageUrl;
  $("personalCaptionOutput").textContent = result.caption;
  setPersonalLoadingUI(false);
  refreshDashboard();
  renderHistory();
  toast("Conteúdo pessoal gerado!", "success");
};

window.copyCaptionPersonal = function () {
  if (!lastPersonalResult) {
    toast("Nada para copiar (pessoal).", "error");
    return;
  }
  navigator.clipboard
    .writeText(lastPersonalResult.caption)
    .then(() => toast("Legenda pessoal copiada!", "success"))
    .catch(() =>
      toast("Falha ao copiar (permissão do navegador).", "error")
    );
};

window.downloadImagePersonal = function () {
  if (!lastPersonalResult) {
    toast("Nenhuma imagem pessoal para baixar.", "error");
    return;
  }
  const a = document.createElement("a");
  a.href = lastPersonalResult.imageUrl;
  a.download = `nexoraai_pessoal_${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast("Download iniciado!", "success");
};

window.variantPersonal = function (kind) {
  if (!lastPersonalResult) {
    toast("Nada para ajustar (pessoal).", "error");
    return;
  }
  let caption = lastPersonalResult.caption || "";

  if (kind === "short") {
    const lines = caption.split("\n");
    const main = lines.slice(0, 6).join("\n");
    const hashtags = (caption.match(/#\S+/g) || []).slice(0, 6).join(" ");
    caption = main + (hashtags ? "\n\n" + hashtags : "");
  } else if (kind === "formal") {
    caption = caption
      .replace(/[🔥💜🎉🎊🥳💥🚀✨🎁🎈]/g, "")
      .replace(/!/g, ".")
      .replace(/✅/g, "•");
  } else if (kind === "persuasive") {
    caption =
      "💥 " +
      caption.replace(
        "Objetivo:",
        "Objetivo desse momento:"
      ) +
      "\n\n⚡ Não perca esse momento especial, compartilhe com quem você ama.";
  }

  lastPersonalResult.caption = caption;
  $("personalCaptionOutput").textContent = caption;
  toast("Variação aplicada (pessoal).", "success");
};

// ==========================================================
//  GERAÇÃO COMERCIAL
// ==========================================================
function getCurrentItem() {
  if (!currentGeneratedId) return null;
  return getGenerations().find((x) => x.id === currentGeneratedId) || null;
}

window.generatePostComplete = async function () {
  if (!checkPlanBeforeGenerate()) return;

  const objective = $("objectiveSelect")?.value || "Vender";
  const briefing = ($("briefingInput")?.value || "").trim();
  const type = selectedContentType;
  const fileInput = $("referenceImages");
  const recreateCheck = $("recreateCheck");

  // 🔹 Pega a marca selecionada normalmente
  let brand = getSelectedBrand();

  // 🔹 Se NÃO tiver marca e o flag da sugestão estiver ativo,
  //     criamos uma marca genérica só para essa geração.
  if (!brand && allowNoBrandJustThisGeneration) {
    brand = {
      id: null,
      name: "Minha marca",
      niche: "Negócio local",
      audience: "Clientes da região",
      tone: "Profissional",
      goal: objective,
    };
  }

  // 🔹 Se mesmo assim não tiver brand, exige marca (fluxo normal)
  if (!brand) {
    toast("Selecione uma marca.", "error");
    $("createBrandSelect")?.focus();
    return;
  }

  if (!type) {
    toast("Selecione um tipo de conteúdo.", "error");
    return;
  }
  if (!briefing) {
    toast("Preencha o briefing.", "error");
    $("briefingInput")?.focus();
    return;
  }

  setLoadingUI(true);
  let result = null;

  try {
    const fd = new FormData();
    fd.append("brand", JSON.stringify(brand));
    fd.append("objective", objective);
    fd.append("briefing", briefing);
    fd.append("contentType", type);
    // Campo 4 removido daqui também
    if (recreateCheck && recreateCheck.checked) {
      fd.append("recreateMode", "true");
    }
    if (fileInput && fileInput.files.length > 0) {
      for (let i = 0; i < fileInput.files.length; i++) {
        fd.append("referenceImages", fileInput.files[i]);
      }
    }

    const r = await fetch(`${API_BASE_URL}/api/generate-post`, {
      method: "POST",
      body: fd,
    });

    if (r.ok) {
      const payload = await r.json();
      if (payload?.ok && payload.caption) {
        const fallbackVisual = buildLocalPost({
          brand,
          objective,
          briefing,
          type,
        });
        result = {
          caption: payload.caption,
          imageUrl: payload.imageUrl || fallbackVisual.imageUrl,
        };
        if (!payload.imageUrl) {
          toast("Imagem da IA falhou, gerando visual provisório.", "info");
        }
      } else if (payload && !payload.ok) {
        toast(
          "Erro no backend: " +
            (payload.error || "Falha ao gerar conteúdo."),
          "error"
        );
      }
    }
  } catch (e) {
    console.warn("Erro backend (comercial), usando fallback local.", e);
  }

  if (!result) {
    result = buildLocalPost({ brand, objective, briefing, type });
    toast("Backend indisponível. Usei fallback local.", "info");
  }

  const id =
    (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + Math.random();

  const item = {
    id,
    createdAt: nowISO(),
    brandId: brand.id || null,
    brandName: brand.name || "Minha marca",
    platform: type,
    objective,
    briefing,
    caption: result.caption,
    imageUrl: result.imageUrl,
  };

  const items = getGenerations();
  items.unshift(item);
  setGenerations(items);
  currentGeneratedId = id;

  $("previewImage").src = result.imageUrl;
  $("captionOutput").textContent = result.caption;
  setLoadingUI(false);
  refreshDashboard();
  renderHistory();
  toast("Post completo gerado!", "success");

  // 🔹 Reseta o flag, para que fora da sugestão volte a exigir marca
  allowNoBrandJustThisGeneration = false;
};

window.copyCaption = function () {
  const item = getCurrentItem();
  if (!item) {
    toast("Nada para copiar.", "error");
    return;
  }
  navigator.clipboard
    .writeText(item.caption)
    .then(() => toast("Legenda copiada!", "success"))
    .catch(() =>
      toast("Falha ao copiar (permissão do navegador).", "error")
    );
};

window.downloadImage = function () {
  const item = getCurrentItem();
  if (!item) {
    toast("Nada para baixar.", "error");
    return;
  }
  const a = document.createElement("a");
  a.href = item.imageUrl;
  a.download = `nexoraai_${item.brandName.replace(/\s+/g, "_").toLowerCase()}_${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast("Download iniciado!", "success");
};

window.variant = function (kind) {
  const item = getCurrentItem();
  if (!item) {
    toast("Nada para ajustar.", "error");
    return;
  }
  let caption = item.caption;

  if (kind === "short") {
    caption =
      caption.split("\n").slice(0, 6).join("\n") +
      "\n\n" +
      (caption.match(/#\S+/g) || []).slice(0, 6).join(" ");
  } else if (kind === "formal") {
    caption = caption
      .replace("🔥", "")
      .replace("📲", "")
      .replace("💬", "")
      .replace("💾", "")
      .replace(/!/g, ".")
      .replace(/✅/g, "•");
  } else if (kind === "persuasive") {
    caption =
      "🚀 " +
      caption.replace(
        "✅",
        "✅ BENEFÍCIOS"
      ) +
      "\n\n⚡ Oferta por tempo limitado.";
  }

  $("captionOutput").textContent = caption;
  toast("Variação aplicada.", "success");
};

// ==========================================================
//  DASHBOARD + HISTÓRICO
// ==========================================================
function refreshDashboard() {
  const brands = getBrands();
  const gens = getGenerations();
  const mk = monthKey(new Date());
  const monthCount = gens.filter(
    (g) => monthKey(new Date(g.createdAt)) === mk
  ).length;

  $("statContentsMonth").textContent = String(monthCount);
  $("statBrands").textContent = String(brands.length);
  $("statGenerations").textContent = String(gens.length);

  const last = gens[0];
  $("statLastType").textContent = last ? labelContentType(last.platform) : "—";
  $("statLastBrand").textContent = last ? last.brandName : "—";

  const list = $("recentList");
  if (!list) return;

  if (!gens.length) {
    list.innerHTML =
      '<li class="text-sm text-slate-500">Nenhum conteúdo gerado ainda.</li>';
    return;
  }

  list.innerHTML = gens
    .slice(0, 6)
    .map(
      (g) => `
      <li class="border border-slate-200 rounded-2xl p-4 bg-slate-50/40">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="text-sm font-bold text-slate-900">${escapeHtml(
              labelContentType(g.platform)
            )}</p>
            <p class="text-xs text-slate-600 mt-1">
              <strong>${escapeHtml(g.brandName)}</strong> • ${escapeHtml(
        g.objective || ""
      )}
            </p>
            <p class="text-xs text-slate-500 mt-1">
              <i class="fa-regular fa-clock"></i> ${formatDateTimeBR(
                g.createdAt
              )}
            </p>
            <p class="text-sm text-slate-700 mt-3 leading-relaxed">
              ${escapeHtml(g.briefing || "")}
            </p>
          </div>
          <button class="text-xs px-3 py-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-100"
            onclick="openGenerated('${g.id}')">
            <i class="fa-solid fa-eye"></i> Ver
          </button>
        </div>
      </li>
    `
    )
    .join("");
}

function renderHistory() {
  const list = $("historyList");
  if (!list) return;
  const gens = getGenerations();

  if (!gens.length) {
    list.innerHTML =
      '<li class="text-sm text-slate-500">Nenhum conteúdo ainda.</li>';
    return;
  }

  list.innerHTML = gens
    .slice(0, 30)
    .map(
      (g) => `
      <li class="border border-slate-200 rounded-2xl p-4 bg-slate-50/40">
        <div class="flex items-start justify-between gap-3">
          <div class="flex gap-3">
            <div class="w-16 h-16 rounded-xl overflow-hidden border border-slate-200 bg-white">
              <img src="${
                g.imageUrl ||
                svgDataURI({
                  title: labelContentType(g.platform),
                  subtitle: g.brandName,
                })
              }" class="w-full h-full object-cover" alt="thumb" />
            </div>
            <div>
              <p class="text-sm font-bold text-slate-900">${escapeHtml(
                labelContentType(g.platform)
              )}</p>
              <p class="text-xs text-slate-600 mt-1">
                <strong>${escapeHtml(g.brandName)}</strong> • ${escapeHtml(
        g.objective || ""
      )}
              </p>
              <p class="text-xs text-slate-500 mt-1">
                <i class="fa-regular fa-clock"></i> ${formatDateTimeBR(
                  g.createdAt
                )}
              </p>
              <p class="text-sm text-slate-700 mt-2 leading-relaxed">
                ${escapeHtml(g.briefing || "")}
              </p>
            </div>
          </div>
          <div class="flex flex-col gap-2">
            <button class="text-xs px-3 py-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-100"
              onclick="openGenerated('${g.id}')">
              <i class="fa-solid fa-eye"></i> Abrir
            </button>
            <button class="text-xs px-3 py-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-100 text-red-600"
              onclick="deleteGenerated('${g.id}')">
              <i class="fa-solid fa-trash"></i> Remover
            </button>
          </div>
        </div>
      </li>
    `
    )
    .join("");
}

window.clearHistory = function () {
  if (!confirm("Apagar todo o histórico?")) return;
  setGenerations([]);
  renderHistory();
  refreshDashboard();
  toast("Histórico limpo.", "success");
};

window.deleteGenerated = function (id) {
  const items = getGenerations().filter((x) => x.id !== id);
  setGenerations(items);
  if (currentGeneratedId === id) {
    currentGeneratedId = null;
    $("finalContent")?.classList.add("hidden");
    $("resultArea")?.classList.remove("hidden");
  }
  renderHistory();
  refreshDashboard();
  toast("Removido.", "success");
};

window.openGenerated = function (id) {
  const item = getGenerations().find((x) => x.id === id);
  if (!item) return;

  // pessoal
  if (item.platform === "personal" || item.mode === "personal") {
    showSection("create-personal");
    const imageSrc =
      item.imageUrl ||
      svgDataURI({
        title: labelContentType("personal"),
        subtitle: item.brandName,
      });
    $("personalPreviewImage").src = imageSrc;
    $("personalCaptionOutput").textContent = item.caption || "";

    $("personalResultArea")?.classList.add("hidden");
    $("personalFinalContent")?.classList.remove("hidden");

    if ($("personalBriefingInput"))
      $("personalBriefingInput").value = item.briefing || "";
    if ($("personalObjectiveSelect"))
      $("personalObjectiveSelect").value =
        item.objective || "Compartilhar momento";

    const typeSelect = $("personalTypeSelect");
    const customInput = $("personalTypeCustom");
    let foundInSelect = false;
    if (typeSelect && item.personalType) {
      for (let opt of typeSelect.options) {
        if (opt.value === item.personalType) {
          typeSelect.value = item.personalType;
          foundInSelect = true;
          break;
        }
      }
    }
    if (!foundInSelect && customInput) {
      typeSelect.value = "";
      customInput.value = item.personalType || "";
    }

    lastPersonalResult = {
      caption: item.caption,
      imageUrl: item.imageUrl,
      personalType: item.personalType,
      objective: item.objective,
      briefing: item.briefing,
    };
    toast("Conteúdo pessoal carregado.", "success");
    return;
  }

  // comercial
  showSection("create");
  currentGeneratedId = item.id;
  const imageSrc =
    item.imageUrl ||
    svgDataURI({
      title: labelContentType(item.platform),
      subtitle: item.brandName,
    });
  $("previewImage").src = imageSrc;
  $("captionOutput").textContent = item.caption || "";
  $("finalContent")?.classList.remove("hidden");
  $("resultArea")?.classList.add("hidden");

  if ($("briefingInput")) $("briefingInput").value = item.briefing || "";
  if ($("objectiveSelect"))
    $("objectiveSelect").value = item.objective || "Vender";
  if ($("createBrandSelect"))
    $("createBrandSelect").value = item.brandId || "";

  selectedContentType = item.platform;
  document.querySelectorAll(".content-type-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.content === item.platform);
  });
  $("typeHint").textContent = `Tipo selecionado: ${labelContentType(
    item.platform
  )}`;

  toast("Conteúdo carregado.", "success");
};

// ==========================================================
//  NOVA FUNÇÃO: SUGESTÃO AUTOMÁTICA
// ==========================================================
window.openSuggestionAuto = function () {
  // 1. Usar a tela de criação comercial
  showSection("create");

  // 2. Tentar selecionar a primeira marca disponível
  const brands = getBrands();
  let brand = null;
  const brandSelect = document.getElementById("createBrandSelect");

  if (brands.length > 0) {
    brand = brands[0];
    if (brandSelect) {
      brandSelect.value = brand.id;
    }
  } else {
    // Se não tiver marca, seleciona o vazio se possível
    if (brandSelect) brandSelect.value = "";
  }

  // 3. Definir Variáveis e Prompt
  const now = new Date();
  const monthName = now.toLocaleString("pt-BR", { month: "long" }); 
  
  const brandText = brand ? `meu negócio "${brand.name}" (${brand.niche})` : "meu negócio";

  const briefingPrompt = `
Me dê uma ideia criativa para engajar ${brandText} neste mês de ${monthName} no Instagram.
Quero um Briefing completo.
O objetivo é impulsionar a visibilidade aproveitando a temporada, datas comemorativas do mês e cultura brasileira.
Texto para imagem: irei fazer essa campanha, gere uma imagem publicitária atraente que represente essa ideia visualmente.
`.trim();

  // 4. Preencher campos
  selectedContentType = "instagram";
  document.querySelectorAll(".content-type-btn").forEach(btn => {
    btn.classList.remove("active");
    if (btn.dataset.content === "instagram") btn.classList.add("active");
  });
  
  const hint = document.getElementById("typeHint");
  if(hint) hint.textContent = "Tipo selecionado: Post Instagram (Sugestão)";

  const objSelect = document.getElementById("objectiveSelect");
  if (objSelect) objSelect.value = "Engajar";

  const briefingInput = document.getElementById("briefingInput");
  if (briefingInput) briefingInput.value = briefingPrompt;

  // 5. Feedback visual e Disparo
  toast("Gerando sugestão automática...", "info");
  
  // 🔹 Permitir gerar mesmo sem marca APENAS neste fluxo de sugestão
  allowNoBrandJustThisGeneration = true;

  // Chama a função que já existe para gerar o post
  generatePostComplete();
};

// ==========================================================
//  INIT
// ==========================================================
function init() {
  hydrateCreateBrandSelect();
  setupContentTypeButtons();
  renderBrands();
  renderHistory();
  refreshDashboard();
  checkAPI();
  setupSidebarNavigation();
  fetchPlanStatus();
  showSection("dashboard");

  const igInput = $("igHandleInput");
  if (igInput) {
    igInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        generateFlyerFromHandle();
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
