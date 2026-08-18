#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import fs from "fs";
import path from "path";
import http from "http";
import open from "open";
import os from "os";
import { fileURLToPath } from "url";


const OAUTH_PORT = parseInt(process.env.GMAIL_MCP_OAUTH_PORT || "3000", 10);
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/oauth2callback`;

const CONFIG_DIR =
    process.env.GMAIL_MCP_CONFIG_DIR || path.join(os.homedir(), ".gmail-mcp");
const OAUTH_KEYS_PATH =
    process.env.GMAIL_OAUTH_KEYS_PATH ||
    path.join(CONFIG_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH =
    process.env.GMAIL_CREDENTIALS_PATH ||
    path.join(CONFIG_DIR, "credentials.json");

const SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks",
];

let oauth2Client;


function loadOAuthClient() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    if (!fs.existsSync(OAUTH_KEYS_PATH)) {
        console.error(
            `Error: OAuth keys file not found at ${OAUTH_KEYS_PATH}.`
        );
        console.error(
            "Download a Desktop OAuth client JSON from Google Cloud Console and place it there. See README.md."
        );
        process.exit(1);
    }
    const keysContent = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, "utf8"));
    const keys = keysContent.installed || keysContent.web;
    if (!keys) {
        console.error(
            'Error: OAuth keys file must contain "installed" or "web" credentials.'
        );
        process.exit(1);
    }
    oauth2Client = new OAuth2Client(
        keys.client_id,
        keys.client_secret,
        REDIRECT_URI
    );

    oauth2Client.on("tokens", (tokens) => {
        let merged = tokens;
        if (fs.existsSync(CREDENTIALS_PATH)) {
            const existing = JSON.parse(
                fs.readFileSync(CREDENTIALS_PATH, "utf8")
            );
            merged = { ...existing, ...tokens };
        }
        fs.writeFileSync(
            CREDENTIALS_PATH,
            JSON.stringify(merged, null, 2)
        );
    });

    if (fs.existsSync(CREDENTIALS_PATH)) {
        const credentials = JSON.parse(
            fs.readFileSync(CREDENTIALS_PATH, "utf8")
        );
        oauth2Client.setCredentials(credentials);
    }
}

async function authenticate({ timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        let timer;
        let authUrl;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            try {
                server.close();
            } catch {}
        };
        server.on("error", (e) => {
            cleanup();
            reject(e);
        });
        server.listen(OAUTH_PORT, () => {
            authUrl = oauth2Client.generateAuthUrl({
                access_type: "offline",
                prompt: "consent",
                scope: SCOPES,
            });
            console.error("Visit this URL to authenticate:");
            console.error(authUrl);
            open(authUrl).catch(() => {});
            if (timeoutMs) {
                timer = setTimeout(() => {
                    cleanup();
                    reject(
                        new Error(
                            `Auth timed out after ${timeoutMs}ms (browser flow not completed). URL: ${authUrl}`
                        )
                    );
                }, timeoutMs);
            }
        });

        server.on("request", async (req, res) => {
            if (!req.url?.startsWith("/oauth2callback")) return;
            const url = new URL(req.url, REDIRECT_URI);
            const code = url.searchParams.get("code");
            if (!code) {
                res.writeHead(400);
                res.end("No code received");
                cleanup();
                reject(new Error("No code received"));
                return;
            }
            try {
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);
                fs.writeFileSync(
                    CREDENTIALS_PATH,
                    JSON.stringify(tokens, null, 2)
                );
                res.writeHead(200);
                res.end("Authenticated. You can close this window.");
                cleanup();
                resolve();
            } catch (e) {
                res.writeHead(500);
                res.end("Authentication failed");
                cleanup();
                reject(e);
            }
        });
    });
}


function isAuthError(e) {
    const msg = (e.message || "").toLowerCase();
    const code = e.code || e.status;
    return (
        msg.includes("invalid_grant") ||
        msg.includes("token has been expired") ||
        msg.includes("invalid credentials") ||
        code === 401
    );
}

function sanitizeHeader(v) {
    return String(v).replace(/[\r\n]+/g, " ");
}

function encodeHeader(text) {
    if (/[^\x00-\x7F]/.test(text)) {
        return `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;
    }
    return text;
}

