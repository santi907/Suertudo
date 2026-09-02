import { LIGAS } from './leagues.js';
import { simulateMatch, getTeamsForLeague } from './model.js';

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

  function populateTeams(leagueKey) {
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

    homeSelect.selectedIndex = 0;
    awaySelect.selectedIndex = Math.min(1, teamNames.length - 1);
  }

  leagueSelect.addEventListener('change', (e) => {
    populateTeams(e.target.value);
  });

  simulateBtn.addEventListener('click', async () => {
    const leagueKey = leagueSelect.value;
    const homeTeam = homeSelect.value;
    const awayTeam = awaySelect.value;

    if (!leagueKey || !homeTeam || !awayTeam || homeTeam === awayTeam) {
      alert('Selecciona liga y dos equipos distintos');
      return;
    }

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
      simulateBtn.textContent = 'Simular';
    }
  });

  function fmt(n) {
    return Number(n).toFixed(1);
  }

  // Fila completa: etiqueta + valor + barra semáforo (color y largo según prob.)
  function fila(label, prob) {
    const color = getColor(prob);
    const pct = Math.max(0, Math.min(100, prob));
    return `
      <div class="prob-row">
        <div class="prob-row-top"><span>${label}</span><span class="prob" style="color:${color}">${fmt(prob)}%</span></div>
        <div class="semaforo-track"><div class="semaforo-fill" style="width:${pct}%;background:${color}"></div></div>
      </div>`;
  }

  // Versión compacta para las tablas de 4 columnas (valor arriba, barra fina abajo)
  function gridProb(val) {
    const color = getColor(val);
    const pct = Math.max(0, Math.min(100, val));
    return `<span class="grid-prob"><span class="grid-prob-value" style="color:${color}">${fmt(val)}%</span><span class="grid-prob-bar"><span style="width:${pct}%;background:${color}"></span></span></span>`;
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
        ${compareRow('Local', data.resultProbs.local, data.bzzoiroML.resultProbs.local, data.blended.resultProbs.local)}
        ${compareRow('Empate', data.resultProbs.empate, data.bzzoiroML.resultProbs.empate, data.blended.resultProbs.empate)}
        ${compareRow('Visitante', data.resultProbs.visitante, data.bzzoiroML.resultProbs.visitante, data.blended.resultProbs.visitante)}
        ${compareRow('Over 1.5', data.over15, data.bzzoiroML.over15, data.blended.over15)}
        ${compareRow('Over 2.5', data.over25, data.bzzoiroML.over25, data.blended.over25)}
        ${compareRow('BTTS', data.btts, data.bzzoiroML.btts, data.blended.btts)}
        ` : `<div class="compare-row"><span>Datos ML parciales para este partido — se muestra solo tu modelo.</span></div>`}
      </div>` : '';

    predictionsContent.innerHTML = `
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
        ${fila('Over 8.5', data.cornerProbs.over8)}
        ${fila('Over 9.5', data.cornerProbs.over9)}
        <h3 class="corner-team-title">Córners por equipo</h3>
        <div class="compare-row compare-head">
          <span></span><span>Esperados</span><span>Over 3.5</span><span>Over 4.5</span>
        </div>
        <div class="compare-row">
          <span>${data.homeTeam}</span>
          <span class="grid-plain">${fmt(data.cornerProbs.porEquipo.local.esperado)}</span>
          ${gridProb(data.cornerProbs.porEquipo.local.over3)}
          ${gridProb(data.cornerProbs.porEquipo.local.over4)}
        </div>
        <div class="compare-row">
          <span>${data.awayTeam}</span>
          <span class="grid-plain">${fmt(data.cornerProbs.porEquipo.visitante.esperado)}</span>
          ${gridProb(data.cornerProbs.porEquipo.visitante.over3)}
          ${gridProb(data.cornerProbs.porEquipo.visitante.over4)}
        </div>
      </div>` : ''}
      ${comparisonCard}
    `;
    resultsDiv.style.display = 'block';
  }

  function getColor(prob) {
    if (prob >= 65) return 'var(--green)';
    if (prob >= 42) return 'var(--yellow)';
    return 'var(--red)';
  }

  populateLeagues();
  const firstLeague = Object.keys(LIGAS)[0];
  if (firstLeague) populateTeams(firstLeague);
});
