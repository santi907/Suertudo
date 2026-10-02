import { LIGAS, HOME_ADVANTAGE, DIXON_COLES_RHO } from './leagues.js';
import { simulateMatch } from './model.js';
import { calcularTasasBase, ajustarHomeAdvantage, ajustarRho, shrinkHaciaBase } from './calibrate.js';

// ============ CONFIGURACIÓN DE CALIBRACIÓN ============
const CAL_ITERACIONES = 7;         // cuántas pasadas de ajuste
const CAL_MUESTRA = 60;            // cuántos partidos usar por iteración
const CAL_MIN_PARTIDOS = 20;       // por debajo de esto, no calibrar
const SHRINK_ALPHA = 0.15;         // 0 = sin shrinkage, 1 = solo tasas base

// ============ MÉTRICAS DE DEVIG ============
function devigar2(oddsA, oddsB) {
  if (!oddsA || !oddsB) return null;
  const pA = 1 / oddsA, pB = 1 / oddsB;
  return (pA / (pA + pB)) * 100;
}
function devigar3(oddsA, oddsB, oddsC) {
  if (!oddsA || !oddsB || !oddsC) return null;
  const pA = 1 / oddsA, pB = 1 / oddsB, pC = 1 / oddsC;
  const s = pA + pB + pC;
  return [(pA / s) * 100, (pB / s) * 100, (pC / s) * 100];
}

// ============ DOM ============
const fileInput = document.getElementById('historial-file');
const fileInfo = document.getElementById('file-info');
const runBtn = document.getElementById('run-btn');
const logSection = document.getElementById('log-section');
const logDiv = document.getElementById('log');
const calibrationSection = document.getElementById('calibration-section');
const calibrationContent = document.getElementById('calibration-content');
const resultsSection = document.getElementById('results');
const resultsContent = document.getElementById('results-content');
const exportSection = document.getElementById('export-section');
const exportBtn = document.getElementById('export-btn');

let historial = null;
let filasComparacion = [];
let calibracionUsada = null;

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  runBtn.disabled = true;
  historial = null;
  if (!file) { fileInfo.textContent = ''; return; }

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.leagueKey || !LIGAS[data.leagueKey]) {
      fileInfo.textContent = '❌ El archivo no tiene una liga reconocida (leagueKey).';
      return;
    }
    if (!Array.isArray(data.partidos) || data.partidos.length === 0) {
      fileInfo.textContent = '❌ El archivo no tiene partidos.';
      return;
    }
    historial = data;
    fileInfo.textContent = `✅ ${data.liga || data.leagueKey} — ${data.partidos.length} partidos cargados.`;
    runBtn.disabled = false;
  } catch (err) {
    fileInfo.textContent = '❌ No se pudo leer el archivo: ' + err.message;
  }
});

function fmt(n) { return Number(n).toFixed(1); }

function log(msg) {
  logSection.style.display = 'block';
  logDiv.textContent += msg + '\n';
  logDiv.scrollTop = logDiv.scrollHeight;
}

// ============ MÉTRICAS ============
class MarketStats {
  constructor(name) {
    this.name = name;
    this.n = 0;
    this.hits = 0;
    this.brierSum = 0;
    this.sumaReal = 0;
    this.buckets = { '0-20': [0, 0], '20-40': [0, 0], '40-60': [0, 0], '60-80': [0, 0], '80-100': [0, 0] };
  }
  add(predictedPct, actualBool) {
    if (predictedPct == null || !Number.isFinite(predictedPct)) return;
    this.n++;
    this.sumaReal += actualBool ? 1 : 0;
    const predictedYes = predictedPct >= 50;
    if (predictedYes === actualBool) this.hits++;
    const p = predictedPct / 100;
    this.brierSum += (p - (actualBool ? 1 : 0)) ** 2;
    const b = predictedPct < 20 ? '0-20' : predictedPct < 40 ? '20-40' : predictedPct < 60 ? '40-60' : predictedPct < 80 ? '60-80' : '80-100';
    this.buckets[b][0] += actualBool ? 1 : 0;
    this.buckets[b][1] += 1;
  }
  summary() {
    const hitRate = this.n ? (this.hits / this.n * 100) : null;
    const brier = this.n ? (this.brierSum / this.n) : null;
    const baseRate = this.n ? (this.sumaReal / this.n) : null;
    const brierBase = baseRate != null ? baseRate * (1 - baseRate) : null;
    const mejoraVsBase = (brier != null && brierBase != null && brierBase > 0.0001)
      ? ((brierBase - brier) / brierBase * 100) : null;
    return { name: this.name, n: this.n, hitRate, brier, baseRate, brierBase, mejoraVsBase, buckets: this.buckets };
  }
}

