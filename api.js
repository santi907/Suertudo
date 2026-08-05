```javascript
const BASE_URL = 'https://sports.bzzoiro.com/api/v2';

function getToken() {
  return localStorage.getItem('bzzoiro_token');
}

async function fetchFromAPI(endpoint) {
  const token = getToken();
  if (!token) throw new Error('Token no configurado');
  
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'Authorization': `Token ${token}` }
  });
  
  if (!res.ok) throw new Error(`Error ${res.status}: ${await res.text()}`);
  return await res.json();
}

// Devuelve { goalsAvg, cornAvg, teamRatings: { [name]: { atk, def } } } para una liga
export async function fetchLeagueDynamicData(leagueId) {
  // 1. Obtener standings (asumimos que la liga tiene una sola tabla)
  const data = await fetchFromAPI(`/leagues/${leagueId}/standings/`);
  // Estructura esperada: data.standings[0].rows, cada row tiene team.name, goals_for, goals_against, xG_for, xG_against (si existen)
  
  const rows = data.standings?.[0]?.rows;
  if (!rows || rows.length === 0) throw new Error('No se pudieron obtener standings');
  
  let totalGF = 0;
  let totalXGF = 0;
  let totalMatches = 0;
  const teamStats = {};
  
  for (const row of rows) {
    const name = row.team.name;
    const gf = row.goals_for || 0;
    const ga = row.goals_against || 0;
    const xgf = row.xG_for || gf;   // fallback a goles reales
    const xga = row.xG_against || ga;
    
    teamStats[name] = { gf, ga, xgf, xga };
    totalGF += gf;
    totalXGF += xgf;
    // Cada equipo ha jugado (equipos - 1) partidos? Asumimos que la tabla tiene los partidos jugados correctos, no necesitamos totalMatches aquí, podemos calcular el promedio como totalGF / (rows.length * (rows.length - 1)) si es liga de doble vuelta.
  }
  
  // Suponemos liga de doble vuelta (todos contra todos ida y vuelta)
  const nTeams = rows.length;
  totalMatches = nTeams * (nTeams - 1); // ida y vuelta = 2 * combinaciones? Sí, n*(n-1)
  const goalsAvg = totalGF / totalMatches;
  const xG_avg = totalXGF / totalMatches; // para normalizar ataque (promedio de xG por partido por equipo)
  
  // Normalizar ratings
  const teamRatings = {};
  for (const [name, stats] of Object.entries(teamStats)) {
    const matchesPlayed = nTeams - 1; // asumimos todos jugaron los mismos partidos (puede variar en copas, pero para liga normal está bien)
    const xgf_per_match = stats.xgf / matchesPlayed;
    const xga_per_match = stats.xga / matchesPlayed;
    teamRatings[name] = {
      atk: +(xgf_per_match / xG_avg).toFixed(3),
      def: +(xga_per_match / xG_avg).toFixed(3)
    };
  }
  
  // Obtener promedio de córneres (si está disponible en algún otro endpoint; por ahora usamos el estático como fallback)
  return { goalsAvg, cornAvg: null, teamRatings };
}
```

---
