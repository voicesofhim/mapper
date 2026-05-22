/** Main application entry point — wires state, domain loading, estimator, quiz loop, and renderer. */

import { validateSchema, isAvailable, resetAll, exportResponses } from './state/persistence.js';
import {
  $activeDomain,
  $responses,
  $estimates,
  $answeredIds,
  $coverage,
  $questionMode,
  $watchedVideos,
  $preVideoSnapshot,
  $runningDifferenceMap,
  $phase,
  $quizDrawerCollapsed,
} from './state/store.js';
import * as registry from './domain/registry.js';
import { load as loadDomain, loadQuestionsForDomain } from './domain/loader.js';
import { indexQuestions } from './domain/questions.js';
import { Estimator } from './learning/estimator.js';
import { Sampler } from './learning/sampler.js';
import { getCentrality } from './learning/curriculum.js';
import { Renderer } from './viz/renderer.js';
import { Minimap } from './viz/minimap.js';
import { ParticleSystem, subsampleParticlePoints } from './viz/particles.js';
import * as controls from './ui/controls.js';
import * as quiz from './ui/quiz.js';
import * as modes from './ui/modes.js';

import * as insights from './ui/insights.js';
import * as share from './ui/share.js';
import { checkMilestone, highlightExpertiseButton, updateProgressDisplay } from './ui/milestones.js';
import { initTutorial, advanceTutorial, isTutorialActive, resetTutorial, dismissTutorial, setAnswerFeedback, goToStep as tutorialGoToStep } from './ui/tutorial.js';
import * as videoModal from './ui/video-modal.js';
import * as videoLoader from './domain/video-loader.js';
import * as videoPanel from './ui/video-panel.js';
import { computeRanking, takeSnapshot, handlePostVideoQuestion } from './learning/video-recommender.js';
import { updateConfidence, initConfidence } from './ui/progress.js';
import { announce, setupKeyboardNav } from './utils/accessibility.js';
import { lockLandscape, unlockOrientation } from './ui/orientation.js';
import { decodeSharedToken, applySharedViewChrome } from './sharing/shared-view.js';
import { maybeCollect, isCollectionEnabled, setCollectionEnabled } from './collection/collector.js';

const GLOBAL_REGION = { x_min: 0, x_max: 1, y_min: 0, y_max: 1 };
const GLOBAL_GRID_SIZE = 50;
const SOURCE_COLORS = {
  interview: [169, 255, 255, 220],
  prior_interview: [154, 163, 255, 220],
  application: [245, 222, 148, 220],
  public_trace: [255, 184, 92, 220],
  derived_analysis: [194, 132, 252, 220],
  social: [255, 184, 92, 220],
  mentor_note: [112, 226, 164, 220],
  program_material: [245, 222, 148, 220],
  reflection: [194, 132, 252, 220],
};
const SOURCE_COLOR_CSS = {
  interview: '#a9ffff',
  prior_interview: '#9aa3ff',
  application: '#f5de94',
  public_trace: '#ffb85c',
  derived_analysis: '#c284fc',
  social: '#ffb85c',
  mentor_note: '#70e2a4',
  program_material: '#f5de94',
  reflection: '#c284fc',
};
const LOCAL_ASK_ENDPOINT = 'http://127.0.0.1:8787/api/ask-map';

// Uniform length scale for all observations — no per-domain variation.
const UNIFORM_LENGTH_SCALE = 0.18;

let renderer = null;
let minimap = null;
let particleSystem = null;
let estimator = null;
let globalEstimator = null; // Always covers GLOBAL_REGION for minimap
let sampler = null;
let allDomainBundle = null;   // Permanent "all" domain data — never replaced
let currentDomainBundle = null; // Points to allDomainBundle once loaded
let aggregatedQuestions = [];   // Questions for active domain + descendants (CL-049)
let currentViewport = { x_min: 0, x_max: 1, y_min: 0, y_max: 1 };
let domainQuestionCount = 0;
let consecutiveCorrect = 0;
let switchGeneration = 0;
let questionIndex = new Map();
let mergedVideoWindows = []; // Accumulated window coords from recent unwatched-between videos
let mapInitialized = false; // True once articles/questions/labels are set on the renderer
let activeLens = {
  datasetId: 'all',
  participantId: 'all',
  sourceType: 'all',
  theme: 'all',
  colorBy: 'source_type',
  highlightedIds: [],
};
let lensControls = null;

function isAcceleratorBundle(bundle = allDomainBundle) {
  return bundle?.schema_version === 'accelerator-demo-v1' || bundle?.domain?.content_model === 'accelerator_research';
}

