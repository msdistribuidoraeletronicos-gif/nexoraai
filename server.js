import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

// =====================================================
//  CONFIGURAÇÃO INICIAL
// =====================================================
const app = express();
const PORT = process.env.PORT || 3001;

// Caminhos para ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middlewares básicos
app.use(express.static(path.join(process.cwd(), "public")));
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Configuração de Upload (Multer)
const upload = multer({
  limits: { fileSize: 6 * 1024 * 1024 }, // Limite de 6MB
});

// Configuração OpenAI
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

console.log("--- AMBIENTE ---");
console.log("META_APP_ID:", process.env.META_APP_ID ? "Carregado" : "NÃO CONFIGURADO");
console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Carregada" : "NÃO CONFIGURADA");
console.log("----------------");

// =====================================================
//  STORAGE LOCAL (JSON)
// =====================================================
const STORAGE_DIR = path.join(process.cwd(), "storage");
const TOKENS_FILE = path.join(STORAGE_DIR, "meta_tokens.json");
const POSTS_FILE = path.join(STORAGE_DIR, "ig_posts.json");

function ensureStorage() {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(TOKENS_FILE)) fs.writeFileSync(TOKENS_FILE, JSON.stringify({}), "utf-8");
  if (!fs.existsSync(POSTS_FILE)) fs.writeFileSync(POSTS_FILE, JSON.stringify({}), "utf-8");
}
ensureStorage();

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

const oauthStateStore = new Set();

// =====================================================
//  SUPABASE SETUP
// =====================================================
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("ERRO CRÍTICO: Variáveis do Supabase ausentes no .env");
  process.exit(1);
}

// Cliente público (anon)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Cliente admin (service_role) - Permissão total
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =====================================================
//  MIDDLEWARE DE AUTENTICAÇÃO
// =====================================================
async function getUserFromToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: "Token não informado." });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ ok: false, error: "Token inválido ou expirado." });
  }

  req.user = data.user;
  req.accessToken = token;
  next();
}

// =====================================================
//  HELPERS AUXILIARES
// =====================================================
function j(res, status, payload) {
  return res.status(status).json(payload);
}

function buildCorpusFromPosts(posts = []) {
  const examples = posts
    .filter((p) => (p.caption || "").trim().length > 0)
    .slice(0, 25)
    .map((p, i) => {
      const cap = (p.caption || "").trim().slice(0, 1200);
      return `--- POST REAL ${i + 1} (${p.timestamp || ""}) ---\n${cap}\n`;
    })
    .join("\n");
  return examples.slice(0, 12000);
}

