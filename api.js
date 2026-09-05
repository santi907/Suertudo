// ============================================================
// api.js – llamadas a la API externa de Bzzoiro (standings, temporada
// y predicciones ML en vivo)
// ============================================================
import { BZZOIRO_COUNTRY } from './leagues.js';

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

// Quita el emoji de bandera / trofeo del nombre para comparar solo el texto
function cleanName(name) {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // saca tildes/acentos
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim().toLowerCase();
}

function tokens(name) {
  return cleanName(name).split(/\s+/).filter(Boolean);
}

// ¿todas las palabras de "chicas" aparecen en "grandes"? (en cualquier orden,
// sin importar palabras de más en el medio — resuelve casos como
// "Brasileirão A" vs "Brasileirão Serie A")
function todasLasPalabrasEstan(chicas, grandes) {
  const set = new Set(grandes);
  return chicas.length > 0 && chicas.every(t => set.has(t));
}

// ---------- Resolución de IDs reales de Bzzoiro ----------
// Bzzoiro usa sus propios ids numéricos (no nuestros códigos PL/MXL/etc).
// Hay que resolverlos buscando por país y nombre, una sola vez, y cachear
// el resultado en memoria para no repetir la búsqueda en cada simulación.
const leagueIdCache = new Map();
const seasonIdCache = new Map();

export async function resolveLeagueId(leagueKey, leagueDisplayName) {
  if (leagueIdCache.has(leagueKey)) return leagueIdCache.get(leagueKey);

  const country = BZZOIRO_COUNTRY[leagueKey];
  if (!country) {
    // Competición continental (Champions, Europa League, Libertadores):
    // no se puede resolver por país. Se usa siempre el dato estático.
    leagueIdCache.set(leagueKey, null);
    return null;
  }

  const data = await fetchFromAPI(`/leagues/?country=${encodeURIComponent(country)}`);
  const results = data.results || data || [];
  const target = cleanName(leagueDisplayName);
  const targetTokens = tokens(leagueDisplayName);

  const match = results.find(l => cleanName(l.name) === target)
    || results.find(l => cleanName(l.name).includes(target) || target.includes(cleanName(l.name)))
    || results.find(l => todasLasPalabrasEstan(targetTokens, tokens(l.name)))
    || results.find(l => todasLasPalabrasEstan(tokens(l.name), targetTokens));

  if (!match) {
    const candidatas = results.slice(0, 8).map(l => l.name).join(', ') || '(ninguna)';
    throw new Error(
      `"${leagueDisplayName}" no coincide con ningún nombre de liga que Bzzoiro tiene para ${country}. ` +
      `Ligas que sí devolvió: ${candidatas}`
    );
  }

  leagueIdCache.set(leagueKey, match.id);
  return match.id;
}

async function resolveCurrentSeason(bzzoiroLeagueId) {
  if (seasonIdCache.has(bzzoiroLeagueId)) return seasonIdCache.get(bzzoiroLeagueId);
  try {
    const season = await fetchFromAPI(`/leagues/${bzzoiroLeagueId}/season/`);
    seasonIdCache.set(bzzoiroLeagueId, season.id);
    return season.id;
  } catch (e) {
    console.warn('⚠️ Error resolviendo temporada actual:', e.message);
    seasonIdCache.set(bzzoiroLeagueId, null);
    return null;
  }
}

// Las copas devuelven { groups: [{ rows: [...] }, ...] } en vez de rows plano
function extractRows(standingsResponse) {
  const table = standingsResponse.standings?.[0];
  if (!table) return [];
  if (Array.isArray(table.rows)) return table.rows;
  if (Array.isArray(table.groups)) return table.groups.flatMap(g => g.rows || []);
  return [];
}

export async function fetchLeagueDynamicData(leagueKey, leagueDisplayName) {
  const bzzoiroLeagueId = await resolveLeagueId(leagueKey, leagueDisplayName);
  if (!bzzoiroLeagueId) throw new Error('Liga no resoluble en Bzzoiro (se usa dato estático)');

  const seasonId = await resolveCurrentSeason(bzzoiroLeagueId);
  const query = seasonId ? `?season_id=${seasonId}` : '';

  console.log(`🔍 Obteniendo standings de liga Bzzoiro #${bzzoiroLeagueId}`);
  const data = await fetchFromAPI(`/leagues/${bzzoiroLeagueId}/standings/${query}`);
  const rows = extractRows(data);
  if (rows.length === 0) throw new Error('No se pudieron obtener standings');

  let totalGF = 0;
  let totalPlayed = 0;
  const teamStats = {};

  for (const row of rows) {
    const name = row.team?.name ?? row.team_name;
    const played = row.played || 0;
    const gf = row.goals_for || 0;
    const ga = row.goals_against || 0;

    teamStats[name] = { played, gf, ga };
    totalGF += gf;
    totalPlayed += played;
  }

  // Promedio de goles por partido de la liga, a partir de partidos REALMENTE jugados
  // (antes se asumía round-robin completo, lo que rompía el promedio a mitad de temporada)
  const goalsAvg = totalPlayed > 0 ? (totalGF / totalPlayed) * 2 : null;
  if (!goalsAvg) throw new Error('Datos insuficientes (0 partidos jugados)');

  const teamRatings = {};
  for (const [name, s] of Object.entries(teamStats)) {
    if (s.played < 3) continue; // muestra muy chica, mejor dejar el fallback estático para ese equipo
    const gfPerMatch = s.gf / s.played;
    const gaPerMatch = s.ga / s.played;
    teamRatings[name] = {
      atk: +(gfPerMatch / (goalsAvg / 2)).toFixed(3),
      def: +(gaPerMatch / (goalsAvg / 2)).toFixed(3)
    };
  }

  console.log(`✅ Standings OK. Equipos con datos en vivo: ${Object.keys(teamRatings).length}/${rows.length}`);
  return { goalsAvg, cornAvg: null, teamRatings, bzzoiroLeagueId };
}

// ---------- Predicción propia de Bzzoiro (modelo ML / CatBoost) ----------
// Se usa solo como comparación/mezcla con nuestro modelo Poisson+Dixon-Coles;
// si no se encuentra el partido, simplemente no se muestra (no rompe nada).
export async function fetchMatchPrediction(bzzoiroLeagueId, homeTeam, awayTeam) {
  if (!bzzoiroLeagueId) return null;

  const today = new Date();
  const in21 = new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().slice(0, 10);

  try {
    const data = await fetchFromAPI(
      `/predictions/?league_id=${bzzoiroLeagueId}&date_from=${fmt(today)}&date_to=${fmt(in21)}&limit=100`
    );
    const results = data.results || data || [];
    const h = cleanName(homeTeam);
    const a = cleanName(awayTeam);

    const found = results.find(p => {
      const eh = cleanName(p.event?.home_team || '');
      const ea = cleanName(p.event?.away_team || '');
      return (eh === h || eh.includes(h) || h.includes(eh))
          && (ea === a || ea.includes(a) || a.includes(ea));
    });

    if (!found) return null;
    console.log(`🤖 Predicción ML de Bzzoiro encontrada para ${homeTeam} vs ${awayTeam}`);
    return found;
  } catch (e) {
    console.warn('⚠️ No se pudo obtener predicción ML de Bzzoiro:', e.message);
    return null;
  }
}
