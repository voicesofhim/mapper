/** Ask-the-Map UI adapted from the original quiz panel contract. */

import { announce } from '../utils/accessibility.js';

let askCallback = null;
let nextCallback = null;
let currentQuestion = null;
let ui = {};
let sampleQuestions = [];

export function init(container) {
  if (!container) return;

  if (!document.getElementById('ask-map-styles')) {
    const style = document.createElement('style');
    style.id = 'ask-map-styles';
    style.textContent = `
      .quiz-content.ask-map-content {
        display: flex;
        flex-direction: column;
        gap: 0.85rem;
      }
      .ask-map-title {
        font-family: var(--font-heading);
        font-size: 1rem;
        font-weight: 700;
        color: var(--color-text);
      }
      .ask-map-subtitle {
        color: var(--color-text-muted);
        font-size: 0.78rem;
        line-height: 1.45;
      }
      .ask-map-form {
        display: grid;
        gap: 0.5rem;
      }
      .ask-map-input {
        width: 100%;
        min-height: 86px;
        resize: vertical;
        border: 1px solid var(--color-border);
        border-radius: 8px;
        background: rgba(255,255,255,0.04);
        color: var(--color-text);
        padding: 0.75rem;
        font: 0.86rem/1.45 var(--font-body);
      }
      .ask-map-input:focus {
        border-color: var(--color-secondary);
        box-shadow: 0 0 0 3px rgba(138, 205, 255, 0.12);
        outline: none;
      }
      .ask-map-submit,
      .ask-map-chip {
        border: 1px solid var(--color-border);
        border-radius: 8px;
        background: rgba(138, 205, 255, 0.08);
        color: var(--color-text);
        cursor: pointer;
        transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
      }
      .ask-map-submit {
        min-height: 42px;
        font-weight: 700;
        font-family: var(--font-heading);
      }
      .ask-map-submit:hover,
      .ask-map-chip:hover {
        border-color: var(--color-secondary);
        box-shadow: 0 0 14px rgba(138, 205, 255, 0.14);
      }
      .ask-map-samples {
        display: grid;
        gap: 0.45rem;
      }
      .ask-map-chip {
        text-align: left;
        padding: 0.55rem 0.65rem;
        font-size: 0.78rem;
        line-height: 1.35;
      }
      .ask-map-answer {
        border-top: 1px solid var(--color-border);
        padding-top: 0.8rem;
        display: grid;
        gap: 0.7rem;
      }
      .ask-map-answer h3 {
        font-size: 0.82rem;
        color: var(--color-secondary);
        margin: 0;
        font-family: var(--font-heading);
      }
      .ask-map-answer p {
        font-size: 0.82rem;
        line-height: 1.55;
        color: var(--color-text);
      }
      .ask-map-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
      }
      .ask-map-pill {
        border: 1px solid var(--color-border);
        border-radius: 999px;
        color: var(--color-text-muted);
        font-size: 0.68rem;
        padding: 0.18rem 0.45rem;
      }
      .ask-map-evidence {
        display: grid;
        gap: 0.45rem;
      }
      .ask-map-evidence-item {
        border-left: 2px solid var(--source-color, var(--color-secondary));
        background: rgba(255,255,255,0.035);
        padding: 0.55rem 0.65rem;
        border-radius: 6px;
        font-size: 0.76rem;
        line-height: 1.45;
        color: var(--color-text-muted);
      }
      .ask-map-followup {
        color: var(--color-secondary);
        font-size: 0.78rem;
        line-height: 1.45;
      }
    `;
    document.head.appendChild(style);
  }

  const toggleBtn = container.querySelector('.quiz-toggle-btn');
  container.innerHTML = `
    <div class="resize-handle"></div>
    <div class="quiz-content ask-map-content">
      <div>
        <div class="ask-map-title">Ask the Map</div>
        <div class="ask-map-subtitle">Answers are grounded only in the synthetic evidence bundle. Interpretations are labeled as inferences.</div>
      </div>
      <form class="ask-map-form">
        <textarea class="ask-map-input" aria-label="Research question" placeholder="Ask about participant patterns, tensions, themes, or evidence..."></textarea>
        <button class="ask-map-submit" type="submit">Ask</button>
      </form>
      <div class="ask-map-samples" aria-label="Sample research questions"></div>
      <div class="ask-map-answer" aria-live="polite"></div>
    </div>
  `;
  if (toggleBtn) container.appendChild(toggleBtn);

  ui = {
    input: container.querySelector('.ask-map-input'),
    form: container.querySelector('.ask-map-form'),
    samples: container.querySelector('.ask-map-samples'),
    answer: container.querySelector('.ask-map-answer'),
  };

  ui.form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = ui.input.value.trim();
    if (!query) return;
    submitAsk(query);
  });

  attachDrawerBehavior(container);
}