function buildRawMessage({
    to,
    cc,
    bcc,
    subject,
    body,
    htmlBody,
    inReplyTo,
}) {
    const safeTo = (to || []).map(sanitizeHeader);
    const safeCc = (cc || []).map(sanitizeHeader);
    const safeBcc = (bcc || []).map(sanitizeHeader);
    const safeReplyTo = inReplyTo ? sanitizeHeader(inReplyTo) : null;
    const safeSubject = encodeHeader(sanitizeHeader(subject || ""));
    const boundary = `----=_NextPart_${Math.random().toString(36).slice(2)}`;

    const headers = [
        "From: me",
        `To: ${safeTo.join(", ")}`,
        ...(safeCc.length ? [`Cc: ${safeCc.join(", ")}`] : []),
        ...(safeBcc.length ? [`Bcc: ${safeBcc.join(", ")}`] : []),
        `Subject: ${safeSubject}`,
        ...(safeReplyTo
            ? [`In-Reply-To: ${safeReplyTo}`, `References: ${safeReplyTo}`]
            : []),
        "MIME-Version: 1.0",
    ];

    let lines;
    if (htmlBody && body) {
        lines = [
            ...headers,
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            "",
            `--${boundary}`,
            "Content-Type: text/plain; charset=UTF-8",
            "Content-Transfer-Encoding: 7bit",
            "",
            body,
            "",
            `--${boundary}`,
            "Content-Type: text/html; charset=UTF-8",
            "Content-Transfer-Encoding: 7bit",
            "",
            htmlBody,
            "",
            `--${boundary}--`,
        ];
    } else if (htmlBody) {
        lines = [
            ...headers,
            "Content-Type: text/html; charset=UTF-8",
            "Content-Transfer-Encoding: 7bit",
            "",
            htmlBody,
        ];
    } else {
        lines = [
            ...headers,
            "Content-Type: text/plain; charset=UTF-8",
            "Content-Transfer-Encoding: 7bit",
            "",
            body || "",
        ];
    }

    return Buffer.from(lines.join("\r\n"))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function extractContent(part) {
    let text = "";
    let html = "";
    if (part.body?.data) {
        const decoded = Buffer.from(part.body.data, "base64").toString("utf8");
        if (part.mimeType === "text/plain") text = decoded;
        else if (part.mimeType === "text/html") html = decoded;
    }
    if (part.parts) {
        for (const p of part.parts) {
            const sub = extractContent(p);
            text += sub.text;
            html += sub.html;
        }
    }
    return { text, html };
}

function getHeader(headers, name) {
    return (
        headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
            ?.value || ""
    );
}

function htmlToText(html) {
    return html
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<\s*br\s*\/?\s*>/gi, "\n")
        .replace(/<\/(p|div|tr|h[1-6]|li|ul|ol|table)>/gi, "\n")
        .replace(/<\/(td|th)>/gi, "\t")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, c) =>
            String.fromCharCode(parseInt(c, 16))
        )
        .replace(/[ \t]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function normalizeDue(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
}


const SearchThreadsSchema = z.object({
    query: z
        .string()
        .describe(
            "Gmail search query (e.g. 'from:foo@bar.com newer_than:7d is:unread')"
        ),
    maxResults: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(25)
        .describe("Max threads to return per page"),
    pageToken: z
        .string()
        .optional()
        .describe("Pagination token from a previous response"),
});

const GetThreadSchema = z.object({
    threadId: z.string(),
    format: z
        .enum(["full", "metadata", "minimal"])
        .optional()
        .default("full"),
});

const ThreadIdSchema = z.object({ threadId: z.string() });

const LabelThreadSchema = z.object({
    threadId: z.string(),
    addLabelIds: z.array(z.string()).optional(),
    removeLabelIds: z.array(z.string()).optional(),
});

const ListLabelsSchema = z.object({});

const ReauthSchema = z.object({});

const DraftSchema = z.object({
    to: z.array(z.string()).min(1),
    subject: z.string(),
    body: z.string(),
    htmlBody: z.string().optional(),
    cc: z.array(z.string()).optional(),
    bcc: z.array(z.string()).optional(),
    threadId: z.string().optional(),
    inReplyTo: z.string().optional(),
});


const DriveSearchSchema = z.object({
    query: z.string().describe("Drive query string (e.g. 'name contains \"budget\"')"),
    maxResults: z.number().int().min(1).max(1000).optional().default(25),
    pageToken: z.string().optional(),
});

const DriveGetFileSchema = z.object({
    fileId: z.string(),
});

const DriveDownloadSchema = z.object({
    fileId: z.string(),
    mimeType: z.string().optional().describe(
        "Export MIME type for Google Workspace files (e.g. 'text/plain' for Docs, 'text/csv' for Sheets). Omit to download the native file as text."
    ),
});

const CalListEventsSchema = z.object({
    calendarId: z.string().optional().default("primary"),
    startTime: z.string().optional().describe("ISO 8601 lower bound"),
    endTime: z.string().optional().describe("ISO 8601 upper bound"),
    maxResults: z.number().int().min(1).max(2500).optional().default(25),
    orderBy: z.enum(["startTime", "updated"]).optional(),
    pageToken: z.string().optional(),
    timeZone: z.string().optional(),
});

const CalCreateEventSchema = z.object({
    calendarId: z.string().optional().default("primary"),
    summary: z.string(),
    start: z.string().describe("ISO date YYYY-MM-DD (all-day) or datetime YYYY-MM-DDThh:mm:ss"),
    end: z.string().describe("ISO date or datetime"),
    description: z.string().optional(),
    timeZone: z.string().optional().describe("IANA timezone e.g. 'Asia/Ho_Chi_Minh'"),
});

const CalUpdateEventSchema = z.object({
    calendarId: z.string().optional().default("primary"),
    eventId: z.string(),
    summary: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    description: z.string().optional(),
    timeZone: z.string().optional(),
});

const CalDeleteEventSchema = z.object({
    calendarId: z.string().optional().default("primary"),
    eventId: z.string(),
});

const CalListCalendarsSchema = z.object({});

const TaskListListsSchema = z.object({});

const TaskListSchema = z.object({
    tasklist: z.string().optional().default("@default").describe("Task list id (default: '@default')"),
    status: z.enum(["needsAction", "completed"]).optional().describe("Filter by status"),
    dueMax: z.string().optional().describe("RFC 3339 upper bound on due date"),
    dueMin: z.string().optional().describe("RFC 3339 lower bound on due date"),
    maxResults: z.number().int().min(1).max(100).optional().default(20),
    pageToken: z.string().optional(),
});

const TaskCreateSchema = z.object({
    tasklist: z.string().optional().default("@default"),
    title: z.string(),
    notes: z.string().optional(),
    due: z.string().optional().describe("Due date YYYY-MM-DD (or full RFC 3339 timestamp)"),
});

const TaskUpdateSchema = z.object({
    tasklist: z.string().optional().default("@default"),
    task: z.string().describe("Task id"),
    title: z.string().optional(),
    notes: z.string().optional(),
    due: z.string().optional().describe("Due date YYYY-MM-DD (or full RFC 3339 timestamp)"),
    status: z.enum(["needsAction", "completed"]).optional().describe("Set to 'completed' to mark done"),
});

const TaskDeleteSchema = z.object({
    tasklist: z.string().optional().default("@default"),
    task: z.string().describe("Task id"),
});

const TaskMoveSchema = z.object({
    tasklist: z.string().optional().default("@default"),
    task: z.string().describe("Task id"),
    parent: z.string().optional().describe("New parent task id, or empty to make a top-level task"),
    previous: z.string().optional().describe("Task id to position after"),
});

const TaskClearSchema = z.object({
    tasklist: z.string().optional().default("@default"),
});

const TOOLS = [
    {
        name: "search_threads",
        description:
            "Search Gmail threads using Gmail query syntax. Returns paginated list with subject/from/date/snippet.",
        inputSchema: zodToJsonSchema(SearchThreadsSchema),
    },
    {
        name: "get_thread",
        description: "Fetch a thread by ID with all messages and full bodies.",
        inputSchema: zodToJsonSchema(GetThreadSchema),
    },
    {
        name: "mark_read",
        description: "Remove the UNREAD label from a thread.",
        inputSchema: zodToJsonSchema(ThreadIdSchema),
    },
    {
        name: "mark_unread",
        description: "Add the UNREAD label to a thread.",
        inputSchema: zodToJsonSchema(ThreadIdSchema),
    },
    {
        name: "archive_thread",
        description: "Remove a thread from the inbox (removes INBOX label).",
        inputSchema: zodToJsonSchema(ThreadIdSchema),
    },
    {
        name: "trash_thread",
        description:
            "Move a thread to Trash (recoverable for 30 days). This is the only delete operation supported — there is no permanent delete.",
        inputSchema: zodToJsonSchema(ThreadIdSchema),
    },
    {
        name: "label_thread",
        description: "Add or remove labels on a thread.",
        inputSchema: zodToJsonSchema(LabelThreadSchema),
    },
    {
        name: "list_labels",
        description: "List all Gmail labels (system + user).",
        inputSchema: zodToJsonSchema(ListLabelsSchema),
    },
    {
        name: "create_draft",
        description: "Create a draft email or reply.",
        inputSchema: zodToJsonSchema(DraftSchema),
    },
    {
        name: "send_email",
        description: "Send an email immediately.",
        inputSchema: zodToJsonSchema(DraftSchema),
    },
    {
        name: "reauth",
        description:
            "Re-run the Google OAuth flow to refresh credentials. Opens a browser to sign in; on success updates the in-memory OAuth client so subsequent calls work without restarting the MCP host. Use when tools fail with 'invalid_grant' (refresh tokens expire after 7 days for unverified Testing-mode OAuth apps).",
        inputSchema: zodToJsonSchema(ReauthSchema),
    },
    {
        name: "drive_search",
        description: "Search Google Drive files using Drive query syntax. Returns id, name, mimeType, modifiedTime, webViewLink. Trashed files are excluded.",
        inputSchema: zodToJsonSchema(DriveSearchSchema),
    },
    {
        name: "drive_get_file",
        description: "Get metadata for a Drive file by ID (id, name, mimeType, modifiedTime, size, webViewLink, parents).",
        inputSchema: zodToJsonSchema(DriveGetFileSchema),
    },
    {
        name: "drive_download",
        description: "Download or export a Drive file as text. For Google Workspace files (Docs/Sheets/Slides) pass mimeType (e.g. 'text/plain', 'text/csv'). Omit mimeType for plain binary/text files.",
        inputSchema: zodToJsonSchema(DriveDownloadSchema),
    },
    {
        name: "cal_list_events",
        description: "List Google Calendar events in a time range.",
        inputSchema: zodToJsonSchema(CalListEventsSchema),
    },
    {
        name: "cal_create_event",
        description: "Create a Google Calendar event. Pass YYYY-MM-DD for all-day events or YYYY-MM-DDThh:mm:ss for timed events.",
        inputSchema: zodToJsonSchema(CalCreateEventSchema),
    },
    {
        name: "cal_update_event",
        description: "Update an existing Google Calendar event.",
        inputSchema: zodToJsonSchema(CalUpdateEventSchema),
    },
    {
        name: "cal_delete_event",
        description: "Delete a Google Calendar event.",
        inputSchema: zodToJsonSchema(CalDeleteEventSchema),
    },
    {
        name: "cal_list_calendars",
        description: "List all Google Calendars accessible to the user (id, summary, accessRole, timeZone).",
        inputSchema: zodToJsonSchema(CalListCalendarsSchema),
    },
    {
        name: "task_list_lists",
        description: "List all Google Tasks task lists (id, title).",
        inputSchema: zodToJsonSchema(TaskListListsSchema),
    },
    {
        name: "task_list",
        description: "List tasks in a task list ('@default' by default), with optional status/due filters and pagination.",
        inputSchema: zodToJsonSchema(TaskListSchema),
    },
    {
        name: "task_create",
        description: "Create a Google Task (title, notes, due date, optional list id).",
        inputSchema: zodToJsonSchema(TaskCreateSchema),
    },
    {
        name: "task_update",
        description: "Update title/notes/due/status of a task. Set status='completed' to mark done.",
        inputSchema: zodToJsonSchema(TaskUpdateSchema),
    },
    {
        name: "task_delete",
        description: "Delete a Google Task.",
        inputSchema: zodToJsonSchema(TaskDeleteSchema),
    },
    {
        name: "task_move",
        description: "Reorder or move a task (parent/previous).",
        inputSchema: zodToJsonSchema(TaskMoveSchema),
    },
    {
        name: "task_clear",
        description: "Clear all completed tasks in a task list.",
        inputSchema: zodToJsonSchema(TaskClearSchema),
    },
];


function createExecuteToolCall({ gmail, drive, calendar, tasks, authenticate, credentialsPath }) {
    return async (name, args) => {
        switch (name) {
            case "search_threads": {
                    const a = SearchThreadsSchema.parse(args);
                    const resp = await gmail.users.threads.list({
                        userId: "me",
                        q: a.query,
                        maxResults: a.maxResults,
                        pageToken: a.pageToken,
                    });
                    const threads = resp.data.threads || [];
                    const enriched = await Promise.all(
                        threads.map(async (t) => {
                            const detail = await gmail.users.threads.get({
                                userId: "me",
                                id: t.id,
                                format: "metadata",
                                metadataHeaders: ["Subject", "From", "Date"],
                            });
                            const msgs = detail.data.messages || [];
                            const last = msgs[msgs.length - 1];
                            const headers = last?.payload?.headers || [];
                            return {
                                id: t.id,
                                messageCount: msgs.length,
                                unread: msgs.some((m) =>
                                    m.labelIds?.includes("UNREAD")
                                ),
                                subject: getHeader(headers, "Subject"),
                                from: getHeader(headers, "From"),
                                date: getHeader(headers, "Date"),
                                snippet: detail.data.snippet || "",
                            };
                        })
                    );
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        threads: enriched,
                                        nextPageToken:
                                            resp.data.nextPageToken || null,
                                        resultSizeEstimate:
                                            resp.data.resultSizeEstimate,
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                }
                case "get_thread": {
                    const a = GetThreadSchema.parse(args);
                    const resp = await gmail.users.threads.get({
                        userId: "me",
                        id: a.threadId,
                        format: a.format,
                    });
                    const messages = (resp.data.messages || []).map((m) => {
                        const headers = m.payload?.headers || [];
                        const { text, html } = extractContent(m.payload || {});
                        return {
                            id: m.id,
                            labelIds: m.labelIds,
                            from: getHeader(headers, "From"),
                            to: getHeader(headers, "To"),
                            subject: getHeader(headers, "Subject"),
                            date: getHeader(headers, "Date"),
                            body: text || (html ? htmlToText(html) : ""),
                            snippet: m.snippet,
                        };
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    { id: resp.data.id, messages },
                                    null,
                                    2
                                ),
                            },
                        ],
                    };
                }
                case "mark_read": {
                    const a = ThreadIdSchema.parse(args);
                    await gmail.users.threads.modify({
                        userId: "me",
                        id: a.threadId,
                        requestBody: { removeLabelIds: ["UNREAD"] },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thread ${a.threadId} marked as read.`,
                            },
                        ],
                    };
                }
                case "mark_unread": {
                    const a = ThreadIdSchema.parse(args);
                    await gmail.users.threads.modify({
                        userId: "me",
                        id: a.threadId,
                        requestBody: { addLabelIds: ["UNREAD"] },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thread ${a.threadId} marked as unread.`,
                            },
                        ],
                    };
                }
                case "archive_thread": {
                    const a = ThreadIdSchema.parse(args);
                    await gmail.users.threads.modify({
                        userId: "me",
                        id: a.threadId,
                        requestBody: { removeLabelIds: ["INBOX"] },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thread ${a.threadId} archived.`,
                            },
                        ],
                    };
                }
                case "trash_thread": {
                    const a = ThreadIdSchema.parse(args);
                    await gmail.users.threads.trash({
                        userId: "me",
                        id: a.threadId,
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thread ${a.threadId} moved to Trash.`,
                            },
                        ],
                    };
                }
                case "label_thread": {
                    const a = LabelThreadSchema.parse(args);
                    await gmail.users.threads.modify({
                        userId: "me",
                        id: a.threadId,
                        requestBody: {
                            addLabelIds: a.addLabelIds,
                            removeLabelIds: a.removeLabelIds,
                        },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Labels updated on thread ${a.threadId}.`,
                            },
                        ],
                    };
                }
                case "list_labels": {
                    const resp = await gmail.users.labels.list({
                        userId: "me",
                    });
                    const labels = (resp.data.labels || []).map((l) => ({
                        id: l.id,
                        name: l.name,
                        type: l.type,
                    }));
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(labels, null, 2),
                            },
                        ],
                    };
                }
                case "create_draft": {
                    const a = DraftSchema.parse(args);
                    const raw = buildRawMessage(a);
                    const resp = await gmail.users.drafts.create({
                        userId: "me",
                        requestBody: {
                            message: {
                                raw,
                                ...(a.threadId && { threadId: a.threadId }),
                            },
                        },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Draft created: ${resp.data.id}`,
                            },
                        ],
                    };
                }
                case "send_email": {
                    const a = DraftSchema.parse(args);
                    const raw = buildRawMessage(a);
                    const resp = await gmail.users.messages.send({
                        userId: "me",
                        requestBody: {
                            raw,
                            ...(a.threadId && { threadId: a.threadId }),
                        },
                    });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Email sent: ${resp.data.id}`,
                            },
                        ],
                    };
                }
                case "reauth": {
                    ReauthSchema.parse(args);
                    await authenticate({ timeoutMs: 5 * 60 * 1000 });
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Re-auth completed. New credentials written to ${credentialsPath}. The in-memory OAuth client has been refreshed.`,
                            },
                        ],
                    };
                }
            case "drive_search": {
                const a = DriveSearchSchema.parse(args);
                const resp = await drive.files.list({
                    q: a.query,
                    pageSize: a.maxResults,
                    pageToken: a.pageToken,
                    fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,trashed)",
                });
                const files = (resp.data.files || []).filter(f => !f.trashed);
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ files, nextPageToken: resp.data.nextPageToken || null }, null, 2),
                    }],
                };
            }
            case "drive_get_file": {
                const a = DriveGetFileSchema.parse(args);
                const resp = await drive.files.get({
                    fileId: a.fileId,
                    fields: "id,name,mimeType,modifiedTime,size,webViewLink,parents,trashed,description",
                });
                return {
                    content: [{ type: "text", text: JSON.stringify(resp.data, null, 2) }],
                };
            }
            case "drive_download": {
                const a = DriveDownloadSchema.parse(args);
                let content;
                if (a.mimeType) {
                    const resp = await drive.files.export(
                        { fileId: a.fileId, mimeType: a.mimeType },
                        { responseType: "text" }
                    );
                    content = String(resp.data);
                } else {
                    const resp = await drive.files.get(
                        { fileId: a.fileId, alt: "media" },
                        { responseType: "text" }
                    );
                    content = String(resp.data);
                }
                const MAX = 100_000;
                const truncated = content.length > MAX;
                return {
                    content: [{
                        type: "text",
                        text: truncated
                            ? content.slice(0, MAX) + `\n\n[truncated — ${content.length - MAX} chars omitted]`
                            : content,
                    }],
                };
            }
            case "cal_list_events": {
                const a = CalListEventsSchema.parse(args);
                const resp = await calendar.events.list({
                    calendarId: a.calendarId,
                    timeMin: a.startTime,
                    timeMax: a.endTime,
                    maxResults: a.maxResults,
                    orderBy: a.orderBy,
                    pageToken: a.pageToken,
                    timeZone: a.timeZone,
                    singleEvents: true,
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            events: resp.data.items || [],
                            nextPageToken: resp.data.nextPageToken || null,
                        }, null, 2),
                    }],
                };
            }
            case "cal_create_event": {
                const a = CalCreateEventSchema.parse(args);
                const toField = (s) => s.includes("T")
                    ? { dateTime: s, timeZone: a.timeZone }
                    : { date: s };
                const resp = await calendar.events.insert({
                    calendarId: a.calendarId,
                    requestBody: {
                        summary: a.summary,
                        description: a.description,
                        start: toField(a.start),
                        end: toField(a.end),
                    },
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ id: resp.data.id, htmlLink: resp.data.htmlLink }, null, 2),
                    }],
                };
            }
            case "cal_update_event": {
                const a = CalUpdateEventSchema.parse(args);
                const cur = await calendar.events.get({ calendarId: a.calendarId, eventId: a.eventId });
                const ev = cur.data;
                const toField = (s) => s.includes("T")
                    ? { dateTime: s, timeZone: a.timeZone }
                    : { date: s };
                if (a.summary !== undefined) ev.summary = a.summary;
                if (a.description !== undefined) ev.description = a.description;
                if (a.start !== undefined) ev.start = toField(a.start);
                if (a.end !== undefined) ev.end = toField(a.end);
                const resp = await calendar.events.update({
                    calendarId: a.calendarId,
                    eventId: a.eventId,
                    requestBody: ev,
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ id: resp.data.id, updated: resp.data.updated }, null, 2),
                    }],
                };
            }
            case "cal_delete_event": {
                const a = CalDeleteEventSchema.parse(args);
                await calendar.events.delete({ calendarId: a.calendarId, eventId: a.eventId });
                return {
                    content: [{
                        type: "text",
                        text: `Event ${a.eventId} deleted from calendar ${a.calendarId}.`,
                    }],
                };
            }
            case "cal_list_calendars": {
                CalListCalendarsSchema.parse(args);
                const resp = await calendar.calendarList.list();
                const cals = (resp.data.items || []).map(c => ({
                    id: c.id,
                    summary: c.summary,
                    description: c.description,
                    primary: c.primary || false,
                    accessRole: c.accessRole,
                    timeZone: c.timeZone,
                }));
                return {
                    content: [{ type: "text", text: JSON.stringify(cals, null, 2) }],
                };
            }
            case "task_list_lists": {
                TaskListListsSchema.parse(args);
                const resp = await tasks.tasklists.list({});
                const lists = (resp.data.items || []).map(l => ({
                    id: l.id,
                    title: l.title,
                }));
                return {
                    content: [{ type: "text", text: JSON.stringify(lists, null, 2) }],
                };
            }
            case "task_list": {
                const a = TaskListSchema.parse(args);
                const resp = await tasks.tasks.list({
                    tasklist: a.tasklist,
                    showCompleted: a.status ? a.status === "completed" : true,
                    showHidden: a.status ? a.status === "completed" : false,
                    dueMax: a.dueMax,
                    dueMin: a.dueMin,
                    maxResults: a.maxResults,
                    pageToken: a.pageToken,
                });
                const items = (resp.data.items || []).filter(t =>
                    !a.status || t.status === a.status
                );
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            tasks: items,
                            nextPageToken: resp.data.nextPageToken || null,
                        }, null, 2),
                    }],
                };
            }
            case "task_create": {
                const a = TaskCreateSchema.parse(args);
                const resp = await tasks.tasks.insert({
                    tasklist: a.tasklist,
                    requestBody: {
                        title: a.title,
                        notes: a.notes,
                        ...(a.due && { due: normalizeDue(a.due) }),
                    },
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ id: resp.data.id, title: resp.data.title, due: resp.data.due }, null, 2),
                    }],
                };
            }
            case "task_update": {
                const a = TaskUpdateSchema.parse(args);
                const cur = await tasks.tasks.get({ tasklist: a.tasklist, task: a.task });
                const t = cur.data;
                if (a.title !== undefined) t.title = a.title;
                if (a.notes !== undefined) t.notes = a.notes;
                if (a.due !== undefined) t.due = normalizeDue(a.due);
                if (a.status !== undefined) t.status = a.status;
                const resp = await tasks.tasks.update({
                    tasklist: a.tasklist,
                    task: a.task,
                    requestBody: t,
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ id: resp.data.id, title: resp.data.title, status: resp.data.status, due: resp.data.due }, null, 2),
                    }],
                };
            }
            case "task_delete": {
                const a = TaskDeleteSchema.parse(args);
                await tasks.tasks.delete({ tasklist: a.tasklist, task: a.task });
                return {
                    content: [{
                        type: "text",
                        text: `Task ${a.task} deleted from list ${a.tasklist}.`,
                    }],
                };
            }
            case "task_move": {
                const a = TaskMoveSchema.parse(args);
                const resp = await tasks.tasks.move({
                    tasklist: a.tasklist,
                    task: a.task,
                    parent: a.parent,
                    previous: a.previous,
                });
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({ id: resp.data.id, title: resp.data.title, position: resp.data.position }, null, 2),
                    }],
                };
            }
            case "task_clear": {
                const a = TaskClearSchema.parse(args);
                await tasks.tasks.clear({ tasklist: a.tasklist });
                return {
                    content: [{
                        type: "text",
                        text: `Completed tasks cleared from list ${a.tasklist}.`,
                    }],
                };
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    };
}