// ============ CALIBRACIÓN AUTOMÁTICA ============
async function calibrarLiga(leagueKey, partidos) {
  const tasas = calcularTasasBase(partidos);
  if (tasas.n < CAL_MIN_PARTIDOS) {
    log(`⚠️ Solo ${tasas.n} partidos con resultado — se omite la calibración (mínimo ${CAL_MIN_PARTIDOS}).`);
    return { calibracion: null, tasas, historial: [] };
  }

  log(`\n🎯 Calibrando liga (${tasas.n} partidos)... [v2]`);
  log(`   Tasa real: local ${fmt(tasas.homeRate*100)}% · empate ${fmt(tasas.drawRate*100)}% · visitante ${fmt(tasas.awayRate*100)}%`);
  log(`   Goles promedio: ${fmt(tasas.goalsAvg)} · Córners: ${fmt(tasas.cornAvg)}`);

  let homeAdv = HOME_ADVANTAGE[leagueKey] ?? 1.05;
  let rho = DIXON_COLES_RHO[leagueKey] ?? DIXON_COLES_RHO.default ?? -0.1;
  const historial = [];

  // Muestreo distribuido a lo largo del historial
  const muestra = [];
  const step = Math.max(1, Math.floor(partidos.length / CAL_MUESTRA));
  for (let i = 0; i < partidos.length && muestra.length < CAL_MUESTRA; i += step) {
    if (partidos[i].goles_local != null && partidos[i].local && partidos[i].visitante) {
      muestra.push(partidos[i]);
    }
  }

  for (let iter = 0; iter < CAL_ITERACIONES; iter++) {
    // Medimos PROMEDIO de probabilidades (continuo, estable), no argmax
    let sumL = 0, sumE = 0, sumV = 0, n = 0;
    for (const p of muestra) {
      try {
        const pred = await simulateMatch(leagueKey, p.local, p.visitante, {
          staticOnly: true,
          calibracion: { homeAdvantage: homeAdv, rho }
        });
        const rp = pred.resultProbs;
        sumL += rp.local;
        sumE += rp.empate;
        sumV += rp.visitante;
        n++;
      } catch (e) { /* skip */ }
    }
    if (n === 0) break;

    const predHomeRate = sumL / n / 100;
    const predDrawRate = sumE / n / 100;
    const predAwayRate = sumV / n / 100;
    const err = Math.abs(tasas.homeRate - predHomeRate)
              + Math.abs(tasas.drawRate - predDrawRate)
              + Math.abs(tasas.awayRate - predAwayRate);

    historial.push({
      iter: iter + 1,
      homeAdv, rho,
      predHome: predHomeRate, predDraw: predDrawRate, predAway: predAwayRate,
      err
    });

    log(`   [iter ${iter + 1}] homeAdv=${homeAdv.toFixed(3)} rho=${rho.toFixed(3)} → prob media L:${fmt(predHomeRate*100)}% E:${fmt(predDrawRate*100)}% V:${fmt(predAwayRate*100)}% (err ${fmt(err*100)}%)`);

    if (err < 0.02) {
      log(`   ✓ Convergió (error < 2%)`);
      break;
    }

    homeAdv = ajustarHomeAdvantage(homeAdv, tasas, predHomeRate);
    rho = ajustarRho(rho, tasas, predDrawRate);
  }

  return {
    calibracion: { homeAdvantage: homeAdv, rho },
    tasas,
    historial
  };
}

