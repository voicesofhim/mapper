# Research: Analytics & Response Data Collection

## Decision 1: Analytics Service

**Decision**: GoatCounter (free tier, context-lab.goatcounter.com)
**Rationale**: Cookie-free, privacy-respecting, no consent banner needed. Free tier covers the project's scale. User already created account and provided the snippet.
**Alternatives considered**:
- Cloudflare Web Analytics — requires Cloudflare proxy (site is direct GitHub Pages)
- Plausible — self-hosted is free but requires server; cloud is paid
- Umami — self-hosted only, requires server
- Google Analytics — uses cookies, requires consent banner, privacy concerns

## Decision 2: Response Collection Transport

**Decision**: Google Apps Script web app endpoint, called via `fetch()` with `no-cors` mode or `navigator.sendBeacon()`
**Rationale**: Free, no server to maintain, data lands directly in Google Sheets for easy research access. The existing token codec produces compact payloads (~300-400 chars for 100 responses) well within URL/body limits.
**Alternatives considered**:
- Custom backend server — operational burden, cost
- Google Forms — limited programmatic submission, no custom fields
- Firebase — overkill for append-only logging
- Direct Sheets API — requires OAuth, complex auth flow from browser

**Implementation notes**:
- Google Apps Script web apps deployed as "Execute as me, Anyone can access" provide a public POST endpoint
- The script receives JSON via `doPost(e)`, parses `e.postData.contents`, and appends to a sheet
- Free quota: ~20,000 requests/day — sufficient for early-stage collection
- CORS: GAS web apps redirect on POST, so use `mode: 'no-cors'` (fire-and-forget, no response body needed)

## Decision 3: Token Reuse Strategy

**Decision**: Reuse `encodeToken()` from `src/sharing/token-codec.js` directly
**Rationale**: The function already encodes responses into a compact binary format (question index + correctness). The `questionIndex` is built from `allDomainBundle.questions` at boot and available via `window.__mapper`. No new encoding logic needed.
**Key details**:
- `encodeToken(responses, questionIndex)` → base64url string
- Input: `$responses.get()` (the reactive store) + `questionIndex` (built at boot)
- Output: ~340 chars for 100 responses (deflate-compressed)
- The `questionIndex.version` field (question count mod 256) enables decoder to detect schema mismatches

## Decision 4: Feature Flag Mechanism

**Decision**: Config object at top of collection module with `ENABLED` boolean and `ENDPOINT_URL` string
**Rationale**: Simple, no build-time env vars needed (Vite doesn't use them currently). Can be toggled by editing one file. If endpoint URL is empty/null, collection is disabled regardless of flag.
**Alternatives considered**:
- Vite env vars (`.env` file) — adds build complexity, secrets in repo
- URL query param — too easy to accidentally enable/disable
- localStorage flag — admin-only, but could be confused with user opt-out

## Decision 5: Opt-Out Persistence

**Decision**: `localStorage` key `mapper:collectResponses` (boolean, default `true`)
**Rationale**: Consistent with existing persistence pattern (`mapper:responses`, `mapper:schema`, `mapper:watchedVideos`). Simple to check before sending.

## Decision 6: Tutorial Integration

**Decision**: Add new tutorial step (ID 15) before current completion step (which becomes ID 16)
**Rationale**: The tutorial STEPS array is ordered by ID. The current final step (ID 15, `isCompletion: true`) becomes ID 16. The new step shows a "Contribute to science!" modal with "I'd like to help!" / "No thanks" buttons. The `advanceOn` trigger fires on either button click, setting the collection preference before advancing.
**Key details**:
- New step inserted at STEPS array position before the completion step
- `isCompletion` stays on the final step (now ID 16)
- The consent step uses `advanceOn: 'consent-choice'` — a new custom event
- Button click handlers set `localStorage.setItem('mapper:collectResponses', ...)` and fire the advance event

## Decision 7: About Modal Disclosure

**Decision**: Add a "Data Collection" section at the bottom of the About modal with disclosure text and a toggle switch
**Rationale**: Matches the existing modal structure (h3 sections). The toggle uses the same visual style as the auto-advance toggle in the quiz panel for consistency.
**Key details**:
- HTML added before `</div>` of `.modal-content` in index.html
- Toggle reads/writes `mapper:collectResponses` in localStorage
- Text: "We collect anonymized quiz responses (answers only) to help improve our system. No personal information is stored."
