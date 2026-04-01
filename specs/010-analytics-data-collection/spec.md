# Feature Specification: Analytics & Response Data Collection

**Feature Branch**: `010-analytics-data-collection`
**Created**: 2026-03-20
**Status**: Draft
**Input**: User description: "Explore visitor analytics tracking and response data collection via Google Apps Scripts. CRITICAL: demo is LIVE and under reporter review — no changes to main until tested and signed off."

## Deployment Safety *(mandatory constraint)*

The live demo at context-lab.com/mapper/ is actively being reviewed by reporters. All changes:

1. MUST be developed and tested on a feature branch — never pushed directly to main
2. MUST be verified locally with full regression testing before any merge
3. MUST receive explicit sign-off from the project owner before merging or deploying
4. MUST NOT alter existing functionality, performance, or user experience

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Visitor Analytics Dashboard (Priority: P1)

A researcher wants to understand how many people are visiting the Knowledge Mapper demo, where they're coming from, and what devices/browsers they use — without paying for analytics services and without adding tracking code that could affect site performance or user privacy.

**Why this priority**: Understanding visitor volume and demographics is the most immediately useful data for gauging interest from reporters and the public. It requires zero code changes to the live site.

**Independent Test**: Can be fully verified by checking that analytics data appears in the dashboard after visiting the live site, with no code deployed to the mapper itself.

**Acceptance Scenarios**:

1. **Given** the analytics service is configured, **When** a user visits the Knowledge Mapper, **Then** the visit is recorded with timestamp, approximate location, browser, device type, and referrer
2. **Given** multiple visits from the same browser, **When** viewing analytics, **Then** unique vs. repeat visitors are distinguishable
3. **Given** a reporter shares the link on social media, **When** visitors arrive via that link, **Then** the referrer source is captured

---

### User Story 2 — Automatic Response Collection (Priority: P1)

A researcher wants to collect anonymized response data from users who answer quiz questions, so they can study knowledge patterns across the population. After every N responses (configurable), the system encodes the current responses as a shareable token and sends it to a Google Sheet via Google Apps Script, without interrupting the user's experience.

**Why this priority**: This is the core research data collection mechanism. The existing token encoding system already compresses responses efficiently — reusing it minimizes new code and keeps payloads small.

**Independent Test**: Can be tested locally by answering questions and verifying that tokens appear in a test Google Sheet at the configured interval.

**Acceptance Scenarios**:

