import { test } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeDue,
    buildRawMessage,
    htmlToText,
    extractContent,
    getHeader,
    sanitizeHeader,
    encodeHeader,
    isAuthError,
    singleFlightAuthenticate,
    decodeJwtPayload,
    computeAuthStatus,
    TaskListSchema,
    TaskCreateSchema,
    TaskUpdateSchema,
    TaskMoveSchema,
} from "../index.js";

test("normalizeDue converts YYYY-MM-DD to UTC midnight", () => {
    assert.equal(normalizeDue("2026-08-18"), "2026-08-18T00:00:00.000Z");
});

test("normalizeDue passes through full RFC 3339 timestamps", () => {
    assert.equal(
        normalizeDue("2026-08-18T14:30:00.000Z"),
        "2026-08-18T14:30:00.000Z"
    );
    assert.equal(
        normalizeDue("2026-08-18T14:30:00+07:00"),
        "2026-08-18T14:30:00+07:00"
    );
});

test("normalizeDue leaves non-date strings untouched", () => {
    assert.equal(normalizeDue("tomorrow"), "tomorrow");
});

test("isAuthError detects auth failures", () => {
    assert.equal(isAuthError(new Error("invalid_grant")), true);
    assert.equal(isAuthError(new Error("token has been expired")), true);
    assert.equal(isAuthError(new Error("invalid credentials")), true);
    assert.equal(isAuthError({ code: 401 }), true);
    assert.equal(isAuthError({ status: 401 }), true);
    assert.equal(isAuthError(new Error("some other error")), false);
    assert.equal(isAuthError({ code: 404 }), false);
});

test("buildRawMessage produces base64url and sanitizes headers", () => {
    const raw = buildRawMessage({
        to: ["a@example.com"],
        subject: "Hello",
        body: "Hi there",
    });
    assert.ok(typeof raw === "string");
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    assert.match(decoded, /To: a@example\.com/);
    assert.match(decoded, /Subject: Hello/);
    assert.match(decoded, /Hi there/);
});

test("buildRawMessage strips CRLF header injection", () => {
    const raw = buildRawMessage({
        to: ["evil@example.com"],
        subject: "X\r\nBcc: injected@example.com",
        body: "body",
    });
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    assert.doesNotMatch(decoded, /\r?\nBcc:/);
});

test("sanitizeHeader removes CR/LF", () => {
    assert.equal(sanitizeHeader("a\r\nb\nc"), "a b c");
});

test("encodeHeader wraps non-ASCII in RFC 2047", () => {
    assert.equal(encodeHeader("café"), "=?UTF-8?B?Y2Fmw6k=?=");
    assert.equal(encodeHeader("plain"), "plain");
});

test("htmlToText strips tags and decodes entities", () => {
    assert.equal(
        htmlToText("<p>Hello<br>World</p> &amp; goodbye"),
        "Hello\nWorld\n& goodbye"
    );
    assert.equal(htmlToText("&#x41;&#x42;"), "AB");
});

test("buildRawMessage produces multipart/alternative with html and text", () => {
    const raw = buildRawMessage({
        to: ["a@example.com"],
        subject: "Hi",
        body: "plain",
        htmlBody: "<b>bold</b>",
    });
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    assert.match(decoded, /Content-Type: multipart\/alternative/);
    assert.match(decoded, /text\/plain/);
    assert.match(decoded, /text\/html/);
    assert.match(decoded, /plain/);
    assert.match(decoded, /<b>bold<\/b>/);
});

test("buildRawMessage html-only body", () => {
    const raw = buildRawMessage({
        to: ["a@example.com"],
        subject: "Hi",
        body: "",
        htmlBody: "<b>bold</b>",
    });
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    assert.match(decoded, /Content-Type: text\/html/);
    assert.doesNotMatch(decoded, /multipart\/alternative/);
});

test("getHeader is case-insensitive", () => {
    const headers = [{ name: "Subject", value: "Hi" }];
    assert.equal(getHeader(headers, "subject"), "Hi");
    assert.equal(getHeader(headers, "nope"), "");
});

