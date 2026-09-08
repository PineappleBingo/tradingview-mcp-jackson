/**
 * Core indicator settings logic.
 */
import { evaluate } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function setInputs({ entity_id, inputs: inputsRaw }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const escapedId = entity_id.replace(/'/g, "\\'");
  const inputsJson = JSON.stringify(inputs);

  // Validate against metaInfo BEFORE writing. A value outside a categorical input's options is
  // accepted by setInputValues() and echoed back on read, but it wedges the script permanently:
  // verified live on Desktop 3.4 (2026-09-04) by writing the option INDEX instead of its label —
  // reportData() went null and stayed null through every later recompute, and only removing and
  // re-adding the study recovered it. Sweeps enumerate option labels, so this guard is what keeps
  // a hand-written override (or an agent's) from silently destroying the user's Strategy Tester.
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById('${escapedId}');
      if (!study) return { error: 'Study not found: ${escapedId}' };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      // metaInfo lives on the MODEL source, not on the study API object getStudyById returns.
      var meta = [];
      try {
        var srcs = chart._chartWidget.model().model().dataSources();
        for (var d0 = 0; d0 < srcs.length; d0++) {
          var src = srcs[d0], sid = null;
          try { sid = typeof src.id === 'function' ? src.id() : src._id; } catch (e) { continue; }
          if (sid !== '${escapedId}') continue;
          var mi = typeof src.metaInfo === 'function' ? src.metaInfo() : src.metaInfo;
          meta = (mi && mi.inputs) || [];
          break;
        }
      } catch (e) {}
      var byId = {};
      for (var m = 0; m < meta.length; m++) byId[meta[m].id] = meta[m];
      var known = {};
      for (var c = 0; c < currentInputs.length; c++) known[currentInputs[c].id] = true;
      var bad = [], unknown = [];
      for (var k in overrides) {
        if (!overrides.hasOwnProperty(k)) continue;
        if (!known[k]) { unknown.push(k); continue; }
        var d = byId[k], v = overrides[k];
        if (!d) continue;
        if (d.options && d.options.length && d.options.indexOf(v) === -1) {
          bad.push(k + ' (' + (d.name || '') + ') = ' + JSON.stringify(v) + '; allowed: ' + JSON.stringify(d.options));
        } else if (d.type === 'bool' && typeof v !== 'boolean') {
          bad.push(k + ' (' + (d.name || '') + ') = ' + JSON.stringify(v) + '; expects true or false');
        } else if ((d.type === 'integer' || d.type === 'float' || d.type === 'price') && typeof v !== 'number') {
          bad.push(k + ' (' + (d.name || '') + ') = ' + JSON.stringify(v) + '; expects a number');
        }
      }
      if (!meta.length) return { error: "could not read this study's input metadata, so the values cannot be validated; refusing to write blind (a value outside an input's allowed set permanently stops the script computing)" };
      if (bad.length) return { error: 'refusing to write invalid input value(s) — TradingView accepts them and then stops computing the script: ' + bad.join(' | ') };
      if (unknown.length === Object.keys(overrides).length) return { error: 'none of these ids are inputs of this study: ' + unknown.join(', ') };
      var updatedKeys = {};
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
      study.setInputValues(currentInputs);
      return { updated_inputs: updatedKeys, ignored: unknown };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, updated_inputs: result.updated_inputs, ...(result.ignored && result.ignored.length ? { ignored: result.ignored } : {}) };
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const escapedId = entity_id.replace(/'/g, "\\'");
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById('${escapedId}');
      if (!study) return { error: 'Study not found: ${escapedId}' };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
