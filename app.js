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

// ------ MANEJO DEL TOKEN ------
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

// Cargar estado inicial del token
updateTokenStatus();

// ... resto del código (populateLeagues, populateTeams, simulateMatch, etc.)