function renderCalibracion(resultado) {
  if (!resultado) return;
  const { calibracion, tasas, historial } = resultado;
  calibrationSection.style.display = 'block';

  if (!calibracion) {
    calibrationContent.innerHTML = `<p style="color:var(--chalk-dim)">Liga con ${tasas.n} partidos — no se calibró (mínimo ${CAL_MIN_PARTIDOS}).</p>`;
    return;
  }

  const ultimo = historial[historial.length - 1];
  const fila = (label, real, pred) => {
    const d = Math.abs(real - pred);
    const color = d < 0.03 ? 'var(--green)' : d < 0.06 ? 'var(--yellow)' : 'var(--red)';
    return `
      <div class="compare-row">
        <span>${label}</span>
        <span class="grid-plain">real ${fmt(real*100)}%</span>
        <span class="grid-plain" style="color:${color}">pred ${fmt(pred*100)}%</span>
      </div>`;
  };

  const originalHA = HOME_ADVANTAGE[resultado.leagueKey] ?? HOME_ADVANTAGE['PL'];
  const originalRho = DIXON_COLES_RHO[resultado.leagueKey] ?? DIXON_COLES_RHO.default;

  calibrationContent.innerHTML = `
    <div class="card">
      <h3>Parámetros derivados <small>(auto)</small></h3>
      <div class="compare-row">
        <span>HOME_ADVANTAGE</span>
        <span class="grid-plain">${(originalHA ?? 1.05).toFixed(3)} original</span>
        <span class="prob" style="color:var(--green)">${calibracion.homeAdvantage.toFixed(3)}</span>
      </div>
      <div class="compare-row">
        <span>DIXON_COLES_RHO</span>
        <span class="grid-plain">${(originalRho ?? -0.1).toFixed(3)} original</span>
        <span class="prob" style="color:var(--green)">${calibracion.rho.toFixed(3)}</span>
      </div>
      <h3 class="corner-team-title">Distribución: real vs predicha (calibrada)</h3>
      <div class="compare-row compare-head"><span>Resultado</span><span>Real</span><span>Modelo</span></div>
      ${fila('Local gana', tasas.homeRate, ultimo.predHome)}
      ${fila('Empate', tasas.drawRate, ultimo.predDraw)}
      ${fila('Visitante gana', tasas.awayRate, ultimo.predAway)}
      <p style="margin:10px 0 0; font-size:0.8rem; color:var(--chalk-dim)">
        Error total: ${fmt(ultimo.err * 100)}% — ${historial.length} iteraciones.
        ${SHRINK_ALPHA > 0 ? `Shrinkage activo (α=${SHRINK_ALPHA}).` : ''}
      </p>
    </div>`;
}

