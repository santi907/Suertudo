import { LIGAS, TEAM_STRENGTH_DB, HOME_ADVANTAGE, CORNER_HOME_BIAS } from './config/leagues.js';
import * as stats from './js/models/stats.js';
import { fetchLeagueDynamicData } from './api.js';

// Cache para datos dinámicos por liga
const dynamicCache = {};

async function getDynamicData(leagueKey) {
  if (dynamicCache[leagueKey]) return dynamicCache[leagueKey];
  
  try {
    const data = await fetchLeagueDynamicData(leagueKey);
    dynamicCache[leagueKey] = data;
    return data;
  } catch (e) {
    console.warn('Fallback a datos estáticos:', e.message);
    return null;
  }
}

function getTeamRating(leagueKey, teamName, dynamicRatings) {
  // Primero busca en dinámico
  if (dynamicRatings?.[teamName]) return dynamicRatings[teamName];
  // Luego estático
  return TEAM_STRENGTH_DB[leagueKey]?.[teamName] || { atk: 1.0, def: 1.0 };
}

export async function simulateMatch(leagueKey, homeTeam, awayTeam) {
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
  
  // Córneres (si la liga tiene cornAvg válido)
  let cornerProbs = null;
  if (cornAvg && cornAvg > 0) {
    const { home: lCornerHome, away: lCornerAway } = stats.splitCornerLambda(
      cornAvg, hRating.atk, hRating.def, aRating.atk, aRating.def, CORNER_HOME_BIAS
    );
    const totalCorners = lCornerHome + lCornerAway;
    cornerProbs = {
      over8: stats.negBinOver(totalCorners, 7.5, liga.cornR || 20),
      over9: stats.negBinOver(totalCorners, 8.5, liga.cornR || 20),
      over10: stats.negBinOver(totalCorners, 9.5, liga.cornR || 20),
      over11: stats.negBinOver(totalCorners, 10.5, liga.cornR || 20),
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

