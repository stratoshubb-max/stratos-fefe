// Central API service — connected to the Bun backend.
// Token is stored in localStorage under "stratos_token".

// Always use relative URLs — in dev, Vite proxies API routes to port 3001.
// In production, the Bun backend serves both the API and the built frontend.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

function getToken(): string | null {
  return localStorage.getItem("stratos_token");
}

export function setToken(token: string) {
  localStorage.setItem("stratos_token", token);
}

export function clearToken() {
  localStorage.removeItem("stratos_token");
  localStorage.removeItem("stratos_user");
}

type FetchOptions = RequestInit & { auth?: boolean };

async function request<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ===== Types (data model) =====
export interface Company {
  id: string;
  name: string;
  email: string;
  phone: string;
}
export interface User {
  id: string;
  email: string;
  name: string;
  companyId: string;
  role: "admin" | "member";
}
export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  status: "processing" | "ready" | "failed";
  uploadedAt: string;
}
export interface ChatSession {
  id: string;
  title: string;
  updatedAt: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
export interface Lead {
  id: string;
  name: string;
  phone: string;
  budget: number;
  city: string;
  propertyType: string;
  source: string;
  status: "new" | "contacted" | "qualified" | "lost" | "won";
  score: number;
  createdAt: string;
}
export interface CreditUsage {
  date: string;
  credits: number;
  chats: number;
}
export interface Subscription {
  plan: string;
  creditsLeft: number;
  renewsAt: string;
}
export interface WidgetConfig {
  color: string;
  name: string;
  greeting: string;
  theme: "light" | "dark";
  position: "right" | "left";
}

export interface ChannelStatus {
  connected: boolean;
}
export interface WhatsAppChannel extends ChannelStatus {
  phoneId: string;
  businessId: string;
  verifyToken: string;
}
export interface MessengerChannel extends ChannelStatus {
  pageId: string;
  verifyToken: string;
}
export interface InstagramChannel extends ChannelStatus {
  accountId: string;
  verifyToken: string;
}
export interface TikTokChannel extends ChannelStatus {
  appId: string;
  accountId: string;
  verifyToken: string;
}
export interface Channels {
  whatsapp: WhatsAppChannel;
  messenger: MessengerChannel;
  instagram: InstagramChannel;
  tiktok: TikTokChannel;
}

export interface Settings {
  company: Company;
  subscription: Subscription;
  hasOpenAIKey: boolean;
  systemPrompt?: string;
  user: User;
  widgetConfig?: WidgetConfig;
  channels: Channels;
}

// ===== API surface =====
export const api = {
  request,
  auth: {
    register: (email: string, password: string, name: string) =>
      request<{ token: string; userId: string; companyId: string }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password, name }),
      }),
    login: (email: string, password: string) =>
      request<{ token: string; user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    google: (token: string) =>
      request<{ token: string; user: User }>("/auth/google", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
  },
  files: {
    list: () => request<UploadedFile[]>("/files"),
    upload: (formData: FormData) =>
      fetch(`${API_BASE_URL}/files`, {
        method: "POST",
        body: formData,
        headers: { Authorization: `Bearer ${getToken() ?? ""}` },
      }).then((r) => r.json() as Promise<UploadedFile[]>),
    remove: (id: string) => request<{ ok: boolean }>(`/files/${id}`, { method: "DELETE" }),
  },
  chat: {
    sessions: () => request<ChatSession[]>("/chat/sessions"),
    createSession: (title?: string) =>
      request<ChatSession>("/chat/sessions", { method: "POST", body: JSON.stringify({ title }) }),
    messages: (sessionId: string) => request<Message[]>(`/chat/sessions/${sessionId}/messages`),
    send: (sessionId: string, content: string) =>
      request<Message>(`/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    streamSend: async (sessionId: string, content: string, onChunk: (chunk: string) => void) => {
      const token = getToken();
      const res = await fetch(`${API_BASE_URL}/chat/sessions/${sessionId}/messages?stream=true`, {
        method: "POST",
        body: JSON.stringify({ content }),
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((err as { error?: string }).error ?? `Request failed: ${res.status}`);
      }

      if (!res.body) throw new Error("No readable stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let finalMessage = null;
      let fallbackText = "";

      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          const chunkStr = decoder.decode(value, { stream: true });
          const lines = chunkStr.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const dataStr = line.replace("data: ", "").trim();
              if (dataStr === "[DONE]") {
                // Done
              } else {
                try {
                  const data = JSON.parse(dataStr);
                  if (data.type === "chunk") {
                    fallbackText += data.text;
                    onChunk(data.text);
                  } else if (data.type === "done") {
                    finalMessage = data.message;
                  }
                } catch (err) {
                  console.error("Failed to parse event stream line:", err);
                }
              }
            }
          }
        }
      }
      if (!finalMessage) {
        finalMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: fallbackText || "Connection completed.",
          createdAt: new Date().toISOString(),
        };
      }
      return finalMessage as Message;
    },
  },
  leads: {
    list: () => request<Lead[]>("/leads"),
    create: (data: Partial<Lead>) =>
      request<Lead>("/leads", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, patch: Partial<Lead>) =>
      request<Lead>(`/leads/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    delete: (id: string) => request<{ ok: boolean }>(`/leads/${id}`, { method: "DELETE" }),
  },
  usage: {
    summary: () => request<CreditUsage[]>("/usage"),
  },
  settings: {
    get: () => request<Settings>("/settings"),
    update: (data: Partial<Company>) =>
      request<{ ok: boolean }>("/settings", { method: "PATCH", body: JSON.stringify(data) }),
    saveOpenAIKey: (apiKey: string) =>
      request<{ ok: boolean }>("/settings/openai-key", {
        method: "PUT",
        body: JSON.stringify({ apiKey }),
      }),
    deleteOpenAIKey: () => request<{ ok: boolean }>("/settings/openai-key", { method: "DELETE" }),
    saveSystemPrompt: (prompt: string) =>
      request<{ ok: boolean }>("/settings/system-prompt", {
        method: "PUT",
        body: JSON.stringify({ prompt }),
      }),
    saveWidgetConfig: (config: Partial<WidgetConfig>) =>
      request<{ ok: boolean }>("/settings/widget", { method: "PUT", body: JSON.stringify(config) }),
    saveWhatsApp: (data: {
      phoneId: string;
      businessId: string;
      token: string;
      verifyToken: string;
    }) =>
      request<{ ok: boolean }>("/settings/whatsapp", { method: "PUT", body: JSON.stringify(data) }),
    saveMessenger: (data: { pageId: string; token: string; verifyToken: string }) =>
      request<{ ok: boolean }>("/settings/messenger", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    saveInstagram: (data: { accountId: string; token: string; verifyToken: string }) =>
      request<{ ok: boolean }>("/settings/instagram", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    saveTikTok: (data: {
      appId: string;
      appSecret: string;
      accessToken: string;
      accountId: string;
      verifyToken: string;
    }) =>
      request<{ ok: boolean }>("/settings/tiktok", { method: "PUT", body: JSON.stringify(data) }),
  },
};