async function boot() {
  // Detect shared view mode via ?t= URL parameter (T012/T016)
  const urlParams = new URLSearchParams(window.location.search);
  const sharedToken = urlParams.get('t');
  let sharedData = null;

  const storageAvailable = isAvailable();
  if (!storageAvailable) {
    showNotice('Progress won\u2019t be saved across visits (localStorage unavailable).');
  }

  const schemaOk = validateSchema();
  if (!schemaOk && storageAvailable) {
    showNotice('Previous progress was from an older version and could not be restored.');
  }

  try {
    await registry.init();
  } catch (err) {
    console.error('[app] Failed to load domain registry:', err);
    showLandingError('Could not load domain data. Please try refreshing.');
    return;
  }

  // Decode shared token now that registry is ready (needs descendant info)
  if (sharedToken) {
    try {
      sharedData = await decodeSharedToken(sharedToken);
    } catch (err) {
      console.warn('[app] Shared token decode failed, falling back to normal boot:', err);
    }
  }

  const particleCanvas = document.getElementById('particle-canvas');
  if (particleCanvas) {
    particleSystem = new ParticleSystem();
    // Particle data is set later via initWithPoints() after allDomainBundle loads
  }

  renderer = new Renderer();
  renderer.init({
    container: document.getElementById('map-container'),
    onViewportChange: handleViewportChange,
    onCellClick: handleCellClick,
  });

  estimator = new Estimator();
  estimator.init(GLOBAL_GRID_SIZE, GLOBAL_REGION);
  globalEstimator = new Estimator();
  globalEstimator.init(GLOBAL_GRID_SIZE, GLOBAL_REGION);
  sampler = new Sampler();
  sampler.configure(GLOBAL_GRID_SIZE, GLOBAL_REGION);

  // Attach the landing button BEFORE the data load so it's responsive immediately.
  // If clicked before data loads, we store the intent and act on it once data arrives.
  let earlyStartRequested = !!sharedData; // Auto-start in shared mode
  const landingStartBtn = document.getElementById('landing-start-btn');
  if (landingStartBtn) {
    landingStartBtn.addEventListener('click', () => {
      if (allDomainBundle) {
        // Data already loaded — transition immediately
        $activeDomain.set('all');
      } else {
        // Data still loading — record intent, show loading feedback
        earlyStartRequested = true;
        landingStartBtn.textContent = 'Loading…';
        landingStartBtn.disabled = true;
      }
    });
  }

  // Eagerly load the "all" domain — this is the permanent, full dataset.
  // All articles, questions, and labels come from here; domain selection
  // only pans/zooms the viewport rather than replacing data.
  try {
    allDomainBundle = await loadDomain('all', {});
    allDomainBundle.questions = allDomainBundle.questions?.length ? allDomainBundle.questions : (allDomainBundle.ask_map?.questions || []);
    allDomainBundle.articles = allDomainBundle.articles?.length ? allDomainBundle.articles : (allDomainBundle.map_items || []);
    if (isAcceleratorBundle()) initMapLensControls(allDomainBundle);
    indexQuestions(allDomainBundle.questions);
    questionIndex = new Map(allDomainBundle.questions.map(q => [q.id, q]));
    insights.setConcepts(allDomainBundle.questions, allDomainBundle.articles);
    insights.setDomains(registry.getDomains());

    // Signal that data is loaded and button is clickable.
    // Tests wait for [data-ready] before clicking — must come AFTER data loads.
    if (landingStartBtn) landingStartBtn.dataset.ready = 'true';

    // Initialize particles in the background — don't block the transition.
    // If user already clicked start, skip particles entirely (they'd be destroyed anyway).
    if (particleSystem && particleCanvas && !earlyStartRequested) {
      const points = subsampleParticlePoints(allDomainBundle.articles);
      particleSystem.initWithPoints(particleCanvas, points);
    }
  } catch (err) {
    console.error('[app] Failed to pre-load "all" domain:', err);
    showLandingError('Could not load map data. Please try refreshing.');
    return;
  }

  // If user clicked "Map my Knowledge" while data was loading, transition now.
  // In shared mode, this auto-starts the map without user interaction.
  if (earlyStartRequested) {
    $activeDomain.set('all');
  }

  // In shared mode, inject decoded responses and apply read-only chrome
  // after the map has initialized via switchDomain.
  if (sharedData) {
    // Wait a tick for switchDomain to finish rendering
    await new Promise(r => setTimeout(r, 200));
    injectSharedResponses(sharedData.responses);
    applySharedViewChrome(sharedData.tokenString);
  }

  if (!isAcceleratorBundle()) {
    // Start background video catalog loading for the original Mapper learning flow.
    videoLoader.startBackgroundLoad();
    videoLoader.getVideos().promise.then((videos) => {
      if (renderer && videos.length > 0 && mapInitialized) {
        renderer.setVideos(videosToMarkers(videos));
      }
      if (videos && videos.length > 0) {
        videoPanel.setVideos(videosToMarkers(videos));
        if (minimap) minimap.setVideos(videosToLastPoints(videos));
      }
    });
  }

  // Pre-load all domain bundles in the background so domain switches are instant.
  const allDomainIds = registry.getDomains().map(d => d.id).filter(id => id !== 'all');
  for (const id of allDomainIds) {
    loadDomain(id, {}).catch(() => {});  // silent — will retry on demand
  }

  const headerEl = document.getElementById('app-header');
  controls.init(headerEl);
  controls.onDomainSelect((domainId) => $activeDomain.set(domainId));
  controls.onReset(handleReset);
  controls.onExport(handleExport);
  controls.onImport(handleImport);

  // Move action buttons (reset/download/upload) into .header-actions (left group)
  const headerActions = headerEl.querySelector('.header-actions');
  const actionBtns = controls.getActionButtons();
  if (headerActions && actionBtns.importButton) {
    headerActions.appendChild(actionBtns.resetButton);
    headerActions.appendChild(actionBtns.exportButton);
    headerActions.appendChild(actionBtns.importButton);
    for (const btn of [actionBtns.resetButton, actionBtns.exportButton, actionBtns.importButton]) {
      btn.classList.add('btn-icon');
    }
  }

  // Logo click — context-dependent behavior:
  // Welcome screen: start mapping (same as "Map my knowledge!" button)
  // Map screen: return to welcome without clearing progress
  // Shared view (?t=): reload without token to start user's own session
  const logo = headerEl.querySelector('.logo');
  const isSharedView = new URLSearchParams(window.location.search).has('t');
  if (logo) {
    logo.style.cursor = 'pointer';
    if (isSharedView) {
      logo.setAttribute('data-tooltip', 'Open observatory');
    }
    logo.addEventListener('click', () => {
      const appEl = document.getElementById('app');
      const screen = appEl?.dataset.screen;

      if (isSharedView) {
        // Shared view → reload without ?t= param to start user's own session
        window.location.href = window.location.origin + window.location.pathname;
        return;
      }

      if (screen === 'welcome') {
        // Welcome screen → start mapping (same as start button)
        if (allDomainBundle) {
          $activeDomain.set('all');
        }
      } else if (screen === 'map') {
        // Map screen → return to welcome without clearing progress
        dismissTutorial();
        unlockOrientation();
        renderer.abortTransition();
        toggleQuizPanel(false);
        toggleVideoPanel(false);
        const toggleBtn = document.getElementById('quiz-toggle');
        if (toggleBtn) toggleBtn.setAttribute('hidden', '');
        const videoToggleBtn = document.getElementById('video-toggle');
        if (videoToggleBtn) videoToggleBtn.setAttribute('hidden', '');
        // Clear visual layers so the welcome screen particle canvas isn't obscured
        renderer.setHeatmap([], GLOBAL_REGION);
        renderer.setAnsweredQuestions([]);
        renderer.setPoints([]);
        renderer.setVideos([]);
        const landing = document.getElementById('landing');
        if (landing) landing.classList.remove('hidden');
        if (appEl) appEl.dataset.screen = 'welcome';
        logo.setAttribute('data-tooltip', 'Open observatory');
        // Reset active domain so re-entering map triggers switchDomain again
        $activeDomain.set(null);
        // Re-create particle system for the welcome screen
        const pCanvas = document.getElementById('particle-canvas');
        if (pCanvas && allDomainBundle) {
          particleSystem = new ParticleSystem();
          const points = subsampleParticlePoints(allDomainBundle.articles);
          particleSystem.initWithPoints(pCanvas, points);
        }
      }
    });
  }

  const quizPanel = document.getElementById('quiz-panel');
  quiz.init(quizPanel);
  quiz.onAnswer(handleAnswer);
  quiz.onNext(() => selectAndShowNextQuestion());

  renderer.onReanswer((questionId) => {
    const q = questionIndex.get(questionId);
    if (q) quiz.showQuestion(q);
  });

  renderer.onPointClick((point) => {
    const item = findMapItem(point.id);
    if (item) selectMapItem(item);
  });

  renderer.onVideoClick((hit) => {
    if (isAcceleratorBundle()) {
      const item = findMapItem(hit.itemId || hit.id || hit.videoId);
      if (item) selectMapItem(item);
      return;
    }
    videoModal.playVideo({
      id: hit.videoId,
      title: hit.title,
      duration_s: hit.durationS,
      thumbnail_url: hit.thumbnailUrl,
    });
  });

  // Video discovery panel (left sidebar)
  const videoPanelEl = document.getElementById('video-panel');
  if (videoPanelEl) {
    videoPanel.init(videoPanelEl, {
      onVideoSelect: (video) => {
        if (isAcceleratorBundle()) {
          const item = findMapItem(video.itemId || video.id);
          if (item) selectMapItem(item);
        } else {
          videoModal.playVideo(video);
        }
      },
      onVideoHover: (videoId) => {
        if (renderer) renderer.setHoveredVideoId(videoId);
      },
    });
  }

  const videoToggle = document.getElementById('video-toggle');
  if (videoToggle) {
    videoToggle.addEventListener('click', () => toggleVideoPanel());
  }

  if (!isAcceleratorBundle()) {
    modes.init(quizPanel);
    modes.onModeSelect(handleModeSelect);
    modes.onSkip(handleSkip);
  }
  insights.init();
  if (!isAcceleratorBundle()) initConfidence(quizPanel);

  const trophyBtn = document.getElementById('trophy-btn');
  if (trophyBtn) {
    trophyBtn.addEventListener('click', () => {
      if (!globalEstimator) return;
      const dk = insights.computeDomainKnowledge(
        globalEstimator.predict(),
        GLOBAL_REGION,
        GLOBAL_GRID_SIZE,
      );
      insights.showLeaderboard(dk);
      advanceTutorial('expertise-click');
    });
  }

  const suggestBtn = document.getElementById('suggest-btn');
  if (suggestBtn) {
    suggestBtn.addEventListener('click', () => {
      if (!globalEstimator) return;
      advanceTutorial('suggest-click');
      const { data, promise } = videoLoader.getVideos();
      if (data) {
        openVideoModal(data);
      } else {
        videoModal.showVideoModal([]);
        promise.then((videos) => openVideoModal(videos));
      }
    });
  }

  // Initialize video modal and wire completion callback
  videoModal.init();
  videoModal.onVideoComplete(handleVideoComplete);

  // Wire share button click for tutorial
  const shareBtn = document.getElementById('share-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => advanceTutorial('share-click'));
  }

  share.init(headerEl, () => renderer._canvas, () => {
    if (!currentDomainBundle) return [];
    const dk = insights.computeDomainKnowledge(
      globalEstimator.predict(),
      GLOBAL_REGION,
      GLOBAL_GRID_SIZE,
    );
    const evidenced = dk.filter(d => d.hasEvidence !== false);
    const sorted = [...evidenced].sort((a, b) => b.knowledge - a.knowledge);
    return sorted.slice(0, 3).map(d => ({ label: d.name, value: d.knowledge }));
  }, () => $responses.get().length, () => {
    if (!currentDomainBundle) return null;
    const estimates = $estimates.get();
    const grid = estimates.map(e => e.value);
    const articles = currentDomainBundle.articles.map(a => ({ x: a.x, y: a.y }));
    const responses = $responses.get();
    const answeredQuestions = responses
      .filter(r => r.x != null && r.y != null)
      .map(r => ({ x: r.x, y: r.y, isCorrect: r.is_correct, isSkipped: !!r.is_skipped }));
    const { data: videoData } = videoLoader.getVideos();
    const videos = [];
    if (videoData) {
      for (const v of videoData) {
        if (!v.windows || v.windows.length === 0) continue;
        // Only include complete-transcript embedding (last point)
        const last = v.windows[v.windows.length - 1];
        videos.push({ x: last[0], y: last[1] });
      }
    }
    return { estimateGrid: grid, articles, answeredQuestions, videos };
  }, () => {
    if (!allDomainBundle) return null;
    // Use aggregatedQuestions (all 2500) for token encoding, not allDomainBundle.questions (only 50)
    const qs = aggregatedQuestions.length > 0 ? aggregatedQuestions : allDomainBundle.questions;
    return { responses: $responses.get(), questions: qs };
  });

  const minimapContainer = document.getElementById('minimap-container');
  if (minimapContainer) {
    if (isAcceleratorBundle()) {
      minimapContainer.hidden = true;
    }
    minimap = new Minimap();
    minimap.init(minimapContainer, registry.getDomains());
    minimap.onClick((domainId) => $activeDomain.set(domainId));
    minimap.onNavigate((region, animated) => {
      if (!renderer) return;
      if (animated) renderer.transitionTo(region, 400);
      else renderer.jumpTo(region);
    });
    minimap.onPan((cx, cy, animated) => {
      if (!renderer) return;
      renderer.panToCenter(cx, cy, animated);
    });

    // Use the pre-loaded "all" domain for minimap background
    if (allDomainBundle) {
      minimap.setArticles(articlesToPoints(allDomainBundle.articles));
    }
  }

  if (import.meta.env.DEV) {
    window.__mapper = { registry, estimator, sampler, renderer, minimap, $activeDomain, $estimates, $responses, getCurrentQuestion: quiz.getCurrentQuestion, tutorialGoToStep };
  }

  window.mapperActions = {
    highlightMapItems,
    showEvidencePanel,
    setMapLens,
    clearMapLens,
    selectParticipant,
  };

  const quizToggle = document.getElementById('quiz-toggle');
  if (quizToggle) {
    quizToggle.addEventListener('click', () => toggleQuizPanel());
  }

  // Mobile drawer pull toggle (custom event from quiz.js)
  const quizPanelEl = document.getElementById('quiz-panel');
  if (quizPanelEl) {
    quizPanelEl.addEventListener('drawer-pull-toggle', () => toggleQuizPanel());
  }

  // Wire auto-advance toggle for tutorial (created dynamically by modes.js)
  document.addEventListener('click', (e) => {
    if (e.target.closest('.auto-advance-track') || e.target.closest('.auto-advance-label')) {
      advanceTutorial('toggle-auto-advance');
    }
  });

  // Wire modal-dismiss for tutorial (insights/share/video modals closing)
  // Uses a body-level observer since insights-modal is created dynamically
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'hidden') {
        const el = m.target;
        if (el.hidden && (el.id === 'insights-modal' || el.id === 'share-modal')) {
          advanceTutorial('modal-dismiss');
        }
      }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['hidden'], subtree: true });

  setupKeyboardNav({ onEscape: handleEscape });
  wireSubscriptions();

  // Tutorial is initialized after first domain switch (when map becomes visible)
  // See switchDomain() — initTutorial() called there on first run.

  announce('Knowledge Mapper loaded. Open the observatory to begin.');
}