async function fbGet(url, accessToken) {
  const finalUrl =
    url +
    (url.includes("?") ? "&" : "?") +
    `access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetch(finalUrl);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
  return data;
}

// =====================================================
//  LÓGICA DE IA (VISÃO E GERAÇÃO)
// =====================================================
async function inferVisualStyleFromLocalIgPosts(igId) {
  try {
    const postsDb = readJSON(POSTS_FILE, {});
    const pack = postsDb[igId];

    if (!pack?.posts?.length) return null;

    const imageUrls = pack.posts
      .filter((p) =>
        ["IMAGE", "CAROUSEL_ALBUM", "PHOTO"].includes(p.media_type)
      )
      .map((p) => p.media_url)
      .filter(Boolean)
      .slice(0, 6);

    if (!imageUrls.length) return null;

    const prompt = `Você é um especialista em identidade visual.
Analise as imagens e retorne JSON:
{
  "main_colors": ["#hex1", "#hex2"],
  "secondary_colors": ["#hex3", "#hex4"],
  "imagery_keywords": ["keyword1", "keyword2"],
  "style_vibe": "vibe visual (ex: minimalista, rústico)"
}`;

    const content = [
      { type: "text", text: prompt },
      ...imageUrls.map((url) => ({
        type: "image_url",
        image_url: { url },
      })),
    ];

    const resp = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content }],
      temperature: 0,
    });

    let raw = resp.choices?.[0]?.message?.content ?? "{}";
    raw = raw.replace(/^```json/, "").replace(/```$/, "");
    return JSON.parse(raw);
  } catch (e) {
    console.error("Erro ao inferir estilo do IG:", e);
    return null;
  }
}

// -----------------------------------------------------
//  CORREÇÃO AQUI: REMOVIDO response_format
// -----------------------------------------------------
async function generateImageWithOpenAI({ imagePrompt, size }) {
  const modelToUse = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1"; 
  
  console.log(`🎨 Gerando Imagem | Modelo: ${modelToUse} | Tamanho: ${size}`);

  // 1. Chamada sem response_format para evitar erro 400
  const img = await client.images.generate({
    model: modelToUse,
    prompt: imagePrompt,
    size: size || "1024x1024",
  });

  const first = img.data[0];
  
  // 2. Tenta pegar b64 se vier (alguns modelos mandam), senão baixa a URL
  if (first.b64_json) {
    return first.b64_json;
  } else if (first.url) {
    console.log("📥 Recebida URL. Baixando para converter em Base64...");
    const r = await fetch(first.url);
    const arr = await r.arrayBuffer();
    return Buffer.from(arr).toString("base64");
  }

  throw new Error("Sem dados de imagem retornados (nem URL nem b64).");
}

// =====================================================
//  BUILDERS DE PROMPT
// =====================================================
function resolveContentKind(type, platform) {
  const raw = (type || platform || "").toLowerCase();
  if (raw.includes("insta")) return "instagram";
  if (raw.includes("face")) return "facebook";
  if (raw.includes("site") || raw.includes("blog")) return "site";
  return "generic_social";
}

function buildTextPrompt(kind, { brand, objective, briefing, corpus, referenceProfile }) {
  const context = `Marca: ${brand.name}
Nicho: ${brand.niche || "?"}
Público: ${brand.audience || "?"}
Objetivo: ${objective}
Briefing: ${briefing || ""}
${corpus ? `\nESTILO DO CLIENTE (Imite o tom):\n${corpus}\n` : ""}`.trim();

  return `Você é um estrategista de conteúdo (${kind}).
Crie APENAS o JSON:
{
  "caption": "texto do post...",
  "hashtags": ["#tag1", "#tag2"]
}
CONTEXTO:
${context}`;
}

function buildRecreateFromImagePrompt(analysis, briefing, objective) {
  return `
Recrie uma IMAGEM baseada na análise visual fornecida.

DETALHES OBRIGATÓRIOS:
- Cena: ${analysis.scene_description || "mesma da original"}
- Personagens/Objetos: ${analysis.main_subjects || "mesmos da original"}
- Composição: ${analysis.composition || "mesma da original"}
- Estilo: ${analysis.style || "realista"}
- Cores: ${analysis.colors ? analysis.colors.join(", ") : "originais"}
- Clima: ${analysis.mood || "mesmo vibe"}

NOVO CONTEXTO (Atualize se necessário):
Briefing: ${briefing}
Objetivo: ${objective}

IMPORTANTE: Melhore a qualidade, mantenha a essência, use português do Brasil para textos.
`.trim();
}

function buildPersonalImagePrompt({ personalType, objective, briefing, audience, visualStyle }) {
  const colors = visualStyle?.main_colors?.join(", ") || "cores harmoniosas e alegres";
  const vibe = visualStyle?.style_vibe || "moderno e positivo";
  
  return `
Crie uma IMAGEM para uso PESSOAL.
Tipo: "${personalType}" | Objetivo: "${objective}" | Público: ${audience}

BRIEFING: ${briefing}

ESTILO VISUAL:
- Cores: ${colors}
- Vibe: ${vibe}
- Elementos: ${visualStyle?.imagery_keywords?.join(", ") || "elementos comemorativos"}

REGRAS:
- Textos em Português do Brasil (se houver).
- Texto deve estar totalmente visível.
- Tom emocional e memorável.
`.trim();
}

function buildImagePrompt(kind, { businessName, businessNiche, businessAudience, postObjective, postType, briefingText, visualStyle, referenceProfile }) {
  const colors = visualStyle?.main_colors?.join(", ") || "cores profissionais";
  
  return `
Crie um FLYER PUBLICITÁRIO para ${kind === 'instagram' ? 'Instagram' : 'Redes Sociais'}.

DADOS:
- Marca: ${businessName} (${businessNiche})
- Público: ${businessAudience}
- Objetivo: ${postObjective}
- Briefing: ${briefingText}

ESTILO:
- Cores: ${colors}
- Layout: ${visualStyle?.layout_description || "organizado e limpo"}

REGRAS:
- Aparência profissional de marketing.
- Texto em Português do Brasil.
- Hierarquia visual clara.
`.trim();
}

// =====================================================
//  ROTAS PÚBLICAS
// =====================================================
app.get("/", (req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));
app.get("/app", (req, res) => res.sendFile(path.join(process.cwd(), "public", "painel.html")));
app.get("/health", (req, res) => res.json({ ok: true, status: "online", db: "supabase" }));

// =====================================================
//  ROTAS DE AUTENTICAÇÃO (SUPABASE)
// =====================================================

// REGISTRO
app.post("/auth/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "E-mail e senha são obrigatórios." });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name || null,
          phone: phone || null,
        },
      },
    });

    if (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }

    const user = data.user;
    if (!user) {
      return res.status(400).json({ ok: false, error: "Erro na criação do usuário." });
    }

    await supabaseAdmin.from("profiles").upsert({
      id: user.id,
      full_name: name || null,
      phone: phone || null,
      updated_at: new Date().toISOString(),
    });

    await supabaseAdmin.from("plans").insert({
      user_id: user.id,
      status: "trial",
      trial_started_at: new Date().toISOString(),
      trial_days: 7,
    });

    await supabaseAdmin.from("users").upsert({
      id: user.id,
      name: name || user.email,
      email: user.email,
      phone: phone || null,
    });

    const token = data.session?.access_token || null;

    return res.json({
      ok: true,
      token,
      user: { 
        id: user.id, 
        name: name || null, 
        email: user.email 
      },
      message: token ? "Conta criada com sucesso." : "Verifique seu e-mail para confirmar.",
    });

  } catch (e) {
    console.error("Erro register:", e);
    return res.status(500).json({ ok: false, error: "Erro interno ao registrar." });
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;
    const email = identifier;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Credenciais obrigatórias." });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.warn("Falha no login:", error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }

    const { user, session } = data;

    const { data: profileData } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();

    const { data: planData } = await supabaseAdmin
      .from("plans")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .maybeSingle();

    let plan = null;
    if (planData) {
      const now = new Date();
      let status = planData.status;
      let daysLeft = 0;

      if (status === "trial" && planData.trial_started_at) {
        const start = new Date(planData.trial_started_at);
        const end = new Date(start.getTime() + (planData.trial_days || 7) * 86400000);
        const diffMs = end.getTime() - now.getTime();
        
        daysLeft = Math.max(0, Math.ceil(diffMs / 86400000));
        if (diffMs <= 0) {
          status = "expired";
          daysLeft = 0;
        }
      }
      plan = { status, daysLeft };
    }

    return res.json({
      ok: true,
      token: session.access_token,
      user: {
        id: user.id,
        name: profileData?.full_name || user.user_metadata?.full_name || null,
        email: user.email,
      },
      plan,
    });
  } catch (e) {
    console.error("Erro login:", e);
    return res.status(500).json({ ok: false, error: "Erro interno no login." });
  }
});

// CONSULTA DE PLANO
app.get("/auth/plan", getUserFromToken, async (req, res) => {
  try {
    const user = req.user;
    
    // Buscar também o profile para retornar nome correto
    const { data: profileData } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();

    const { data: planData } = await supabaseAdmin
      .from("plans")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .maybeSingle();

    let status = planData?.status || "none";
    let daysLeft = 0;

    if (planData && status === "trial") {
      const start = new Date(planData.trial_started_at);
      const end = new Date(start.getTime() + (planData.trial_days || 7) * 86400000);
      const diffMs = end.getTime() - new Date().getTime();
      daysLeft = Math.max(0, Math.ceil(diffMs / 86400000));
      if (diffMs <= 0) status = "expired";
    }

    return res.json({
      ok: true,
      plan: { status, daysLeft },
      user: { 
        id: user.id, 
        email: user.email,
        name: profileData?.full_name || user.user_metadata?.full_name || null,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao buscar plano." });
  }
});

// =====================================================
//  INTEGRAÇÃO META / FACEBOOK
// =====================================================
app.get("/auth/meta/start", (req, res) => {
  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;
  
  if (!appId || !redirectUri) return j(res, 400, { error: "Meta Config Missing" });

  const state = crypto.randomBytes(16).toString("hex");
  oauthStateStore.add(state);
  
  const scope = "public_profile,pages_show_list,pages_read_engagement,pages_read_user_content,instagram_basic,instagram_manage_insights";
  const url = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirectUri}&state=${state}&response_type=code&scope=${scope}`;
  
  return res.redirect(url);
});