test("extractContent returns text and html from a part", () => {
    const text = Buffer.from("plain body").toString("base64");
    const html = Buffer.from("<b>bold</b>").toString("base64");
    const part = {
        mimeType: "multipart/alternative",
        parts: [
            { mimeType: "text/plain", body: { data: text } },
            { mimeType: "text/html", body: { data: html } },
        ],
    };
    const result = extractContent(part);
    assert.equal(result.text, "plain body");
    assert.equal(result.html, "<b>bold</b>");
});

test("TaskListSchema defaults tasklist to @default", () => {
    const parsed = TaskListSchema.parse({});
    assert.equal(parsed.tasklist, "@default");
    assert.equal(parsed.maxResults, 20);
});

test("TaskListSchema rejects invalid status", () => {
    assert.throws(() => TaskListSchema.parse({ status: "done" }));
});

test("TaskCreateSchema requires title", () => {
    assert.throws(() => TaskCreateSchema.parse({}));
    assert.equal(TaskCreateSchema.parse({ title: "x" }).title, "x");
});

test("TaskUpdateSchema accepts completed status", () => {
    const parsed = TaskUpdateSchema.parse({ task: "t", status: "completed" });
    assert.equal(parsed.status, "completed");
});

test("TaskMoveSchema allows parent/previous or neither", () => {
    assert.deepEqual(TaskMoveSchema.parse({ task: "t" }), { tasklist: "@default", task: "t" });
    const moved = TaskMoveSchema.parse({ task: "t", parent: "p", previous: "q" });
    assert.equal(moved.parent, "p");
    assert.equal(moved.previous, "q");
});

test("decodeJwtPayload decodes a standard JWT payload", () => {
    const payload = { sub: "123", email: "a@example.com", exp: 2000000000 };
    const token = `h.${Buffer.from(JSON.stringify(payload))
        .toString("base64url")}.s`;
    assert.deepEqual(decodeJwtPayload(token), payload);
});

test("decodeJwtPayload returns null for malformed tokens", () => {
    assert.equal(decodeJwtPayload(null), null);
    assert.equal(decodeJwtPayload("not-a-jwt"), null);
    assert.equal(decodeJwtPayload("a."), null);
    assert.equal(decodeJwtPayload("a.!.c"), null);
});

test("computeAuthStatus reports unauthenticated when no client", () => {
    const status = computeAuthStatus(undefined);
    assert.equal(status.authenticated, false);
    assert.equal(status.expired, true);
    assert.equal(status.email, null);
    assert.ok(Array.isArray(status.scopes));
});

test("computeAuthStatus reports unexpired session with email", () => {
    const payload = { email: "user@example.com", exp: Math.floor(Date.now() / 1000) + 3600 };
    const client = {
        credentials: {
            access_token: `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`,
            id_token: `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`,
        },
    };
    const status = computeAuthStatus(client);
    assert.equal(status.authenticated, true);
    assert.equal(status.email, "user@example.com");
    assert.ok(status.expiresAt);
    assert.equal(status.expired, false);
});

test("computeAuthStatus marks expired token", () => {
    const payload = { email: "user@example.com", exp: Math.floor(Date.now() / 1000) - 60 };
    const client = {
        credentials: {
            access_token: `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`,
        },
    };
    const status = computeAuthStatus(client);
    assert.equal(status.authenticated, true);
    assert.equal(status.expired, true);
});

test("computeAuthStatus prefers id_token email over access token", () => {
    const tokenFor = (email) =>
        `h.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.s`;
    const client = {
        credentials: {
            access_token: tokenFor("access@example.com"),
            id_token: tokenFor("id@example.com"),
        },
    };
    assert.equal(computeAuthStatus(client).email, "id@example.com");
});

test("singleFlightAuthenticate de-duplicates concurrent calls and releases after settle", async () => {
    let calls = 0;
    const fakeAuth = async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 25));
        return "ok";
    };
    const first = singleFlightAuthenticate({}, fakeAuth);
    const second = singleFlightAuthenticate({}, fakeAuth);
    assert.equal(await first, "ok");
    assert.equal(await second, "ok");
    assert.equal(calls, 1);
    await singleFlightAuthenticate({}, fakeAuth);
    assert.equal(calls, 2);
});
