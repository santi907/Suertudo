import { LIGAS, TEAM_STRENGTH_DB, HOME_ADVANTAGE, CORNER_HOME_BIAS } from './leagues.js';
import * as stats from './stats.js';
import { fetchLeagueDynamicData, fetchMatchPrediction } from './api.js';

const dynamicCache = {};

async function getDynamicData(leagueKey, leagueDisplayName) {
  if (dynamicCache[leagueKey]) return dynamicCache[leagueKey];
  try {
    const data = await fetchLeagueDynamicData(leagueKey, leagueDisplayName);
    dynamicCache[leagueKey] = data;
    return data;
  } catch (e) {
    console.warn('Fallback a datos estáticos:', e.message);
    return null;
  }
}

// Fusiona equipos de sub-ligas si la liga es "compuesta" (ej. Copa del Rey = PD + SD2)
export function getTeamsForLeague(leagueKey) {
  const liga = LIGAS[leagueKey];
  if (liga?.compositeOf) {
    return liga.compositeOf.reduce(
      (acc, subKey) => ({ ...acc, ...(TEAM_STRENGTH_DB[subKey] || {}) }),
      {}
    );
  }
  return TEAM_STRENGTH_DB[leagueKey] || {};
}

function getTeamRating(leagueKey, teamName, dynamicRatings) {
  if (dynamicRatings?.[teamName]) return dynamicRatings[teamName];
  return getTeamsForLeague(leagueKey)[teamName] || { atk: 1.0, def: 1.0 };
}

// Promedia nuestro modelo con el de Bzzoiro solo en los mercados que ambos cubren
function blend(own, ml) {
  const avg = (a, b) => +(((a + b) / 2)).toFixed(1);
  return {
    resultProbs: {
      local: avg(own.resultProbs.local, ml.resultProbs.local),
      empate: avg(own.resultProbs.empate, ml.resultProbs.empate),
      visitante: avg(own.resultProbs.visitante, ml.resultProbs.visitante),
    },
    over15: avg(own.over15, ml.over15),
    over25: avg(own.over25, ml.over25),
    btts: avg(own.btts, ml.btts),
  };
}

export async function simulateMatch(leagueKey, homeTeam, awayTeam) {
  const liga = LIGAS[leagueKey];
  if (!liga) throw new Error('Liga no encontrada');

  const dynamic = await getDynamicData(leagueKey, liga.name);
  const goalsAvg = dynamic?.goalsAvg ?? liga.goalsAvg;
  const cornAvg = dynamic?.cornAvg ?? liga.cornAvg;

  const hRating = getTeamRating(leagueKey, homeTeam, dynamic?.teamRatings);
  const aRating = getTeamRating(leagueKey, awayTeam, dynamic?.teamRatings);

  const homeAdv = HOME_ADVANTAGE[leagueKey] || 1.0;
  const lambdaHome = goalsAvg * hRating.atk * aRating.def * homeAdv;
  const lambdaAway = goalsAvg * aRating.atk * hRating.def;

  const resultProbs = stats.calcResultProbs(lambdaHome, lambdaAway, leagueKey);

  const over15 = stats.poissonOver(lambdaHome + lambdaAway, 1.5);
  const over25 = stats.poissonOver(lambdaHome + lambdaAway, 2.5);
  const over35 = stats.poissonOver(lambdaHome + lambdaAway, 3.5);

  const btts = stats.calcBTTS(lambdaHome, lambdaAway, leagueKey);

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

  const ownResult = {
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

  // Intento traer la predicción ML de Bzzoiro para el mismo partido, si hay
  // token y la liga se pudo resolver. Es 100% opcional: si falla o no
  // encuentra el partido, se devuelve el resultado propio sin cambios.
  let bzzoiroML = null;
  if (dynamic?.bzzoiroLeagueId) {
    const pred = await fetchMatchPrediction(dynamic.bzzoiroLeagueId, homeTeam, awayTeam);
    if (pred?.markets) {
      bzzoiroML = {
        resultProbs: {
          local: pred.markets.match_result?.prob_home,
          empate: pred.markets.match_result?.prob_draw,
          visitante: pred.markets.match_result?.prob_away,
        },
        over15: pred.markets.over_under?.prob_over_15,
        over25: pred.markets.over_under?.prob_over_25,
        over35: pred.markets.over_under?.prob_over_35,
        btts: pred.markets.btts?.prob_yes,
        confidence: pred.model?.confidence ?? null,
      };
    }
  }

  const hasFullML = bzzoiroML
    && [bzzoiroML.resultProbs.local, bzzoiroML.resultProbs.empate, bzzoiroML.resultProbs.visitante, bzzoiroML.over15, bzzoiroML.over25, bzzoiroML.btts]
      .every(v => typeof v === 'number');

  return {
    ...ownResult,
    bzzoiroML,
    blended: hasFullML ? blend(ownResult, bzzoiroML) : null
  };
}