/** Update heatmap display on renderer and minimap using global estimates.
 *  Call this after every $estimates.set() instead of doing it via subscription
 *  to avoid a redundant globalEstimator.predict() on every $estimates change.
 *  Returns the global estimates array for callers that need it. */
let _lastGlobalEstimates = null;
function updateHeatmapDisplay() {
  if (!renderer || !currentDomainBundle || !globalEstimator) return null;
  _lastGlobalEstimates = globalEstimator.predict();
  renderer.setHeatmap(_lastGlobalEstimates, GLOBAL_REGION);
  if (minimap) {
    minimap.setEstimates(_lastGlobalEstimates, GLOBAL_REGION);
  }
  return _lastGlobalEstimates;
}

function wireSubscriptions() {
  $activeDomain.subscribe(async (domainId) => {
    if (!domainId) return;
    await switchDomain(domainId);
  });

  // Heatmap display is updated directly via updateHeatmapDisplay() at each
  // $estimates.set() call site — avoids redundant globalEstimator.predict().

  $coverage.subscribe((coverage) => {
    updateConfidence(coverage);
  });

  $watchedVideos.subscribe((watched) => {
    videoPanel.setWatchedVideos(watched);
  });
}

function articlesToPoints(articles) {
  return articles.map((a) => ({
    id: a.id || a.title,
    x: a.x ?? a.umap_x,
    y: a.y ?? a.umap_y,
    z: a.z || 0,
    type: a.participant_id ? 'map_item' : 'article',
    color: a.participant_id ? colorForMapItem(a) : [0, 0, 0, 30],
    radius: a.participant_id ? 3.4 : 1.5,
    title: a.title,
    url: a.url,
    excerpt: a.excerpt || a.anonymized_text || '',
    summary: a.summary || '',
    participant_id: a.participant_id,
    source_type: a.source_type,
    themes: a.themes || [],
    consent_level: a.consent_level,
  }));
}

function colorForMapItem(item) {
  const colorBy = activeLens?.colorBy || 'source_type';
  if (colorBy === 'source_type') return SOURCE_COLORS[item.source_type] || SOURCE_COLORS.interview;
  if (colorBy === 'theme') return themeColor(item.themes?.[0] || 'other');
  const participant = participantByDisplayCode(item.participant_id);
  const value = participant?.profile_json?.[colorBy];
  if (typeof value === 'number') return traitColor(value);
  return SOURCE_COLORS[item.source_type] || SOURCE_COLORS.interview;
}

