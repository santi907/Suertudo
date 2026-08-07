// ============================================================
// api.js – llamadas a la API externa de Bzzoiro (standings en vivo)
// ============================================================

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

export async function fetchLeagueDynamicData(leagueId) {
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
  const xgAvg = totalXGF / totalMatches;

  const teamRatings = {};
  for (const [name, s] of Object.entries(teamStats)) {
    const matchesPlayed = nTeams - 1;
    const xgfPerMatch = s.xgf / matchesPlayed;
    const xgaPerMatch = s.xga / matchesPlayed;
    teamRatings[name] = {
      atk: +(xgfPerMatch / xgAvg).toFixed(3),
      def: +(xgaPerMatch / xgAvg).toFixed(3)
    };
  }

  console.log(`✅ Datos de ${leagueId} obtenidos. Equipos: ${Object.keys(teamRatings).length}`);
  return { goalsAvg, cornAvg: null, teamRatings };
}
