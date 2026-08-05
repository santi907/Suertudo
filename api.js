// ============================================================
// app.js – versión unificada con api.js y depuración
// ============================================================

import { LIGAS, TEAM_STRENGTH_DB, HOME_ADVANTAGE, CORNER_HOME_BIAS } from './config/leagues.js';
import * as stats from './js/models/stats.js';

// ---------- API (bzzoiro) ----------
const BASE_URL = 'https://sports.bzzoiro.com/api/v2';

function getToken() {
  return localStorage.getItem('bzzoiro_token');
}

async function fetchFromAPI(endpoint) {
  const token = getToken();
  if (!token) throw new Error('Token no configurado. Ingresa tu API key de Bzzoiro.');

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'Authorization': `Token ${token}` }
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Error ${res.status}: ${errorText}`);
  }
  return await res.json();
}

async function fetchLeagueDynamicData(leagueId) {
  console.log(`🔍 Obteniendo datos de liga: ${leagueId}`);
  const data = await fetchFromAPI(`/leagues/${leagueId}/standings/`);
  const rows = data.standings?.[0]?.rows;
  if (!rows || rows.length === 0) throw new Error('No se pudieron obtener standings');

  let totalGF = 0;
  let totalXGF = 0;
  const teamStats = {};

  for (const row of rows) {
    const name = row.team.name;
    const gf = row.goals_for || 0;
    const ga = row.goals_against || 0;
    const xgf = row.xG_for || gf;
    const xga = row.xG_against || ga;

    teamStats[name] = { gf, ga, xgf, xga };
    totalGF += gf;
    totalXGF += xgf;
  }

  const nTeams = rows.length;
  const totalMatches = nTeams * (nTeams - 1);
  const goalsAvg = totalGF / totalMatches;
  const xG_avg = totalXGF / totalMatches;

  const teamRatings = {};
  for (const [name, stats] of Object.entries(teamStats)) {
    const matchesPlayed = nTeams - 1;
    const xgf_per_match = stats.xgf / matchesPlayed;
    const xga_per_match = stats.xga / matchesPlayed;
    teamRatings[name] = {
      atk: +(xgf_per_match / xG_avg).toFixed(3),
      def: +(xga_per_match / xG_avg).toFixed(3)
    };
  }

  console.log(`✅ Datos de ${leagueId} obtenidos. Equipos: ${Object.keys(teamRatings).length}`);
  return { goalsAvg, cornAvg: null, teamRatings };
}

// ---------- Modelo de predicción ----------
const dynamicCache = {};

async function getDynamicData(leagueKey) {
  if (dynamicCache[leagueKey]) return dynamicCache[leagueKey];
  try {
    const data = await fetchLeagueDynamicData(leagueKey);
    dynamicCache[leagueKey] = data;
    return data;
  } catch (e) {
    console.warn('⚠️ Fallback a datos estáticos:', e.message);
    return null;
  }
}

function getTeamRating(leagueKey, teamName, dynamicRatings) {
  if (dynamicRatings?.[teamName]) return dynamicRatings[teamName];
  return TEAM_STRENGTH_DB[leagueKey]?.[teamName] || { atk: 1.0, def: 1.0 };
}

async function simulateMatch(leagueKey, homeTeam, awayTeam) {
  const liga = LIGAS[leagueKey];
  if (!liga) throw new Error('Liga no encontrada');

  const dynamic = await getDynamicData(leagueKey);
  const goalsAvg = dynamic?.goalsAvg ?? liga.goalsAvg;
  const cornAvg = dynamic?.cornAvg ?? liga.cornAvg;

  const hRating = getTeamRating(leagueKey, homeTeam, dynamic?.teamRatings);
  const aRating = getTeamRating(leagueKey, awayTeam, dynamic?.teamRatings);

  const homeAdv = HOME_ADVANTAGE[leagueKey] || 1.0;
  const lambdaHome = goalsAvg * hRating.atk * aRating.def * homeAdv;
  const lambdaAway = goalsAvg * aRating.atk * hRating.def;

  // Resultado
  const resultProbs = stats.calcResultProbs(lambdaHome, lambdaAway, leagueKey);

  // Over/Under goles
  const over15 = stats.poissonOver(lambdaHome + lambdaAway, 1.5);
  const over25 = stats.poissonOver(lambdaHome + lambdaAway, 2.5);
  const over35 = stats.poissonOver(lambdaHome + lambdaAway, 3.5);

  // BTTS
  const btts = stats.calcBTTS(lambdaHome, lambdaAway, leagueKey);

  // Córneres
  let cornerProbs = null;
  if (cornAvg && cornAvg > 0) {
    const { home: lCornerHome, away: lCornerAway } = stats.splitCornerLambda(
      cornAvg, hRating.atk, hRating.def, aRating.atk, aRating.def, CORNER_HOME_BIAS
    );
    const totalCorners = lCornerHome + lCornerAway;
    const r = liga.cornR || 20;
    cornerProbs = {
      over8: stats.negBinOver(totalCorners, 7.5, r),
      over9: stats.negBinOver(totalCorners, 8.5, r),
      over10: stats.negBinOver(totalCorners, 9.5, r),
      over11: stats.negBinOver(totalCorners, 10.5, r),
    };
  }

  return {
    liga: liga.name,
    homeTeam,
    awayTeam,
    resultProbs: {
      local: stats.plattCalibrate(resultProbs.home, 'resultado'),
      empate: stats.plattCalibrate(resultProbs.draw, 'resultado'),
      visitante: stats.plattCalibrate(resultProbs.away, 'resultado'),
    },
    over15: stats.plattCalibrate(over15, 'goals15'),
    over25: stats.plattCalibrate(over25, 'goals25'),
    over35,
    btts: stats.plattCalibrate(btts, 'btts'),
    cornerProbs
  };
}

// ---------- Interfaz de usuario ----------
document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 App iniciada');

  // Elementos
  const apiKeyInput = document.getElementById('api-key');
  const saveApiKeyBtn = document.getElementById('save-api-key');
  const apiStatus = document.getElementById('api-status');
  const leagueSelect = document.getElementById('league-select');
  const homeSelect = document.getElementById('home-team-select');
  const awaySelect = document.getElementById('away-team-select');
  const simulateBtn = document.getElementById('simulate-btn');
  const resultsDiv = document.getElementById('results');
  const predictionsContent = document.getElementById('predictions-content');

  // Verificar que todos los elementos existen
  if (!apiKeyInput || !saveApiKeyBtn || !apiStatus || !leagueSelect || !homeSelect || !awaySelect || !simulateBtn || !resultsDiv || !predictionsContent) {
    console.error('❌ Faltan elementos HTML. Revisa los IDs en index.html.');
    return;
  }

  // ---------- Funciones de token ----------
  function updateTokenStatus() {
    const token = localStorage.getItem('bzzoiro_token');
    if (token) {
      apiKeyInput.value = token;
      apiStatus.textContent = '✅ Token guardado';
      apiStatus.style.color = 'var(--green)';
      console.log('🔑 Token encontrado en localStorage');
    } else {
      apiStatus.textContent = '⚠️ No hay token';
      apiStatus.style.color = 'var(--yellow)';
      console.log('🔑 No hay token en localStorage');
    }
  }

  saveApiKeyBtn.addEventListener('click', () => {
    console.log('🖱️ Botón Guardar presionado');
    const token = apiKeyInput.value.trim();
    if (token) {
      localStorage.setItem('bzzoiro_token', token);
      console.log('💾 Token guardado en localStorage');
      updateTokenStatus();
    } else {
      apiStatus.textContent = '❌ Ingresa un token válido';
      apiStatus.style.color = 'var(--red)';
      console.warn('⚠️ Token vacío');
    }
  });

  // Inicializar estado del token
  updateTokenStatus();

  // ---------- Selectores de ligas y equipos ----------
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

    const teams = TEAM_STRENGTH_DB[leagueKey];
    if (!teams) {
      console.error(`❌ No hay equipos para la liga ${leagueKey}`);
      return;
    }

    const teamNames = Object.keys(teams);
    for (const name of teamNames) {
      const optionHome = document.createElement('option');
      optionHome.value = name;
      optionHome.textContent = name;
      homeSelect.appendChild(optionHome);

      const optionAway = document.createElement('option');
      optionAway.value = name;
      optionAway.textContent = name;
      awaySelect.appendChild(optionAway);
    }

    homeSelect.selectedIndex = 0;
    awaySelect.selectedIndex = 1;
  }

  leagueSelect.addEventListener('change', (e) => {
    console.log(`🌐 Liga seleccionada: ${e.target.value}`);
    populateTeams(e.target.value);
  });

  // ---------- Simulación ----------
  simulateBtn.addEventListener('click', async () => {
    console.log('🖱️ Botón Simular presionado');
    const leagueKey = leagueSelect.value;
    const homeTeam = homeSelect.value;
    const awayTeam = awaySelect.value;

    if (!leagueKey || !homeTeam || !awayTeam || homeTeam === awayTeam) {
      alert('Selecciona liga y equipos distintos');
      return;
    }

    simulateBtn.disabled = true;
    simulateBtn.textContent = 'Calculando...';
    console.log(`🧮 Simulando ${homeTeam} vs ${awayTeam} (${leagueKey})`);

    try {
      const results = await simulateMatch(leagueKey, homeTeam, awayTeam);
      displayResults(results);
      console.log('✅ Simulación completada', results);
    } catch (err) {
      alert('Error: ' + err.message);
      console.error('❌ Error en simulación', err);
    } finally {
      simulateBtn.disabled = false;
      simulateBtn.textContent = 'Simular';
    }
  });

  function displayResults(data) {
    const html = `
      <div class="card">
        <h3>Resultado 1X2</h3>
        <div>Local: <span class="prob" style="color:${getColor(data.resultProbs.local)}">${data.resultProbs.local}%</span></div>
        <div>Empate: <span class="prob" style="color:${getColor(data.resultProbs.empate)}">${data.resultProbs.empate}%</span></div>
        <div>Visitante: <span class="prob" style="color:${getColor(data.resultProbs.visitante)}">${data.resultProbs.visitante}%</span></div>
      </div>
      <div class="card">
        <h3>Goles</h3>
        <div>Over 1.5: ${data.over15}%</div>
        <div>Over 2.5: ${data.over25}%</div>
        <div>Over 3.5: ${data.over35}%</div>
        <div>BTTS: ${data.btts}%</div>
      </div>
      ${data.cornerProbs ? `
      <div class="card">
        <h3>Córneres</h3>
        <div>Over 8.5: ${data.cornerProbs.over8}%</div>
        <div>Over 9.5: ${data.cornerProbs.over9}%</div>
        <div>Over 10.5: ${data.cornerProbs.over10}%</div>
        <div>Over 11.5: ${data.cornerProbs.over11}%</div>
      </div>` : ''}
    `;
    predictionsContent.innerHTML = html;
    resultsDiv.style.display = 'block';
  }

  function getColor(prob) {
    if (prob >= 65) return 'var(--green)';
    if (prob >= 42) return 'var(--yellow)';
    return 'var(--red)';
  }

  // Inicializar selectores
  populateLeagues();
  const firstLeague = Object.keys(LIGAS)[0];
  if (firstLeague) {
    populateTeams(firstLeague);
  }

  console.log('✅ App lista');
});