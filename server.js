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
import os from "os";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(process.cwd(), "public")));
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// =====================================================
//  MULTER (UPLOAD IMAGENS DE REFERÊNCIA)
// =====================================================
const upload = multer({
  limits: { fileSize: 4.5 * 1024 * 1024 },
});

// =====================================================
//  OPENAI CLIENT
// =====================================================
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =====================================================
//  STORAGE LOCAL (TOKENS META / POSTS IG)
// =====================================================
const STORAGE_DIR =
  process.env.NODE_ENV === "production"
    ? os.tmpdir()
    : path.join(process.cwd(), "storage");

const TOKENS_FILE = path.join(STORAGE_DIR, "meta_tokens.json");
const POSTS_FILE = path.join(STORAGE_DIR, "ig_posts.json");

function ensureStorage() {
  if (!fs.existsSync(STORAGE_DIR)) {
    try {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    } catch (e) {
      console.error("Erro ao criar pasta storage:", e);
    }
  }
  if (!fs.existsSync(TOKENS_FILE)) writeJSON(TOKENS_FILE, {});
  if (!fs.existsSync(POSTS_FILE)) writeJSON(POSTS_FILE, {});
}

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8")) ?? fallback;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.warn(
      `Aviso: Não foi possível gravar em ${file}. (Vercel limita escrita)`,
      e.message
    );
  }
}

ensureStorage();

// simples controle de estados OAuth
const oauthStateStore = new Set();

// =====================================================
//  SUPABASE
// =====================================================
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "⚠️ AVISO: Variáveis do Supabase não configuradas. Login não funcionará."
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_ANON_KEY || "placeholder"
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder"
);

// =====================================================
//  AUTH MIDDLEWARE
// =====================================================
async function getUserFromToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token)
    return res
      .status(401)
      .json({ ok: false, error: "Token não informado." });

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res
      .status(401)
      .json({ ok: false, error: "Token inválido ou expirado." });
  }

  req.user = data.user;
  next();
}

// =====================================================
//  HELPER – GERA IMAGEM (BASE64)
// =====================================================
async function generateImageWithOpenAI({ imagePrompt, size }) {
  const modelToUse = process.env.OPENAI_IMAGE_MODEL || "dall-e-3";

  console.log(`🎨 Gerando Imagem | Modelo: ${modelToUse}`);
  console.log("📝 Prompt da imagem:", imagePrompt);

  const img = await client.images.generate({
    model: modelToUse,
    prompt: imagePrompt,
    size: size || "1024x1024",
  });

  const first = img.data[0];

  if (first.b64_json) {
    return first.b64_json;
  } else if (first.url) {
    const r = await fetch(first.url);
    const arr = await r.arrayBuffer();
    return Buffer.from(arr).toString("base64");
  }

  throw new Error("Sem dados de imagem retornados.");
}

// =====================================================
//  ROTAS BÁSICAS
// =====================================================
app.get("/", (req, res) =>
  res.sendFile(path.join(process.cwd(), "public", "index.html"))
);
app.get("/app", (req, res) =>
  res.sendFile(path.join(process.cwd(), "public", "painel.html"))
);
app.get("/health", (req, res) =>
  res.json({ ok: true, status: "online", env: process.env.NODE_ENV })
);

// =====================================================
//  AUTH: REGISTER / LOGIN / PLAN
// =====================================================
app.post("/auth/register", async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!email || !password)
    return res
      .status(400)
      .json({ ok: false, error: "Dados incompletos." });

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: name, phone } },
  });

  if (error)
    return res.status(400).json({ ok: false, error: error.message });

  if (data.user) {
    await supabaseAdmin
      .from("profiles")
      .upsert({ id: data.user.id, full_name: name, phone });

    await supabaseAdmin.from("plans").insert({
      user_id: data.user.id,
      status: "trial",
      trial_days: 7,
      trial_started_at: new Date(),
    });

    await supabaseAdmin
      .from("users")
      .upsert({ id: data.user.id, name: name || email, email });
  }

  return res.json({
    ok: true,
    token: data.session?.access_token,
    user: { id: data.user?.id, name, email },
  });
});