// ============ RUN ============
runBtn.addEventListener('click', async () => {
  if (!historial) return;
  runBtn.disabled = true;
  logDiv.textContent = '';
  resultsSection.style.display = 'none';
  exportSection.style.display = 'none';
  calibrationSection.style.display = 'none';
  filasComparacion = [];

  const leagueKey = historial.leagueKey;
  const partidos = historial.partidos;

  // === 1. Calibración automática ===
  const calResult = await calibrarLiga(leagueKey, partidos);
  calResult.leagueKey = leagueKey;
  const calibracion = calResult.calibracion;
  const tasas = calResult.tasas;
  calibracionUsada = calibracion;
  renderCalibracion(calResult);

  // === 2. Backtest con calibración aplicada ===
  log(`\n▶ Corriendo backtest con calibración ${calibracion ? 'ACTIVA' : 'por defecto'}...`);

  const markets = {
    local: new MarketStats('Local gana'),
    empate: new MarketStats('Empate'),
    visitante: new MarketStats('Visitante gana'),
    over15: new MarketStats('Over 1.5 goles'),
    over25: new MarketStats('Over 2.5 goles'),
    over35: new MarketStats('Over 3.5 goles'),
    btts: new MarketStats('Ambos marcan'),
    corners75: new MarketStats('Over 7.5 córners'),
    corners85: new MarketStats('Over 8.5 córners'),
    corners95: new MarketStats('Over 9.5 córners'),
    cornersLocal35: new MarketStats('Córners local Over 3.5'),
    cornersVisit35: new MarketStats('Córners visitante Over 3.5'),
  };
  const mercado = {
    local: new MarketStats('Local gana'),
    empate: new MarketStats('Empate'),
    visitante: new MarketStats('Visitante gana'),
    over15: new MarketStats('Over 1.5 goles'),
    over25: new MarketStats('Over 2.5 goles'),
    over35: new MarketStats('Over 3.5 goles'),
    btts: new MarketStats('Ambos marcan'),
  };
  const modeloVsMercado = {
    local: new MarketStats('Local gana'),
    empate: new MarketStats('Empate'),
    visitante: new MarketStats('Visitante gana'),
    over15: new MarketStats('Over 1.5 goles'),
    over25: new MarketStats('Over 2.5 goles'),
    over35: new MarketStats('Over 3.5 goles'),
    btts: new MarketStats('Ambos marcan'),
  };

  let evaluados = 0, saltados = 0;

  for (const p of partidos) {
    if (p.goles_local == null || p.goles_visitante == null || !p.local || !p.visitante) {
      saltados++;
      continue;
    }

    let pred;
    try {
      pred = await simulateMatch(leagueKey, p.local, p.visitante, {
        staticOnly: true,
        calibracion
      });
    } catch (e) {
      saltados++;
      continue;
    }

    // Aplicar shrinkage hacia la tasa base
    const resultProbsFinal = SHRINK_ALPHA > 0
      ? shrinkHaciaBase(pred.resultProbs, tasas, SHRINK_ALPHA)
      : pred.resultProbs;

    const totalGoles = p.goles_local + p.goles_visitante;
    const resultado = p.goles_local > p.goles_visitante ? 'local' : p.goles_local < p.goles_visitante ? 'visitante' : 'empate';

    markets.local.add(resultProbsFinal.local, resultado === 'local');
    markets.empate.add(resultProbsFinal.empate, resultado === 'empate');
    markets.visitante.add(resultProbsFinal.visitante, resultado === 'visitante');
    markets.over15.add(pred.over15, totalGoles > 1.5);
    markets.over25.add(pred.over25, totalGoles > 2.5);
    markets.over35.add(pred.over35, totalGoles > 3.5);
    markets.btts.add(pred.btts, p.goles_local > 0 && p.goles_visitante > 0);

    if (p.odds_local != null && p.odds_empate != null && p.odds_visitante != null) {
      const [fL, fE, fV] = devigar3(p.odds_local, p.odds_empate, p.odds_visitante) || [];
      if (fL != null) {
        mercado.local.add(fL, resultado === 'local');
        mercado.empate.add(fE, resultado === 'empate');
        mercado.visitante.add(fV, resultado === 'visitante');
        modeloVsMercado.local.add(resultProbsFinal.local, resultado === 'local');
        modeloVsMercado.empate.add(resultProbsFinal.empate, resultado === 'empate');
        modeloVsMercado.visitante.add(resultProbsFinal.visitante, resultado === 'visitante');
      }
    }
    const fOver15 = devigar2(p.odds_over15, p.odds_under15);
    if (fOver15 != null) { mercado.over15.add(fOver15, totalGoles > 1.5); modeloVsMercado.over15.add(pred.over15, totalGoles > 1.5); }
    const fOver25 = devigar2(p.odds_over25, p.odds_under25);
    if (fOver25 != null) { mercado.over25.add(fOver25, totalGoles > 2.5); modeloVsMercado.over25.add(pred.over25, totalGoles > 2.5); }
    const fOver35 = devigar2(p.odds_over35, p.odds_under35);
    if (fOver35 != null) { mercado.over35.add(fOver35, totalGoles > 3.5); modeloVsMercado.over35.add(pred.over35, totalGoles > 3.5); }
    const fBtts = devigar2(p.odds_btts_si, p.odds_btts_no);
    if (fBtts != null) { mercado.btts.add(fBtts, p.goles_local > 0 && p.goles_visitante > 0); modeloVsMercado.btts.add(pred.btts, p.goles_local > 0 && p.goles_visitante > 0); }

    if (p.corners_local != null && p.corners_visitante != null && pred.cornerProbs) {
      const totalCorners = p.corners_local + p.corners_visitante;
      markets.corners75.add(pred.cornerProbs.over7, totalCorners > 7.5);
      markets.corners85.add(pred.cornerProbs.over8, totalCorners > 8.5);
      markets.corners95.add(pred.cornerProbs.over9, totalCorners > 9.5);
      markets.cornersLocal35.add(pred.cornerProbs.porEquipo?.local?.over3, p.corners_local > 3.5);
      markets.cornersVisit35.add(pred.cornerProbs.porEquipo?.visitante?.over3, p.corners_visitante > 3.5);
    }

    filasComparacion.push({
      fecha: p.fecha ?? '',
      local: p.local,
      visitante: p.visitante,
      app: {
        local: resultProbsFinal.local,
        empate: resultProbsFinal.empate,
        visitante: resultProbsFinal.visitante,
        over15: pred.over15, over25: pred.over25, over35: pred.over35, btts: pred.btts,
        corners_over75: pred.cornerProbs?.over7 ?? null,
        corners_over85: pred.cornerProbs?.over8 ?? null,
        corners_over95: pred.cornerProbs?.over9 ?? null,
        corners_local_over35: pred.cornerProbs?.porEquipo?.local?.over3 ?? null,
        corners_visit_over35: pred.cornerProbs?.porEquipo?.visitante?.over3 ?? null,
      },
      real: {
        goles_local: p.goles_local, goles_visitante: p.goles_visitante,
        total_goles: totalGoles, resultado,
        over15: totalGoles > 1.5 ? 1 : 0, over25: totalGoles > 2.5 ? 1 : 0,
        over35: totalGoles > 3.5 ? 1 : 0,
        btts: (p.goles_local > 0 && p.goles_visitante > 0) ? 1 : 0,
        corners_local: p.corners_local ?? null,
        corners_visitante: p.corners_visitante ?? null,
        corners_total: (p.corners_local != null && p.corners_visitante != null) ? p.corners_local + p.corners_visitante : null,
      },
      casa: {
        odds_local: p.odds_local ?? null, odds_empate: p.odds_empate ?? null, odds_visitante: p.odds_visitante ?? null,
        odds_over15: p.odds_over15 ?? null, odds_under15: p.odds_under15 ?? null,
        odds_over25: p.odds_over25 ?? null, odds_under25: p.odds_under25 ?? null,
        odds_over35: p.odds_over35 ?? null, odds_under35: p.odds_under35 ?? null,
        odds_btts_si: p.odds_btts_si ?? null, odds_btts_no: p.odds_btts_no ?? null,
      },
    });

    evaluados++;
    if (evaluados % 20 === 0) log(`  ${evaluados}/${partidos.length}...`);
  }

  log(`\n✅ Listo. ${evaluados} evaluados, ${saltados} salteados.`);

  const mercadoResumen = {};
  for (const [k, m] of Object.entries(mercado)) mercadoResumen[k] = m.summary();
  const modeloVsMercadoResumen = {};
  for (const [k, m] of Object.entries(modeloVsMercado)) modeloVsMercadoResumen[k] = m.summary();

  renderResults(
    Object.entries(markets).map(([k, m]) => ({ key: k, ...m.summary() })),
    mercadoResumen,
    modeloVsMercadoResumen
  );

  exportSection.style.display = filasComparacion.length ? 'block' : 'none';
  runBtn.disabled = false;
});