async function main() {
    loadOAuthClient();

    if (process.argv[2] === "auth") {
        await authenticate();
        console.error("Authentication completed.");
        process.exit(0);
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const tasks = google.tasks({ version: "v1", auth: oauth2Client });

    const server = new Server(
        { name: "yt-gmail-mcp", version: "0.1.0" },
        { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS,
    }));

    const executeToolCall = createExecuteToolCall({
        gmail,
        drive,
        calendar,
        tasks,
        authenticate,
        credentialsPath: CREDENTIALS_PATH,
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        try {
            return await executeToolCall(name, args);
        } catch (e) {
            if (name !== "reauth" && isAuthError(e)) {
                try {
                    await authenticate({ timeoutMs: 5 * 60 * 1000 });
                    return await executeToolCall(name, args);
                } catch (retryErr) {
                    return {
                        content: [{ type: "text", text: `Error after re-auth: ${retryErr.message}` }],
                        isError: true,
                    };
                }
            }
            return {
                content: [{ type: "text", text: `Error: ${e.message}` }],
                isError: true,
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

const isMain =
    process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
    main().catch((e) => {
        console.error("Fatal:", e);
        process.exit(1);
    });
}

export {
    buildRawMessage,
    extractContent,
    getHeader,
    htmlToText,
    sanitizeHeader,
    encodeHeader,
    normalizeDue,
    isAuthError,
    createExecuteToolCall,
    SearchThreadsSchema,
    GetThreadSchema,
    ThreadIdSchema,
    LabelThreadSchema,
    ListLabelsSchema,
    ReauthSchema,
    DraftSchema,
    DriveSearchSchema,
    DriveGetFileSchema,
    DriveDownloadSchema,
    CalListEventsSchema,
    CalCreateEventSchema,
    CalUpdateEventSchema,
    CalDeleteEventSchema,
    CalListCalendarsSchema,
    TaskListListsSchema,
    TaskListSchema,
    TaskCreateSchema,
    TaskUpdateSchema,
    TaskDeleteSchema,
    TaskMoveSchema,
    TaskClearSchema,
};
