# Quickstart: Analytics & Response Data Collection

## Prerequisites

- Node.js 18+ and npm
- A Google account (for Google Apps Script + Sheets)
- GoatCounter account already set up at context-lab.goatcounter.com

## Step 1: Add GoatCounter Analytics Snippet

Add the following to `index.html` before `</body>`:

```html
<script data-goatcounter="https://context-lab.goatcounter.com/count"
        async src="//gc.zgo.at/count.js"></script>
```

Verify at https://context-lab.goatcounter.com/ after a page visit.

## Step 2: Create Google Apps Script Endpoint

1. Go to https://script.google.com/ → New project
2. Replace `Code.gs` with:

```javascript
function doPost(e) {
  var sheet = SpreadsheetApp.openById('SHEET_ID').getActiveSheet();
  var data = JSON.parse(e.postData.contents);
  sheet.appendRow([
    new Date(),
    data.session_id,
    data.token,
    data.response_count,
    data.domain
  ]);
  return ContentService.createTextOutput('ok');
}
```

3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone
4. Copy the deployment URL

## Step 3: Configure Collection in Mapper

Set the endpoint URL in the collection module config (e.g., `src/collection/collector.js`):

```javascript
const CONFIG = {
  ENABLED: true,
  ENDPOINT_URL: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec',
  INTERVAL: 10,  // send every N responses
};
```

## Step 4: Test Locally

1. `npm run dev` — start local dev server
2. Answer 10 questions
3. Check browser console for `[collector] Sent token` log
4. Check Google Sheet for new row

## Step 5: Run Tests

```bash
npm test        # unit tests
npm run lint    # linting
```

## Step 6: Get Sign-Off

**CRITICAL**: Do NOT push to main or merge without explicit project owner approval. The live site is under active reporter review.