// ============ RENDER ============
function vsBaseColor(m) {
  if (m == null) return 'var(--chalk-dim)';
  if (m >= 10) return 'var(--green)';
  if (m >= 0) return 'var(--yellow)';
  return 'var(--red)';
}

function vsBaseNote(m, baseRate) {
  if (m == null) return '';
  const signo = m >= 0 ? '+' : '';
  if (m >= 10) return `${signo}${fmt(m)}% mejor que solo saber que esto pasa ${fmt(baseRate)}% de las veces`;
  if (m >= 0) return `${signo}${fmt(m)}% mejor que adivinar el ${fmt(baseRate)}% de siempre`;
  return `${fmt(m)}% peor que adivinar el ${fmt(baseRate)}% de siempre`;
}

function bucketRows(buckets) {
  return Object.entries(buckets)
    .filter(([, v]) => v[1] > 0)
    .map(([range, [hits, total]]) => `
      <div class="compare-row">
        <span>Predijo ${range}%</span>
        <span class="grid-plain">${total} partidos</span>
        <span class="grid-plain">pasó ${fmt(hits / total * 100)}%</span>
      </div>`)
    .join('');
}

function vsMercadoColor(m) {
  if (m == null) return 'var(--chalk-dim)';
  if (m > 2) return 'var(--green)';
  if (m >= -2) return 'var(--yellow)';
  return 'var(--red)';
}

