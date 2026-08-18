import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecuteToolCall } from "../index.js";

function deps(overrides = {}) {
    const d = {
        authenticate: async () => {},
        credentialsPath: "/tmp/credentials.json",
        gmail: {
            users: {
                threads: {
                    list: async () => ({ data: { threads: [] } }),
                    get: async () => ({ data: {} }),
                    modify: async () => ({ data: {} }),
                    trash: async () => ({ data: {} }),
                },
                labels: { list: async () => ({ data: { labels: [] } }) },
                drafts: { create: async () => ({ data: { id: "d1" } }) },
                messages: { send: async () => ({ data: { id: "m1" } }) },
            },
        },
        drive: {
            files: {
                list: async () => ({ data: { files: [] } }),
                get: async () => ({ data: {} }),
                export: async () => ({ data: "" }),
            },
        },
        calendar: {
            events: {
                list: async () => ({ data: { items: [] } }),
                insert: async () => ({ data: {} }),
                get: async () => ({ data: {} }),
                update: async () => ({ data: {} }),
                delete: async () => ({ data: {} }),
            },
            calendarList: { list: async () => ({ data: { items: [] } }) },
        },
        tasks: {
            tasklists: { list: async () => ({ data: { items: [] } }) },
            tasks: {
                list: async () => ({ data: { items: [] } }),
                insert: async () => ({ data: {} }),
                get: async () => ({ data: {} }),
                update: async () => ({ data: {} }),
                delete: async () => ({ data: {} }),
                move: async () => ({ data: {} }),
                clear: async () => ({ data: {} }),
            },
        },
    };
    Object.assign(d, overrides);
    return d;
}

function text(result) {
    return result.content[0].text;
}