app.get("/auth/meta/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!oauthStateStore.has(state)) return j(res, 400, { error: "Estado inválido (CSRF)" });
    oauthStateStore.delete(state);

    const tokenUrl = `https://graph.facebook.com/v20.0/oauth_access_token?client_id=${process.env.META_APP_ID}&redirect_uri=${process.env.META_REDIRECT_URI}&client_secret=${process.env.META_APP_SECRET}&code=${code}`;
    const r1 = await fetch(tokenUrl);
    const d1 = await r1.json();
    const shortToken = d1.access_token;

    const longUrl = `https://graph.facebook.com/v20.0/oauth_access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${shortToken}`;
    const r2 = await fetch(longUrl);
    const d2 = await r2.json();
    const accessToken = d2.access_token || shortToken;

    const p = await fbGet(`https://graph.facebook.com/v20.0/me/accounts?fields=id,name,access_token`, accessToken);

    const db = readJSON(TOKENS_FILE, {});
    db["local_user"] = {
      connectedAt: new Date().toISOString(),
      accessToken,
      pages: p.data || [],
    };
    writeJSON(TOKENS_FILE, db);

    return res.redirect("/?connected=1");
  } catch (e) {
    console.error(e);
    return res.redirect(`/?connected=0&error=${e.message}`);
  }
});

