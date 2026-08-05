``javascript
import { LIGAS, TEAM_STRENGTH_DB } from './config/leagues.js';
import { simulateMatch } from './model.js';

// DOM Elements
const apiKeyInput = document.getElementById('api-key');
const saveApiKeyBtn = document.getElementById('save-api-key');
const apiStatus = document.getElementById('api-status');
const leagueSelect = document.getElementById('league-select');
const homeSelect = document.getElementById('home-team-select');
const awaySelect = document.getElementById('away-team-select');
const simulateBtn = document.getElementById('simulate-btn');
const resultsDiv = document.getElementById('results');
const predictionsContent = document.getElementById('predictions-content');

// API Key
saveApiKeyBtn.addEventListener('click', () => {
  const token = apiKeyInput.value.trim();
  if (token) {
    localStorage.setItem('bzzoiro_token', token);
    apiStatus.textContent = '✅ Token guardado';
    apiStatus.style.color = 'var(--green)';
  }
});

// Cargar token guardado
const savedToken = localStorage.getItem('bzzoiro_token');
if (savedToken) {
  apiKeyInput.value = savedToken;
  apiStatus.textContent = '✅ Token cargado';
  apiStatus.style.color = 'var(--green)';
}

// Poblar selector de ligas
function populateLeagues() {
  for (const [key, liga] of Object.entries(LIGAS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = liga.name;
    leagueSelect.appendChild(option);
  }
}

// Poblar selectores de equipos según liga seleccionada
function populateTeams(leagueKey) {
  homeSelect.innerHTML = '';
  awaySelect.innerHTML = '';
  
  const teams = TEAM_STRENGTH_DB[leagueKey];
  if (!teams) return;
  
  for (const teamName of Object.keys(teams)) {
    const optionHome = document.createElement('option');
    optionHome.value = teamName;
    optionHome.textContent = teamName;
    homeSelect.appendChild(optionHome);
    
    const optionAway = document.createElement('option');
    optionAway.value = teamName;
    optionAway.textContent = teamName;
    awaySelect.appendChild(optionAway);
  }
  
  // Seleccionar equipos distintos por defecto
  homeSelect.selectedIndex = 0;
  awaySelect.selectedIndex = 1;
}

leagueSelect.addEventListener('change', (e) => {
  populateTeams(e.target.value);
});

// Simular
simulateBtn.addEventListener('click', async () => {
  const leagueKey = leagueSelect.value;
  const homeTeam = homeSelect.value;
  const awayTeam = awaySelect.value;
  
  if (!leagueKey || !homeTeam || !awayTeam || homeTeam === awayTeam) {
    alert('Selecciona liga y equipos distintos');
    return;
  }
  
  simulateBtn.disabled = true;
  simulateBtn.textContent = 'Calculando...';
  
  try {
    const results = await simulateMatch(leagueKey, homeTeam, awayTeam);
    displayResults(results);
  } catch (err) {
    alert('Error: ' + err.message);
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

// Inicializar
populateLeagues();
if (Object.keys(LIGAS).length > 0) {
  const firstLeague = Object.keys(LIGAS)[0];
  populateTeams(firstLeague);
}
```

---
