import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  Send,
  Sparkles,
  Plus,
  Loader2,
  Calendar,
  DollarSign,
  FileText,
  GitCompareArrows,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { Message, ChatSession } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";

const chatSearchSchema = z.object({
  sessionId: z.string().optional(),
  initialMessage: z.string().optional(),
});

export const Route = createFileRoute("/_app/chat")({
  validateSearch: chatSearchSchema,
  head: () => ({ meta: [{ title: "Chat — Stratos Hub" }] }),
  component: Chat,
});

const starterSuggestions = [
  {
    key: "visit",
    icon: Calendar,
    title: "Schedule a site visit",
    desc: "Coordinate a property viewing with a lead",
  },
  {
    key: "qualify",
    icon: DollarSign,
    title: "Qualify buyer budget",
    desc: "Ask key financial qualification questions",
  },
  {
    key: "followup",
    icon: FileText,
    title: "Follow up on proposal",
    desc: "Send a polite follow-up message",
  },
  {
    key: "compare",
    icon: GitCompareArrows,
    title: "Compare properties",
    desc: "Help a lead compare two listings",
  },
] as const;

function TypingDots() {
  return (
    <div className="flex justify-start msg-ai">
      <div className="bg-muted rounded-2xl px-4 py-3.5 flex items-center gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-2 h-2 rounded-full bg-muted-foreground/70 animate-bounce"
            style={{ animationDelay: `${i * 0.18}s`, animationDuration: "1s" }}
          />
        ))}
      </div>
    </div>
  );
}

function parseMessage(content: string) {
  const match = content.match(/<thought_process>([\s\S]*?)<\/thought_process>/);
  if (match) {
    return {
      thoughtProcess: match[1].trim(),
      cleanContent: content.replace(match[0], "").trim(),
    };
  }
  return { thoughtProcess: null, cleanContent: content };
}

