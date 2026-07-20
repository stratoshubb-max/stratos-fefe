// index.js — Bun HTTP server, main router
import { existsSync } from "fs";
import { join } from "path";
import { migrate } from "./migrate.js";

import { handleRegister, handleLogin, handleGoogleLogin } from "./routes/auth.js";
import { handleListFiles, handleUploadFile, handleDeleteFile } from "./routes/files.js";
import {
  handleListSessions, handleCreateSession,
  handleGetMessages, handleSendMessage,
  handleWidgetChat,
} from "./routes/chat.js";
import { handleWhatsAppVerification, handleWhatsAppMessage } from "./routes/whatsapp.js";
import { handleMessengerVerification, handleMessengerMessage } from "./routes/messenger.js";
import { handleInstagramVerification, handleInstagramMessage } from "./routes/instagram.js";
import { handleTikTokVerification, handleTikTokMessage } from "./routes/tiktok.js";
import { handleListLeads, handleCreateLead, handleUpdateLead, handleDeleteLead } from "./routes/leads.js";
import { handleGetUsage } from "./routes/usage.js";
import {
  handleGetSettings, handleUpdateSettings,
  handleSaveOpenAIKey, handleDeleteOpenAIKey,
  handleSaveWidgetConfig, handleGetWidgetConfig,
  handleSaveWhatsAppSettings, handleSaveMessengerSettings,
  handleSaveInstagramSettings, handleSaveTikTokSettings,
  handleSaveSystemPrompt
} from "./routes/settings.js";

import {
  authLimiter, apiLimiter, widgetLimiter, webhookLimiter,
  rateLimitResponse, getClientIP,
} from "./middleware/rateLimit.js";
import { applySecurityHeaders, getCORSHeaders } from "./middleware/headers.js";

// ── Startup: validate required environment variables ─────────────────────────
const REQUIRED_ENV = ["JWT_SECRET", "MASTER_SECRET", "DATABASE_URL"];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`[startup] FATAL: Missing required environment variables: ${missingEnv.join(", ")}`);
  console.error("[startup] The server will start but affected features will not work.");
}

if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
  console.warn("[startup] WARNING: JWT_SECRET is too short. Use at least 32 random characters.");
}

const PORT = Number(process.env.PORT ?? 3001);

// ── Static file serving (production) ─────────────────────────────────────────
const DIST_DIR = new URL("../dist/client", import.meta.url).pathname;
const IS_PROD = existsSync(join(DIST_DIR, "index.html"));

const API_PREFIXES = [
  "/auth", "/files", "/chat", "/leads",
  "/usage", "/settings", "/widget", "/health",
];

function isApiRoute(pathname) {
  return API_PREFIXES.some(p => pathname === p || pathname.startsWith(p + "/"));
}

// Known webhook paths that should not be treated as API auth routes
const WEBHOOK_PATHS = [
  "/chat/whatsapp/webhook",
  "/chat/messenger/webhook",
  "/chat/instagram/webhook",
  "/chat/tiktok/webhook",
];

function isWebhookRoute(pathname) {
  return WEBHOOK_PATHS.includes(pathname);
}

