import { LIGAS } from './leagues.js';
import { simulateMatch } from './model.js';

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
    this.buckets = { '0-20': [0, 0], '20-40': [0, 0], '40-60': [0, 0], '60-80': [0, 0], '80-100': [0, 0] };
  }
  add(predictedPct, actualBool) {
    if (predictedPct == null || !Number.isFinite(predictedPct)) return;
    this.n++;
    const predictedYes = predictedPct >= 50;
    if (predictedYes === actualBool) this.hits++;
    const p = predictedPct / 100;
    this.brierSum += (p - (actualBool ? 1 : 0)) ** 2;
    const b = predictedPct < 20 ? '0-20' : predictedPct < 40 ? '20-40' : predictedPct < 60 ? '40-60' : predictedPct < 80 ? '60-80' : '80-100';
    this.buckets[b][0] += actualBool ? 1 : 0;
    this.buckets[b][1] += 1;
  }
  summary() {
    return {
      name: this.name,
      n: this.n,
      hitRate: this.n ? (this.hits / this.n * 100) : null,
      brier: this.n ? (this.brierSum / this.n) : null,
      buckets: this.buckets,
    };
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
  renderResults(Object.values(markets).map(m => m.summary()));
  runBtn.disabled = false;
});

function brierColor(b) {
  if (b < 0.20) return 'var(--green)';
  if (b < 0.25) return 'var(--yellow)';
  return 'var(--red)';
}

function brierNote(b) {
  if (b < 0.20) return 'mejor que el azar, con margen';
  if (b < 0.25) return 'apenas mejor que tirar una moneda';
  return 'peor que tirar una moneda en este mercado';
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

function renderResults(summaries) {
  const conDatos = summaries.filter(s => s.n > 0);
  if (conDatos.length === 0) {
    resultsContent.innerHTML = `<div class="card"><h3>Sin datos suficientes</h3><p style="color:var(--chalk-dim)">Ningún partido tenía resultado completo para evaluar.</p></div>`;
    resultsSection.style.display = 'block';
    return;
  }

  resultsContent.innerHTML = conDatos.map(s => {
    const bColor = brierColor(s.brier);
    const rows = bucketRows(s.buckets);
    return `
      <div class="card">
        <h3>${s.name} <small>(${s.n} partidos)</small></h3>
        <div class="prob-row">
          <div class="prob-row-top"><span>Acierto (umbral 50%)</span><span class="prob" style="color:${s.hitRate >= 55 ? 'var(--green)' : s.hitRate >= 48 ? 'var(--yellow)' : 'var(--red)'}">${fmt(s.hitRate)}%</span></div>
          <div class="semaforo-track"><div class="semaforo-fill" style="width:${s.hitRate}%;background:${s.hitRate >= 55 ? 'var(--green)' : s.hitRate >= 48 ? 'var(--yellow)' : 'var(--red)'}"></div></div>
        </div>
        <div class="prob-row-top" style="margin-top:10px;">
          <span>Brier score</span>
          <span class="prob" style="color:${bColor}">${s.brier.toFixed(3)}</span>
        </div>
        <p style="margin:4px 0 0; font-size:0.8rem; color:${bColor}">${brierNote(s.brier)}</p>
        ${rows ? `
        <h3 class="corner-team-title">Calibración: predicho vs. pasó de verdad</h3>
        <div class="compare-row compare-head"><span>Rango</span><span></span><span></span></div>
        ${rows}` : ''}
      </div>`;
  }).join('');

  resultsSection.style.display = 'block';
}
