// injected.js — runs in the YouTube page world (injected via a <script> tag
// by content.js), so it has full access to page globals and the player API.
//
// Rule: subtitles always follow the video's native language —
//   native Spanish -> Spanish subtitles
//   native English -> English subtitles
//   any other native language -> English subtitles
(function () {
  'use strict';

  var TAG = '[AutoNativeSubs]';

  var MAX_ATTEMPTS = 6;
  var RETRY_MS = 4000;
  var VERIFY_MS = 600;
  var NAV_SETTLE_MS = 500;
  var currentSeq = 0;

  var DEFAULT_RULES = [
    { native: 'es', subtitles: 'es' },
    { native: 'en', subtitles: 'en' }
  ];
  var DEFAULT_FALLBACK = 'en';

  function normalizeConfig(raw) {
    var config = { rules: [], fallback: DEFAULT_FALLBACK };
    try {
      if (raw && typeof raw === 'object') {
        if (typeof raw.fallback === 'string' && raw.fallback) {
          config.fallback = raw.fallback;
        }
        if (Array.isArray(raw.rules)) {
          for (var i = 0; i < raw.rules.length; i++) {
            var rule = raw.rules[i] || {};
            if (typeof rule.native === 'string' && rule.native &&
              typeof rule.subtitles === 'string' && rule.subtitles) {
              config.rules.push({ native: rule.native, subtitles: rule.subtitles });
            }
          }
        }
      }
    } catch (err) {
      console.warn(TAG, 'invalid saved settings, using defaults', err);
    }
    if (config.rules.length === 0) {
      config.rules = DEFAULT_RULES.slice();
    }
    return config;
  }

  var CONFIG = normalizeConfig(window.__AUTO_NATIVE_SUBS_CONFIG__);

  if (window.__AUTO_NATIVE_SUBS_LOADED__) {
    return;
  }
  window.__AUTO_NATIVE_SUBS_LOADED__ = true;
  try {
    window.__AUTO_NATIVE_SUBS_VERSION__ = document.documentElement.getAttribute('data-anns-version') || 'unknown';
  } catch (err) {
    console.warn(TAG, 'could not read stamped version', err);
    window.__AUTO_NATIVE_SUBS_VERSION__ = 'unknown';
  }

  function normalizeBase(code) {
    return String(code || '').split('-')[0].toLowerCase();
  }

  function getPlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
        return window.ytInitialPlayerResponse;
      }
      if (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
        var pr = window.ytplayer.config.args.player_response;
        if (typeof pr === 'string') {
          return JSON.parse(pr);
        }
        if (pr && typeof pr === 'object') {
          return pr;
        }
      }
    } catch (err) {
      console.warn(TAG, 'could not read player response', err);
    }
    return null;
  }

  function getPlayerResponseFromPlayer(player) {
    try {
      if (player && typeof player.getPlayerResponse === 'function') {
        var pr = player.getPlayerResponse();
        if (pr && typeof pr === 'object') {
          return pr;
        }
      }
    } catch (err) {
      console.warn(TAG, 'could not read player.getPlayerResponse()', err);
    }
    return null;
  }

  function getTracklistRenderer(playerResponse) {
    if (!playerResponse || !playerResponse.captions) {
      return null;
    }
    return playerResponse.captions.playerCaptionsTracklistRenderer || null;
  }

  function getCaptionTracks(playerResponse) {
    try {
      var renderer = getTracklistRenderer(playerResponse);
      return (renderer && renderer.captionTracks) || [];
    } catch (err) {
      console.warn(TAG, 'could not read caption tracks', err);
      return [];
    }
  }

  function getAudioTracks(playerResponse) {
    try {
      var renderer = getTracklistRenderer(playerResponse);
      return (renderer && renderer.audioTracks) || [];
    } catch (err) {
      console.warn(TAG, 'could not read audio tracks', err);
      return [];
    }
  }

  // The static page data can be empty or stale (seen in the wild as
  // captionTracks: [] on videos that do offer captions). The live player is
  // the source of truth for what is selectable right now.
  // Normalizes both the page-data shape ({languageCode, vssId, kind,
  // name: {simpleText}}) and the getOption('captions', 'tracklist') shape
  // ({languageCode, vss_id, kind, is_translateable, ...}).
  function normalizeTrack(entry) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    var code = entry.languageCode || entry.language_code || entry.language || '';
    if (!code) {
      return null;
    }
    var rawName = entry.name;
    var name = '';
    if (rawName && typeof rawName === 'object' && rawName.simpleText) {
      name = rawName.simpleText;
    } else if (typeof rawName === 'string') {
      name = rawName;
    } else if (entry.displayName) {
      name = String(entry.displayName);
    }
    return {
      languageCode: code,
      vssId: entry.vssId || entry.vss_id || entry.id || '',
      kind: entry.kind || '',
      name: name,
      translatable: entry.is_translateable === true || entry.isTranslatable === true,
      raw: entry
    };
  }

  function getLiveTracklist(player) {
    try {
      if (typeof player.loadModule === 'function') {
        player.loadModule('captions');
      }
    } catch (err) {
      console.warn(TAG, 'captions module load notice', err);
    }
    try {
      if (typeof player.getOption !== 'function') {
        return [];
      }
      var list = null;
      try {
        list = player.getOption('captions', 'tracklist', { includeAsr: true });
      } catch (asrErr) {
        console.warn(TAG, 'tracklist with asr flag unsupported, retrying plain', asrErr);
      }
      if (!list) {
        list = player.getOption('captions', 'tracklist');
      }
      if (!list || !list.length) {
        return [];
      }
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var normalized = normalizeTrack(list[i]);
        if (normalized) {
          out.push(normalized);
        }
      }
      return out;
    } catch (err) {
      console.warn(TAG, 'could not read live caption tracklist', err);
      return [];
    }
  }

  function mergeTracks(staticTracks, liveTracks) {
    var merged = [];
    var seen = {};
    var i;
    function push(entry) {
      var normalized = normalizeTrack(entry);
      if (!normalized) {
        return;
      }
      var key = normalizeBase(normalized.languageCode) + '|' + String(normalized.vssId || '');
      if (seen[key]) {
        return;
      }
      seen[key] = true;
      merged.push(normalized);
    }
    for (i = 0; i < staticTracks.length; i++) {
      push(staticTracks[i]);
    }
    for (i = 0; i < liveTracks.length; i++) {
      push(liveTracks[i]);
    }
    return merged;
  }

  // An "auto" track is one YouTube generated from the audio itself: explicitly
  // marked ASR, or carrying a dot-prefixed vssId (".es"), YouTube's marker for
  // auto-generated tracks. Auto-translate tracks are excluded — they mirror
  // another language, not the audio.
  function isAutoTrack(track) {
    if (!track || track.translatable) {
      return false;
    }
    if (track.kind === 'asr') {
      return true;
    }
    return typeof track.vssId === 'string' && track.vssId.charAt(0) === '.';
  }

  // Native-language detection, best signal first:
  // 1. Auto-generated (ASR) caption track in the page data — made from the audio.
  // 2. Single audio track language.
  // 3. The "original" audio track when several dubs exist.
  // 4. Auto track from the live player list (kind "asr", or a dot-prefixed
  //    vssId such as ".es"). Auto-translate tracks are only a last resort —
  //    they mirror another language, not the audio.
  // 5. First caption track as a last resort.
  function detectNativeLanguage(playerResponse, extraTracks) {
    var tracks = getCaptionTracks(playerResponse);
    var i;
    for (i = 0; i < tracks.length; i++) {
      if (tracks[i] && tracks[i].kind === 'asr' && tracks[i].languageCode) {
        return tracks[i].languageCode;
      }
    }
    var audioTracks = getAudioTracks(playerResponse);
    if (audioTracks.length === 1 && audioTracks[0] && audioTracks[0].languageCode) {
      return audioTracks[0].languageCode;
    }
    if (audioTracks.length > 1) {
      for (i = 0; i < audioTracks.length; i++) {
        var entry = audioTracks[i] || {};
        var name = (entry.name && entry.name.simpleText) || '';
        if (/original/i.test(name) && entry.languageCode) {
          return entry.languageCode;
        }
      }
    }
    var live = extraTracks || [];
    for (i = 0; i < live.length; i++) {
      if (isAutoTrack(live[i]) && live[i].languageCode) {
        return live[i].languageCode;
      }
    }
    for (i = 0; i < live.length; i++) {
      var auto = live[i] || {};
      if (typeof auto.vssId === 'string' && auto.vssId.charAt(0) === '.' && auto.languageCode) {
        return auto.languageCode;
      }
    }
    if (tracks.length > 0 && tracks[0] && tracks[0].languageCode) {
      return tracks[0].languageCode;
    }
    for (i = 0; i < live.length; i++) {
      if (live[i] && !live[i].translatable && live[i].languageCode) {
        return live[i].languageCode;
      }
    }
    return null;
  }

  function chooseTargetLanguage(nativeLanguage) {
    var base = normalizeBase(nativeLanguage);
    for (var i = 0; i < CONFIG.rules.length; i++) {
      if (normalizeBase(CONFIG.rules[i].native) === base) {
        return CONFIG.rules[i].subtitles;
      }
    }
    return CONFIG.fallback;
  }

  // Preferred track for the target language, else English, else first available.
  function pickTrack(targetBase, tracks) {
    var i;
    for (i = 0; i < tracks.length; i++) {
      if (tracks[i] && normalizeBase(tracks[i].languageCode) === targetBase) {
        return { track: tracks[i], tlang: null };
      }
    }
    var fallbackBase = normalizeBase(CONFIG.fallback);
    for (i = 0; i < tracks.length; i++) {
      if (tracks[i] && normalizeBase(tracks[i].languageCode) === fallbackBase) {
        return { track: tracks[i], tlang: null };
      }
    }
    var base = null;
    for (i = 0; i < tracks.length; i++) {
      if (tracks[i] && tracks[i].kind === 'asr') {
        base = tracks[i];
        break;
      }
    }
    if (!base) {
      base = tracks[0] || null;
    }
    if (!base) {
      return null;
    }
    return { track: base, tlang: fallbackBase };
  }

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function currentTrackCode(player) {
    try {
      if (typeof player.getOption !== 'function') {
        return null;
      }
      var track = player.getOption('captions', 'track');
      return (track && track.languageCode) || null;
    } catch (err) {
      console.warn(TAG, 'could not read current caption track', err);
      return null;
    }
  }

  function selectTrack(player, track, methodIdx, tlang) {
    try {
      if (typeof player.loadModule === 'function') {
        player.loadModule('captions');
      }
    } catch (err) {
      console.warn(TAG, 'captions module load notice', err);
    }
    if (methodIdx === 3) {
      try {
        player.setTrackToLanguage(track.languageCode);
      } catch (err) {
        console.warn(TAG, 'caption track select failed (method 3)', err);
      }
    } else {
      var opt = null;
      if (methodIdx === 0 && track.raw && typeof track.raw === 'object') {
        opt = {};
        for (var key in track.raw) {
          if (Object.prototype.hasOwnProperty.call(track.raw, key)) {
            opt[key] = track.raw[key];
          }
        }
      } else {
        opt = { languageCode: track.languageCode };
        if (methodIdx === 2 && track.vssId) {
          opt.vssId = track.vssId;
        }
      }
      if (tlang) {
        opt.translationLanguage = { languageCode: tlang };
      }
      try {
        player.setOption('captions', 'track', opt);
      } catch (err) {
        console.warn(TAG, 'caption track select failed (method ' + methodIdx + ')', err);
      }
    }
    try {
      player.setOption('captions', 'reload', true);
    } catch (err) {
      console.warn(TAG, 'setOption captions/reload failed', err);
    }
  }

  function trackLabel(track) {
    if (!track) {
      return '?';
    }
    var label = track.languageCode || '?';
    if (track.vssId) {
      label += ' [' + track.vssId + ']';
    }
    var name = '';
    if (track.name) {
      name = (typeof track.name === 'object' && track.name.simpleText) ?
        track.name.simpleText : String(track.name);
    }
    return name ? label + ' (' + name + ')' : label;
  }

  var CODE_NAMES = {
    es: ['spanish', 'español', 'espagnol', 'spanisch', 'spagnolo'],
    en: ['english', 'inglés', 'ingles', 'anglais', 'englisch', 'inglese'],
    fr: ['french', 'français', 'francais', 'französisch', 'francese'],
    de: ['german', 'deutsch', 'allemand', 'alemán', 'tedesco'],
    it: ['italian', 'italiano', 'italien'],
    pt: ['portuguese', 'português', 'portugues', 'portugiesisch'],
    nl: ['dutch', 'nederlands', 'néerlandais'],
    ru: ['russian', 'ruso', 'russe', 'russisch'],
    ja: ['japanese', 'japonés', 'japones', 'japonais', 'japanisch'],
    zh: ['chinese', 'chino', 'chinois', 'chinesisch'],
    ko: ['korean', 'coreano', 'coréen'],
    ar: ['arabic', 'árabe', 'arabe'],
    hi: ['hindi', 'hindí'],
    tr: ['turkish', 'turco', 'turc']
  };

  function audioNameToBase(name) {
    var lower = String(name || '').toLowerCase();
    if (!lower) {
      return '';
    }
    for (var code in CODE_NAMES) {
      if (!Object.prototype.hasOwnProperty.call(CODE_NAMES, code)) {
        continue;
      }
      var names = CODE_NAMES[code];
      for (var i = 0; i < names.length; i++) {
        if (lower.indexOf(names[i]) !== -1) {
          return code;
        }
      }
    }
    return '';
  }

  function audioTrackInfo(entry) {
    var name = '';
    var code = '';
    try {
      if (entry && typeof entry === 'object') {
        if (typeof entry.getLanguageInfo === 'function') {
          var li = entry.getLanguageInfo() || {};
          name = li.name || li.languageName || '';
          code = li.languageCode || li.code || '';
        }
        var ep = entry.EP || entry.ep || {};
        if (!name) {
          name = ep.name || entry.name || entry.displayName || '';
        }
        if (!code) {
          code = entry.languageCode || '';
          if (!code && ep.id) {
            var m = String(ep.id).match(/^([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,4})?)\./);
            if (m) {
              code = m[1];
            }
          }
        }
      }
    } catch (err) {
      console.warn(TAG, 'could not parse audio track', err);
    }
    return { name: name, code: code };
  }

  function currentAudioBase(player) {
    try {
      if (!player || typeof player.getAudioTrack !== 'function') {
        return null;
      }
      var info = audioTrackInfo(player.getAudioTrack());
      return normalizeBase(info.code) || audioNameToBase(info.name) || null;
    } catch (err) {
      console.warn(TAG, 'could not read current audio track', err);
      return null;
    }
  }

  function findVideoEl(player) {
    try {
      if (!player) {
        return null;
      }
      if (player.shadowRoot) {
        var shadowVideo = player.shadowRoot.querySelector('video');
        if (shadowVideo) {
          return shadowVideo;
        }
      }
      return player.querySelector('video');
    } catch (err) {
      console.warn(TAG, 'could not find video element', err);
      return null;
    }
  }

  function waitForStable(player, done) {
    var start = Date.now();
    (function poll() {
      var ok = false;
      var failed = false;
      try {
        var v = findVideoEl(player);
        ok = !!v && !v.paused && !v.seeking && v.readyState >= 3;
      } catch (err) {
        failed = true;
        console.warn(TAG, 'stability check failed', err);
      }
      if (failed) {
        done(false);
        return;
      }
      if (ok) {
        window.setTimeout(function () {
          done(true);
        }, 500);
        return;
      }
      if (Date.now() - start >= 15000) {
        done(false);
        return;
      }
      window.setTimeout(poll, 300);
    })();
  }

  function gatherData(player) {
    var playerResponse = getPlayerResponseFromPlayer(player) || getPlayerResponse();
    var staticTracks = playerResponse ? getCaptionTracks(playerResponse) : [];
    var liveTracks = getLiveTracklist(player);
    var audioCaps = [];
    try {
      var audioEntry = (typeof player.getAudioTrack === 'function') ? player.getAudioTrack() : null;
      if (audioEntry && audioEntry.captionTracks) {
        audioCaps = audioEntry.captionTracks;
      }
    } catch (err) {
      console.warn(TAG, 'could not read audio caption tracks', err);
    }
    return { playerResponse: playerResponse, staticTracks: staticTracks, liveTracks: liveTracks, audioCaps: audioCaps };
  }

  function currentVideoId() {
    try {
      var path = location.pathname || '';
      if (path === '/watch') {
        var m = /[?&]v=([^&#]+)/.exec(location.search || '');
        return m ? m[1] : null;
      }
      var parts = path.split('/');
      if ((parts[1] === 'shorts' || parts[1] === 'embed' || parts[1] === 'live') && parts[2]) {
        return parts[2];
      }
      return null;
    } catch (err) {
      console.warn(TAG, 'could not read video id from url', err);
      return null;
    }
  }

  function responseMatchesVideo(playerResponse, videoId) {
    if (!playerResponse || !videoId) {
      return true;
    }
    try {
      var id = playerResponse.videoDetails && playerResponse.videoDetails.videoId;
      if (!id) {
        return true;
      }
      return id === videoId;
    } catch (err) {
      console.warn(TAG, 'could not compare response video id', err);
      return true;
    }
  }

  function finishDecision(playerResponse, tracks, liveOnly) {
    var out = { playerResponse: playerResponse, tracks: tracks, native: null, target: null, pick: null, liveOnly: liveOnly };
    if (!tracks.length) {
      return out;
    }
    out.native = detectNativeLanguage(playerResponse, tracks);
    out.target = chooseTargetLanguage(out.native);
    out.pick = pickTrack(out.target, tracks);
    return out;
  }

  function decideTracks(player) {
    var data = gatherData(player);
    if (responseMatchesVideo(data.playerResponse, currentVideoId())) {
      return finishDecision(data.playerResponse, mergeTracks(mergeTracks(data.staticTracks, data.liveTracks), data.audioCaps), false);
    }
    var liveFresh = mergeTracks(data.liveTracks, data.audioCaps);
    if (liveFresh.length) {
      console.info(TAG, 'static data is stale, deciding from live player data');
      return finishDecision(null, liveFresh, true);
    }
    return { playerResponse: data.playerResponse, tracks: [], native: null, target: null, pick: null, liveOnly: true };
  }

  var SUBS_ROW_HINT = /subtit|subt[ií]tulo|sous-titre|untertitel|sottotitol|legenda|ondertitel|cc\b|字幕|자막/i;
  var AUDIO_ROW_HINT = /audio/i;

  function liveEl(root, selector) {
    try {
      return root.querySelector(selector);
    } catch (err) {
      return null;
    }
  }

  function gearButton() {
    return liveEl(document, 'button.ytp-settings-button');
  }

  function settingsMenuEl() {
    return liveEl(document, '.ytp-settings-menu');
  }

  function menuVisible(el) {
    try {
      if (!el) {
        return false;
      }
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') {
        return false;
      }
      var rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch (err) {
      return false;
    }
  }

  function menuOpen() {
    return menuVisible(settingsMenuEl());
  }

  function rowLabel(el) {
    try {
      var labelEl = el.querySelector('.ytp-menuitem-label');
      return (labelEl ? labelEl.textContent : '').trim();
    } catch (err) {
      return '';
    }
  }

  function menuRows() {
    var out = [];
    var nodes = [];
    try {
      nodes = document.querySelectorAll('.ytp-menuitem');
    } catch (err) {
      console.warn(TAG, 'could not list menu rows', err);
      return out;
    }
    for (var i = 0; i < nodes.length; i++) {
      out.push({ el: nodes[i], label: rowLabel(nodes[i]), checked: nodes[i].getAttribute('aria-checked') });
    }
    return out;
  }

  function freshEntries(mainRows) {
    var seen = {};
    var i;
    for (i = 0; i < mainRows.length; i++) {
      seen[mainRows[i].label] = true;
    }
    var out = [];
    var rows = menuRows();
    for (i = 0; i < rows.length; i++) {
      if (rows[i].label && !seen[rows[i].label]) {
        out.push(rows[i]);
      }
    }
    return out.length ? out : null;
  }

  function clickEl(el) {
    try {
      if (!el) {
        return false;
      }
      el.click();
      return true;
    } catch (err) {
      console.warn(TAG, 'menu click failed', err);
      return false;
    }
  }

  function waitForValue(condFn, timeoutMs, done) {
    var start = Date.now();
    (function poll() {
      var value = null;
      try {
        value = condFn() || null;
      } catch (err) {
        console.warn(TAG, 'menu wait check failed', err);
        done(null);
        return;
      }
      if (value) {
        done(value);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        done(null);
        return;
      }
      window.setTimeout(poll, 100);
    })();
  }

  function openSettings(done) {
    if (menuOpen()) {
      done(true);
      return;
    }
    if (!clickEl(gearButton())) {
      console.warn(TAG, 'settings button not found');
      done(false);
      return;
    }
    waitForValue(function () {
      return menuOpen() ? true : null;
    }, 2000, function (v) {
      done(!!v);
    });
  }

  function closeSettings(done) {
    if (!menuOpen()) {
      done(true);
      return;
    }
    if (!clickEl(gearButton())) {
      done(false);
      return;
    }
    waitForValue(function () {
      return menuOpen() ? null : true;
    }, 1500, function (v) {
      done(!!v);
    });
  }

  function ensureMenuClosed(done) {
    if (!menuOpen()) {
      done(true);
      return;
    }
    closeSettings(done);
  }

  function labelMatches(label, names, code) {
    var lower = String(label || '').toLowerCase();
    if (!lower) {
      return false;
    }
    var i;
    for (i = 0; i < (names || []).length; i++) {
      var n = String(names[i] || '').toLowerCase();
      if (n && n.length > 2 && lower.indexOf(n) !== -1) {
        return true;
      }
    }
    if (code) {
      var c = String(code).toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (c && new RegExp('(^|[^a-z])' + c + '([^a-z]|$)').test(lower)) {
        return true;
      }
    }
    return false;
  }

  function trackNamesForMatch(track) {
    var base = normalizeBase(track.languageCode);
    var names = [];
    if (track.name) {
      names.push(track.name);
    }
    var extra = CODE_NAMES[base] || [];
    for (var i = 0; i < extra.length; i++) {
      names.push(extra[i]);
    }
    return { names: names, code: base };
  }

  function isAutoEntry(label) {
    return /auto[\s-]?dub|auto[\s-]?translat|dubbed/i.test(label || '');
  }

  function isVideoPage() {
    var path = location.pathname || '';
    return path === '/watch' ||
      path.indexOf('/shorts/') === 0 ||
      path.indexOf('/embed/') === 0 ||
      path.indexOf('/live/') === 0;
  }

  var playingHandler = null;

  function run() {
    if (!isVideoPage()) {
      return;
    }
    currentSeq += 1;
    var seq = currentSeq;
    var attempts = 0;
    var wantedBase = null;
    if (playingHandler) {
      document.removeEventListener('playing', playingHandler, true);
      playingHandler = null;
    }
    playingHandler = function () {
      if (seq !== currentSeq) {
        return;
      }
      document.removeEventListener('playing', playingHandler, true);
      playingHandler = null;
      window.setTimeout(function () {
        if (seq !== currentSeq || !wantedBase) {
          return;
        }
        var livePlayer = getPlayer();
        if (!livePlayer) {
          return;
        }
        var current = currentTrackCode(livePlayer);
        if (!current || normalizeBase(current) !== wantedBase) {
          console.info(TAG, 'track drifted after playback started (current=' + (current || 'none') +
            '), re-applying');
          attempts = 0;
          attempt();
        }
      }, 1500);
    };
    document.addEventListener('playing', playingHandler, true);

    function scheduleRetry(reason) {
      if (seq !== currentSeq) {
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        console.warn(TAG, 'giving up: ' + reason);
        return;
      }
      attempts += 1;
      console.info(TAG, reason + ' — retry ' + attempts + '/' + MAX_ATTEMPTS);
      window.setTimeout(function () {
        attempt();
      }, RETRY_MS);
    }

    function attempt() {
      if (seq !== currentSeq) {
        return;
      }
      var player = getPlayer();
      if (!player) {
        scheduleRetry('player not ready yet');
        return;
      }
      runSelection(player, false);
    }

    function runSelection(player, audioTried) {
      var data = decideTracks(player);
      if (!data.tracks.length) {
        scheduleRetry(data.playerResponse ? 'no caption tracks exposed yet' : 'player data not ready yet');
        return;
      }
      if (!data.pick) {
        console.warn(TAG, 'no usable caption track found');
        return;
      }
      wantedBase = data.target;
      window.__AUTO_NATIVE_SUBS_LAST__ = {
        extVersion: window.__AUTO_NATIVE_SUBS_VERSION__ || 'unknown',
        available: data.tracks.map(trackLabel),
        native: data.native,
        target: data.target,
        translation: data.pick.tlang,
        picked: trackLabel(data.pick.track),
        currentBefore: currentTrackCode(player),
        currentAfter: null,
        result: 'pending'
      };
      console.info(TAG, 'available: ' + data.tracks.map(trackLabel).join(', ') +
        ' | native=' + (data.native || 'unknown') + ' target=' + data.target +
        (data.pick.tlang ? ' translate=' + data.pick.tlang : '') +
        (data.liveOnly ? ' (live-only)' : ''));
      waitForStable(player, function (stable) {
        if (seq !== currentSeq) {
          return;
        }
        if (!stable) {
          console.info(TAG, 'video not stably playing yet, will re-apply on playback');
          return;
        }
        selectAndVerify(player, data, 0, function (ok) {
          if (seq !== currentSeq) {
            return;
          }
          if (ok) {
            return;
          }
          menuSelectSubtitle(data.pick.track, function (menuOk) {
            if (seq !== currentSeq) {
              return;
            }
            if (!menuOk) {
              afterMenuSubsFailed(player, data, audioTried);
              return;
            }
            verifySelection(player, data, function (menuVerified) {
              if (seq !== currentSeq) {
                return;
              }
              if (menuVerified) {
                return;
              }
              afterMenuSubsFailed(player, data, audioTried);
            });
          });
        });
      });
    }

    function afterMenuSubsFailed(player, data, audioTried) {
      if (seq !== currentSeq) {
        return;
      }
      if (audioTried) {
        console.warn(TAG, 'giving up: subtitle select failed even after audio switch');
        return;
      }
      audioSwitchToOriginal(player, data.native, function (switched) {
        if (seq !== currentSeq) {
          return;
        }
        if (!switched) {
          console.warn(TAG, 'giving up: subtitle select failed and no original audio to switch to');
          return;
        }
        window.setTimeout(function () {
          if (seq !== currentSeq) {
            return;
          }
          var fresh = getPlayer() || player;
          var data2 = gatherData(fresh);
          if (!data2.tracks.length || !data2.pick) {
            console.warn(TAG, 'giving up: no captions after audio switch');
            return;
          }
          wantedBase = data2.target;
          window.__AUTO_NATIVE_SUBS_LAST__.available = data2.tracks.map(trackLabel);
          window.__AUTO_NATIVE_SUBS_LAST__.native = data2.native;
          window.__AUTO_NATIVE_SUBS_LAST__.target = data2.target;
          window.__AUTO_NATIVE_SUBS_LAST__.picked = trackLabel(data2.pick.track);
          window.__AUTO_NATIVE_SUBS_LAST__.result = 'pending';
          menuSelectSubtitle(data2.pick.track, function (menuOk2) {
            if (seq !== currentSeq) {
              return;
            }
            verifySelection(fresh, data2, function (ok2) {
              if (seq !== currentSeq) {
                return;
              }
              if (!ok2) {
                console.warn(TAG, 'giving up: track mismatch even after audio switch');
              }
            });
          });
        }, 2500);
      });
    }

    function verifySelection(player, data, done) {
      window.setTimeout(function () {
        if (seq !== currentSeq) {
          return;
        }
        var current = currentTrackCode(player);
        var currentBase = normalizeBase(current);
        var codeOk = !!current && (currentBase === normalizeBase(data.pick.track.languageCode) ||
          (!!data.pick.tlang && currentBase === normalizeBase(data.pick.tlang)));
        window.__AUTO_NATIVE_SUBS_LAST__.currentAfter = current;
        if (codeOk) {
          window.__AUTO_NATIVE_SUBS_LAST__.result = 'ok';
          console.info(TAG, 'subtitles set to ' + trackLabel(data.pick.track) +
            (data.pick.tlang ? ' translated to ' + data.pick.tlang : '') +
            ' | native=' + (data.native || 'unknown') + ' target=' + data.target);
        }
        done(codeOk);
      }, VERIFY_MS);
    }

    function selectAndVerify(player, data, methodIdx, done) {
      selectTrack(player, data.pick.track, methodIdx, data.pick.tlang);
      verifySelection(player, data, function (codeOk) {
        if (seq !== currentSeq) {
          return;
        }
        if (!codeOk && methodIdx < 3) {
          console.info(TAG, 'select method ' + methodIdx + ' did not stick');
          selectAndVerify(player, data, methodIdx + 1, done);
          return;
        }
        done(codeOk);
      });
    }

    function menuSelectSubtitle(track, done) {
      var spec = trackNamesForMatch(track);
      openSubmenuAndFind(SUBS_ROW_HINT, function (label) {
        return labelMatches(label, spec.names, spec.code);
      }, function (found) {
        if (seq !== currentSeq) {
          return;
        }
        if (!found) {
          console.info(TAG, 'subtitle entry not found in settings menu');
          done(false);
          return;
        }
        if (!clickEl(found.el)) {
          done(false);
          return;
        }
        closeSettings(function () {
          if (seq !== currentSeq) {
            return;
          }
          console.info(TAG, 'menu selected subtitle: ' + found.label);
          done(true);
        });
      });
    }

    function openSubmenuAndFind(hintRe, isWanted, done) {
      if (seq !== currentSeq) {
        return;
      }
      ensureMenuClosed(function (closed) {
        if (seq !== currentSeq) {
          return;
        }
        if (!closed) {
          console.warn(TAG, 'settings menu would not close');
          done(null);
          return;
        }
        openSettings(function (opened) {
          if (seq !== currentSeq) {
            return;
          }
          if (!opened) {
            console.warn(TAG, 'settings menu would not open');
            done(null);
            return;
          }
          var tried = {};
          explore(menuRows());
          function explore(rows) {
            if (seq !== currentSeq) {
              return;
            }
            var order = [];
            var i;
            for (i = 0; i < rows.length; i++) {
              if (!rows[i].label || tried[rows[i].label] || rows[i].checked !== null) {
                continue;
              }
              if (hintRe && hintRe.test(rows[i].label)) {
                order.unshift(rows[i]);
              } else {
                order.push(rows[i]);
              }
            }
            tryRow(0);
            function tryRow(idx) {
              if (seq !== currentSeq) {
                return;
              }
              if (idx >= order.length) {
                closeSettings(function () {
                  done(null);
                });
                return;
              }
              tried[order[idx].label] = true;
              if (!clickEl(order[idx].el)) {
                tryRow(idx + 1);
                return;
              }
              waitForValue(function () {
                return freshEntries(rows);
              }, 1500, function (entries) {
                if (seq !== currentSeq) {
                  return;
                }
                if (entries && entries.length) {
                  window.setTimeout(function () {
                    if (seq !== currentSeq) {
                      return;
                    }
                    var current2 = freshEntries(rows) || [];
                    var hits = [];
                    var j;
                    for (j = 0; j < current2.length; j++) {
                      if (isWanted(current2[j].label)) {
                        hits.push(current2[j]);
                      }
                    }
                    hits.sort(function (a, b) {
                      return (isAutoEntry(a.label) ? 1 : 0) - (isAutoEntry(b.label) ? 1 : 0);
                    });
                    if (hits.length) {
                      done(hits[0]);
                      return;
                    }
                    reopen();
                  }, 400);
                  return;
                }
                reopen();
              });
            }
            function reopen() {
              if (seq !== currentSeq) {
                return;
              }
              closeSettings(function () {
                if (seq !== currentSeq) {
                  return;
                }
                openSettings(function (reopened) {
                  if (seq !== currentSeq) {
                    return;
                  }
                  if (!reopened) {
                    done(null);
                    return;
                  }
                  explore(menuRows());
                });
              });
            }
          }
        });
      });
    }

    function audioSwitchToOriginal(player, nativeLanguage, done) {
      var nativeBase = normalizeBase(nativeLanguage);
      var current = currentAudioBase(player);
      if (current && current === nativeBase) {
        done(false);
        return;
      }
      openSubmenuAndFind(AUDIO_ROW_HINT, function (label) {
        return labelMatches(label, CODE_NAMES[nativeBase] || [], nativeBase);
      }, function (found) {
        if (seq !== currentSeq) {
          return;
        }
        if (!found) {
          console.info(TAG, 'no native-language audio option in menu');
          done(false);
          return;
        }
        if (!clickEl(found.el)) {
          done(false);
          return;
        }
        closeSettings(function () {
          if (seq !== currentSeq) {
            return;
          }
          window.setTimeout(function () {
            if (seq !== currentSeq) {
              return;
            }
            var now = currentAudioBase(getPlayer() || player);
            console.info(TAG, 'audio now: ' + (now || 'unknown'));
            done(!!now && now === nativeBase);
          }, 2500);
        });
      });
    }

    attempt();
  }

  function onNavigate() {
    // Small delay so the new video's player response is in place.
    window.setTimeout(run, NAV_SETTLE_MS);
  }

  window.addEventListener('message', function (event) {
    try {
      var data = event && event.data;
      if (!data || data.type !== 'ANNS_CONFIG' || !data.config) {
        return;
      }
      CONFIG = normalizeConfig(data.config);
      console.info(TAG, 'settings updated, re-applying');
      run();
    } catch (err) {
      console.warn(TAG, 'could not apply updated settings', err);
    }
  });

  document.addEventListener('yt-navigate-finish', onNavigate);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onNavigate, { once: true });
  } else {
    onNavigate();
  }
})();