function vsMercadoNote(modeloSum, mercadoSum) {
  if (!mercadoSum || mercadoSum.n < 20) return null;
  const mejora = ((mercadoSum.brier - modeloSum.brier) / mercadoSum.brier) * 100;
  const signo = mejora >= 0 ? '+' : '';
  let texto;
  if (mejora > 2) texto = `${signo}${fmt(mejora)}% mejor que la cuota real`;
  else if (mejora >= -2) texto = `${signo}${fmt(mejora)}% — prácticamente empatado con la cuota real`;
  else texto = `${fmt(mejora)}% peor que la cuota real`;
  return { texto, mejora, n: mercadoSum.n };
}

function renderResults(summaries, mercadoResumen = {}, modeloVsMercadoResumen = {}) {
  const conDatos = summaries.filter(s => s.n > 0);
  if (conDatos.length === 0) {
    resultsContent.innerHTML = `<div class="card"><h3>Sin datos suficientes</h3></div>`;
    resultsSection.style.display = 'block';
    return;
  }

  resultsContent.innerHTML = conDatos.map(s => {
    const vColor = vsBaseColor(s.mejoraVsBase);
    const rows = bucketRows(s.buckets);
    const mComp = s.key ? vsMercadoNote(modeloVsMercadoResumen[s.key], mercadoResumen[s.key]) : null;
    return `
      <div class="card">
        <h3>${s.name} <small>(${s.n} partidos)</small></h3>
        <div class="prob-row">
          <div class="prob-row-top"><span>Acierto (umbral 50%)</span><span class="prob" style="color:${s.hitRate >= 55 ? 'var(--green)' : s.hitRate >= 48 ? 'var(--yellow)' : 'var(--red)'}">${fmt(s.hitRate)}%</span></div>
          <div class="semaforo-track"><div class="semaforo-fill" style="width:${s.hitRate}%;background:${s.hitRate >= 55 ? 'var(--green)' : s.hitRate >= 48 ? 'var(--yellow)' : 'var(--red)'}"></div></div>
        </div>
        <div class="prob-row-top" style="margin-top:10px;">
          <span>Brier score</span>
          <span class="prob">${s.brier.toFixed(3)}</span>
        </div>
        <p style="margin:4px 0 0; font-size:0.8rem; color:${vColor}">${vsBaseNote(s.mejoraVsBase, s.baseRate)}</p>
        ${mComp ? `<p style="margin:8px 0 0; padding-top:8px; border-top:1px dashed var(--line); font-size:0.8rem; color:${vsMercadoColor(mComp.mejora)}"><strong>vs. cuota real (${mComp.n}):</strong> ${mComp.texto}</p>` : ''}
        ${rows ? `<h3 class="corner-team-title">Calibración</h3>${rows}` : ''}
      </div>`;
  }).join('');

  resultsSection.style.display = 'block';
}