function attachDrawerBehavior(container) {
  const drawerPull = document.createElement('div');
  drawerPull.className = 'drawer-pull';
  drawerPull.setAttribute('aria-label', 'Toggle Ask the Map drawer');
  const pullBar = document.createElement('div');
  pullBar.className = 'drawer-pull-bar';
  drawerPull.appendChild(pullBar);
  const content = container.querySelector('.quiz-content');
  container.insertBefore(drawerPull, content);

  drawerPull.addEventListener('click', () => {
    container.dispatchEvent(new CustomEvent('drawer-pull-toggle', { bubbles: true }));
  });

  const resizeHandle = container.querySelector('.resize-handle');
  if (!resizeHandle) return;
  let resizing = false;
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizing = true;
    resizeHandle.classList.add('active');
    const onMove = (ev) => {
      if (!resizing) return;
      const newWidth = Math.max(320, Math.min(640, window.innerWidth - ev.clientX));
      document.documentElement.style.setProperty('--quiz-sidebar-width', newWidth + 'px');
    };
    const onUp = () => {
      resizing = false;
      resizeHandle.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function submitAsk(query) {
  const matched = findQuestion(query);
  currentQuestion = matched || { id: `freeform-${Date.now()}`, query };
  if (askCallback) askCallback(query, currentQuestion);
  announce(`Asked: ${query}`);
}

function findQuestion(query) {
  const q = query.toLowerCase();
  return sampleQuestions.find(item =>
    item.query?.toLowerCase() === q ||
    item.question_text?.toLowerCase() === q ||
    (item.aliases || []).some(alias => q.includes(alias.toLowerCase()))
  ) || sampleQuestions.find(item => {
    const text = `${item.query || ''} ${(item.themes || []).join(' ')}`.toLowerCase();
    return q.split(/\W+/).filter(Boolean).some(token => token.length > 4 && text.includes(token));
  });
}

export function showQuestion(question) {
  currentQuestion = question || null;
  if (Array.isArray(question)) sampleQuestions = question;
  else if (question?.samples) sampleQuestions = question.samples;
  else if (question) {
    const existing = sampleQuestions.find(q => q.id === question.id);
    if (!existing) sampleQuestions = [question, ...sampleQuestions].slice(0, 6);
  }

  renderSamples();
}

function renderSamples() {
  if (!ui.samples) return;
  ui.samples.textContent = '';
  const samples = sampleQuestions.slice(0, 5);
  for (const q of samples) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ask-map-chip';
    btn.textContent = q.query || q.question_text;
    btn.addEventListener('click', () => {
      ui.input.value = btn.textContent;
      submitAsk(btn.textContent);
    });
    ui.samples.appendChild(btn);
  }
}

export function showAskResponse(response) {
  if (!ui.answer) return;
  ui.answer.textContent = '';

  if (!response) {
    ui.answer.innerHTML = '<p>No grounded sample answer is available for that question yet. Try one of the prepared research questions.</p>';
    return;
  }

  const title = document.createElement('h3');
  title.textContent = 'Synthesis';
  const synthesis = document.createElement('p');
  synthesis.textContent = response.synthesis || 'No synthesis available.';
  ui.answer.appendChild(title);
  ui.answer.appendChild(synthesis);

  const meta = document.createElement('div');
  meta.className = 'ask-map-meta';
  for (const code of response.participant_codes || []) {
    const pill = document.createElement('span');
    pill.className = 'ask-map-pill';
    pill.textContent = code;
    meta.appendChild(pill);
  }
  for (const theme of response.themes || []) {
    const pill = document.createElement('span');
    pill.className = 'ask-map-pill';
    pill.textContent = theme;
    meta.appendChild(pill);
  }
  if (meta.children.length) ui.answer.appendChild(meta);

  if (response.evidence && response.evidence.length) {
    const evTitle = document.createElement('h3');
    evTitle.textContent = 'Supporting Evidence';
    ui.answer.appendChild(evTitle);
    const list = document.createElement('div');
    list.className = 'ask-map-evidence';
    for (const item of response.evidence.slice(0, 4)) {
      const ev = document.createElement('div');
      ev.className = 'ask-map-evidence-item';
      ev.style.setProperty('--source-color', item.color || '#8acdff');
      ev.textContent = `${item.participant_id || item.participant_code || 'participant'}: ${item.summary || item.excerpt || item.id}`;
      list.appendChild(ev);
    }
    ui.answer.appendChild(list);
  }

  if (response.follow_up) {
    const follow = document.createElement('div');
    follow.className = 'ask-map-followup';
    follow.textContent = `Follow-up: ${response.follow_up}`;
    ui.answer.appendChild(follow);
  }
}

export function showAskStatus(message) {
  if (!ui.answer) return;
  ui.answer.textContent = '';
  const status = document.createElement('p');
  status.textContent = message;
  ui.answer.appendChild(status);
}

export function isValidQuestion(question) {
  if (!question) return { valid: false, reason: 'question is missing' };
  const text = question.query || question.question_text;
  return text ? { valid: true, reason: '' } : { valid: false, reason: 'question text missing' };
}

export function showSkipFeedback() {}

export function onAnswer(callback) {
  askCallback = callback;
}

export function onNext(callback) {
  nextCallback = callback;
}

export function getCurrentQuestion() {
  return currentQuestion;
}

export function renderLatex(text) {
  if (!text) return '';
  if (typeof window !== 'undefined' && window.katex && text.includes('$')) {
    return text.replace(/\$([^$]+)\$/g, (_, expr) => {
      try {
        return window.katex.renderToString(expr, { throwOnError: false });
      } catch {
        return `$${expr}$`;
      }
    });
  }
  return escapeHtml(text);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
