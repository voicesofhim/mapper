# Tasks: Analytics & Response Data Collection

**Input**: Design documents from `/specs/010-analytics-data-collection/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Create collection module structure and shared infrastructure

- [X] T001 Create `src/collection/` directory and `src/collection/collector.js` module scaffold with CONFIG object (ENABLED, ENDPOINT_URL, INTERVAL) and exports
- [X] T002 [P] Add `mapper:collectResponses` localStorage key handling — helper functions `isCollectionEnabled()` and `setCollectionEnabled(value)` in `src/collection/collector.js`
- [X] T003 [P] Generate session ID (8-char hex via `crypto.randomUUID().slice(0,8)`) in `src/collection/collector.js` — created once per page load, not persisted

**Checkpoint**: Collection module exists with config, preference helpers, and session ID generation

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Google Apps Script endpoint must exist before any collection can be tested

**⚠️ CRITICAL**: US2 (response collection) cannot be tested without a working GAS endpoint

- [X] T004 Create Google Apps Script project with `doPost(e)` handler per `specs/010-analytics-data-collection/contracts/gas-endpoint.md` — deploy as web app (Execute as: Me, Anyone can access)
- [X] T005 Create target Google Sheet with columns: Timestamp, Session ID, Token, Response Count, Domain
- [X] T006 Test GAS endpoint manually with a `curl` POST to verify rows appear in the sheet

**Checkpoint**: GAS endpoint is live and accepting POST requests — verified with manual test

---

## Phase 3: User Story 1 — Visitor Analytics (Priority: P1) 🎯 MVP

**Goal**: Add GoatCounter analytics snippet so researcher can see visitor traffic

**Independent Test**: Visit the local dev server, then check context-lab.goatcounter.com for the visit (only works after deploy — local test verifies snippet is present in HTML)

- [X] T007 [US1] Add GoatCounter snippet to `index.html` before `</body>`: `<script data-goatcounter="https://context-lab.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>`
- [X] T008 [US1] Verify snippet loads without errors on local dev server (check browser console and network tab)

**Checkpoint**: GoatCounter snippet is in index.html and loads cleanly. Analytics will be live after deploy.

---

## Phase 4: User Story 2 — Automatic Response Collection (Priority: P1)

**Goal**: After every N responses, silently encode a token and POST it to the GAS endpoint

**Independent Test**: Answer 10 questions locally, verify a row appears in the test Google Sheet with correct token

### Implementation for User Story 2

- [X] T009 [US2] Implement `sendToken(token, responseCount, domain, sessionId)` in `src/collection/collector.js` — `fetch()` POST to ENDPOINT_URL with `mode: 'no-cors'`, catch errors silently with `console.warn('[collector]', err)`
- [X] T010 [US2] Implement `maybeCollect(responses, questionIndex, activeDomain)` in `src/collection/collector.js` — checks: ENABLED, not shared view (`?t=` absent), collection preference enabled, `responses.length % INTERVAL === 0 && responses.length > 0`. If all pass, calls `encodeToken()` and `sendToken()`
- [X] T011 [US2] Wire `maybeCollect()` into `src/app.js` — call from `handleAnswer()` after response is added to `$responses`, passing `$responses.get()`, `questionIndex`, and `$activeDomain.get()`
- [X] T012 [US2] Add shared-view guard in `maybeCollect()` — check `new URLSearchParams(window.location.search).has('t')` and skip if true
- [X] T013 [US2] Test end-to-end: start local dev server, answer 10 questions (N=10), verify row in Google Sheet with valid token, session_id, response_count=10, and domain

**Checkpoint**: Answering 10 questions causes a token row to appear in the Google Sheet. Shared view does not trigger collection.

---

## Phase 5: User Story 3 — Tutorial Consent Step (Priority: P2)

**Goal**: Add a final tutorial step "Contribute to science!" that lets users opt in or out of data collection

**Independent Test**: Run through the tutorial, verify the consent modal appears as the last step before "Tutorial Complete!", and that button clicks correctly set the localStorage preference

### Implementation for User Story 3

- [X] T014 [US3] Add new tutorial step object in `src/ui/tutorial.js` STEPS array — insert before the current completion step (ID 15 becomes consent, current 15 becomes 16). Set `title: 'Contribute to science!'`, custom message with info icon inline, `advanceOn: 'consent-choice'`
- [X] T015 [US3] Update the completion step ID from 15 to 16 and ensure `isCompletion: true` stays on the final step in `src/ui/tutorial.js`
- [X] T016 [US3] Implement consent step rendering in `src/ui/tutorial.js` — when step 15 is active, render two buttons: "I'd like to help!" and "No thanks". Button clicks call `setCollectionEnabled(true/false)` from collector.js and fire the `consent-choice` advance event
- [X] T017 [US3] Style the consent buttons in `src/ui/tutorial.css` — "I'd like to help!" uses primary green (matching landing-start-btn style), "No thanks" uses outline/secondary style
- [X] T018 [US3] Render the inline info icon (`<i class="fa-solid fa-circle-info">`) in the consent message text, vertically aligned with surrounding text via `vertical-align: middle`
- [X] T019 [US3] Visually verify consent step via Playwright screenshot at desktop (1280×800) and landscape mobile (812×375) viewports

**Checkpoint**: Tutorial shows consent modal before completion. "I'd like to help!" enables collection, "No thanks" disables it. Preference persists in localStorage.

---

## Phase 6: User Story 4 — About Modal Opt-Out Toggle (Priority: P2)

**Goal**: Add disclosure text and opt-out toggle switch to the About modal

**Independent Test**: Open About modal, verify disclosure text and toggle are visible. Toggle off, answer questions, verify no collection. Toggle on, answer N more, verify collection resumes.