test("search_threads enriches threads with headers and unread flag", async () => {
    const d = deps({
        gmail: {
            users: {
                threads: {
                    list: async () => ({
                        data: {
                            threads: [{ id: "t1" }],
                            nextPageToken: null,
                            resultSizeEstimate: 1,
                        },
                    }),
                    get: async () => ({
                        data: {
                            messages: [
                                {
                                    id: "m1",
                                    labelIds: ["UNREAD"],
                                    payload: {
                                        headers: [
                                            { name: "Subject", value: "Hello" },
                                            { name: "From", value: "a@b.com" },
                                            { name: "Date", value: "today" },
                                        ],
                                    },
                                },
                            ],
                            snippet: "snip",
                        },
                    }),
                    modify: async () => ({}),
                    trash: async () => ({}),
                },
                labels: { list: async () => ({}) },
                drafts: { create: async () => ({}) },
                messages: { send: async () => ({}) },
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("search_threads", { query: "is:unread" });
    const parsed = JSON.parse(text(result));
    assert.equal(parsed.threads.length, 1);
    assert.equal(parsed.threads[0].subject, "Hello");
    assert.equal(parsed.threads[0].from, "a@b.com");
    assert.equal(parsed.threads[0].unread, true);
    assert.equal(parsed.threads[0].snippet, "snip");
});

test("task_create normalizes YYYY-MM-DD due date", async () => {
    let captured;
    const d = deps({
        tasks: {
            tasklists: { list: async () => ({}) },
            tasks: {
                list: async () => ({}),
                insert: async (opts) => {
                    captured = opts;
                    return {
                        data: {
                            id: "t1",
                            title: opts.requestBody.title,
                            due: opts.requestBody.due,
                        },
                    };
                },
                get: async () => ({}),
                update: async () => ({}),
                delete: async () => ({}),
                move: async () => ({}),
                clear: async () => ({}),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("task_create", { title: "Do thing", due: "2026-08-18" });
    assert.equal(captured.requestBody.due, "2026-08-18T00:00:00.000Z");
    assert.equal(captured.tasklist, "@default");
    const parsed = JSON.parse(text(result));
    assert.equal(parsed.id, "t1");
});

test("task_create passes through full RFC 3339 due", async () => {
    let captured;
    const d = deps({
        tasks: {
            tasklists: { list: async () => ({}) },
            tasks: {
                list: async () => ({}),
                insert: async (opts) => {
                    captured = opts;
                    return { data: { id: "t", title: "x", due: opts.requestBody.due } };
                },
                get: async () => ({}),
                update: async () => ({}),
                delete: async () => ({}),
                move: async () => ({}),
                clear: async () => ({}),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    await exec("task_create", { title: "x", due: "2026-08-18T14:30:00.000Z" });
    assert.equal(captured.requestBody.due, "2026-08-18T14:30:00.000Z");
});

test("task_update patches only provided fields", async () => {
    const d = deps({
        tasks: {
            tasklists: { list: async () => ({}) },
            tasks: {
                list: async () => ({}),
                insert: async () => ({}),
                get: async () => ({ data: { id: "t1", title: "old", status: "needsAction" } }),
                update: async (opts) => ({ data: opts.requestBody }),
                delete: async () => ({}),
                move: async () => ({}),
                clear: async () => ({}),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("task_update", { task: "t1", status: "completed" });
    const parsed = JSON.parse(text(result));
    assert.equal(parsed.status, "completed");
    assert.equal(parsed.title, "old");
});

test("cal_create_event uses date for all-day and dateTime for timed", async () => {
    const captured = [];
    const d = deps({
        calendar: {
            events: {
                list: async () => ({}),
                insert: async (opts) => {
                    captured.push(opts.requestBody);
                    return { data: { id: "e1", htmlLink: "http://x" } };
                },
                get: async () => ({}),
                update: async () => ({}),
                delete: async () => ({}),
            },
            calendarList: { list: async () => ({}) },
        },
    });
    const exec = createExecuteToolCall(d);
    await exec("cal_create_event", {
        summary: "All day",
        start: "2026-08-18",
        end: "2026-08-19",
    });
    await exec("cal_create_event", {
        summary: "Timed",
        start: "2026-08-18T09:00:00",
        end: "2026-08-18T10:00:00",
    });
    assert.deepEqual(captured[0].start, { date: "2026-08-18" });
    assert.deepEqual(captured[1].start, {
        dateTime: "2026-08-18T09:00:00",
        timeZone: undefined,
    });
});

test("drive_search filters out trashed files", async () => {
    const d = deps({
        drive: {
            files: {
                list: async () => ({
                    data: {
                        files: [
                            { id: "a", trashed: false },
                            { id: "b", trashed: true },
                        ],
                    },
                }),
                get: async () => ({}),
                export: async () => ({}),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("drive_search", { query: "" });
    const parsed = JSON.parse(text(result));
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].id, "a");
});

test("drive_download truncates content over 100k chars", async () => {
    const big = "x".repeat(100_010);
    const d = deps({
        drive: {
            files: {
                list: async () => ({}),
                get: async () => ({ data: big }),
                export: async () => ({ data: "" }),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("drive_download", { fileId: "f1" });
    assert.match(text(result), /\[truncated — 10 chars omitted\]/);
});

test("drive_download exports when mimeType provided", async () => {
    let exportCalled = false;
    const d = deps({
        drive: {
            files: {
                list: async () => ({}),
                get: async () => ({ data: "native" }),
                export: async () => {
                    exportCalled = true;
                    return { data: "exported" };
                },
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("drive_download", { fileId: "f1", mimeType: "text/plain" });
    assert.equal(exportCalled, true);
    assert.equal(text(result), "exported");
});

test("task_list filters by status", async () => {
    const d = deps({
        tasks: {
            tasklists: { list: async () => ({}) },
            tasks: {
                list: async () => ({
                    data: {
                        items: [
                            { id: "a", status: "needsAction" },
                            { id: "b", status: "completed" },
                        ],
                    },
                }),
                insert: async () => ({}),
                get: async () => ({}),
                update: async () => ({}),
                delete: async () => ({}),
                move: async () => ({}),
                clear: async () => ({}),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("task_list", { status: "completed" });
    const parsed = JSON.parse(text(result));
    assert.equal(parsed.tasks.length, 1);
    assert.equal(parsed.tasks[0].id, "b");
});

test("unknown tool throws", async () => {
    const exec = createExecuteToolCall(deps());
    await assert.rejects(() => exec("nope", {}), /Unknown tool: nope/);
});

test("task_move forwards parent and previous", async () => {
    let captured;
    const d = deps({
        tasks: {
            tasklists: { list: async () => ({}) },
            tasks: {
                list: async () => ({}),
                insert: async () => ({}),
                get: async () => ({}),
                update: async () => ({}),
                delete: async () => ({}),
                move: async (opts) => {
                    captured = opts;
                    return { data: { id: "t1", position: "3" } };
                },
                clear: async () => ({}),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    await exec("task_move", { task: "t1", parent: "p1", previous: "p2" });
    assert.equal(captured.parent, "p1");
    assert.equal(captured.previous, "p2");
});

function gmailMock(overrides = {}) {
    const captured = { modify: [], trash: [], drafts: [], send: [] };
    const mock = {
        users: {
            threads: {
                list: async () => ({ data: { threads: [] } }),
                get: async () => ({ data: {} }),
                modify: async (opts) => {
                    captured.modify.push(opts);
                    return { data: {} };
                },
                trash: async (opts) => {
                    captured.trash.push(opts);
                    return { data: {} };
                },
            },
            labels: { list: async () => ({ data: { labels: [] } }) },
            drafts: {
                create: async (opts) => {
                    captured.drafts.push(opts);
                    return { data: { id: "d1" } };
                },
            },
            messages: {
                send: async (opts) => {
                    captured.send.push(opts);
                    return { data: { id: "m1" } };
                },
            },
        },
    };
    Object.assign(mock.users, overrides.users || {});
    return { mock, captured };
}

test("mark_read / mark_unread / archive_thread modify labels", async () => {
    const { mock, captured } = gmailMock();
    const exec = createExecuteToolCall(deps({ gmail: mock }));
    await exec("mark_read", { threadId: "t" });
    await exec("mark_unread", { threadId: "t" });
    await exec("archive_thread", { threadId: "t" });
    assert.deepEqual(captured.modify[0].requestBody, { removeLabelIds: ["UNREAD"] });
    assert.deepEqual(captured.modify[1].requestBody, { addLabelIds: ["UNREAD"] });
    assert.deepEqual(captured.modify[2].requestBody, { removeLabelIds: ["INBOX"] });
});

test("trash_thread calls trash", async () => {
    const { mock, captured } = gmailMock();
    const exec = createExecuteToolCall(deps({ gmail: mock }));
    await exec("trash_thread", { threadId: "t" });
    assert.equal(captured.trash[0].id, "t");
});

test("label_thread forwards add/remove label ids", async () => {
    const { mock, captured } = gmailMock();
    const exec = createExecuteToolCall(deps({ gmail: mock }));
    await exec("label_thread", { threadId: "t", addLabelIds: ["L1"], removeLabelIds: ["L2"] });
    assert.deepEqual(captured.modify[0].requestBody, {
        addLabelIds: ["L1"],
        removeLabelIds: ["L2"],
    });
});

test("list_labels maps id/name/type", async () => {
    const { mock } = gmailMock({
        users: {
            labels: {
                list: async () => ({
                    data: { labels: [{ id: "L1", name: "Label", type: "user" }] },
                }),
            },
        },
    });
    const exec = createExecuteToolCall(deps({ gmail: mock }));
    const result = await exec("list_labels", {});
    assert.deepEqual(JSON.parse(text(result)), [{ id: "L1", name: "Label", type: "user" }]);
});

test("get_thread extracts content and headers", async () => {
    const body = Buffer.from("hello body").toString("base64");
    const { mock } = gmailMock({
        users: {
            threads: {
                get: async () => ({
                    data: {
                        id: "t1",
                        messages: [
                            {
                                id: "m1",
                                labelIds: ["INBOX"],
                                snippet: "s",
                                payload: {
                                    headers: [
                                        { name: "From", value: "f@x.com" },
                                        { name: "Subject", value: "Subj" },
                                    ],
                                    body: { data: body },
                                    mimeType: "text/plain",
                                },
                            },
                        ],
                    },
                }),
            },
        },
    });
    const exec = createExecuteToolCall(deps({ gmail: mock }));
    const result = await exec("get_thread", { threadId: "t1" });
    const parsed = JSON.parse(text(result));
    assert.equal(parsed.messages[0].body, "hello body");
    assert.equal(parsed.messages[0].from, "f@x.com");
});

test("send_email builds a raw message", async () => {
    const { mock, captured } = gmailMock();
    const exec = createExecuteToolCall(deps({ gmail: mock }));
    await exec("send_email", { to: ["a@b.com"], subject: "Hi", body: "body" });
    assert.ok(captured.send[0].requestBody.raw);
    const decoded = Buffer.from(captured.send[0].requestBody.raw, "base64").toString("utf8");
    assert.match(decoded, /Subject: Hi/);
});

test("create_draft calls drafts.create", async () => {
    const { mock, captured } = gmailMock();
    const exec = createExecuteToolCall(deps({ gmail: mock }));
    await exec("create_draft", { to: ["a@b.com"], subject: "Hi", body: "body" });
    assert.ok(captured.drafts[0].requestBody.message.raw);
});

test("drive_get_file returns file metadata", async () => {
    const d = deps({
        drive: {
            files: {
                list: async () => ({}),
                get: async () => ({ data: { id: "f1", name: "x" } }),
                export: async () => ({}),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("drive_get_file", { fileId: "f1" });
    assert.equal(JSON.parse(text(result)).id, "f1");
});

test("cal_list_events returns items and token", async () => {
    const d = deps({
        calendar: {
            events: {
                list: async () => ({
                    data: { items: [{ id: "e1" }], nextPageToken: "tok" },
                }),
                insert: async () => ({}),
                get: async () => ({}),
                update: async () => ({}),
                delete: async () => ({}),
            },
            calendarList: { list: async () => ({}) },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("cal_list_events", { startTime: "x", endTime: "y" });
    const parsed = JSON.parse(text(result));
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.nextPageToken, "tok");
});

test("cal_update_event merges fields onto existing event", async () => {
    let updated;
    const d = deps({
        calendar: {
            events: {
                list: async () => ({}),
                insert: async () => ({}),
                get: async () => ({
                    data: { id: "e1", summary: "old", start: { date: "2026-08-18" } },
                }),
                update: async (opts) => {
                    updated = opts.requestBody;
                    return { data: { id: "e1", updated: "now" } };
                },
                delete: async () => ({}),
            },
            calendarList: { list: async () => ({}) },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("cal_update_event", { eventId: "e1", summary: "new" });
    assert.equal(updated.summary, "new");
    assert.deepEqual(updated.start, { date: "2026-08-18" });
    const parsed = JSON.parse(text(result));
    assert.equal(parsed.id, "e1");
});

test("cal_update_event converts timed start to dateTime field", async () => {
    let updated;
    const d = deps({
        calendar: {
            events: {
                list: async () => ({}),
                insert: async () => ({}),
                get: async () => ({ data: { id: "e1", summary: "old" } }),
                update: async (opts) => {
                    updated = opts.requestBody;
                    return { data: { id: "e1" } };
                },
                delete: async () => ({}),
            },
            calendarList: { list: async () => ({}) },
        },
    });
    const exec = createExecuteToolCall(d);
    await exec("cal_update_event", {
        eventId: "e1",
        start: "2026-08-18T09:00:00",
        timeZone: "Asia/Ho_Chi_Minh",
    });
    assert.deepEqual(updated.start, {
        dateTime: "2026-08-18T09:00:00",
        timeZone: "Asia/Ho_Chi_Minh",
    });
});

test("cal_delete_event and task_delete call delete", async () => {
    let calDeleted = null;
    let taskDeleted = null;
    const d = deps({
        calendar: {
            events: {
                list: async () => ({}),
                insert: async () => ({}),
                get: async () => ({}),
                update: async () => ({}),
                delete: async (opts) => {
                    calDeleted = opts;
                    return { data: {} };
                },
            },
            calendarList: { list: async () => ({}) },
        },
        tasks: {
            tasklists: { list: async () => ({}) },
            tasks: {
                list: async () => ({}),
                insert: async () => ({}),
                get: async () => ({}),
                update: async () => ({}),
                delete: async (opts) => {
                    taskDeleted = opts;
                    return { data: {} };
                },
                move: async () => ({}),
                clear: async () => ({}),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    await exec("cal_delete_event", { eventId: "e1" });
    await exec("task_delete", { task: "t1" });
    assert.equal(calDeleted.eventId, "e1");
    assert.equal(taskDeleted.task, "t1");
});

test("cal_list_calendars maps fields", async () => {
    const d = deps({
        calendar: {
            events: {
                list: async () => ({}),
                insert: async () => ({}),
                get: async () => ({}),
                update: async () => ({}),
                delete: async () => ({}),
            },
            calendarList: {
                list: async () => ({
                    data: {
                        items: [{ id: "c1", summary: "Cal", primary: true }],
                    },
                }),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("cal_list_calendars", {});
    const parsed = JSON.parse(text(result));
    assert.equal(parsed[0].id, "c1");
    assert.equal(parsed[0].primary, true);
});

test("task_list_lists maps id/title", async () => {
    const d = deps({
        tasks: {
            tasklists: {
                list: async () => ({
                    data: { items: [{ id: "l1", title: "My List" }] },
                }),
            },
            tasks: {
                list: async () => ({}),
                insert: async () => ({}),
                get: async () => ({}),
                update: async () => ({}),
                delete: async () => ({}),
                move: async () => ({}),
                clear: async () => ({}),
            },
        },
    });
    const exec = createExecuteToolCall(d);
    const result = await exec("task_list_lists", {});
    assert.deepEqual(JSON.parse(text(result)), [{ id: "l1", title: "My List" }]);
});

test("task_clear calls clear", async () => {
    let cleared = null;
    const d = deps({
        tasks: {
            tasklists: { list: async () => ({}) },
            tasks: {
                list: async () => ({}),
                insert: async () => ({}),
                get: async () => ({}),
                update: async () => ({}),
                delete: async () => ({}),
                move: async () => ({}),
                clear: async (opts) => {
                    cleared = opts;
                    return { data: {} };
                },
            },
        },
    });
    const exec = createExecuteToolCall(d);
    await exec("task_clear", { tasklist: "@default" });
    assert.equal(cleared.tasklist, "@default");
});

test("reauth invokes authenticate with timeout", async () => {
    let called = null;
    const d = deps({
        authenticate: async (opts) => {
            called = opts;
        },
        credentialsPath: "/tmp/creds.json",
    });
    const exec = createExecuteToolCall(d);
    await exec("reauth", {});
    assert.equal(called.timeoutMs, 5 * 60 * 1000);
});

