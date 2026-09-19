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

  function fillSelect(select, selectedCode) {
    select.textContent = '';
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
    if (!select.value && ANNS_LANGUAGES.length > 0) {
      select.selectedIndex = 0;
    }
  }

  function addRuleRow(nativeCode, subtitleCode) {
    var row = document.createElement('div');
    row.className = 'row';

    var nativeSelect = document.createElement('select');
    nativeSelect.className = 'native';
    nativeSelect.title = 'Video language';
    fillSelect(nativeSelect, nativeCode);

    var arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';

    var subtitleSelect = document.createElement('select');
    subtitleSelect.className = 'subtitles';
    subtitleSelect.title = 'Subtitle language';
    fillSelect(subtitleSelect, subtitleCode);

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
    row.appendChild(subtitleSelect);
    row.appendChild(removeButton);
    el('rules').appendChild(row);
  }

  function render(config) {
    el('rules').textContent = '';
    var rules = (config && Array.isArray(config.rules)) ? config.rules : [];
    for (var i = 0; i < rules.length; i++) {
      addRuleRow(rules[i].native, rules[i].subtitles);
    }
    fillSelect(el('fallback'), config ? config.fallback : null);
  }

  function collect() {
    var rules = [];
    var seen = {};
    var rows = el('rules').querySelectorAll('.row');
    for (var i = 0; i < rows.length; i++) {
      var native = rows[i].querySelector('.native').value;
      var subtitles = rows[i].querySelector('.subtitles').value;
      if (!native || !subtitles || seen[native]) {
        continue;
      }
      seen[native] = true;
      rules.push({ native: native, subtitles: subtitles });
    }
    return { rules: rules, fallback: el('fallback').value };
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
      addRuleRow('es', 'es');
      setStatus('', false);
    });
    el('save').addEventListener('click', save);
    el('reset').addEventListener('click', reset);
  });
})();