function Chat() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { sessionId: paramSessionId, initialMessage: paramInitialMessage } = Route.useSearch();

  const suggestions = [
    t("Schedule a site visit"),
    t("Send pricing PDF"),
    t("Qualify budget"),
    t("Ask about timeline"),
  ];
  const bottomRef = useRef<HTMLDivElement>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [localMessages, setLocalMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ["chat-sessions"],
    queryFn: () => api.chat.sessions(),
  });

  useEffect(() => {
    if (paramSessionId) {
      setActiveId(paramSessionId);
    } else if (sessions.length > 0 && !activeId) {
      setActiveId(sessions[0].id);
    }
  }, [sessions, activeId, paramSessionId]);

  const { data: messages = [], isLoading: messagesLoading } = useQuery({
    queryKey: ["messages", activeId],
    queryFn: () => api.chat.messages(activeId!),
    enabled: !!activeId,
  });

  useEffect(() => {
    setLocalMessages(messages);
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [localMessages]);

  const createSessionMutation = useMutation({
    mutationFn: () => api.chat.createSession(),
    onSuccess: (session: ChatSession) => {
      queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
      setActiveId(session.id);
    },
    onError: () => toast.error("Failed to create conversation"),
  });

  const switchSession = (id: string) => {
    setActiveId(id);
    setDraft("");
  };

  const send = async (text?: string) => {
    const content = (text ?? draft).trim();
    if (!content || sending) return;

    setDraft("");
    setSending(true);

    let targetSessionId = activeId;

    if (!targetSessionId) {
      try {
        const newSession = await createSessionMutation.mutateAsync();
        targetSessionId = newSession.id;
        setActiveId(newSession.id);
      } catch (err) {
        toast.error("Failed to auto-create conversation");
        setSending(false);
        return;
      }
    }

    const optimisticUser: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    // Create an optimistic AI message that will receive chunks
    const aiMessageId = crypto.randomUUID();
    const optimisticAi: Message = {
      id: aiMessageId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };

    setLocalMessages((m) => [...m, optimisticUser, optimisticAi]);

    try {
      const reply = await api.chat.streamSend(targetSessionId, content, (chunk) => {
        setLocalMessages((m) =>
          m.map((msg) => (msg.id === aiMessageId ? { ...msg, content: msg.content + chunk } : msg)),
        );
      });
      // Replace optimistic message with the final saved one from backend
      setLocalMessages((m) => {
        const base = m.filter((x) => x && x.id !== optimisticUser.id && x.id !== aiMessageId);
        return reply ? [...base, optimisticUser, reply] : [...base, optimisticUser];
      });
      queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      queryClient.invalidateQueries({ queryKey: ["usage"] });
    } catch (err: unknown) {
      toast.error((err as Error).message ?? "Failed to send message");
      setLocalMessages((m) =>
        m.filter((x) => x && x.id !== optimisticUser.id && x.id !== aiMessageId),
      );
    } finally {
      setSending(false);
    }
  };

  // Auto-send initial message if passed from Dashboard
  useEffect(() => {
    if (paramInitialMessage && activeId) {
      // Clear initialMessage by resetting the search parameters so it doesn't trigger on reload
      send(paramInitialMessage);
      // Remove query parameters from URL
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + (paramSessionId ? `?sessionId=${paramSessionId}` : ""),
      );
    }
  }, [paramInitialMessage, activeId]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4 h-[calc(100vh-9rem)]">
      {/* Sessions sidebar */}
      <Card className="hidden lg:flex flex-col overflow-hidden">
        <CardHeader className="p-4 pb-2 flex-row items-center justify-between">
          <CardTitle className="text-sm">{t("Conversations")}</CardTitle>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => createSessionMutation.mutate()}
            disabled={createSessionMutation.isPending}
          >
            {createSessionMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Plus className="h-3 w-3" />
            )}
          </Button>
        </CardHeader>
        <CardContent className="p-2 flex-1 overflow-y-auto">
          {sessionsLoading ? (
            <div className="space-y-1 p-1">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="px-3 py-2 space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ))}
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center pt-6">
              {t("No conversations yet.")}
            </p>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => switchSession(s.id)}
                className={cn(
                  "w-full text-start rounded-md px-3 py-2 text-sm transition-all duration-150 active:scale-[0.98]",
                  activeId === s.id
                    ? "bg-accent text-accent-foreground translate-x-0.5"
                    : "hover:bg-muted hover:translate-x-0.5",
                )}
              >
                <div className="font-medium truncate">{s.title}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {new Date(s.updatedAt).toLocaleDateString()}
                </div>
              </button>
            ))
          )}
        </CardContent>
      </Card>

      {/* Chat area */}
      <Card className="flex flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messagesLoading ? (
            <div className="space-y-3 p-2">
              <div className="flex justify-end">
                <Skeleton className="h-10 w-48 rounded-2xl" />
              </div>
              <div className="flex justify-start">
                <Skeleton className="h-16 w-64 rounded-2xl" />
              </div>
              <div className="flex justify-end">
                <Skeleton className="h-10 w-36 rounded-2xl" />
              </div>
              <div className="flex justify-start">
                <Skeleton className="h-12 w-56 rounded-2xl" />
              </div>
            </div>
          ) : !activeId || (localMessages.length === 0 && !sending) ? (
            <div className="flex flex-col items-center justify-center h-full gap-6 px-4">
              <div className="text-center">
                <Sparkles className="h-10 w-10 opacity-30 mx-auto mb-3" />
                <h2 className="text-base font-semibold">{t("Stratos Hub")}</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {t("Start a conversation or pick a suggestion below")}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 w-full max-w-md">
                {starterSuggestions.map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <button
                      key={s.key}
                      style={{ animationDelay: `${i * 80}ms` }}
                      onClick={() => send(t(s.title))}
                      className="group card-pop text-start rounded-xl border border-border bg-card p-4 hover:bg-accent/40 hover:border-primary/30 hover:shadow-sm hover:-translate-y-0.5 transition-all duration-150 active:scale-[0.97]"
                    >
                      <Icon className="h-4 w-4 text-primary mb-2 transition-transform duration-150 group-hover:scale-110" />
                      <div className="text-sm font-medium">{t(s.title)}</div>
                      <div className="text-xs text-muted-foreground mt-1">{t(s.desc)}</div>
                    </button>
                  );
                })}
              </div>
              {!activeId && (
                <Button
                  size="sm"
                  onClick={() => createSessionMutation.mutate()}
                  disabled={createSessionMutation.isPending}
                >
                  {createSessionMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                  ) : null}
                  {t("New conversation")}
                </Button>
              )}
            </div>
          ) : (
            localMessages.map((m) => {
              if (!m) return null;
              const { thoughtProcess, cleanContent } = parseMessage(m.content || "");
              return (
                <div
                  key={m.id}
                  className={cn(
                    "flex",
                    m.role === "user" ? "justify-end msg-user" : "justify-start msg-ai",
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-4 py-2 text-sm flex flex-col gap-2",
                      m.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground",
                    )}
                  >
                    {m.role === "assistant" && (
                      <div className="flex items-center gap-1 text-xs opacity-70">
                        <Sparkles className="h-3 w-3" /> {t("Assistant")}
                      </div>
                    )}

                    {thoughtProcess && (
                      <details className="text-xs border border-border/60 rounded-lg bg-background/50 overflow-hidden group/tp transition-all duration-200 open:shadow-sm">
                        <summary className="px-3 py-2 cursor-pointer font-medium opacity-80 hover:opacity-100 flex items-center gap-1.5 select-none bg-background/30 hover:bg-background/80">
                          <Sparkles className="h-3 w-3 text-primary" />
                          {t("Thinking...")}
                          <ChevronDown className="h-3 w-3 ml-auto transition-transform duration-200 group-open/tp:rotate-180" />
                        </summary>
                        <div className="px-3 pb-3 pt-1 opacity-80 whitespace-pre-wrap font-mono text-[11px] leading-relaxed border-t border-border/30 bg-background/40">
                          {thoughtProcess}
                        </div>
                      </details>
                    )}

                    <div
                      dir="auto"
                      className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:my-2 prose-p:my-2"
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanContent}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              );
            })
          )}
          {sending && <TypingDots />}
          <div ref={bottomRef} />
        </div>
        <div className="border-t border-border p-3 space-y-2">
          <div className="flex gap-2 flex-wrap">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-muted hover:border-primary/40 transition-all duration-150 hover:scale-105 active:scale-95"
              >
                {s}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="flex gap-2"
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("Type a message…")}
              disabled={sending}
            />
            <Button
              type="submit"
              size="icon"
              disabled={sending || !draft.trim()}
              className="transition-transform active:scale-90"
            >
              <Send className="h-4 w-4 transition-transform duration-150 group-hover:-rotate-12" />
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
