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
      translatable: entry.is_translateable === true || entry.isTranslatable === true
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
      var list = player.getOption('captions', 'tracklist');
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
        return tracks[i];
      }
    }
    var fallbackBase = normalizeBase(CONFIG.fallback);
    for (i = 0; i < tracks.length; i++) {
      if (tracks[i] && normalizeBase(tracks[i].languageCode) === fallbackBase) {
        return tracks[i];
      }
    }
    return tracks[0] || null;
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

  function selectTrack(player, track, methodIdx) {
    try {
      if (typeof player.loadModule === 'function') {
        player.loadModule('captions');
      }
    } catch (err) {
      console.warn(TAG, 'captions module load notice', err);
    }
    try {
      if (methodIdx === 2) {
        player.setTrackToLanguage(track.languageCode);
      } else if (methodIdx === 1 && track.vssId) {
        player.setOption('captions', 'track', { languageCode: track.languageCode, vssId: track.vssId });
      } else {
        player.setOption('captions', 'track', { languageCode: track.languageCode });
      }
    } catch (err) {
      console.warn(TAG, 'caption track select failed (method ' + methodIdx + ')', err);
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

  function isVideoPage() {
    var path = location.pathname || '';
    return path === '/watch' ||
      path.indexOf('/shorts/') === 0 ||
      path.indexOf('/embed/') === 0 ||
      path.indexOf('/live/') === 0;
  }

  function run() {
    if (!isVideoPage()) {
      return;
    }
    currentSeq += 1;
    var seq = currentSeq;
    var attempts = 0;

    function scheduleRetry(reason, nextMethod) {
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
        attempt(nextMethod);
      }, RETRY_MS);
    }

    function attempt(methodIdx) {
      if (seq !== currentSeq) {
        return;
      }
      var player = getPlayer();
      if (!player) {
        scheduleRetry('player not ready yet', 0);
        return;
      }
      var playerResponse = getPlayerResponseFromPlayer(player) || getPlayerResponse();
      var staticTracks = playerResponse ? getCaptionTracks(playerResponse) : [];
      var tracks = mergeTracks(staticTracks, getLiveTracklist(player));
      if (tracks.length === 0) {
        if (!playerResponse) {
          scheduleRetry('player data not ready yet', 0);
        } else {
          scheduleRetry('no caption tracks exposed yet', 0);
        }
        return;
      }
      var nativeLanguage = detectNativeLanguage(playerResponse, tracks);
      var targetBase = chooseTargetLanguage(nativeLanguage);
      var track = pickTrack(targetBase, tracks);
      if (!track) {
        console.warn(TAG, 'no usable caption track found');
        return;
      }
      window.__AUTO_NATIVE_SUBS_LAST__ = {
        available: tracks.map(trackLabel),
        native: nativeLanguage,
        target: targetBase,
        picked: trackLabel(track),
        currentBefore: currentTrackCode(player),
        currentAfter: null,
        result: 'pending'
      };
      console.info(TAG, 'available: ' + tracks.map(trackLabel).join(', ') +
        ' | native=' + (nativeLanguage || 'unknown') + ' target=' + targetBase);
      selectTrack(player, track, methodIdx);
      window.setTimeout(function () {
        if (seq !== currentSeq) {
          return;
        }
        var current = currentTrackCode(player);
        var codeOk = current && normalizeBase(current) === normalizeBase(track.languageCode);
        window.__AUTO_NATIVE_SUBS_LAST__.currentAfter = current;
        if (codeOk) {
          window.__AUTO_NATIVE_SUBS_LAST__.result = 'ok';
          console.info(TAG, 'subtitles set to ' + trackLabel(track) +
            ' | native=' + (nativeLanguage || 'unknown') + ' target=' + targetBase);
        } else if (methodIdx < 2) {
          scheduleRetry('method ' + methodIdx + ' did not stick (current=' + (current || 'none') +
            '), trying next method', methodIdx + 1);
        } else {
          scheduleRetry('track mismatch (current=' + (current || 'none') +
            ', expected=' + track.languageCode + ')', 0);
        }
      }, VERIFY_MS);
    }

    attempt(0);
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
