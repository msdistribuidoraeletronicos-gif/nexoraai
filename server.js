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

const upload = multer({
  limits: { fileSize: 4.5 * 1024 * 1024 },
});

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const STORAGE_DIR = process.env.NODE_ENV === "production"
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
    console.warn(`Aviso: Não foi possível gravar em ${file}. (Vercel limita escrita)`, e.message);
  }
}

ensureStorage();
const oauthStateStore = new Set();

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ AVISO: Variáveis do Supabase não configuradas. Login não funcionará.");
}

const supabase = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_ANON_KEY || "placeholder"
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder"
);

// auth middleware
async function getUserFromToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) return res.status(401).json({ ok: false, error: "Token não informado." });

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ ok: false, error: "Token inválido ou expirado." });
  }

  req.user = data.user;
  next();
}

function buildTextPrompt(kind, { brand, objective, briefing }) {
  return `Crie legenda para ${kind}. Marca: ${brand.name}. Objetivo: ${objective}. Briefing: ${briefing}. Retorne JSON {caption, hashtags}.`;
}

async function generateImageWithOpenAI({ imagePrompt, size }) {
  const modelToUse = process.env.OPENAI_IMAGE_MODEL || "dall-e-3";

  console.log(`🎨 Gerando Imagem | Modelo: ${modelToUse}`);

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

// rotas básicas
app.get("/", (req, res) =>
  res.sendFile(path.join(process.cwd(), "public", "index.html"))
);
app.get("/app", (req, res) =>
  res.sendFile(path.join(process.cwd(), "public", "painel.html"))
);
app.get("/health", (req, res) =>
  res.json({ ok: true, status: "online", env: process.env.NODE_ENV })
);

// AUTH
app.post("/auth/register", async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ ok: false, error: "Dados incompletos." });

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: name, phone } },
  });

  if (error) return res.status(400).json({ ok: false, error: error.message });

  if (data.user) {
    await supabaseAdmin
      .from("profiles")
      .upsert({ id: data.user.id, full_name: name, phone });
    await supabaseAdmin
      .from("plans")
      .insert({
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

  if (error) return res.status(400).json({ ok: false, error: "Credenciais inválidas." });

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("full_name")
    .eq("id", data.user.id)
    .single();

  const userName = profile?.full_name || data.user.user_metadata?.full_name || null;

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

// IA – geração de post completo
app.post("/api/generate-post", upload.array("referenceImages", 3), async (req, res) => {
  try {
    let { brand, objective, briefing, contentType, platform } = req.body;
    if (typeof brand === "string") brand = JSON.parse(brand || "{}");
    if (!brand.name) brand.name = "Minha Marca";

    const kind = contentType || platform || "instagram";
    const textPrompt = buildTextPrompt(kind, { brand, objective, briefing });

    const textResp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: textPrompt }],
    });

    let rawText = textResp.choices[0].message.content.replace(/```json|```/g, "");
    let caption = rawText;
    try {
      const json = JSON.parse(rawText);
      caption =
        json.caption +
        (json.hashtags ? "\n\n" + json.hashtags.join(" ") : "");
    } catch {}

    const imagePrompt = `Crie um flyer publicitário profissional para ${brand.name}. Tema: ${briefing}. Objetivo: ${objective}. Texto em PT-BR.`;
    let size = "1024x1024";
    if (String(contentType).toLowerCase().includes("story"))
      size = "1024x1792";

    const b64 = await generateImageWithOpenAI({ imagePrompt, size });

    res.json({
      ok: true,
      caption,
      imageUrl: `data:image/png;base64,${b64}`,
    });
  } catch (e) {
    console.error("Erro generate-post:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Template simples
app.post("/api/templates/ig-flyer", async (req, res) => {
  try {
    const { handle } = req.body;
    const b64 = await generateImageWithOpenAI({
      imagePrompt: `Crie um flyer moderno para o instagram @${handle}.`,
      size: "1024x1024",
    });
    res.json({ ok: true, imageUrl: `data:image/png;base64,${b64}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

if (process.env.NODE_ENV !== "production") {
  const PORT_LOCAL = process.env.PORT || 3001;
  app.listen(PORT_LOCAL, () => {
    console.log(`✅ Server running locally on http://localhost:${PORT_LOCAL}`);
  });
}

export default app;