function themeColor(theme) {
  const palette = [
    [138, 205, 255, 230],
    [112, 226, 164, 220],
    [255, 184, 92, 220],
    [194, 132, 252, 220],
    [245, 222, 148, 220],
    [154, 163, 255, 220],
  ];
  let hash = 0;
  for (const ch of String(theme)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function traitColor(value) {
  const t = Math.max(0, Math.min(1, value));
  const low = [112, 226, 164];
  const mid = [245, 222, 148];
  const high = [194, 132, 252];
  const from = t < 0.5 ? low : mid;
  const to = t < 0.5 ? mid : high;
  const f = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  return [
    Math.round(from[0] + (to[0] - from[0]) * f),
    Math.round(from[1] + (to[1] - from[1]) * f),
    Math.round(from[2] + (to[2] - from[2]) * f),
    225,
  ];
}

function participantByDisplayCode(displayCode) {
  const bundle = currentDomainBundle || allDomainBundle;
  return (bundle?.participants || []).find(p => p.display_code === displayCode || p.id === displayCode);
}

function getAllMapItems() {
  const bundle = currentDomainBundle || allDomainBundle;
  return bundle?.map_items || bundle?.articles || [];
}

function getFilteredMapItems() {
  return getAllMapItems().filter(item => {
    if (activeLens.datasetId !== 'all' && datasetIdForItem(item) !== activeLens.datasetId) return false;
    if (activeLens.participantId !== 'all' && item.participant_id !== activeLens.participantId) return false;
    if (activeLens.sourceType !== 'all' && item.source_type !== activeLens.sourceType) return false;
    if (activeLens.theme !== 'all' && !(item.themes || []).includes(activeLens.theme)) return false;
    return true;
  });
}

function applyLensToMap() {
  if (!isAcceleratorBundle() || !renderer) return;
  const filtered = getFilteredMapItems();
  renderer.setPoints(articlesToPoints(filtered));
  renderer.setParticipantPaths(participantPathsFromItems(filtered));
  videoPanel.setEvidence(evidenceToMarkers(filtered));
  renderer.highlightMapItems(activeLens.highlightedIds || []);
  window.dispatchEvent(new CustomEvent('mapper:lens-change', { detail: { ...activeLens, count: filtered.length } }));
}

function evidenceToMarkers(items) {
  return (items || []).map(item => ({
    id: item.id,
    itemId: item.id,
    videoId: item.id,
    x: item.x ?? item.umap_x,
    y: item.y ?? item.umap_y,
    title: item.title,
    summary: item.summary,
    excerpt: item.excerpt || item.anonymized_text,
    participant_id: item.participant_id,
    source_type: item.source_type,
    themes: item.themes || [],
    color: SOURCE_COLOR_CSS[item.source_type] || SOURCE_COLOR_CSS.interview,
  }));
}

function initMapLensControls(bundle) {
  const container = document.getElementById('map-container');
  if (!container || lensControls) return;

  const styleId = 'map-lens-style';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .map-lens-bar {
        position: absolute;
        top: 14px;
        left: 14px;
        z-index: 18;
        display: flex;
        flex-wrap: wrap;
        gap: 0.45rem;
        max-width: min(760px, calc(100% - 28px));
      }
      .map-lens-bar[hidden] { display: none !important; }
      .map-lens-dropdown {
        position: relative;
      }
      .map-lens-trigger,
      .map-lens-clear {
        min-height: 34px;
        border: 1px solid var(--color-border);
        border-radius: 0;
        background: rgba(31, 247, 255, 0.045);
        color: var(--color-text-muted);
        font: 0.68rem var(--font-body);
      }
      .map-lens-trigger {
        width: 100%;
        min-width: 154px;
        max-width: 220px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0 0.6rem;
        cursor: pointer;
      }
      .map-lens-clear {
        padding: 0 0.7rem;
        cursor: pointer;
        font-weight: 700;
      }
      .map-lens-arrow {
        color: var(--color-text-muted);
        font-size: 0.68rem;
        transition: transform 0.16s ease;
      }
      .map-lens-dropdown.open .map-lens-arrow {
        transform: rotate(180deg);
      }
      .map-lens-options {
        display: none;
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        min-width: 100%;
        max-height: 260px;
        overflow-y: auto;
        background: rgba(3, 9, 18, 0.98);
        border: 1px solid var(--color-border);
        box-shadow: 0 10px 24px rgba(0,0,0,0.26);
        z-index: 40;
        padding: 0.25rem 0;
      }
      .map-lens-dropdown.open .map-lens-options {
        display: block;
      }
      .map-lens-option {
        padding: 0.38rem 0.58rem;
        color: var(--color-text-muted);
        cursor: pointer;
        font: 0.68rem var(--font-body);
        white-space: nowrap;
      }
      .map-lens-option::before {
        content: "[ ]";
        color: rgba(31, 247, 255, 0.72);
        margin-right: 0.45rem;
      }
      .map-lens-option.selected::before {
        content: "[x]";
        color: var(--color-primary);
      }
      .map-lens-option:hover,
      .map-lens-option.focused {
        background: rgba(31, 247, 255, 0.08);
        color: var(--color-primary);
      }
      .map-lens-clear:hover,
      .map-lens-trigger:hover,
      .map-lens-trigger:focus {
        border-color: var(--color-primary);
        box-shadow: 0 0 8px rgba(31, 247, 255, 0.18);
      }
      @media (max-width: 520px) {
        .map-lens-bar {
          top: 54px;
          left: 8px;
          right: 8px;
          max-width: none;
        }
        .map-lens-dropdown {
          flex: 1 1 44%;
          min-width: 0;
          max-width: none;
        }
        .map-lens-trigger {
          min-width: 0;
          max-width: none;
        }
        .map-lens-clear {
          flex: 1 1 100%;
        }
      }
    `;
    document.head.appendChild(style);
  }

  lensControls = document.createElement('div');
  lensControls.className = 'map-lens-bar';
  lensControls.hidden = true;
  lensControls.innerHTML = `
    ${lensDropdownMarkup('datasetId', 'Filter by dataset')}
    ${lensDropdownMarkup('participantId', 'Filter by participant')}
    ${lensDropdownMarkup('sourceType', 'Filter by source type')}
    ${lensDropdownMarkup('theme', 'Filter by theme')}
    ${lensDropdownMarkup('colorBy', 'Color by')}
    <button class="map-lens-clear" type="button">Clear lens</button>
  `;
  container.appendChild(lensControls);

  updateMapLensControls(bundle);

  lensControls.addEventListener('click', (event) => {
    const trigger = event.target.closest('.map-lens-trigger');
    if (trigger) {
      const dropdown = trigger.closest('.map-lens-dropdown');
      toggleLensDropdown(dropdown);
      return;
    }

    const option = event.target.closest('.map-lens-option');
    if (!option) return;
    const dropdown = option.closest('.map-lens-dropdown');
    const lens = dropdown?.dataset.lens;
    if (!lens) return;
    activeLens = { ...activeLens, [lens]: option.dataset.value };
    setLensDropdownValue(dropdown, option.dataset.value);
    closeLensDropdowns();
    applyLensToMap();
  });

  document.addEventListener('click', (event) => {
    if (!lensControls?.contains(event.target)) closeLensDropdowns();
  });

  lensControls.querySelector('.map-lens-clear')?.addEventListener('click', () => {
    activeLens = {
      datasetId: 'all',
      participantId: 'all',
      sourceType: 'all',
      theme: 'all',
      colorBy: 'source_type',
      highlightedIds: [],
    };
    for (const dropdown of lensControls.querySelectorAll('.map-lens-dropdown')) {
      setLensDropdownValue(dropdown, activeLens[dropdown.dataset.lens]);
    }
    clearMapLens();
    applyLensToMap();
  });
}

function lensDropdownMarkup(lens, ariaLabel) {
  return `
    <div class="map-lens-dropdown" data-lens="${lens}">
      <button class="map-lens-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="${ariaLabel}">
        <span class="map-lens-value"></span>
        <span class="map-lens-arrow"><i class="fa-solid fa-chevron-down"></i></span>
      </button>
      <div class="map-lens-options" role="listbox"></div>
    </div>
  `;
}

function toggleLensDropdown(dropdown) {
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  closeLensDropdowns();
  dropdown.classList.toggle('open', !isOpen);
  dropdown.querySelector('.map-lens-trigger')?.setAttribute('aria-expanded', String(!isOpen));
}

function closeLensDropdowns() {
  if (!lensControls) return;
  for (const dropdown of lensControls.querySelectorAll('.map-lens-dropdown.open')) {
    dropdown.classList.remove('open');
    dropdown.querySelector('.map-lens-trigger')?.setAttribute('aria-expanded', 'false');
  }
}

function updateMapLensControls(bundle) {
  if (!lensControls || !bundle) return;

  const participants = bundle.participants || [];
  const items = bundle.map_items || bundle.articles || [];
  const datasets = datasetsFromBundle(bundle, items);
  const sourceTypes = [...new Set(items.map(i => i.source_type).filter(Boolean))].sort();
  const themes = [...new Set(items.flatMap(i => i.themes || []))].sort();

  populateLensDropdown(lensControls.querySelector('[data-lens="datasetId"]'), [
    ['all', 'All datasets'],
    ...datasets.map(dataset => [dataset.id, dataset.label]),
  ], activeLens.datasetId);
  populateLensDropdown(lensControls.querySelector('[data-lens="participantId"]'), [
    ['all', 'All participants'],
    ...participants.map(p => [p.display_code, participantLensLabel(p)]),
  ], activeLens.participantId);
  populateLensDropdown(lensControls.querySelector('[data-lens="sourceType"]'), [
    ['all', 'All source types'],
    ...sourceTypes.map(type => [type, type.replace(/_/g, ' ')]),
  ], activeLens.sourceType);
  populateLensDropdown(lensControls.querySelector('[data-lens="theme"]'), [
    ['all', 'All themes'],
    ...themes.map(theme => [theme, theme]),
  ], activeLens.theme);
  populateLensDropdown(lensControls.querySelector('[data-lens="colorBy"]'), [
    ['source_type', 'Color: source'],
    ['theme', 'Color: theme'],
    ['openness', 'Color: openness'],
    ['conscientiousness', 'Color: conscientiousness'],
    ['ambiguityComfort', 'Color: ambiguity comfort'],
    ['trustInMentorship', 'Color: mentorship trust'],
    ['publicPrivateTension', 'Color: public/private tension'],
  ], activeLens.colorBy);

  for (const dropdown of lensControls.querySelectorAll('.map-lens-dropdown')) {
    if (dropdown.querySelector(`.map-lens-option[data-value="${cssEscape(activeLens[dropdown.dataset.lens])}"]`)) {
      setLensDropdownValue(dropdown, activeLens[dropdown.dataset.lens]);
    } else {
      const fallback = dropdown.dataset.lens === 'colorBy' ? 'source_type' : 'all';
      activeLens = { ...activeLens, [dropdown.dataset.lens]: fallback };
      setLensDropdownValue(dropdown, fallback);
    }
  }
}

function datasetsFromBundle(bundle, items) {
  const datasets = new Map();
  if (bundle.dataset?.id) {
    datasets.set(bundle.dataset.id, bundle.dataset.name || datasetLabel(bundle.dataset.id));
  }
  for (const item of items || []) {
    const id = datasetIdForItem(item);
    if (id && !datasets.has(id)) datasets.set(id, datasetLabel(id));
  }
  if (datasets.size === 0 && isAcceleratorBundle(bundle)) {
    const id = bundle.domain?.id || 'accelerator';
    datasets.set(id, bundle.domain?.name || datasetLabel(id));
  }
  return [...datasets.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function datasetIdForItem(item) {
  return item?.dataset_id || item?.metadata_json?.dataset_id || item?.source?.dataset_id || '';
}

function datasetLabel(id) {
  if (String(id).startsWith('slab:')) return 'SLAB';
  return String(id || 'Dataset').replace(/[:_-]+/g, ' ');
}

function participantLensLabel(participant) {
  const code = participant.display_code || participant.id;
  const team = participant.profile_json?.team_display;
  if (team && team !== code) return `${code} · ${team}`;
  return [code, participant.role].filter(Boolean).join(' · ');
}

function populateLensDropdown(dropdown, options, selectedValue) {
  if (!dropdown) return;
  const panel = dropdown.querySelector('.map-lens-options');
  if (!panel) return;
  panel.textContent = '';
  for (const [value, label] of options) {
    const opt = document.createElement('div');
    opt.className = 'map-lens-option';
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', 'false');
    opt.value = value;
    opt.dataset.value = value;
    opt.textContent = label;
    panel.appendChild(opt);
  }
  setLensDropdownValue(dropdown, selectedValue || options[0]?.[0] || 'all');
}

function setLensDropdownValue(dropdown, value) {
  if (!dropdown) return;
  const selected = dropdown.querySelector(`.map-lens-option[data-value="${cssEscape(value)}"]`);
  const valueEl = dropdown.querySelector('.map-lens-value');
  if (selected && valueEl) valueEl.textContent = selected.textContent.trim();
  dropdown.dataset.value = value;
  dropdown.querySelectorAll('.map-lens-option').forEach(option => {
    const isSelected = option.dataset.value === value;
    option.classList.toggle('selected', isSelected);
    option.setAttribute('aria-selected', String(isSelected));
  });
}

function cssEscape(value) {
  return String(value ?? '').replace(/["\\]/g, '\\$&');
}

function participantPathsFromItems(items) {
  const grouped = new Map();
  for (const item of items || []) {
    if (!item.participant_id) continue;
    if (!grouped.has(item.participant_id)) grouped.set(item.participant_id, []);
    grouped.get(item.participant_id).push({
      x: item.x ?? item.umap_x,
      y: item.y ?? item.umap_y,
      order: item.metadata_json?.sequence ?? grouped.get(item.participant_id).length,
    });
  }
  return [...grouped.entries()].map(([participantId, points], idx) => ({
    participantId,
    color: Object.values(SOURCE_COLORS)[idx % Object.values(SOURCE_COLORS).length],
    points: points.sort((a, b) => a.order - b.order),
  }));
}

function findMapItem(id) {
  if (!id) return null;
  return getAllMapItems().find(item => String(item.id) === String(id));
}

function videosToLastPoints(videos) {
  const points = [];
  for (const v of videos) {
    if (!v.windows || v.windows.length === 0) continue;
    const last = v.windows[v.windows.length - 1];
    points.push({ x: last[0], y: last[1] });
  }
  return points;
}

function videosToMarkers(videos) {
  const markers = [];
  for (const v of videos) {
    if (!v.windows) continue;
    for (const [x, y] of v.windows) {
      markers.push({
        x,
        y,
        videoId: v.id,
        title: v.title,
        thumbnailUrl: v.thumbnail_url,
        durationS: v.duration_s,
      });
    }
  }
  return markers;
}

function responsesToAnsweredDots(responses, qIndex) {
  const latest = new Map();
  for (const r of responses) {
    latest.set(r.question_id, r);
  }
  const dots = [];
  for (const [qid, r] of latest) {
    const q = qIndex.get(qid);
    // Show dot if we have coordinates — even if question isn't in index yet (e.g. during import)
    if (!q && (r.x == null || r.y == null)) continue;
    const isSkipped = !!r.is_skipped;
    dots.push({
      x: r.x,
      y: r.y,
      questionId: qid,
      title: q ? q.question_text : 'Imported question',
      isCorrect: r.is_correct,
      isSkipped,
      color: isSkipped ? [212, 160, 23, 200]
           : r.is_correct ? [0, 105, 62, 200]
           : [157, 22, 46, 200],
    });
  }
  return dots;
}

/**
 * Switch to a domain — now only pans/zooms the viewport.
 * All articles, questions, and labels remain from the "all" domain loaded at boot.
 * The first call also initializes the map display (articles, labels, estimator restore).
 */
async function switchDomain(domainId) {
  const generation = ++switchGeneration;
  const landing = document.getElementById('landing');
  if (landing) landing.classList.add('hidden');

  const appEl = document.getElementById('app');
  if (appEl) appEl.dataset.screen = 'map';

  // Update logo tooltip for map screen
  const logo = document.querySelector('.logo');
  if (logo) logo.setAttribute('data-tooltip', 'Return to welcome screen');

  // Force landscape on phone-sized devices
  lockLandscape();

  if (particleSystem) {
    particleSystem.destroy();
    particleSystem = null;
  }

  $quizDrawerCollapsed.set(false);
  renderer.abortTransition();

  if (!allDomainBundle) return;

  // Look up the target domain's region from the registry (index.json).
  // For parent domains, compute the union bounding box of the domain + all descendants
  // so the view encompasses all sub-domain content.
  let targetRegion = GLOBAL_REGION;
  const registryEntry = registry.getDomain(domainId);
  if (registryEntry && registryEntry.region) {
    const descendants = registry.getDescendants(domainId);
    if (descendants.length > 0) {
      let { x_min, x_max, y_min, y_max } = registryEntry.region;
      for (const descId of descendants) {
        const desc = registry.getDomain(descId);
        if (desc && desc.region) {
          x_min = Math.min(x_min, desc.region.x_min);
          x_max = Math.max(x_max, desc.region.x_max);
          y_min = Math.min(y_min, desc.region.y_min);
          y_max = Math.max(y_max, desc.region.y_max);
        }
      }
      targetRegion = { x_min, x_max, y_min, y_max };
    } else {
      targetRegion = registryEntry.region;
    }
  }

  // Ensure the domain bundle is loaded/cached (for questions & labels).
  // Bundles are pre-loaded in the background after boot, so this is usually instant.
  let targetBundle = allDomainBundle;
  try {
    const loadedBundle = await loadDomain(domainId, {});
    if (loadedBundle?.domain?.content_model === 'accelerator_research') {
      loadedBundle.questions = loadedBundle.questions?.length ? loadedBundle.questions : (loadedBundle.ask_map?.questions || []);
      loadedBundle.articles = loadedBundle.articles?.length ? loadedBundle.articles : (loadedBundle.map_items || []);
      targetBundle = loadedBundle;
    }
    if (generation !== switchGeneration) return;
  } catch (err) {
    if (generation === switchGeneration) {
      console.error('[app] switchDomain load failed:', err);
    }
  }

  // First-time map initialization: set all articles, questions, labels, and restore GP
  if (!mapInitialized) {
    currentDomainBundle = targetBundle;
    renderer.addQuestions(currentDomainBundle.questions);
    renderer.setLabels(currentDomainBundle.labels || [], GLOBAL_REGION, GLOBAL_GRID_SIZE);

    // Enrich any responses missing x/y from the question index.
    let allResponses = $responses.get();
    let enriched = 0;
    const patched = allResponses.map(r => {
      if (r.x != null && r.y != null) return r;
      const q = questionIndex.get(r.question_id);
      if (q && q.x != null && q.y != null) {
        enriched++;
        return { ...r, x: q.x, y: q.y };
      }
      return r;
    });
    if (enriched > 0) {
      console.log(`[app] Enriched ${enriched} responses with x/y from question index`);
      $responses.set(patched);
      allResponses = patched;
    }

    const relevantResponses = allResponses.filter(r => r.x != null && r.y != null);
    if (relevantResponses.length > 0) {
      estimator.restore(relevantResponses, UNIFORM_LENGTH_SCALE, questionIndex);
      globalEstimator.restore(relevantResponses, UNIFORM_LENGTH_SCALE, questionIndex);
    }

    if (isAcceleratorBundle()) {
      $estimates.set([]);
      renderer.setHeatmap([], GLOBAL_REGION);
    } else {
      const estimates = estimator.predict();
      $estimates.set(estimates);
      updateHeatmapDisplay();
    }

    renderer.setPoints(articlesToPoints(allDomainBundle.articles));
    if (isAcceleratorBundle()) {
      updateMapLensControls(currentDomainBundle);
      renderer.setParticipantPaths(participantPathsFromItems(currentDomainBundle.map_items || currentDomainBundle.articles));
      videoPanel.setEvidence(evidenceToMarkers(currentDomainBundle.map_items || currentDomainBundle.articles));
      if (lensControls) lensControls.hidden = false;
    }
    renderer.setAnsweredQuestions(responsesToAnsweredDots($responses.get(), questionIndex));

    mapInitialized = true;

    if (!isAcceleratorBundle()) {
      // Start tutorial now that the map is visible (after user clicks "Map my knowledge!")
      initTutorial({ responsesCount: $responses.get().length });
    }

    // Show and wire the tutorial button in the header
    const tutorialBtn = document.getElementById('tutorial-btn');
    if (tutorialBtn && !isAcceleratorBundle()) {
      tutorialBtn.hidden = false;
      tutorialBtn.addEventListener('click', () => resetTutorial());
    }

    // Set video markers now that the map is initialized
    if (!isAcceleratorBundle()) {
      const { data: earlyVideos } = videoLoader.getVideos();
      if (earlyVideos && earlyVideos.length > 0) {
        renderer.setVideos(videosToMarkers(earlyVideos));
        videoPanel.setVideos(videosToMarkers(earlyVideos));
        if (minimap) minimap.setVideos(videosToLastPoints(earlyVideos));
      }
    }
  } else if (isAcceleratorBundle(targetBundle)) {
    currentDomainBundle = targetBundle;
    activeLens = {
      datasetId: 'all',
      participantId: 'all',
      sourceType: 'all',
      theme: 'all',
      colorBy: activeLens.colorBy || 'source_type',
      highlightedIds: [],
    };
    updateMapLensControls(currentDomainBundle);
    renderer.setLabels(currentDomainBundle.labels || [], GLOBAL_REGION, GLOBAL_GRID_SIZE);
    renderer.setPoints(articlesToPoints(currentDomainBundle.articles || currentDomainBundle.map_items || []));
    renderer.setParticipantPaths(participantPathsFromItems(currentDomainBundle.map_items || currentDomainBundle.articles));
    videoPanel.setEvidence(evidenceToMarkers(currentDomainBundle.map_items || currentDomainBundle.articles));
    renderer.highlightMapItems([]);
    renderer.setSelectedPoint(null);
  }

  // Aggregate questions for this domain + all descendants (CL-049)
  try {
    aggregatedQuestions = await loadQuestionsForDomain(domainId);
    if (generation !== switchGeneration) return;
    for (const q of aggregatedQuestions) {
      if (!questionIndex.has(q.id)) questionIndex.set(q.id, q);
    }
    indexQuestions(aggregatedQuestions);
    insights.setConcepts(aggregatedQuestions, currentDomainBundle.articles || allDomainBundle.articles);
    renderer.addQuestions(aggregatedQuestions);
  } catch (err) {
    console.error('[app] Question aggregation failed:', err);
    aggregatedQuestions = allDomainBundle ? allDomainBundle.questions : [];
  }

  // Re-apply answered dots now that questionIndex is fully populated
  // (fixes import-from-landing-page showing only the first dot)
  renderer.setAnsweredQuestions(responsesToAnsweredDots($responses.get(), questionIndex));

  // Update domain-scoped tracking
  domainQuestionCount = $responses.get().length;
  if (!isAcceleratorBundle()) modes.updateAvailability(domainQuestionCount);
  updateInsightButtons($responses.get().length);

  // Pan/zoom to the target domain's region
  await renderer.transitionTo(targetRegion);

  if (generation !== switchGeneration) return;

  if (minimap) {
    minimap.setActive(domainId);
    minimap.setViewport(renderer.getViewport());
  }

  toggleQuizPanel(true);
  const toggleBtn = document.getElementById('quiz-toggle');
  if (toggleBtn) toggleBtn.removeAttribute('hidden');
  const videoToggleBtn = document.getElementById('video-toggle');
  if (videoToggleBtn) videoToggleBtn.removeAttribute('hidden');
  controls.showActionButtons();

  // Set initial scroll positions for header button groups
  const headerActionsBar = document.querySelector('.header-actions');
  if (headerActionsBar) headerActionsBar.scrollLeft = 0; // left buttons visible
  const headerRightBar = document.querySelector('.header-right');
  if (headerRightBar) headerRightBar.scrollLeft = headerRightBar.scrollWidth; // right buttons visible

  const domainName = registry.getDomains().find(d => d.id === domainId)?.name || domainId;
  announce(isAcceleratorBundle()
    ? `Navigated to ${domainName}. ${aggregatedQuestions.length} research prompts available.`
    : `Navigated to ${domainName}. ${aggregatedQuestions.length} questions available.`);

  if (!isAcceleratorBundle()) modes.setSkipVisible(true);
  selectAndShowNextQuestion();

  // Advance tutorial on domain switch
  advanceTutorial('domain-change');
}

function selectAndShowNextQuestion() {
  if (!currentDomainBundle || !estimator || !sampler) return;

  if (isAcceleratorBundle()) {
    const samples = aggregatedQuestions.length > 0
      ? aggregatedQuestions
      : (currentDomainBundle.ask_map?.questions || currentDomainBundle.questions || []);
    quiz.showQuestion({ samples });
    return;
  }

  const answeredIds = $answeredIds.get();
  // Use aggregated questions (own + descendants) per CL-049
  const pool = aggregatedQuestions.length > 0 ? aggregatedQuestions : (currentDomainBundle.questions || []);
  let available = pool.filter(q => !answeredIds.has(q.id) && quiz.isValidQuestion(q).valid);

  // Filter to questions belonging to the active domain's lineage (CL-T014)
  const activeDomain = $activeDomain.get();
  if (activeDomain && activeDomain !== 'all') {
    const descendants = registry.getDescendants(activeDomain);
    const domainObj = registry.getDomain(activeDomain);
    const validIds = new Set([activeDomain, ...descendants]);
    if (domainObj && domainObj.parent_id) validIds.add(domainObj.parent_id);
    available = available.filter(q =>
      q.domain_ids && q.domain_ids.some(id => validIds.has(id))
    );
  }

  if (available.length === 0) {
    // Check if ALL domains are exhausted or just the current one
    const allPool = (currentDomainBundle.questions || []);
    const allExhausted = allPool.every(q => answeredIds.has(q.id) || !quiz.isValidQuestion(q).valid);
    const msg = allExhausted
      ? "You've finished mapping your knowledge. Congratulations!"
      : "You've finished mapping this domain; try choosing another domain from the dropdown menu!";
    announce(msg);
    quiz.showQuestion(null, msg);
    modes.setSkipVisible(false);
    progress.updateConfidence(1.0);
    return;
  }

  const estimates = $estimates.get();
  const activeMode = modes.getActiveMode();
  const phase = $phase.get();
  const scored = activeMode === 'auto'
    ? sampler.selectNext(available, estimates, currentViewport, answeredIds, phase)
    : sampler.selectByMode(activeMode, available, estimates, currentViewport, answeredIds);

  if (!scored) {
    quiz.showQuestion(available[0]);
    return;
  }

  const question = available.find((q) => q.id === scored.questionId) || available[0];
  quiz.showQuestion(question);
}

let askRequestSeq = 0;
let activeAskInFlight = false;

async function handleAskMap(queryText, question) {
  const requestId = ++askRequestSeq;
  activeAskInFlight = true;
  quiz.showAskStatus('Searching local evidence...');
  renderer.setThinking(true);
  let localResponse = null;
  try {
    localResponse = await queryLocalAskMap(queryText);
  } finally {
    if (requestId === askRequestSeq) activeAskInFlight = false;
    if (requestId === askRequestSeq) renderer.setThinking(false);
  }
  if (requestId !== askRequestSeq) return;
  if (localResponse?.evidence?.length) {
    const itemIds = localResponse.highlighted_map_item_ids || localResponse.evidence.map(item => item.id);
    const evidence = itemIds
      .map(id => findMapItem(id))
      .filter(Boolean);
    if (evidence.length) {
      const matchedIds = evidence.map(item => item.id);
      const response = {
        ...localResponse,
        highlighted_map_item_ids: matchedIds,
        evidence: evidence.map(item => ({
          ...item,
          excerpt: item.excerpt || item.anonymized_text,
          color: SOURCE_COLOR_CSS[item.source_type] || SOURCE_COLOR_CSS.interview,
        })),
      };
      quiz.showAskResponse(response);
      highlightMapItems(matchedIds, queryText, { focus: true, focusIds: matchedIds.slice(0, 3) });
      showEvidencePanel(evidence, { close: true });
      return;
    }
    console.info('[ask-map] Local retrieval returned IDs outside the active map; using loaded map fallback.', itemIds);
  }

  const questions = currentDomainBundle.ask_map?.questions || currentDomainBundle.questions || [];
  const matched = questions.find(q => q.id === question.id) || matchAskQuestion(queryText, questions);
  if (!matched?.answer) {
    const staticResponse = staticAskResponse(queryText);
    if (!staticResponse) {
      quiz.showAskResponse(null);
      clearMapLens();
      return;
    }
    const itemIds = staticResponse.highlighted_map_item_ids || [];
    const evidence = itemIds.map(findMapItem).filter(Boolean);
    quiz.showAskResponse(staticResponse);
    highlightMapItems(itemIds, queryText, { focus: true, focusIds: itemIds.slice(0, 3) });
    showEvidencePanel(evidence, { close: true });
    return;
  }

  const itemIds = matched.answer.highlighted_map_item_ids || matched.answer.item_ids || [];
  const evidence = itemIds.map(findMapItem).filter(Boolean);
  const response = {
    ...matched.answer,
    evidence: evidence.map(item => ({
      ...item,
      excerpt: item.excerpt || item.anonymized_text,
      color: SOURCE_COLOR_CSS[item.source_type] || SOURCE_COLOR_CSS.interview,
    })),
  };

  quiz.showAskResponse(response);
  highlightMapItems(itemIds, matched.query || queryText, { focus: true, focusIds: itemIds.slice(0, 3) });
  showEvidencePanel(evidence, { close: true });
}

function handleVoiceStatus(detail = {}) {
  const state = String(detail.state || '').toLowerCase();
  if (!state || !renderer) return;

  if (state === 'transcribing') {
    quiz.showAskStatus('Transcribing local voice...');
    renderer.setThinking(true);
    return;
  }

  if (state === 'searching' || state === 'thinking') {
    quiz.showAskStatus('Searching local evidence...');
    renderer.setThinking(true);
    return;
  }

  if (!activeAskInFlight && ['idle', 'listening', 'done', 'error'].includes(state)) {
    renderer.setThinking(false);
  }
}

async function queryLocalAskMap(queryText) {
  if (!queryText || !isAcceleratorBundle()) return null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(LOCAL_ASK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: queryText,
        topK: 5,
        filters: {
          participantId: activeLens.participantId,
          sourceType: activeLens.sourceType,
          theme: activeLens.theme,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Local Ask server returned ${response.status}`);
    return await response.json();
  } catch (err) {
    console.info('[ask-map] Local retrieval unavailable; falling back to bundled sample answers.', err);
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function matchAskQuestion(queryText, questions) {
  const query = (queryText || '').toLowerCase();
  return questions.find(q => (q.query || q.question_text || '').toLowerCase() === query)
    || questions.find(q => (q.aliases || []).some(alias => query.includes(alias.toLowerCase())))
    || questions.find(q => {
      const haystack = `${q.query || ''} ${(q.themes || []).join(' ')}`.toLowerCase();
      return query.split(/\W+/).filter(t => t.length > 4).some(token => haystack.includes(token));
    });
}

function rankStaticEvidence(queryText, limit = 5) {
  const terms = String(queryText || '')
    .toLowerCase()
    .split(/\W+/)
    .filter(term => term.length > 3);
  const items = getFilteredMapItems();
  return items
    .map(item => {
      const haystack = [
        item.participant_id,
        item.title,
        item.summary,
        item.excerpt,
        ...(item.themes || []),
      ].join(' ').toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { item, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || (b.item.confidence || 0) - (a.item.confidence || 0))
    .slice(0, limit)
    .map(entry => entry.item);
}

function staticAskResponse(queryText) {
  const evidence = rankStaticEvidence(queryText, 5);
  if (!evidence.length) return null;
  const participants = [...new Set(evidence.map(item => item.participant_id).filter(Boolean))];
  const themes = [...new Set(evidence.flatMap(item => item.themes || []))].slice(0, 6);
  return {
    synthesis: `Inference: the nearest loaded evidence for ${participants.join(', ')} is shown below. This is local static search over imported chunks.`,
    participant_codes: participants,
    themes,
    highlighted_map_item_ids: evidence.map(item => item.id),
    evidence: evidence.map(item => ({
      ...item,
      excerpt: item.excerpt || item.anonymized_text,
      color: SOURCE_COLOR_CSS[item.source_type] || SOURCE_COLOR_CSS.interview,
    })),
    follow_up: 'Which of these evidence points should we inspect next?',
  };
}

function highlightMapItems(itemIds, reason = '', options = {}) {
  activeLens = { ...activeLens, highlightedIds: itemIds || [] };
  renderer.highlightMapItems(itemIds || []);
  if (options.focus) {
    const focusIds = options.focusIds || itemIds || [];
    renderer.focusMapItems(focusIds, { maxZoom: 1.05, minSpan: 0.7, duration: 1800 });
  }
  window.dispatchEvent(new CustomEvent('mapper:highlight-items', {
    detail: { itemIds, reason, focus: !!options.focus },
  }));
}

function showEvidencePanel(items, options = {}) {
  const evidence = (items && items.length ? items : getFilteredMapItems());
  videoPanel.setEvidence(evidenceToMarkers(evidence));
  if (items && items.length) videoPanel.updateViewport(GLOBAL_REGION);
  if (options.close) {
    toggleVideoPanel(false);
  } else if (options.open !== false) {
    toggleVideoPanel(true);
  }
}

function setMapLens({ theme, colorBy, highlightedIds } = {}) {
  activeLens = {
    ...activeLens,
    theme: theme || activeLens.theme,
    colorBy: colorBy || activeLens.colorBy,
    highlightedIds: highlightedIds || activeLens.highlightedIds,
  };
  if (lensControls) {
    for (const dropdown of lensControls.querySelectorAll('.map-lens-dropdown')) {
      setLensDropdownValue(dropdown, activeLens[dropdown.dataset.lens]);
    }
  }
  applyLensToMap();
  if (highlightedIds) highlightMapItems(highlightedIds, theme || colorBy || 'map lens');
}

function clearMapLens() {
  activeLens = { ...activeLens, highlightedIds: [] };
  renderer.highlightMapItems([]);
  renderer.setSelectedPoint(null);
}

function selectParticipant(participantId) {
  activeLens = { ...activeLens, participantId: participantId || 'all' };
  if (lensControls) {
    setLensDropdownValue(lensControls.querySelector('[data-lens="participantId"]'), activeLens.participantId);
  }
  applyLensToMap();
  const items = getFilteredMapItems();
  if (!items.length) return;
  highlightMapItems(items.map(item => item.id), `participant ${participantId}`);
  showEvidencePanel(items);
}

function selectMapItem(item) {
  renderer.setSelectedPoint(item.id);
  highlightMapItems([item.id], item.title);
  showEvidencePanel([item]);
}

function handleModeSelect(modeId) {
  $questionMode.set(modeId);
  selectAndShowNextQuestion();
}

function handleAnswer(selectedKey, question) {
  if (!question || !currentDomainBundle) return;

  if (isAcceleratorBundle()) {
    handleAskMap(selectedKey, question);
    return;
  }

  const isCorrect = selectedKey === question.correct_answer;

  // Tag the response with the user's currently selected domain (for tracking),
  // not the bundle's domain id (which is always "all" now).
  const activeDomainId = $activeDomain.get() || 'all';

  const response = {
    question_id: question.id,
    domain_id: activeDomainId,
    selected: selectedKey,
    is_correct: isCorrect,
    difficulty: question.difficulty,
    timestamp: Date.now(),
    x: question.x,
    y: question.y,
  };

  const current = $responses.get();
  const filtered = current.filter(r => r.question_id !== question.id);
  const isReanswer = filtered.length < current.length;
  $responses.set([...filtered, response]);

  if (!isReanswer) {
    domainQuestionCount++;
    modes.updateAvailability(domainQuestionCount);
    updateInsightButtons($responses.get().length);
  }

  // Anonymized response collection (every N responses, fire-and-forget)
  maybeCollect($responses.get(), aggregatedQuestions.length > 0 ? aggregatedQuestions : allDomainBundle?.questions);

  // Show answer dot and feedback immediately (before expensive GP computation)
  renderer.setAnsweredQuestions(responsesToAnsweredDots($responses.get(), questionIndex));

  const feedback = isCorrect ? 'Correct!' : 'Incorrect.';
  announce(`${feedback}`);

  // Revert non-auto modes (easy/hardest/dont-know) back to auto after one answer
  modes.revertToAutoIfNeeded();

  // Auto-advance after a short delay if the toggle is on
  if (modes.isAutoAdvance()) {
    setTimeout(() => selectAndShowNextQuestion(), 800);
  }

  // Defer expensive GP computation so UI stays responsive (Issue #26)
  const difficulty = question.difficulty;
  const qx = question.x, qy = question.y;
  setTimeout(() => {
    estimator.observe(qx, qy, isCorrect, UNIFORM_LENGTH_SCALE, difficulty);
    globalEstimator.observe(qx, qy, isCorrect, UNIFORM_LENGTH_SCALE, difficulty);
    const estimates = estimator.predict();
    $estimates.set(estimates);
    updateHeatmapDisplay();

    const coverage = Math.round($coverage.get() * 100);
    announce(`${coverage}% mapped.`);

    // Video recommendation: post-video diff map flow (T-V052, FR-V021)
    if ($preVideoSnapshot.get() !== null) {
      // Reuse global estimates already computed by updateHeatmapDisplay above
      const globalEstimates = _lastGlobalEstimates || globalEstimator.predict();
      const result = handlePostVideoQuestion(globalEstimates, mergedVideoWindows);
      if (result.phaseComplete) {
        mergedVideoWindows = [];
      }
    }
  }, 0);

  // Engagement: track streak, update progress display, check milestones
  if (isCorrect) {
    consecutiveCorrect++;
  } else {
    consecutiveCorrect = 0;
  }
  const totalAnswered = $responses.get().length;
  updateProgressDisplay(totalAnswered, consecutiveCorrect);
  if (!isTutorialActive()) {
    checkMilestone(totalAnswered);
  }
  if (totalAnswered >= 15 && !isTutorialActive()) {
    highlightExpertiseButton();
  }

  // Advance tutorial on answer event (pass feedback for step 2)
  setAnswerFeedback(isCorrect);
  advanceTutorial('answer');
}

function handleSkip() {
  const question = quiz.getCurrentQuestion();
  if (!question || !currentDomainBundle) return;

  const activeDomainId = $activeDomain.get() || 'all';

  const response = {
    question_id: question.id,
    domain_id: activeDomainId,
    selected: null,
    is_correct: false,
    is_skipped: true,
    difficulty: question.difficulty,
    timestamp: Date.now(),
    x: question.x,
    y: question.y,
  };

  const current = $responses.get();
  const filtered = current.filter(r => r.question_id !== question.id);
  const isReanswer = filtered.length < current.length;
  $responses.set([...filtered, response]);

  if (!isReanswer) {
    domainQuestionCount++;
    modes.updateAvailability(domainQuestionCount);
    updateInsightButtons($responses.get().length);
  }

  // Anonymized response collection (every N responses, fire-and-forget)
  maybeCollect($responses.get(), aggregatedQuestions.length > 0 ? aggregatedQuestions : allDomainBundle?.questions);

  // Show answer dot and feedback immediately (before expensive GP computation)
  renderer.setAnsweredQuestions(responsesToAnsweredDots($responses.get(), questionIndex));

  // Show feedback with correct answer highlighted (like wrong-answer flow)
  quiz.showSkipFeedback(question);
  announce('Skipped. The correct answer is highlighted.');

  // Reset streak and update progress display
  consecutiveCorrect = 0;
  const totalAnswered = $responses.get().length;
  updateProgressDisplay(totalAnswered, consecutiveCorrect);

  // Revert non-auto modes back to auto after skip
  modes.revertToAutoIfNeeded();

  // Auto-advance after delay if toggle is on; otherwise user clicks "Next"
  if (modes.isAutoAdvance()) {
    setTimeout(() => selectAndShowNextQuestion(), 800);
  }

  // Defer expensive GP computation so UI stays responsive (Issue #26)
  const difficulty = question.difficulty;
  const qx = question.x, qy = question.y;
  setTimeout(() => {
    estimator.observeSkip(qx, qy, UNIFORM_LENGTH_SCALE, difficulty);
    globalEstimator.observeSkip(qx, qy, UNIFORM_LENGTH_SCALE, difficulty);
    const estimates = estimator.predict();
    $estimates.set(estimates);
    updateHeatmapDisplay();
  }, 0);

  // Advance tutorial on skip event
  setAnswerFeedback(false, true);
  advanceTutorial('skip');
}

/** Inject shared-view responses into the running app and update visualization. */
function injectSharedResponses(responses) {
  // Reset estimators to clear any locally-loaded responses
  estimator.reset();
  estimator.init(GLOBAL_GRID_SIZE, GLOBAL_REGION);
  globalEstimator.reset();
  globalEstimator.init(GLOBAL_GRID_SIZE, GLOBAL_REGION);

  // Save the user's own responses before we touch the store
  const ownResponses = localStorage.getItem('mapper:responses');

  // Prevent persistentAtom from writing shared responses to localStorage.
  // Block all writes to 'mapper:responses' for the entire shared view session,
  // since subscriptions/computed atoms may trigger re-persists at any time.
  const origSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function(key, value) {
    if (key === 'mapper:responses') return; // block shared data from persisting
    origSetItem(key, value);
  };

  // Set responses on the store (updates in-memory only, localStorage write is blocked)
  $responses.set(responses || []);

  // Ensure user's own data stays intact in localStorage
  if (ownResponses) {
    origSetItem('mapper:responses', ownResponses);
  }

  if (!responses || responses.length === 0) {
    // Empty shared map — clear heatmap and dots
    renderer.setHeatmap([], GLOBAL_REGION);
    renderer.setAnsweredQuestions([]);
    if (minimap) minimap.setEstimates([], GLOBAL_REGION);
    return;
  }

  // Feed each response into the estimators
  for (const r of responses) {
    if (r.x == null || r.y == null) continue;
    const diff = r.difficulty || 1;
    if (r.is_skipped) {
      estimator.observeSkip(r.x, r.y, UNIFORM_LENGTH_SCALE, diff);
      globalEstimator.observeSkip(r.x, r.y, UNIFORM_LENGTH_SCALE, diff);
    } else {
      estimator.observe(r.x, r.y, r.is_correct, UNIFORM_LENGTH_SCALE, diff);
      globalEstimator.observe(r.x, r.y, r.is_correct, UNIFORM_LENGTH_SCALE, diff);
    }
  }

  // Update the heatmap and answered dots
  updateHeatmapDisplay();
  renderer.setAnsweredQuestions(responsesToAnsweredDots(responses, questionIndex));
}

function handleReset() {
  if (!confirm('Are you sure? This will clear all progress.')) return;
  dismissTutorial();
  // Clear tutorial state so it re-shows on next domain select (like first visit)
  try { localStorage.removeItem('mapper-tutorial'); } catch { /* noop */ }
  // Release landscape lock so welcome screen can be portrait
  unlockOrientation();
  resetAll();
  currentDomainBundle = null;
  mapInitialized = false;
  domainQuestionCount = 0;
  aggregatedQuestions = [];
  switchGeneration++;
  renderer.abortTransition();
  estimator.reset();
  estimator.init(GLOBAL_GRID_SIZE, GLOBAL_REGION);
  globalEstimator.reset();
  globalEstimator.init(GLOBAL_GRID_SIZE, GLOBAL_REGION);
  renderer.setPoints([]);
  renderer.setVideos([]);
  renderer.setHeatmap([], GLOBAL_REGION);
  renderer.setLabels([]);
  renderer.setAnsweredQuestions([]);
  renderer.clearQuestions();
  insights.resetGlobalConcepts();
  insights.resetDomains();
  videoModal.hide();
  mergedVideoWindows = [];
  // Re-set concepts and domains from the permanent "all" bundle so insights work on next domain select
  if (allDomainBundle) {
    insights.setConcepts(allDomainBundle.questions, allDomainBundle.articles);
    insights.setDomains(registry.getDomains());
  }
  questionIndex = allDomainBundle
    ? new Map(allDomainBundle.questions.map(q => [q.id, q]))
    : new Map();
  if (minimap) {
    minimap.setActive(null);
    minimap.setEstimates([]);
  }
  // Reset viewport to full map
  renderer.jumpTo(GLOBAL_REGION);
  toggleQuizPanel(false);
  toggleVideoPanel(false);
  const toggleBtn = document.getElementById('quiz-toggle');
  if (toggleBtn) toggleBtn.setAttribute('hidden', '');
  const videoToggleBtn = document.getElementById('video-toggle');
  if (videoToggleBtn) videoToggleBtn.setAttribute('hidden', '');
  const landing = document.getElementById('landing');
  if (landing) landing.classList.remove('hidden');
  const appEl = document.getElementById('app');
  if (appEl) appEl.dataset.screen = 'welcome';

  // Re-create particle system for the welcome screen
  const pCanvas = document.getElementById('particle-canvas');
  if (pCanvas && allDomainBundle) {
    particleSystem = new ParticleSystem();
    const points = subsampleParticlePoints(allDomainBundle.articles);
    particleSystem.initWithPoints(pCanvas, points);
  }

  announce('All progress has been reset.');
}

function handleExport() {
  const blob = exportResponses();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `knowledge-map-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  announce('Progress exported.');
}

function handleImport(data) {
  console.log('[import] handleImport called with', data ? 'data' : 'null');
  if (!data) return;

  let responses = [];
  if (Array.isArray(data)) {
    responses = data;
  } else if (data.responses && Array.isArray(data.responses)) {
    responses = data.responses;
  } else {
    alert('Unrecognized file format. Expected an array of responses or an object with a "responses" key.');
    return;
  }

  const valid = responses.filter(r =>
    r.question_id && r.domain_id && typeof r.is_correct === 'boolean'
    && (r.selected || r.is_skipped || r.selected === null)
  ).map(r => {
    // Infer is_skipped for older exports that lack the field
    if (!r.is_skipped && r.selected === null) {
      return { ...r, is_skipped: true };
    }
    return r;
  });

  if (valid.length === 0) {
    alert('No valid responses found in the imported file.');
    return;
  }

  // Enrich imported responses with x/y coordinates from questionIndex
  // (older exports may lack these, but we need them for the GP estimator)
  let coordsRecovered = 0;
  const enrichedValid = valid.map(r => {
    if (r.x != null && r.y != null) return r;
    const q = questionIndex.get(r.question_id);
    if (q && q.x != null && q.y != null) {
      coordsRecovered++;
      return { ...r, x: q.x, y: q.y };
    }
    return r;
  });

  if (coordsRecovered > 0) {
    console.log(`[import] Recovered x/y coordinates for ${coordsRecovered} responses from question index`);
  }

  const existing = $responses.get();
  const existingIds = new Set(existing.map(r => r.question_id));
  const newResponses = enrichedValid.filter(r => !existingIds.has(r.question_id));
  const merged = [...existing, ...newResponses];

  $responses.set(merged);

  if (estimator) {
    const relevant = merged.filter(r => r.x != null && r.y != null);
    estimator.restore(relevant, UNIFORM_LENGTH_SCALE, questionIndex);
    if (globalEstimator) globalEstimator.restore(relevant, UNIFORM_LENGTH_SCALE, questionIndex);
    const estimates = estimator.predict();
    $estimates.set(estimates);
    updateHeatmapDisplay();

    domainQuestionCount = merged.length;
    modes.updateAvailability(domainQuestionCount);
    renderer.setAnsweredQuestions(responsesToAnsweredDots(merged, questionIndex));
  }

  const msg = `Imported ${newResponses.length} new responses (${valid.length} total in file, ${existing.length} already existed).`;
  announce(msg);
  _showBanner(msg, 'success');
  console.log('[import]', msg);

  // If we're still on the welcome screen, switch to map view with "all" domain.
  if (!currentDomainBundle) {
    controls.setSelectedDomain('all');
    $activeDomain.set('all');
  }
}

function handleViewportChange(viewport) {
  currentViewport = viewport;
  if (minimap) minimap.setViewport(viewport);
  videoPanel.updateViewport(viewport);
}

function handleCellClick(_gx, _gy) {
  // Reserved for future question targeting by cell
}

function handleEscape() {
  if (videoModal.handleEscape()) return;
  const insightsModal = document.getElementById('insights-modal');
  if (insightsModal && !insightsModal.hidden) {
    insightsModal.hidden = true;
    return;
  }
  const aboutModal = document.getElementById('about-modal');
  if (aboutModal && !aboutModal.hidden) {
    aboutModal.hidden = true;
    return;
  }
  const shareModal = document.getElementById('share-modal');
  if (shareModal && !shareModal.hidden) {
    shareModal.hidden = true;
    return;
  }
  toggleQuizPanel(false);
}

function toggleQuizPanel(show) {
  const quizPanel = document.getElementById('quiz-panel');
  const toggleBtn = document.getElementById('quiz-toggle');
  if (!quizPanel) return;

  if (show === undefined) show = !quizPanel.classList.contains('open');

  if (show) {
    // On mobile, close the video panel to avoid overlapping bottom sheets
    if (window.innerWidth <= 480) {
      const videoEl = document.getElementById('video-panel');
      if (videoEl && videoEl.classList.contains('open')) {
        toggleVideoPanel(false);
      }
    }
    quizPanel.classList.add('open');
    // On mobile, ensure drawer-collapsed is cleared when opening
    if (window.innerWidth <= 480) $quizDrawerCollapsed.set(false);
    if (toggleBtn) {
      toggleBtn.querySelector('i').className = 'fa-solid fa-chevron-right';
      toggleBtn.setAttribute('aria-label', isAcceleratorBundle() ? 'Close Ask the Map panel' : 'Close quiz panel');
    }
  } else {
    quizPanel.classList.remove('open');
    if (toggleBtn) {
      toggleBtn.querySelector('i').className = 'fa-solid fa-chevron-left';
      toggleBtn.setAttribute('aria-label', isAcceleratorBundle() ? 'Open Ask the Map panel' : 'Open quiz panel');
    }
  }
}

function toggleVideoPanel(show) {
  const panel = document.getElementById('video-panel');
  const toggleBtn = document.getElementById('video-toggle');
  if (!panel) return;

  if (show === undefined) show = !panel.classList.contains('open');

  if (show) {
    // On mobile, close the quiz panel to avoid overlapping bottom sheets
    if (window.innerWidth <= 480) {
      toggleQuizPanel(false);
    }
    panel.classList.add('open');
    if (toggleBtn) {
      toggleBtn.querySelector('i').className = 'fa-solid fa-chevron-left';
      toggleBtn.setAttribute('aria-label', isAcceleratorBundle() ? 'Close evidence panel' : 'Close video panel');
    }
  } else {
    panel.classList.remove('open');
    if (toggleBtn) {
      toggleBtn.querySelector('i').className = 'fa-solid fa-chevron-right';
      toggleBtn.setAttribute('aria-label', isAcceleratorBundle() ? 'Open evidence panel' : 'Open video panel');
    }
  }
}

function _showBanner(message, type = 'warning') {
  const container = document.getElementById('app-main');
  if (!container) return;

  const banner = document.createElement('div');
  banner.className = `notice-banner ${type}`;
  banner.setAttribute('role', 'alert');

  const content = document.createElement('div');
  content.className = 'notice-banner-content';
  content.textContent = message;

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'notice-banner-dismiss';
  dismissBtn.setAttribute('aria-label', 'Dismiss notification');

  const iconEl = document.createElement('i');
  iconEl.className = 'fa fa-times';
  dismissBtn.appendChild(iconEl);

  const removeBanner = () => {
    banner.classList.add('dismissing');
    setTimeout(() => {
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }, 300);
  };

  dismissBtn.addEventListener('click', removeBanner);

  banner.appendChild(content);
  banner.appendChild(dismissBtn);
  container.insertBefore(banner, container.firstChild);

  let autoDismissTimer = setTimeout(removeBanner, 8000);

  banner.addEventListener('mouseenter', () => clearTimeout(autoDismissTimer));
  banner.addEventListener('mouseleave', () => {
    autoDismissTimer = setTimeout(removeBanner, 8000);
  });
}

function showNotice(message) {
  console.warn('[mapper]', message);
  announce(message);
  _showBanner(message);
}

function showLandingError(message) {
  const landing = document.getElementById('landing');
  if (landing) {
    const p = landing.querySelector('p');
    if (p) p.textContent = message;
  }
}

// ─── Video recommendation helpers (T-V050, T-V051, T-V052) ──

function openVideoModal(videos) {
  if (!globalEstimator) return;
  const globalEstimates = globalEstimator.predict();
  const watchedIds = $watchedVideos.get();
  const runningDiffMap = $runningDifferenceMap.get();
  const ranked = computeRanking(videos, globalEstimates, watchedIds, runningDiffMap);
  videoModal.showVideoModal(ranked);
}

function handleVideoComplete(videoId) {
  if (!globalEstimator) return;
  // Take snapshot for diff map computation (FR-V020, CL-004)
  const globalEstimates = globalEstimator.predict();
  const snapshotTaken = takeSnapshot(globalEstimates);

  // Find the completed video's windows and merge them
  const { data } = videoLoader.getVideos();
  if (data) {
    const video = data.find((v) => v.id === videoId);
    if (video && video.windows) {
      if (snapshotTaken) {
        mergedVideoWindows = [...video.windows];
      } else {
        // Multiple videos without questions — merge windows (CL-004)
        mergedVideoWindows = mergedVideoWindows.concat(video.windows);
      }
    }
  }
}

const INSIGHT_MIN_ANSWERS = 5;

function updateInsightButtons(answerCount) {
  const trophyBtn = document.getElementById('trophy-btn');
  const suggestBtn = document.getElementById('suggest-btn');
  if (isAcceleratorBundle()) {
    if (trophyBtn) trophyBtn.hidden = true;
    if (suggestBtn) suggestBtn.hidden = true;
    return;
  }
  const ready = answerCount >= INSIGHT_MIN_ANSWERS;
  if (trophyBtn) trophyBtn.disabled = !ready;
  if (suggestBtn) suggestBtn.disabled = !ready;
}

function setupAboutModal() {
  const btn = document.getElementById('about-btn');
  const modal = document.getElementById('about-modal');
  if (!btn || !modal) return;
  // Sync collection toggle state when modal opens
  function syncCollectToggle() {
    const track = document.getElementById('collect-toggle-track');
    const thumb = document.getElementById('collect-toggle-thumb');
    if (!track || !thumb) return;
    const enabled = isCollectionEnabled();
    track.setAttribute('aria-checked', String(enabled));
    track.style.background = enabled ? 'var(--color-primary, #00693e)' : 'var(--color-text-muted, #94a3b8)';
    thumb.style.left = enabled ? '18px' : '2px';
  }

  btn.addEventListener('click', () => {
    modal.hidden = !modal.hidden;
    if (!modal.hidden) syncCollectToggle();
  });
  const closeBtn = modal.querySelector('.close-modal');
  if (closeBtn) closeBtn.addEventListener('click', () => { modal.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });

  // Sync toggle when preference changes externally (e.g., tutorial consent step)
  window.addEventListener('collect-pref-change', syncCollectToggle);

  // Collection toggle click handler
  const collectTrack = document.getElementById('collect-toggle-track');
  if (collectTrack) {
    function toggleCollect() {
      const newVal = !isCollectionEnabled();
      setCollectionEnabled(newVal);
      syncCollectToggle();
    }
    collectTrack.addEventListener('click', toggleCollect);
    collectTrack.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollect(); }
    });
  }

  // Wire up inline info link on landing page to open the about modal
  const landingInfoLink = document.getElementById('landing-info-link');
  if (landingInfoLink) {
    landingInfoLink.addEventListener('click', (e) => {
      e.preventDefault();
      modal.hidden = false;
    });
  }
}

window.mapperActions = {
  highlightMapItems,
  showEvidencePanel,
  setMapLens,
  clearMapLens,
  selectParticipant,
};

window.addEventListener('mapper:action', (event) => {
  const { type, payload = {} } = event.detail || {};
  if (type === 'highlightMapItems') highlightMapItems(payload.itemIds || [], payload.reason || 'external action', { focus: !!payload.focus });
  if (type === 'showEvidencePanel') showEvidencePanel(payload.items || []);
  if (type === 'setMapLens') setMapLens(payload);
  if (type === 'clearMapLens') clearMapLens();
  if (type === 'selectParticipant') selectParticipant(payload.participantId);
});

window.addEventListener('mapper:voice-status', (event) => {
  handleVoiceStatus(event.detail || {});
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { setupAboutModal(); boot(); });
} else {
  setupAboutModal();
  boot();
}

export default boot;