app.get("/api/meta/pages", (req, res) => {
  const db = readJSON(TOKENS_FILE, {});
  if (!db["local_user"]?.accessToken) return j(res, 401, { error: "Não conectado ao Meta" });
  return res.json({ ok: true, pages: db["local_user"].pages });
});

app.post("/api/meta/select-page", async (req, res) => {
  const { pageId } = req.body;
  const db = readJSON(TOKENS_FILE, {});
  const user = db["local_user"];
  
  if (!user?.accessToken) return j(res, 401, { error: "Não conectado" });

  const page = user.pages.find((p) => p.id === pageId);
  if (!page) return j(res, 400, { error: "Página não encontrada na conta" });

  try {
    const info = await fbGet(
      `https://graph.facebook.com/v20.0/${pageId}?fields=id,name,instagram_business_account{name,username}`,
      page.access_token
    );
    const ig = info.instagram_business_account;
    if (!ig?.id) return j(res, 400, { error: "Página não possui Instagram Business vinculado." });

    user.selected = {
      pageId,
      pageName: info.name,
      pageAccessToken: page.access_token,
      igId: ig.id,
      igUsername: ig.username,
      igName: ig.name,
    };
    writeJSON(TOKENS_FILE, db);
    res.json({ ok: true, selected: user.selected });
  } catch (e) {
    j(res, 500, { error: e.message });
  }
});

app.post("/api/meta/sync-instagram", async (req, res) => {
  const { limit = 30 } = req.body;
  const db = readJSON(TOKENS_FILE, {});
  const sel = db["local_user"]?.selected;
  
  if (!sel?.igId) return j(res, 400, { error: "Nenhum Instagram selecionado." });

  try {
    const media = await fbGet(
      `https://graph.facebook.com/v20.0/${sel.igId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,thumbnail_url`,
      sel.pageAccessToken
    );
    const items = (media.data || []).slice(0, Number(limit));

    const postsDb = readJSON(POSTS_FILE, {});
    postsDb[sel.igId] = {
      syncedAt: new Date().toISOString(),
      ...sel,
      posts: items.map((p) => ({
        id: p.id,
        caption: p.caption,
        media_type: p.media_type,
        media_url: p.media_url || p.thumbnail_url,
        permalink: p.permalink,
        timestamp: p.timestamp,
      })),
    };
    writeJSON(POSTS_FILE, postsDb);
    res.json({ ok: true, count: items.length });
  } catch (e) {
    j(res, 500, { error: e.message });
  }
});

// =====================================================
//  GERAÇÃO DE CONTEÚDO (IA)
// =====================================================

// FLYER SIMPLES POR ARROBA
app.post("/api/templates/ig-flyer", async (req, res) => {
  try {
    const { handle } = req.body || {};
    if (!handle) return j(res, 400, { error: "Handle obrigatório." });

    const cleanHandle = String(handle).trim().replace(/^@+/, "");
    const imagePrompt = `Crie um flyer moderno e quadrado para o perfil do Instagram @${cleanHandle}. Estilo profissional e visualmente atraente.`;

    const b64 = await generateImageWithOpenAI({ imagePrompt, size: "1024x1024" });
    return res.json({ ok: true, imageUrl: `data:image/png;base64,${b64}` });

  } catch (e) {
    console.error("Erro flyer:", e);
    return j(res, 500, { ok: false, error: "Erro ao gerar flyer." });
  }
});