// ============ EXPORT ============
function exportarComparacionCSV(filas) {
  if (!filas.length) { alert('No hay partidos para exportar.'); return; }

  const headers = [
    'fecha','local','visitante',
    'APP_local','APP_empate','APP_visitante',
    'APP_over15','APP_over25','APP_over35','APP_btts',
    'APP_corners_over75','APP_corners_over85','APP_corners_over95',
    'APP_corners_local_over35','APP_corners_visit_over35',
    'REAL_goles_local','REAL_goles_visitante','REAL_total_goles','REAL_resultado',
    'REAL_over15','REAL_over25','REAL_over35','REAL_btts',
    'REAL_corners_local','REAL_corners_visitante','REAL_corners_total',
    'CASA_odds_local','CASA_odds_empate','CASA_odds_visitante',
    'CASA_fair_local','CASA_fair_empate','CASA_fair_visitante',
    'CASA_odds_over15','CASA_odds_under15','CASA_fair_over15',
    'CASA_odds_over25','CASA_odds_under25','CASA_fair_over25',
    'CASA_odds_over35','CASA_odds_under35','CASA_fair_over35',
    'CASA_odds_btts_si','CASA_odds_btts_no','CASA_fair_btts_si',
  ];

  const escapar = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v) => (v == null || !Number.isFinite(v)) ? '' : Number(v).toFixed(2);

  const lineas = [headers.join(',')];
  for (const f of filas) {
    const dev3 = devigar3(f.casa.odds_local, f.casa.odds_empate, f.casa.odds_visitante);
    const fairL = dev3 ? dev3[0] : null;
    const fairE = dev3 ? dev3[1] : null;
    const fairV = dev3 ? dev3[2] : null;
    const fairO15 = devigar2(f.casa.odds_over15, f.casa.odds_under15);
    const fairO25 = devigar2(f.casa.odds_over25, f.casa.odds_under25);
    const fairO35 = devigar2(f.casa.odds_over35, f.casa.odds_under35);
    const fairBttsSi = devigar2(f.casa.odds_btts_si, f.casa.odds_btts_no);

    lineas.push([
      f.fecha, f.local, f.visitante,
      num(f.app.local), num(f.app.empate), num(f.app.visitante),
      num(f.app.over15), num(f.app.over25), num(f.app.over35), num(f.app.btts),
      num(f.app.corners_over75), num(f.app.corners_over85), num(f.app.corners_over95),
      num(f.app.corners_local_over35), num(f.app.corners_visit_over35),
      f.real.goles_local, f.real.goles_visitante, f.real.total_goles, f.real.resultado,
      f.real.over15, f.real.over25, f.real.over35, f.real.btts,
      f.real.corners_local ?? '', f.real.corners_visitante ?? '', f.real.corners_total ?? '',
      f.casa.odds_local ?? '', f.casa.odds_empate ?? '', f.casa.odds_visitante ?? '',
      num(fairL), num(fairE), num(fairV),
      f.casa.odds_over15 ?? '', f.casa.odds_under15 ?? '', num(fairO15),
      f.casa.odds_over25 ?? '', f.casa.odds_under25 ?? '', num(fairO25),
      f.casa.odds_over35 ?? '', f.casa.odds_under35 ?? '', num(fairO35),
      f.casa.odds_btts_si ?? '', f.casa.odds_btts_no ?? '', num(fairBttsSi),
    ].map(escapar).join(','));
  }

  const csv = '\uFEFF' + lineas.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ligaSlug = String(historial?.liga || historial?.leagueKey || 'backtest').replace(/\s+/g, '_');
  a.download = `comparacion_${ligaSlug}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

exportBtn.addEventListener('click', () => exportarComparacionCSV(filasComparacion));