### Implementation for User Story 4

- [X] T020 [US4] Add "Data Collection" section to About modal in `index.html` — new `<h3>Data Collection</h3>` section before closing `</div>` of `.modal-content`, with disclosure text: "We collect anonymized quiz responses (answers only) to help improve our system. No personal information is stored."
- [X] T021 [US4] Add toggle switch HTML in the About modal data collection section in `index.html` — reuse the same visual pattern as the auto-advance toggle (track + thumb divs with role="switch")
- [X] T022 [US4] Wire toggle switch behavior in `src/app.js` `setupAboutModal()` — read initial state from `isCollectionEnabled()`, toggle calls `setCollectionEnabled()`, update visual state on click
- [X] T023 [US4] Sync toggle state on modal open — when About modal opens, read current `isCollectionEnabled()` and set toggle position (in case it was changed by tutorial consent step)
- [X] T024 [US4] Visually verify About modal toggle via Playwright screenshot

**Checkpoint**: About modal shows disclosure and working toggle. Toggle state syncs with localStorage and affects collection behavior.

---

## Phase 7: User Story 5 — Response Data Decoding (Priority: P3)

**Goal**: Provide an offline script to decode tokens from the Google Sheet into structured data for analysis

**Independent Test**: Export a CSV from the Google Sheet, run the decoder script, verify output contains correct question text and answer data for each token

### Implementation for User Story 5

- [X] T025 [US5] Create `scripts/decode-tokens.js` — Node.js script that reads a CSV/JSON file of tokens, imports `decodeToken` and `buildIndex` from the codec/index modules, and decodes each token
- [X] T026 [US5] Implement output formatting in `scripts/decode-tokens.js` — for each decoded response, output: question_id, question_text (looked up from domain bundles), is_correct, is_skipped. Support `--format csv` and `--format json` flags
- [X] T027 [US5] Add usage documentation as a comment block at the top of `scripts/decode-tokens.js` — example: `node scripts/decode-tokens.js --input tokens.csv --format csv > decoded.csv`
- [X] T028 [US5] Test decoder with the known token `O8LAwTDnP-NPJiap_8xO_1kW_2flZmI1ZmIP-w8A` — verify it produces the expected 100 responses with correct/incorrect flags

**Checkpoint**: Decoder script converts tokens to structured data. Round-trip fidelity is 100%.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Regression testing, feature flag verification, final sign-off preparation

- [X] T029 Run full test suite (`npm test && npm run lint`) and verify zero regressions
- [X] T030 [P] Verify feature flag — set `CONFIG.ENABLED = false` in collector.js, answer N questions, confirm no POST requests are made
- [X] T031 [P] Verify shared view guard — visit a `?t=` URL, answer questions (if possible), confirm no collection
- [X] T032 Test opt-out flow end-to-end: tutorial consent → "No thanks" → answer 10+ questions → verify no rows in sheet → About modal toggle ON → answer 10 more → verify row appears
- [X] T033 Run Playwright E2E tests across chromium, firefox, webkit to verify no visual regressions
- [X] T034 Prepare sign-off summary for project owner: list all changes, affected files, test results, screenshots

**Checkpoint**: All tests pass, feature flags work, opt-out flow verified. Ready for project owner sign-off before merge to main.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Independent of Phase 1 — GAS setup is external
- **US1 Analytics (Phase 3)**: Independent — just a snippet addition, can run in parallel with anything
- **US2 Collection (Phase 4)**: Depends on Phase 1 (collector module) + Phase 2 (GAS endpoint)
- **US3 Tutorial Consent (Phase 5)**: Depends on Phase 1 (collector preference helpers)
- **US4 About Toggle (Phase 6)**: Depends on Phase 1 (collector preference helpers)
- **US5 Decoding (Phase 7)**: Independent — offline script, no runtime dependencies
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (Analytics)**: Fully independent — no dependencies on other stories
- **US2 (Collection)**: Depends on Phase 1 + Phase 2 only — independent of US3/US4/US5
- **US3 (Tutorial Consent)**: Depends on Phase 1 preference helpers — independent of US2/US4/US5
- **US4 (About Toggle)**: Depends on Phase 1 preference helpers — independent of US2/US3/US5
- **US5 (Decoding)**: Fully independent — offline script

### Parallel Opportunities

- **Phase 1**: T002 and T003 can run in parallel (different functions, same file but independent)
- **Phase 2 + Phase 3**: GAS setup (T004-T006) and GoatCounter snippet (T007-T008) can run in parallel
- **Phase 5 + Phase 6**: Tutorial consent and About toggle can be built in parallel (different files)
- **Phase 7**: Decoder script can be built any time — no runtime dependencies

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Complete Phase 1: Setup (collector module scaffold)
2. Complete Phase 2: GAS endpoint (external setup)
3. Complete Phase 3: GoatCounter snippet (trivial)
4. Complete Phase 4: Response collection wiring
5. **STOP and VALIDATE**: Verify analytics dashboard + collection rows in sheet
6. Get sign-off for GoatCounter snippet deployment (low risk, high value)

### Incremental Delivery

1. Setup + GAS endpoint → Foundation ready
2. Add GoatCounter → Analytics live (after deploy)
3. Add response collection → Data flowing to sheet
4. Add tutorial consent + About toggle → Transparency complete
5. Add decoder script → Research-ready data pipeline
6. **Sign-off and merge** — only after project owner approval

---

## Notes

- **CRITICAL**: No push to main or merge without explicit project owner sign-off
- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Commit after each task or logical group
- The GoatCounter snippet (US1) is the lowest-risk change and could be deployed first
- The GAS endpoint setup (Phase 2) is external and doesn't touch the mapper codebase
