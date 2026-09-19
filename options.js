(function () {
  'use strict';

  var TAG = '[AutoNativeSubs options]';

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(message, isError) {
    var status = el('status');
    status.textContent = message;
    status.className = isError ? 'error' : '';
  }

  function languageLabel(entry) {
    return entry.name + ' (' + entry.code + ')';
  }

  function fillSelect(select, selectedCode, allowEmpty) {
    select.textContent = '';
    if (allowEmpty) {
      var emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = "Don't change audio";
      if (!selectedCode) {
        emptyOption.selected = true;
      }
      select.appendChild(emptyOption);
    }
    for (var i = 0; i < ANNS_LANGUAGES.length; i++) {
      var entry = ANNS_LANGUAGES[i];
      var option = document.createElement('option');
      option.value = entry.code;
      option.textContent = languageLabel(entry);
      if (entry.code === selectedCode) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    if (!select.value && !allowEmpty && ANNS_LANGUAGES.length > 0) {
      select.selectedIndex = 0;
    }
  }

  function addRuleRow(containerId, targetClass, targetTitle, nativeCode, targetCode) {
    var row = document.createElement('div');
    row.className = 'row';

    var nativeSelect = document.createElement('select');
    nativeSelect.className = 'native';
    nativeSelect.title = 'Video language';
    fillSelect(nativeSelect, nativeCode, false);

    var arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';

    var targetSelect = document.createElement('select');
    targetSelect.className = targetClass;
    targetSelect.title = targetTitle;
    fillSelect(targetSelect, targetCode, false);

    var removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'remove';
    removeButton.textContent = '✕';
    removeButton.title = 'Remove rule';
    removeButton.addEventListener('click', function () {
      row.remove();
    });

    row.appendChild(nativeSelect);
    row.appendChild(arrow);
    row.appendChild(targetSelect);
    row.appendChild(removeButton);
    el(containerId).appendChild(row);
  }

  function renderRules(containerId, targetClass, targetTitle, rules, targetKey) {
    el(containerId).textContent = '';
    var list = Array.isArray(rules) ? rules : [];
    for (var i = 0; i < list.length; i++) {
      addRuleRow(containerId, targetClass, targetTitle, list[i].native, list[i][targetKey]);
    }
  }

  function collectRules(containerId, targetClass, targetKey) {
    var rules = [];
    var seen = {};
    var rows = el(containerId).querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) {
      var native = rows[i].querySelector('.native').value;
      var target = rows[i].querySelector('.' + targetClass).value;
      if (!native || !target || seen[native]) {
        continue;
      }
      seen[native] = true;
      var rule = { native: native };
      rule[targetKey] = target;
      rules.push(rule);
    }
    return rules;
  }

  function render(config) {
    var safe = config || {};
    renderRules('rules', 'subtitles', 'Subtitle language', safe.rules, 'subtitles');
    renderRules('audioRules', 'audio', 'Audio language', safe.audioRules, 'audio');
    fillSelect(el('fallback'), safe.fallback, false);
    fillSelect(el('audioFallback'), safe.audioFallback, true);
  }

  function collect() {
    return {
      rules: collectRules('rules', 'subtitles', 'subtitles'),
      fallback: el('fallback').value,
      audioRules: collectRules('audioRules', 'audio', 'audio'),
      audioFallback: el('audioFallback').value
    };
  }

  function save() {
    var config = collect();
    browser.storage.local.set(config).then(function () {
      setStatus('Saved ✓', false);
    }, function (err) {
      console.error(TAG + ' save failed', err);
      setStatus('Save failed — see console', true);
    });
  }

  function reset() {
    var snapshot = JSON.parse(JSON.stringify(ANNS_DEFAULTS));
    browser.storage.local.set(snapshot).then(function () {
      render(snapshot);
      setStatus('Reset to defaults ✓', false);
    }, function (err) {
      console.error(TAG + ' reset failed', err);
      setStatus('Reset failed — see console', true);
    });
  }

  function load() {
    browser.storage.local.get(ANNS_DEFAULTS).then(function (stored) {
      render(stored);
    }, function (err) {
      console.error(TAG + ' load failed, showing defaults', err);
      render(ANNS_DEFAULTS);
      setStatus('Could not load saved settings — showing defaults', true);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    load();
    el('add').addEventListener('click', function () {
      addRuleRow('rules', 'subtitles', 'Subtitle language', 'es', 'es');
      setStatus('', false);
    });
    el('addAudio').addEventListener('click', function () {
      addRuleRow('audioRules', 'audio', 'Audio language', 'es', 'es');
      setStatus('', false);
    });
    el('save').addEventListener('click', save);
    el('reset').addEventListener('click', reset);
  });
})();
