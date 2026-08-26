# yt-gmail-mcp

MCP server for **Gmail**, **Google Drive**, **Google Calendar**, and **Google Tasks** — search, read, send, and manage threads, files, events, and to-dos.

[![npm](https://img.shields.io/npm/v/yt-gmail-mcp)](https://www.npmjs.com/package/yt-gmail-mcp)

Implements the [Model Context Protocol](https://modelcontextprotocol.io) specification: it runs over the stdio transport, speaks JSON-RPC 2.0, negotiates the protocol version on `initialize`, advertises `tools` capabilities, and describes each tool with a JSON Schema. Protocol version negotiation is handled by the `@modelcontextprotocol/sdk` `Server` class, which defaults to the latest supported version.

## Tools

### Gmail

| Tool | Description |
|------|-------------|
| `search_threads` | Search inbox with Gmail query syntax |
| `get_thread` | Fetch a thread by ID with full message bodies |
| `mark_read` | Remove UNREAD label |
| `mark_unread` | Add UNREAD label |
| `archive_thread` | Remove INBOX label |
| `trash_thread` | Move to Trash (recoverable 30 days) |
| `label_thread` | Add or remove labels |
| `list_labels` | List all labels (system + user) |
| `create_draft` | Create a draft email or reply |
| `send_email` | Send an email immediately |
| `reauth` | Re-run OAuth flow to refresh credentials |
| `auth_status` | Report auth health (authenticated, email, expiry, scopes) — preflight before batching |

### Google Drive

| Tool | Description |
|------|-------------|
| `drive_search` | Search files with Drive query syntax |
| `drive_get_file` | Get file metadata by ID |
| `drive_download` | Download/export file content as text |

### Google Calendar

| Tool | Description |
|------|-------------|
| `cal_list_events` | List events in a time range |
| `cal_create_event` | Create an event (all-day or timed) |
| `cal_update_event` | Update an existing event |
| `cal_delete_event` | Delete an event |
| `cal_list_calendars` | List all accessible calendars |

### Google Tasks

| Tool | Description |
|------|-------------|
| `task_list_lists` | List all task lists |
| `task_list` | List tasks in a list (`@default` by default) |
| `task_create` | Create a task (title, notes, due date) |
| `task_update` | Update title/notes/due/status (also marks complete) |
| `task_delete` | Delete a task |
| `task_move` | Reorder/move a task (parent/previous) |
| `task_clear` | Clear completed tasks in a list |

## Setup

### 1. Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or use an existing one)
3. Enable the APIs you need:
   - **Gmail API**
   - **Google Drive API** (if using Drive tools)
   - **Google Calendar API** (if using Calendar tools)
   - **Google Tasks API** (if using Tasks tools)
4. Create an **OAuth 2.0 Client ID** of type **Desktop application**
5. Add `http://localhost:3000/oauth2callback` as an authorized redirect URI
6. Download the client configuration JSON

### 2. Place the credentials

Save the downloaded JSON as `~/.gmail-mcp/gcp-oauth.keys.json`:

```bash
mkdir -p ~/.gmail-mcp
mv ~/Downloads/client_secret_*.json ~/.gmail-mcp/gcp-oauth.keys.json
```

### 3. Authenticate

```bash
npx yt-gmail-mcp auth
```

This opens a browser where you sign in with your Google account. On success, tokens are saved to `~/.gmail-mcp/credentials.json`.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `GMAIL_MCP_CONFIG_DIR` | `~/.gmail-mcp` | Directory for OAuth keys and tokens |
| `GMAIL_OAUTH_KEYS_PATH` | `$CONFIG_DIR/gcp-oauth.keys.json` | Path to OAuth client JSON |
| `GMAIL_CREDENTIALS_PATH` | `$CONFIG_DIR/credentials.json` | Path to saved tokens |
| `GMAIL_MCP_OAUTH_PORT` | `3000` | Starting port for the OAuth callback server (falls back to the next free port if taken) |

### Custom port

If port 3000 is occupied:

```bash
GMAIL_MCP_OAUTH_PORT=3001 npx yt-gmail-mcp auth
```

Make sure your GCP OAuth client's redirect URI matches.

## MCP host config

### opencode

```jsonc
{
  "mcp": {
    "gmail": {
      "type": "local",
      "command": ["npx", "yt-gmail-mcp"]
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["yt-gmail-mcp"]
    }
  }
}
```

## Troubleshooting

### Tools disappear mid-session

If the MCP host starts while OAuth tokens are expired, the server fails to initialize and doesn't register tools. Fix:

1. Run `npx yt-gmail-mcp auth` to refresh credentials
2. Restart the MCP host

### `EADDRINUSE` during re-auth

The OAuth callback listener starts on port 3000 (or your `GMAIL_MCP_OAUTH_PORT`) and now automatically retries on the next free port if it's taken, so this should rarely surface. If it still fails, every port in range is in use — kill a conflicting process, or set `GMAIL_MCP_OAUTH_PORT` to a specific free port.

### Batching tools triggers multiple re-auth flows

Concurrent auth-requiring calls (e.g. Gmail + Calendar + Tasks) now share a single re-auth flow: the first failure opens the browser and the others wait and retry once it completes. To avoid orphaning a browser tab, call `auth_status` first to preflight credential health before batching.

### `invalid_grant` / expired tokens

OAuth refresh tokens for unverified Testing-mode apps expire after 7 days. Run `npx yt-gmail-mcp auth` to re-authenticate. For production, publish your OAuth app through Google's verification process.

### Re-auth succeeds but Tasks calls fail

If re-auth completed but Tasks tools still error, the Tasks API itself may be disabled in the GCP project. Enable it at:

https://console.developers.google.com/apis/api/tasks.googleapis.com/overview?project=496352139179

It can take a minute to propagate — retry after enabling.

## License

MIT
