import { LIGAS } from './leagues.js';
import { simulateMatch, getTeamsForLeague } from './model.js';

// ============================================================================
// PERSISTENCIA DE ESTADO
// ============================================================================
const ESTADO_KEY = 'vv_estado_seleccion';

function guardarEstado(leagueKey, homeTeam, awayTeam) {
  try {
    localStorage.setItem(ESTADO_KEY, JSON.stringify({
      liga: leagueKey, local: homeTeam, visitante: awayTeam
    }));
  } catch (e) { /* localStorage puede fallar en modo privado */ }
}

function leerEstado() {
  try {
    const raw = localStorage.getItem(ESTADO_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// ============================================================================
// UMBRALES DE PICKS
// Mismos valores que usa el backtest. Ajustá acá si querés subir/bajar.
// ============================================================================
const UMBRAL_1X2 = 45;       // favorito ≥ 45% → pick
const UMBRAL_GOLES = 60;     // Over X.5 ≥ 60% → pick (solo la más alta)
const UMBRAL_BTTS = 60;      // BTTS Sí ≥ 60% → pick
const UMBRAL_CORNERS = 60;   // Córners ≥ 60% → pick

document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('api-key');
  const saveApiKeyBtn = document.getElementById('save-api-key');
  const apiStatus = document.getElementById('api-status');
  const leagueSelect = document.getElementById('league-select');
  const homeSelect = document.getElementById('home-team-select');
  const awaySelect = document.getElementById('away-team-select');
  const simulateBtn = document.getElementById('simulate-btn');
  const resultsDiv = document.getElementById('results');
  const predictionsContent = document.getElementById('predictions-content');

  function updateTokenStatus() {
    const token = localStorage.getItem('bzzoiro_token');
    if (token) {
      apiKeyInput.value = token;
      apiStatus.textContent = '✅ Token guardado';
      apiStatus.style.color = 'var(--green)';
    } else {
      apiStatus.textContent = '⚠️ No hay token';
      apiStatus.style.color = 'var(--yellow)';
    }
  }

  saveApiKeyBtn.addEventListener('click', () => {
    const token = apiKeyInput.value.trim();
    if (token) {
      localStorage.setItem('bzzoiro_token', token);
      updateTokenStatus();
    } else {
      apiStatus.textContent = '❌ Ingresa un token válido';
      apiStatus.style.color = 'var(--red)';
    }
  });

  updateTokenStatus();

  function populateLeagues() {
    for (const [key, liga] of Object.entries(LIGAS)) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = liga.name;
      leagueSelect.appendChild(option);
    }
  }

  function populateTeams(leagueKey, { keepSelection = false } = {}) {
    const prevHome = keepSelection ? homeSelect.value : null;
    const prevAway = keepSelection ? awaySelect.value : null;

    homeSelect.innerHTML = '';
    awaySelect.innerHTML = '';

    const teams = getTeamsForLeague(leagueKey);
    const teamNames = Object.keys(teams);

    if (teamNames.length === 0) {
      console.error(`❌ No hay equipos cargados para la liga ${leagueKey}`);
      return;
    }

    for (const name of teamNames) {
      homeSelect.appendChild(new Option(name, name));
      awaySelect.appendChild(new Option(name, name));
    }

    let homeIndex = 0;
    let awayIndex = Math.min(1, teamNames.length - 1);

    if (prevHome && teamNames.includes(prevHome)) {
      homeIndex = teamNames.indexOf(prevHome);
    }
    if (prevAway && teamNames.includes(prevAway) && prevAway !== teamNames[homeIndex]) {
      awayIndex = teamNames.indexOf(prevAway);
    } else if (teamNames[homeIndex] === teamNames[awayIndex]) {
      awayIndex = (homeIndex + 1) % teamNames.length;
    }

    homeSelect.selectedIndex = homeIndex;
    awaySelect.selectedIndex = awayIndex;
  }

  function restaurarEstado() {
    const estado = leerEstado();

    if (estado?.liga && LIGAS[estado.liga]) {
      leagueSelect.value = estado.liga;
      populateTeams(estado.liga);

      const teamNames = Object.keys(getTeamsForLeague(estado.liga));
      if (estado.local && teamNames.includes(estado.local)) {
        homeSelect.value = estado.local;
      }
      if (estado.visitante && teamNames.includes(estado.visitante) && estado.visitante !== homeSelect.value) {
        awaySelect.value = estado.visitante;
      }
    } else {
      const firstLeague = Object.keys(LIGAS)[0];
      if (firstLeague) {
        leagueSelect.value = firstLeague;
        populateTeams(firstLeague);
      }
    }
  }

  leagueSelect.addEventListener('change', (e) => {
    populateTeams(e.target.value);
    guardarEstado(e.target.value, homeSelect.value, awaySelect.value);
  });

  homeSelect.addEventListener('change', () => {
    guardarEstado(leagueSelect.value, homeSelect.value, awaySelect.value);
  });

  awaySelect.addEventListener('change', () => {
    guardarEstado(leagueSelect.value, homeSelect.value, awaySelect.value);
  });

  simulateBtn.addEventListener('click', async () => {
    const leagueKey = leagueSelect.value;
    const homeTeam = homeSelect.value;
    const awayTeam = awaySelect.value;

    if (!leagueKey || !homeTeam || !awayTeam || homeTeam === awayTeam) {
      alert('Selecciona liga y dos equipos distintos');
      return;
    }

    guardarEstado(leagueKey, homeTeam, awayTeam);

    simulateBtn.disabled = true;
    simulateBtn.textContent = 'Calculando...';

    try {
      const results = await simulateMatch(leagueKey, homeTeam, awayTeam);
      displayResults(results);
    } catch (err) {
      alert('Error: ' + err.message);
      console.error('❌ Error en simulación', err);
    } finally {
      simulateBtn.disabled = false;
      simulateBtn.textContent = 'Simular partido';
    }
  });

  function fmt(n) {
    return Number(n).toFixed(1);
  }

  function fila(label, prob) {
    const color = getColor(prob);
    const pct = Math.max(0, Math.min(100, prob));
    return `
      <div class="prob-row">
        <div class="prob-row-top"><span>${label}</span><span class="prob" style="color:${color}">${fmt(prob)}%</span></div>
        <div class="semaforo-track"><div class="semaforo-fill" style="width:${pct}%;background:${color}"></div></div>
      </div>`;
  }

  function gridProb(val) {
    const color = getColor(val);
    const pct = Math.max(0, Math.min(100, val));
    return `<span class="grid-prob"><span class="grid-prob-value" style="color:${color}">${fmt(val)}%</span><span class="grid-prob-bar"><span style="width:${pct}%;background:${color}"></span></span></span>`;
  }

  function getColor(prob) {
    if (prob >= 65) return 'var(--green)';
    if (prob >= 42) return 'var(--yellow)';
    return 'var(--red)';
  }

  // ==========================================================================
  // GENERADOR DE PICKS
  // Aplica los mismos umbrales que el backtest.
  // Devuelve array de { label, prob, color }
  // ==========================================================================
  function generarPicks(data) {
    const picks = [];

    // --- 1X2 ---
    const rp = data.resultProbs;
    const max1x2 = Math.max(rp.local, rp.empate, rp.visitante);
    if (max1x2 >= UMBRAL_1X2) {
      if (rp.local === max1x2) picks.push({ label: 'Local gana', prob: rp.local });
      else if (rp.empate === max1x2) picks.push({ label: 'Empate', prob: rp.empate });
      else picks.push({ label: 'Visitante gana', prob: rp.visitante });
    }

    // --- Goles: la línea más alta que supere el umbral ---
    const lineasGoles = [
      { label: 'Over 3.5 goles', prob: data.over35 },
      { label: 'Over 2.5 goles', prob: data.over25 },
      { label: 'Over 1.5 goles', prob: data.over15 },
    ];
    for (const l of lineasGoles) {
      if (l.prob != null && l.prob >= UMBRAL_GOLES) {
        picks.push(l);
        break;
      }
    }

    // --- BTTS Sí ---
    if (data.btts != null && data.btts >= UMBRAL_BTTS) {
      picks.push({ label: 'Ambos marcan (Sí)', prob: data.btts });
    }

    // --- Córners totales: la línea más alta que supere el umbral ---
    if (data.cornerProbs) {
      const lineasCorners = [
        { label: 'Over 9.5 córners', prob: data.cornerProbs.over9 },
        { label: 'Over 8.5 córners', prob: data.cornerProbs.over8 },
        { label: 'Over 7.5 córners', prob: data.cornerProbs.over7 },
      ];
      for (const l of lineasCorners) {
        if (l.prob != null && l.prob >= UMBRAL_CORNERS) {
          picks.push(l);
          break;
        }
      }
    }

    // --- Córners por equipo ---
    if (data.cornerProbs?.porEquipo) {
      const cL = data.cornerProbs.porEquipo.local?.over3;
      const cV = data.cornerProbs.porEquipo.visitante?.over3;
      if (cL != null && cL >= UMBRAL_CORNERS) {
        picks.push({ label: `Córners ${data.homeTeam} Over 3.5`, prob: cL });
      }
      if (cV != null && cV >= UMBRAL_CORNERS) {
        picks.push({ label: `Córners ${data.awayTeam} Over 3.5`, prob: cV });
      }
    }

    return picks;
  }

  function renderPicksCard(data) {
    const picks = generarPicks(data);
    const umbrales = `Umbrales: 1X2 ≥${UMBRAL_1X2}% · Goles ≥${UMBRAL_GOLES}% · BTTS ≥${UMBRAL_BTTS}% · Córners ≥${UMBRAL_CORNERS}%`;

    if (picks.length === 0) {
      return `
        <div class="card" style="border:2px solid var(--line); opacity:0.8;">
          <h3>🎯 Mejores picks para este partido</h3>
          <p style="color:var(--chalk-dim); margin:8px 0 0; font-size:0.9rem;">
            Sin picks recomendados. Ningún mercado supera los umbrales configurados.
          </p>
          <p style="color:var(--chalk-dim); margin:6px 0 0; font-size:0.72rem;">${umbrales}</p>
        </div>`;
    }

    const filas = picks.map(p => `
      <div class="prob-row">
        <div class="prob-row-top">
          <span>✅ ${p.label}</span>
          <span class="prob" style="color:${getColor(p.prob)}">${fmt(p.prob)}%</span>
        </div>
        <div class="semaforo-track">
          <div class="semaforo-fill" style="width:${p.prob}%;background:${getColor(p.prob)}"></div>
        </div>
      </div>`).join('');

    return `
      <div class="card" style="border:2px solid var(--green);">
        <h3>🎯 Mejores picks para este partido <small>(${picks.length})</small></h3>
        ${filas}
        <p style="color:var(--chalk-dim); margin:10px 0 0; font-size:0.72rem;">${umbrales}</p>
      </div>`;
  }

  function displayResults(data) {
    const compareRow = (label, own, ml, blended) => `
      <div class="compare-row">
        <span>${label}</span>
        ${gridProb(own)}
        ${gridProb(ml)}
        ${gridProb(blended)}
      </div>`;

    const comparisonCard = data.bzzoiroML ? `
      <div class="card">
        <h3>Tu modelo vs. Bzzoiro ML${data.bzzoiroML.confidence != null ? ` <small>(confianza ${(data.bzzoiroML.confidence * 100).toFixed(0)}%)</small>` : ''}</h3>
        ${data.blended ? `
        <div class="compare-row compare-head">
          <span></span><span>Poisson</span><span>Bzzoiro ML</span><span>Promedio</span>
        </div>
        ${compareRow('Local', data.resultProbs.local, data.bzzoiroML.resultProbs.local, data.blended.resultProbs.local)}${compareRow('Empate', data.resultProbs.empate, data.bzzoiroML.resultProbs.empate, data.blended.resultProbs.empate)}
        ${compareRow('Visitante', data.resultProbs.visitante, data.bzzoiroML.resultProbs.visitante, data.blended.resultProbs.visitante)}${compareRow('Over 1.5', data.over15, data.bzzoiroML.over15, data.blended.over15)}
        ${compareRow('Over 2.5', data.over25, data.bzzoiroML.over25, data.blended.over25)}${compareRow('BTTS', data.btts, data.bzzoiroML.btts, data.blended.btts)}
        ` : `<div class="compare-row"><span>Datos ML parciales para este partido — se muestra solo tu modelo.</span></div>`}
      </div>` : '';

    const picksCard = renderPicksCard(data);

    predictionsContent.innerHTML = `
      ${picksCard}
      <div class="card">
        <h3>Resultado 1X2</h3>
        ${fila('Local', data.resultProbs.local)}
        ${fila('Empate', data.resultProbs.empate)}
        ${fila('Visitante', data.resultProbs.visitante)}
      </div>
      <div class="card">
        <h3>Goles</h3>
        ${fila('Over 1.5', data.over15)}
        ${fila('Over 2.5', data.over25)}
        ${fila('Over 3.5', data.over35)}
      </div>
      <div class="card">
        <h3>Ambos marcan (BTTS)</h3>
        ${fila('Sí', data.btts)}
      </div>
      ${data.cornerProbs ? `
      <div class="card">
        <h3>Córneres</h3>
        ${fila('Over 7.5', data.cornerProbs.over7)}
        ${fila('Over 8.5', data.cornerProbs.over8)}${fila('Over 9.5', data.cornerProbs.over9)}
        <h3 class="corner-team-title">Córners por equipo</h3>
        <div class="compare-row compare-head">
          <span></span><span>Esperados</span><span>Over 3.5</span><span>Over 4.5</span>
        </div>
        <div class="compare-row">
          <span>${data.homeTeam}</span>
          <span class="grid-plain">${fmt(data.cornerProbs.porEquipo.local.esperado)}</span>
          ${gridProb(data.cornerProbs.porEquipo.local.over3)}${gridProb(data.cornerProbs.porEquipo.local.over4)}
        </div>
        <div class="compare-row">
          <span>${data.awayTeam}</span>
          <span class="grid-plain">${fmt(data.cornerProbs.porEquipo.visitante.esperado)}</span>
          ${gridProb(data.cornerProbs.porEquipo.visitante.over3)}${gridProb(data.cornerProbs.porEquipo.visitante.over4)}
        </div>
      </div>` : ''}
      ${comparisonCard}
    `;
    resultsDiv.style.display = 'block';
  }

  // --- Arranque ---
  populateLeagues();
  restaurarEstado();
});