async function serveStatic(pathname) {
  const cleanPath = pathname.split("?")[0];
  if (cleanPath.includes("..")) return null;

  const filePath = join(DIST_DIR, cleanPath);
  if (existsSync(filePath)) {
    const f = Bun.file(filePath);
    if (f.size > 0) return new Response(f);
  }
  // SPA fallback
  return new Response(Bun.file(join(DIST_DIR, "index.html")), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ── Response helpers ──────────────────────────────────────────────────────────
function withCORS(response, pathname, requestOrigin) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(getCORSHeaders(pathname, requestOrigin))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function finalise(response, pathname, requestOrigin) {
  return applySecurityHeaders(withCORS(response, pathname, requestOrigin));
}

// ── URL pattern matching ──────────────────────────────────────────────────────
function match(pathname, pattern) {
  const re = new RegExp("^" + pattern.replace(/:([a-z]+)/g, "([^/]+)") + "$");
  const m = pathname.match(re);
  return m ? m.slice(1) : null;
}

// ── Startup ───────────────────────────────────────────────────────────────────
// We run migration in the background so the server can start and be healthy immediately
migrate().catch(err => console.error("[migrate] Background migration failed:", err));

// ── Router ────────────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  hostname: "::",
  // Global request body size limit: 20 MB (file uploads can be up to 10 MB per file)
  maxRequestBodySize: 20 * 1024 * 1024,
  // Prevent Bun from timing out streams prematurely (default in Bun can be as low as 10s)
  idleTimeout: 255,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const ip = getClientIP(req);
    const requestOrigin = req.headers.get("Origin") ?? undefined;

    // ── CORS preflight ──
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCORSHeaders(path, requestOrigin),
      });
    }

    // ── Health check (no rate limit, no auth) ──
    if (path === "/health") {
      return finalise(
        Response.json({ status: "ok", timestamp: new Date().toISOString() }),
        path,
        requestOrigin
      );
    }

    // ── Rate limiting ──
    // Auth endpoints: strict limit
    if (path === "/auth/login" || path === "/auth/register") {
      const { limited, retryAfter } = authLimiter(ip);
      if (limited) return finalise(rateLimitResponse(retryAfter), path, requestOrigin);
    }
    // Widget chat: moderate public limit
    else if (path === "/chat/widget") {
      const { limited, retryAfter } = widgetLimiter(ip);
      if (limited) return finalise(rateLimitResponse(retryAfter), path, requestOrigin);
    }
    // Webhook endpoints: moderate limit
    else if (isWebhookRoute(path)) {
      const { limited, retryAfter } = webhookLimiter(ip);
      if (limited) return finalise(rateLimitResponse(retryAfter), path, requestOrigin);
    }
    // All other API routes: standard per-IP limit
    else if (isApiRoute(path)) {
      const { limited, retryAfter } = apiLimiter(ip);
      if (limited) return finalise(rateLimitResponse(retryAfter), path, requestOrigin);
    }

    let response;

    // ── Auth ──
    if      (method === "POST" && path === "/auth/register")  response = await handleRegister(req);
    else if (method === "POST" && path === "/auth/login")     response = await handleLogin(req);
    else if (method === "POST" && path === "/auth/google")    response = await handleGoogleLogin(req);

    // ── Files ──
    else if (method === "GET"    && path === "/files")    response = await handleListFiles(req);
    else if (method === "POST"   && path === "/files")    response = await handleUploadFile(req);
    else if (method === "DELETE" && match(path, "/files/:id")) {
      const [id] = match(path, "/files/:id");
      response = await handleDeleteFile(req, id);
    }

    // ── Chat sessions ──
    else if (method === "GET"  && path === "/chat/sessions") response = await handleListSessions(req);
    else if (method === "POST" && path === "/chat/sessions") response = await handleCreateSession(req);
    else if (method === "POST" && path === "/chat/widget")   response = await handleWidgetChat(req);

    // ── Webhooks ──
    else if (method === "GET"  && path === "/chat/whatsapp/webhook")  response = await handleWhatsAppVerification(req);
    else if (method === "POST" && path === "/chat/whatsapp/webhook")  response = await handleWhatsAppMessage(req);
    else if (method === "GET"  && path === "/chat/messenger/webhook") response = await handleMessengerVerification(req);
    else if (method === "POST" && path === "/chat/messenger/webhook") response = await handleMessengerMessage(req);
    else if (method === "GET"  && path === "/chat/instagram/webhook") response = await handleInstagramVerification(req);
    else if (method === "POST" && path === "/chat/instagram/webhook") response = await handleInstagramMessage(req);
    else if (method === "GET"  && path === "/chat/tiktok/webhook")    response = await handleTikTokVerification(req);
    else if (method === "POST" && path === "/chat/tiktok/webhook")    response = await handleTikTokMessage(req);

    // ── Chat messages ──
    else if (method === "GET"  && match(path, "/chat/sessions/:id/messages")) {
      const [id] = match(path, "/chat/sessions/:id/messages");
      response = await handleGetMessages(req, id);
    }
    else if (method === "POST" && match(path, "/chat/sessions/:id/messages")) {
      const [id] = match(path, "/chat/sessions/:id/messages");
      response = await handleSendMessage(req, id);
    }

    // ── Leads ──
    else if (method === "GET"   && path === "/leads")          response = await handleListLeads(req);
    else if (method === "POST"  && path === "/leads")          response = await handleCreateLead(req);
    else if (method === "PATCH" && match(path, "/leads/:id")) {
      const [id] = match(path, "/leads/:id");
      response = await handleUpdateLead(req, id);
    }
    else if (method === "DELETE" && match(path, "/leads/:id")) {
      const [id] = match(path, "/leads/:id");
      response = await handleDeleteLead(req, id);
    }

    // ── Usage ──
    else if (method === "GET" && path === "/usage") response = await handleGetUsage(req);

    // ── Settings ──
    else if (method === "GET"    && path === "/settings")               response = await handleGetSettings(req);
    else if (method === "PATCH"  && path === "/settings")               response = await handleUpdateSettings(req);
    else if (method === "PUT"    && path === "/settings/openai-key")    response = await handleSaveOpenAIKey(req);
    else if (method === "DELETE" && path === "/settings/openai-key")    response = await handleDeleteOpenAIKey(req);
    else if (method === "PUT"    && path === "/settings/system-prompt") response = await handleSaveSystemPrompt(req);
    else if (method === "PUT"    && path === "/settings/whatsapp")      response = await handleSaveWhatsAppSettings(req);
    else if (method === "PUT"    && path === "/settings/messenger")     response = await handleSaveMessengerSettings(req);
    else if (method === "PUT"    && path === "/settings/instagram")     response = await handleSaveInstagramSettings(req);
    else if (method === "PUT"    && path === "/settings/tiktok")        response = await handleSaveTikTokSettings(req);
    else if (method === "PUT"    && path === "/settings/widget")        response = await handleSaveWidgetConfig(req);
    else if (method === "GET"    && path.startsWith("/widget/config/")) {
      const agencyId = path.split("/").pop();
      req.agencyId = agencyId;
      response = await handleGetWidgetConfig(req);
    }

    // ── Static files (production) ──
    else if (IS_PROD && !isApiRoute(path)) {
      const staticRes = await serveStatic(path);
      // Static files don't get API security headers — serve as-is
      if (staticRes) return staticRes;
    }

    if (!response) response = Response.json({ error: "Not found" }, { status: 404 });

    return finalise(response, path, requestOrigin);
  },

  error(err) {
    console.error("[server error]", err?.message ?? err);
    // Never expose internal error details to clients
    const res = Response.json({ error: "Internal server error" }, { status: 500 });
    // Attach wildcard CORS so the browser can read the 500 response
    res.headers.set("Access-Control-Allow-Origin", "*");
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return applySecurityHeaders(res);
  },
});

console.log(`🚀 Stratos Hub backend running on http://0.0.0.0:${PORT}${IS_PROD ? " [serving static build]" : " [dev mode]"}`);
