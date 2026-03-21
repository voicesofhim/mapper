# Data Model: Analytics & Response Data Collection

## Entities

### Collection Record (Google Sheet row)

| Field | Description |
|-|-|
| timestamp | ISO 8601 datetime when the token was received by the Apps Script |
| session_id | Random 8-char hex string, generated once per browser session (not persisted across sessions) |
| token | Base64url-encoded deflate-compressed binary response token (from existing codec) |
| response_count | Number of responses encoded in the token |
| domain | Active domain ID at time of collection (e.g., "all", "psychology") |

**Identity**: No unique constraint — multiple rows per session are expected (one every N responses).

**Lifecycle**: Append-only. Rows are never updated or deleted by the system.

### Collection Preference (localStorage)

| Key | Type | Default | Description |
|-|-|-|-|
| `mapper:collectResponses` | boolean | `true` | Whether the user consents to response collection |

**Lifecycle**: Set on first tutorial completion (or remains default if tutorial skipped). Toggled via About modal. Persists across sessions.

### Session ID (in-memory)

Generated once per page load via `crypto.randomUUID().slice(0,8)` or equivalent. Not persisted to localStorage — a new session ID is created on each visit. Used only to group collection records from the same browsing session in the Google Sheet.

## Relationships

```
User Session (browser tab)
  └── generates 0..N Collection Records (every N responses)
       └── each contains 1 Response Token (cumulative snapshot)

Collection Preference
  └── gates whether Collection Records are sent
```

## Data Flow

```
User answers question
  → $responses store updated (existing flow)
  → if (responseCount % N === 0) AND (collectResponses === true) AND (not shared view):
      → encodeToken($responses.get(), questionIndex) → token string
      → POST { session_id, token, response_count, domain } to GAS endpoint
      → GAS appends row to Google Sheet with server timestamp
```

## Volume Estimates

- ~100 responses per engaged session → ~10 collection records per session (at N=10)
- Token size: ~340 chars for 100 responses
- POST payload: ~500 bytes per request
- At 1000 daily users: ~10,000 requests/day (within GAS free quota of 20,000)
