import { LIGAS } from './leagues.js';
import { simulateMatch } from './model.js';

// Las cuotas de la casa siempre suman más de 100% de probabilidad implícita
// (ahí está su margen/ganancia). Esto lo saca, dejando la probabilidad "justa".
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

const fileInput = document.getElementById('historial-file');
const fileInfo = document.getElementById('file-info');
const runBtn = document.getElementById('run-btn');
const logSection = document.getElementById('log-section');
const logDiv = document.getElementById('log');
const resultsSection = document.getElementById('results');
const resultsContent = document.getElementById('results-content');

let historial = null;

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

// ---------- Métricas ----------
// Brier score: (probabilidad predicha - resultado real 0/1)^2, promediado.
// 0 = perfecto. 0.25 = lo mismo que decir siempre "50%" sin saber nada.
// Cuanto más bajo, mejor: no solo mide aciertos, castiga estar mal seguro.
class MarketStats {
  constructor(name) {
    this.name = name;
    this.n = 0;
    this.hits = 0;
    this.brierSum = 0;
    this.sumaReal = 0; // para la tasa base real (cuánto pasó de verdad)
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
    // Tasa base real: cuánto pasó de verdad esto en la muestra. El Brier de
    // "adivinar siempre esa tasa, sin mirar el partido" es baseRate*(1-baseRate) —
    // la vara justa para saber si el modelo aporta algo, no un 50/50 fijo que
    // no tiene sentido en mercados donde lo normal es que no pase casi nunca
    // (o que pase casi siempre).
    const baseRate = this.n ? (this.sumaReal / this.n) : null;
    const brierBase = baseRate != null ? baseRate * (1 - baseRate) : null;
    const mejoraVsBase = (brier != null && brierBase != null && brierBase > 0.0001)
      ? ((brierBase - brier) / brierBase * 100) : null;
    return { name: this.name, n: this.n, hitRate, brier, baseRate, brierBase, mejoraVsBase, buckets: this.buckets };
  }
}

runBtn.addEventListener('click', async () => {
  if (!historial) return;
  runBtn.disabled = true;
  logDiv.textContent = '';
  resultsSection.style.display = 'none';

  const leagueKey = historial.leagueKey;
  const partidos = historial.partidos;

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
  // Mismos mercados, pero puntuando la cuota real de la casa (sin margen) en
  // vez de la predicción del modelo — para saber si le ganamos al mercado,
  // no solo a "adivinar a ciegas".
  const mercado = {
    local: new MarketStats('Local gana'),
    empate: new MarketStats('Empate'),
    visitante: new MarketStats('Visitante gana'),
    over15: new MarketStats('Over 1.5 goles'),
    over25: new MarketStats('Over 2.5 goles'),
    over35: new MarketStats('Over 3.5 goles'),
    btts: new MarketStats('Ambos marcan'),
  };
  // El modelo, pero acumulado SOLO en los partidos donde también hay cuota
  // real — para comparar Brier vs Brier en el mismo conjunto exacto de
  // partidos, no en muestras distintas.
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
  log(`Evaluando ${partidos.length} partidos de ${historial.liga || leagueKey} (solo con datos estáticos, sin usar standings actuales)...`);

  for (const p of partidos) {
    if (p.goles_local == null || p.goles_visitante == null || !p.local || !p.visitante) {
      saltados++;
      continue;
    }

    let pred;
    try {
      pred = await simulateMatch(leagueKey, p.local, p.visitante, { staticOnly: true });
    } catch (e) {
      saltados++;
      continue;
    }

    const totalGoles = p.goles_local + p.goles_visitante;
    const resultado = p.goles_local > p.goles_visitante ? 'local' : p.goles_local < p.goles_visitante ? 'visitante' : 'empate';

    markets.local.add(pred.resultProbs.local, resultado === 'local');
    markets.empate.add(pred.resultProbs.empate, resultado === 'empate');
    markets.visitante.add(pred.resultProbs.visitante, resultado === 'visitante');
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
        modeloVsMercado.local.add(pred.resultProbs.local, resultado === 'local');
        modeloVsMercado.empate.add(pred.resultProbs.empate, resultado === 'empate');
        modeloVsMercado.visitante.add(pred.resultProbs.visitante, resultado === 'visitante');
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

    evaluados++;
    if (evaluados % 10 === 0) log(`  ${evaluados}/${partidos.length}...`);
  }

  log(`\n✅ Listo. ${evaluados} partidos evaluados, ${saltados} salteados (sin resultado real completo).`);
  const mercadoResumen = {};
  for (const [k, m] of Object.entries(mercado)) mercadoResumen[k] = m.summary();
  const modeloVsMercadoResumen = {};
  for (const [k, m] of Object.entries(modeloVsMercado)) modeloVsMercadoResumen[k] = m.summary();

  renderResults(
    Object.entries(markets).map(([k, m]) => ({ key: k, ...m.summary() })),
    mercadoResumen,
    modeloVsMercadoResumen
  );
  runBtn.disabled = false;
});

function vsBaseColor(m) {
  if (m == null) return 'var(--chalk-dim)';
  if (m >= 10) return 'var(--green)';
  if (m >= 0) return 'var(--yellow)';
  return 'var(--red)';
}

function vsBaseNote(m, baseRate) {
  if (m == null) return '';
  const signo = m >= 0 ? '+' : '';
  if (m >= 10) return `${signo}${fmt(m)}% mejor que solo saber que esto pasa ${fmt(baseRate)}% de las veces en esta liga — hay ventaja real`;
  if (m >= 0) return `${signo}${fmt(m)}% mejor que adivinar el ${fmt(baseRate)}% de siempre — casi no aporta mirar el partido puntual`;
  return `${fmt(m)}% peor que adivinar el ${fmt(baseRate)}% de siempre, sin mirar nada del partido`;
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
  if (mejora > 2) texto = `${signo}${fmt(mejora)}% mejor que la cuota real de la casa (ya sin su margen) — esto sí es contra lo que hay que ganar, no contra adivinar a ciegas`;
  else if (mejora >= -2) texto = `${signo}${fmt(mejora)}% — prácticamente empatado con la cuota real. El mercado ya sabe lo mismo que el modelo`;
  else texto = `${fmt(mejora)}% peor que la cuota real — el mercado está más afilado que el modelo acá`;
  return { texto, mejora, n: mercadoSum.n };
}

function renderResults(summaries, mercadoResumen = {}, modeloVsMercadoResumen = {}) {
  const conDatos = summaries.filter(s => s.n > 0);
  if (conDatos.length === 0) {
    resultsContent.innerHTML = `<div class="card"><h3>Sin datos suficientes</h3><p style="color:var(--chalk-dim)">Ningún partido tenía resultado completo para evaluar.</p></div>`;
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
        ${mComp ? `
        <p style="margin:8px 0 0; padding-top:8px; border-top:1px dashed var(--line); font-size:0.8rem; color:${vsMercadoColor(mComp.mejora)}">
          <strong>vs. cuota real (${mComp.n} partidos con cuota):</strong> ${mComp.texto}
        </p>` : ''}
        ${rows ? `
        <h3 class="corner-team-title">Calibración: predicho vs. pasó de verdad</h3>
        <div class="compare-row compare-head"><span>Rango</span><span></span><span></span></div>
        ${rows}` : ''}
      </div>`;
  }).join('');

  resultsSection.style.display = 'block';
}
