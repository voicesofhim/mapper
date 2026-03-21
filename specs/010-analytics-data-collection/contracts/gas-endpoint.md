# Contract: Google Apps Script Collection Endpoint

## Request

**Method**: POST
**URL**: `https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec`
**Mode**: `no-cors` (fire-and-forget — no response body expected)
**Content-Type**: `application/json`

### Body

```json
{
  "session_id": "a1b2c3d4",
  "token": "O8LAwTDnP-NPJiap_8xO_...",
  "response_count": 10,
  "domain": "all"
}
```

| Field | Type | Required | Description |
|-|-|-|-|
| session_id | string | yes | 8-char hex, generated per page load |
| token | string | yes | Base64url-encoded response token from `encodeToken()` |
| response_count | integer | yes | Total responses in the token |
| domain | string | yes | Active domain ID at time of send |

## Response

Not inspected (no-cors mode). The client treats all sends as fire-and-forget.

## Google Apps Script Handler

The `doPost(e)` function:
1. Parses `e.postData.contents` as JSON
2. Appends a row to the configured sheet: `[new Date(), session_id, token, response_count, domain]`
3. Returns `ContentService.createTextOutput('ok')`

## Error Handling

- Network failure: silently caught, logged to console
- Invalid JSON: GAS returns error, client ignores (no-cors)
- Quota exceeded: GAS returns 429, client ignores (no-cors)