// GERAÇÃO DE POST COMPLETO
app.post("/api/generate-post", upload.array("referenceImages", 3), async (req, res) => {
  try {
    let { brand, objective, briefing, contentType, platform, recreateMode } = req.body || {};

    if (typeof brand === "string") {
      try { brand = JSON.parse(brand); } catch { brand = { name: "Marca Desconhecida" }; }
    }

    if (!brand?.name || !objective) {
      return j(res, 400, { error: "Marca e Objetivo são obrigatórios." });
    }

    const isRecreate = recreateMode === "true";
    const type = contentType || platform;
    const kind = resolveContentKind(type, platform);
    
    const tokens = readJSON(TOKENS_FILE, {});
    const sel = tokens["local_user"]?.selected;

    // 1. ANÁLISE DE IMAGENS (UPLOAD)
    let visualStyleFromImages = null;
    if (req.files && req.files.length > 0) {
      console.log(`📸 Analisando ${req.files.length} imagens...`);
      
      const imageBuffers = req.files.map((f) => ({
        type: "image_url",
        image_url: {
          url: `data:image/${f.mimetype.split("/")[1] || "jpeg"};base64,${f.buffer.toString("base64")}`,
        },
      }));

      const visionPrompt = isRecreate 
        ? `Analise para recriação exata: descreva cenário, personagens, composição, estilo e cores em JSON.`
        : `Analise identidade visual: paleta de cores, estilo e elementos em JSON.`;

      try {
        const visionResp = await client.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: [{ type: "text", text: visionPrompt }, ...imageBuffers] }],
        });
        
        let raw = visionResp.choices?.[0]?.message?.content || "{}";
        raw = raw.replace(/^```json/, "").replace(/```$/, "");
        visualStyleFromImages = JSON.parse(raw);
      } catch (e) {
        console.error("Erro na análise visual:", e);
      }
    }

    // 2. BUSCA ESTILO DO IG (SYNC)
    let visualStyleFromLocalIg = null;
    let corpus = "";
    if (sel?.igId && !visualStyleFromImages) {
      const postsDb = readJSON(POSTS_FILE, {});
      const pack = postsDb[sel.igId];
      if (pack?.posts?.length) {
        corpus = buildCorpusFromPosts(pack.posts);
        visualStyleFromLocalIg = await inferVisualStyleFromLocalIgPosts(pack.igId);
      }
    }

    const finalVisualStyle = visualStyleFromImages || visualStyleFromLocalIg || null;

    // 3. GERAÇÃO DE TEXTO
    const textPrompt = buildTextPrompt(kind, { brand, objective, briefing, corpus });
    const textResp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: textPrompt }],
      temperature: 0.7,
    });

    let rawText = textResp.choices?.[0]?.message?.content ?? "{}";
    rawText = rawText.replace(/^```json/, "").replace(/```$/, "");
    let textJson;
    try { textJson = JSON.parse(rawText); } catch { textJson = { caption: rawText }; }

    let captionFinal = textJson.caption || "";
    if (Array.isArray(textJson.hashtags)) captionFinal += "\n\n" + textJson.hashtags.join(" ");

    // 4. GERAÇÃO DE IMAGEM
    let imagePrompt;
    if (isRecreate && finalVisualStyle) {
      imagePrompt = buildRecreateFromImagePrompt(finalVisualStyle, briefing, objective);
    } else if (type === "personal") {
      imagePrompt = buildPersonalImagePrompt({
        personalType: brand.niche || brand.name,
        objective, briefing, audience: brand.audience, visualStyle: finalVisualStyle
      });
    } else {
      imagePrompt = buildImagePrompt(kind, {
        businessName: brand.name, businessNiche: brand.niche, businessAudience: brand.audience,
        postObjective: objective, postType: type, briefingText: briefing,
        visualStyle: finalVisualStyle
      });
    }

    let size = "1024x1024";
    const lowerType = String(type || "").toLowerCase();
    if (lowerType.match(/story|stories|reels|tiktok|vertical/)) size = "1024x1792";
    if (lowerType.match(/site|blog|horizontal/)) size = "1792x1024";

    let imageUrl = null;
    try {
      const b64 = await generateImageWithOpenAI({ imagePrompt, size });
      imageUrl = `data:image/png;base64,${b64}`;
    } catch (e) {
      console.error("Erro DALL-E:", e);
    }

    return res.json({
      ok: true,
      caption: captionFinal,
      imageUrl,
      debug: {
        mode: isRecreate ? "RECREATE" : "GENERATE",
        size
      }
    });

  } catch (e) {
    console.error("Erro CRÍTICO /generate-post:", e);
    return j(res, 500, { error: e.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});