app.post("/auth/login", async (req, res) => {
  const { identifier, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({
    email: identifier,
    password,
  });

  if (error)
    return res
      .status(400)
      .json({ ok: false, error: "Credenciais inválidas." });

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("full_name")
    .eq("id", data.user.id)
    .single();

  const userName =
    profile?.full_name || data.user.user_metadata?.full_name || null;

  return res.json({
    ok: true,
    token: data.session.access_token,
    user: { id: data.user.id, name: userName, email: data.user.email },
  });
});

app.get("/auth/plan", getUserFromToken, async (req, res) => {
  const { data: plan } = await supabaseAdmin
    .from("plans")
    .select("*")
    .eq("user_id", req.user.id)
    .maybeSingle();

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("full_name")
    .eq("id", req.user.id)
    .single();

  let status = plan?.status || "none";
  let daysLeft = 7;

  return res.json({
    ok: true,
    plan: { status, daysLeft },
    user: { id: req.user.id, email: req.user.email, name: profile?.full_name },
  });
});

// =====================================================
//  IA – GERAÇÃO DE POST COMPLETO (TEXTO + IMAGEM)
//  -> Usa 5 campos: marca, tipo, objetivo, briefing, styleJson
// =====================================================
app.post(
  "/api/generate-post",
  upload.array("referenceImages", 3),
  async (req, res) => {
    try {
      // -----------------------------
      // 1. DADOS VINDOS DO FRONT
      // -----------------------------
      let { brand, objective, briefing, contentType, platform, styleJson, recreateMode } =
        req.body;

      if (typeof brand === "string") {
        brand = JSON.parse(brand || "{}");
      }
      if (!brand || typeof brand !== "object") brand = {};
      if (!brand.name) brand.name = "Minha marca";
      if (!brand.niche) brand.niche = "negócio local";

      const kind = contentType || platform || "instagram";
      const objectiveFinal = objective || "Vender";
      const briefingFinal = (briefing || "").trim();

      if (!briefingFinal) {
        return res
          .status(400)
          .json({ ok: false, error: "Briefing vazio." });
      }

      // Campo 5 – estilo (opcional)
      let styleConfig = null;
      let styleDescText = "";

      if (styleJson) {
        try {
          styleConfig = JSON.parse(styleJson);
        } catch (e) {
          console.warn("Não consegui fazer parse de styleJson:", e, styleJson);
        }
      }

      if (styleConfig) {
        const coresPrincipais = Array.isArray(styleConfig.main_colors)
          ? styleConfig.main_colors.join(", ")
          : "";
        const coresSecundarias = Array.isArray(styleConfig.secondary_colors)
          ? styleConfig.secondary_colors.join(", ")
          : "";
        const palavrasChave = Array.isArray(styleConfig.imagery_keywords)
          ? styleConfig.imagery_keywords.join(", ")
          : "";
        const vibe = styleConfig.style_vibe || "";
        const logoDesc = styleConfig.logo_description || "";
        const layoutDesc = styleConfig.layout_description || "";

        styleDescText = `
Estilo visual desejado:
- Cores principais: ${coresPrincipais || "livre"}
- Cores secundárias: ${coresSecundarias || "livre"}
- Palavras-chave visuais: ${palavrasChave || "livre"}
- Clima/estilo: ${vibe || "profissional"}
- Logo: ${logoDesc || "usar logo da marca, se houver"}
- Layout: ${layoutDesc || "layout limpo e legível para redes sociais"}
`.trim();
      } else {
        styleDescText = `
Estilo visual desejado:
- Paleta moderna, profissional e bem iluminada
- Foco no produto/serviço
- Composição limpa, pensada para feed de redes sociais
`.trim();
      }

      // imagens de referência + modo recriar
      const hasRefs = req.files && req.files.length > 0;
      const recreate = String(recreateMode || "").toLowerCase() === "true";

      let refImagesInfo = "";
      if (hasRefs && recreate) {
        refImagesInfo = `
IMPORTANTE:
- O usuário marcou modo RECRIAR.
- Recrie a cena principal das imagens enviadas, mantendo enquadramento e elementos,
  mas melhore a iluminação, cores e qualidade.
- NÃO escreva textos na imagem.
`.trim();
      } else if (hasRefs) {
        refImagesInfo = `
IMPORTANTE:
- O usuário enviou imagens de referência.
- Use as referências como base de paleta de cores, clima e estilo,
  sem copiar exatamente a cena.
- NÃO escreva textos na imagem.
`.trim();
      }

      // -----------------------------
      // 2. PRIMEIRA ETAPA: IA DE TEXTO
      // -----------------------------
      const negocioNome = brand.name;
      const negocioNicho = brand.niche;

      const textPrompt = `
Você é um estrategista de marketing brasileiro.

Gere uma campanha de conteúdo para ${kind} para o negócio "${negocioNome}" (${negocioNicho}).

Objetivo principal: ${objectiveFinal}.

Briefing detalhado fornecido pelo usuário:
"""
${briefingFinal}
"""

${styleDescText}

Responda APENAS em JSON com o seguinte formato:

{
  "titulo_campanha": "nome curto e forte da campanha (sem emoji)",
  "descricao_campanha": "explicação rápida da ideia",
  "legenda": "texto completo para o post, pronto para copiar",
  "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3"],
  "image_prompt": "descrição da CENA da imagem, explicando cenário, personagens, cores, estilo e iluminação. NÃO coloque textos escritos na arte."
}
`.trim();

      const textResp = await client.chat.completions.create({
        model: process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Você gera campanhas, legendas e sugestões de imagem para posts de marketing em português do Brasil.",
          },
          { role: "user", content: textPrompt },
        ],
      });

      const rawJson = textResp.choices[0]?.message?.content || "{}";

      let data;
      try {
        data = JSON.parse(rawJson);
      } catch (e) {
        console.error("Erro ao parsear JSON da campanha:", e, rawJson);
        return res.status(500).json({
          ok: false,
          error: "Falha ao interpretar resposta da IA de texto.",
        });
      }

      const tituloCampanha = data.titulo_campanha || "Campanha especial";
      const legenda = data.legenda || briefingFinal;
      const hashtags = Array.isArray(data.hashtags) ? data.hashtags : [];
      const imagePromptFromText =
        data.image_prompt ||
        `Gere uma imagem publicitária para a campanha "${tituloCampanha}" do negócio ${negocioNome} (${negocioNicho}).`;

      const captionFinal =
        legenda + (hashtags.length ? "\n\n" + hashtags.join(" ") : "");

      // -----------------------------
      // 3. SEGUNDA ETAPA: PROMPT DE IMAGEM
      // -----------------------------
      let imagePrompt =
        `Arte para ${kind} de uma campanha chamada "${tituloCampanha}". ` +
        imagePromptFromText +
        " Foque na cena e no conceito, NÃO escreva textos na arte. ";

      imagePrompt += `Nicho: ${negocioNicho}. Objetivo: ${objectiveFinal}. `;

      if (styleDescText) {
        imagePrompt += `Estilo visual: ${styleDescText}. `;
      }
      if (refImagesInfo) {
        imagePrompt += refImagesInfo + " ";
      }

      // tamanho da imagem (story x feed)
      let size = "1024x1024";
      const kindLower = String(kind).toLowerCase();
      if (kindLower.includes("story") || kindLower.includes("reels")) {
        size = "1024x1792";
      }

      // -----------------------------
      // 4. GERAR IMAGEM
      // -----------------------------
      let b64 = null;
      try {
        b64 = await generateImageWithOpenAI({ imagePrompt, size });
      } catch (eImg) {
        console.error("Erro ao gerar imagem:", eImg);
        // se falhar, o front usa fallback SVG
      }

      // -----------------------------
      // 5. RESPOSTA PARA O FRONTEND
      // -----------------------------
      return res.json({
        ok: true,
        caption: captionFinal,
        imageUrl: b64 ? `data:image/png;base64,${b64}` : null,
        meta: {
          titulo_campanha: tituloCampanha,
          descricao_campanha: data.descricao_campanha || "",
          usado_recreateMode: recreate,
          usado_referencia: hasRefs,
        },
      });
    } catch (e) {
      console.error("Erro generate-post:", e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// =====================================================
//  TEMPLATE SIMPLES – IG FLYER POR @handle
// =====================================================
app.post("/api/templates/ig-flyer", async (req, res) => {
  try {
    const { handle } = req.body;
    const imagePrompt = `Crie um flyer moderno, profissional e chamativo para divulgação no Instagram do perfil @${handle}. Use cores vibrantes, estilo digital e NÃO escreva textos na imagem (apenas elementos visuais).`;

    const b64 = await generateImageWithOpenAI({
      imagePrompt,
      size: "1024x1024",
    });

    res.json({ ok: true, imageUrl: `data:image/png;base64,${b64}` });
  } catch (e) {
    console.error("Erro em /api/templates/ig-flyer:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =====================================================
//  SERVER LOCAL
// =====================================================
if (process.env.NODE_ENV !== "production") {
  const PORT_LOCAL = process.env.PORT || 3001;
  app.listen(PORT_LOCAL, () => {
    console.log(
      `✅ Server running locally on http://localhost:${PORT_LOCAL}`
    );
  });
}

export default app;