1. **Given** a user has answered N questions (where N is the configured interval), **When** the Nth answer is submitted, **Then** the system silently encodes a token from current responses and sends it to the collection endpoint
2. **Given** the user continues answering, **When** they reach 2N responses, **Then** a second token is sent (capturing cumulative progress)
3. **Given** the collection endpoint is unreachable, **When** a send fails, **Then** the failure is silently logged to the console and the user's experience is unaffected
4. **Given** a user in shared view mode (viewing someone else's token), **When** they browse the shared map, **Then** no response data is collected from them

---

### User Story 3 — Tutorial Consent Step (Priority: P2)

When a user completes the tutorial, they see a final "Contribute to science!" modal that transparently explains data collection and lets them choose to opt in or out before the tutorial closes.

**Why this priority**: Proactive transparency builds trust — especially important given reporter scrutiny. Presenting the choice during onboarding ensures informed consent without being disruptive.

**Independent Test**: Can be tested by running through the tutorial and verifying the consent modal appears as the final step, and that the user's choice correctly sets the collection toggle.

**Acceptance Scenarios**:

1. **Given** a user is taking the tutorial, **When** they reach the final step, **Then** a "Contribute to science!" modal appears with explanatory text and two buttons
2. **Given** the consent modal is displayed, **When** the user clicks "I'd like to help!", **Then** data collection is enabled and the tutorial closes
3. **Given** the consent modal is displayed, **When** the user clicks "No thanks", **Then** data collection is disabled and the tutorial closes
4. **Given** the user skipped the tutorial, **When** they use the app, **Then** collection defaults to ON (the About modal toggle serves as the fallback opt-out)

---

### User Story 4 — Opt-Out Toggle in About Modal (Priority: P2)

A user who wants to change their data collection preference at any time can do so via a toggle in the About modal. The system respects this preference across sessions.

**Why this priority**: Provides ongoing control after the tutorial, and serves as the sole opt-out mechanism for users who skipped the tutorial.

**Independent Test**: Can be tested by toggling the setting in the About modal and verifying no data is sent on subsequent responses.

**Acceptance Scenarios**:

1. **Given** a user opens the About modal, **When** they see the data collection section, **Then** a toggle switch and disclosure text are visible
2. **Given** a user disables collection via the toggle, **When** they answer questions, **Then** no tokens are sent to the collection endpoint
3. **Given** a user has opted out, **When** they return in a new session, **Then** the opt-out preference is remembered
4. **Given** a user re-enables collection, **When** they answer the next batch of N questions, **Then** collection resumes normally

---

### User Story 5 — Response Data Decoding (Priority: P3)

A researcher wants to decode the collected tokens in the Google Sheet back into structured response data for analysis.

**Why this priority**: Without decoding, the tokens are opaque. But collection must work first, and decoding can be done offline with a separate script.

**Independent Test**: Can be tested by taking a token from the Google Sheet and running the decoder to verify it produces the expected question-by-question results.

**Acceptance Scenarios**:

1. **Given** a token in the Google Sheet, **When** the researcher runs the decoder, **Then** each response is expanded to show question text, selected answer, correct answer, and correctness
2. **Given** a batch of tokens, **When** decoded, **Then** the output can be exported as CSV for further analysis

---

### Edge Cases

- What happens when the user answers fewer than N questions and leaves the site? Partial sessions below the threshold are not collected (acceptable data loss for simplicity).
- What happens if the Google Apps Script quota is exceeded? Sends fail silently; the user experience is unaffected. Data is lost for that interval.
- What happens if two tabs are open simultaneously? Each tab tracks its own response count independently.
- What happens on the very first visit before any analytics service is configured? Nothing — analytics is a separate, external service with no code in the mapper.

## Requirements *(mandatory)*

### Functional Requirements

**Analytics (external — no mapper code changes)**:

- **FR-001**: The project MUST use a free, privacy-respecting analytics service that requires no code changes to the mapper site (e.g., Cloudflare Web Analytics via CDN proxy, or a lightweight script tag)
- **FR-002**: Analytics MUST track: page views, unique visitors, referrer sources, browser/device type, and approximate geographic location
- **FR-003**: Analytics MUST NOT use cookies or invasive client-side tracking that would require a consent banner. GoatCounter (free tier) has been selected; the snippet will be added to index.html. Dashboard: https://context-lab.goatcounter.com/

**Response Collection (requires mapper code changes — feature-flagged)**:

- **FR-004**: System MUST encode current responses as a token (reusing the existing token codec) after every N responses, where N is configurable
- **FR-005**: System MUST send the encoded token to a Google Apps Script web app endpoint via a background request
- **FR-006**: The Google Apps Script MUST append each received token as a new row in a Google Sheet, along with a timestamp and a session identifier (random, non-identifying)
- **FR-007**: System MUST fail silently on network errors — no user-visible errors, no retries, no impact on quiz flow
- **FR-008**: System MUST NOT collect data when in shared view mode (URL has `?t=` parameter)
- **FR-009**: System MUST collect responses by default and provide a user-facing opt-out toggle that persists across sessions
- **FR-010**: System MUST NOT send any personally identifiable information — tokens contain only question indices and answer correctness
- **FR-011**: All response collection code MUST be feature-flagged so it can be disabled without a code change
- **FR-014**: The About modal MUST disclose that anonymized responses (answers only) are collected to help improve the system, and MUST include an opt-out toggle switch (collection is on by default)
- **FR-015**: The tutorial (if the user elects to take it) MUST include a final step before closing — a modal titled "Contribute to science!" with the text: "This demo is just the beginning! We are working towards new tools for democratizing education and helping *all* people achieve their learning goals and dreams. Would you consider sharing your (anonymized) quiz responses with us to help us improve our system? You can change your mind at any time by clicking the [info icon] about button and toggling the switch." The info icon MUST match the existing About button icon and be vertically aligned with the surrounding text. Two buttons MUST be presented: "I'd like to help!" (enables collection) and "No thanks" (disables collection). The user's choice MUST update the opt-out toggle state accordingly

**Decoding (offline tooling)**:

- **FR-012**: A standalone script MUST be provided to decode tokens from the Google Sheet into structured response data
- **FR-013**: The decoder MUST output results in a format suitable for data analysis (CSV or JSON)

### Key Entities

- **Visit**: A page view event captured by the analytics service — timestamp, IP-derived location, browser, device, referrer
- **Response Token**: A compressed binary encoding of a user's quiz responses (question index + answer correctness), base64url-encoded — already defined by the existing token codec
- **Collection Record**: A row in the Google Sheet — timestamp, session ID, response token, domain name
- **Session ID**: A random identifier generated per browser session (not tied to any user identity), used only to group tokens from the same session

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Within 24 hours of enabling analytics, the research team can see visitor counts, referrer sources, and geographic distribution
- **SC-002**: Response tokens are collected for at least 80% of sessions where users answer N or more questions (accounting for network failures and opt-outs)
- **SC-003**: Collected tokens can be decoded back into structured response data with 100% fidelity (no data loss in encoding/decoding round-trip)
- **SC-004**: The response collection mechanism adds no perceptible delay to the quiz answering flow
- **SC-005**: Zero regressions in existing functionality — all current tests continue to pass
- **SC-006**: No user-visible changes to the app unless the user opens the About modal (where the opt-out toggle and data collection disclosure live)
- **SC-007**: The live site is never affected by development work until explicit sign-off is given

## Clarifications

### Session 2026-03-21

- Q: Should data collection be on by default (opt-out) or off by default (opt-in)? → A: Opt-out — collection is ON by default, users can disable it
- Q: Where should the opt-out toggle be placed in the UI? → A: Inside the existing About modal, with disclosure text explaining that anonymized responses (answers only) are collected to help improve the system. Additionally, the tutorial adds a final "Contribute to science!" step that transparently asks users to opt in/out before closing
- Q: Which analytics service? → A: GoatCounter free tier (context-lab.goatcounter.com), snippet provided by user

## Assumptions

- The site is served directly from GitHub Pages (not via Cloudflare). GoatCounter (context-lab.goatcounter.com) has been set up for cookie-free analytics.
- Google Apps Script web apps have a quota of ~20,000 requests/day on the free tier, which is sufficient for early-stage data collection.
- The existing `encodeToken()` function from the token codec can be reused directly for response collection.
- N (the collection interval) defaults to 10 responses but is configurable.
- The opt-out preference is stored in localStorage alongside other user preferences.
