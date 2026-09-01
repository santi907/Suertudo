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

// Promedia nuestro modelo con el de Bzzoiro, pesando según la confianza que
// Bzzoiro declara en su propia predicción (si no la manda, usa 50/50 llano)
function blend(own, ml) {
  const w = typeof ml.confidence === 'number' ? Math.min(1, Math.max(0, ml.confidence)) : 0.5;
  const mix = (ownVal, mlVal) => +((ownVal * (1 - w) + mlVal * w)).toFixed(1);
  return {
    resultProbs: {
      local: mix(own.resultProbs.local, ml.resultProbs.local),
      empate: mix(own.resultProbs.empate, ml.resultProbs.empate),
      visitante: mix(own.resultProbs.visitante, ml.resultProbs.visitante),
    },
    over15: mix(own.over15, ml.over15),
    over25: mix(own.over25, ml.over25),
    btts: mix(own.btts, ml.btts),
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

  // goalsAvg guardado en leagues.js es el promedio TOTAL de goles del
  // partido (ambos equipos combinados) — por eso se reparte /2 entre cada
  // equipo antes de aplicar su rating de ataque/defensa. Usar goalsAvg
  // completo para cada equipo duplicaba los goles esperados del partido.
  const homeAdv = HOME_ADVANTAGE[leagueKey] || 1.0;
  const avgPerTeam = goalsAvg / 2;
  const lambdaHome = avgPerTeam * hRating.atk * aRating.def * homeAdv;
  const lambdaAway = avgPerTeam * aRating.atk * hRating.def;

  const resultProbs = stats.calcResultProbs(lambdaHome, lambdaAway, leagueKey);

  const over15 = stats.over15DC(lambdaHome, lambdaAway, leagueKey);
  const over25 = stats.poissonOver(lambdaHome + lambdaAway, 2.5);
  const over35 = stats.poissonOver(lambdaHome + lambdaAway, 3.5);

  const btts = stats.calcBTTS(lambdaHome, lambdaAway, leagueKey);

  let cornerProbs = null;
  if (cornAvg && cornAvg > 0) {
    const { home: lCornerHome, away: lCornerAway } = stats.splitCornerLambda(
      cornAvg, hRating.atk, hRating.def, aRating.atk, aRating.def, CORNER_HOME_BIAS
    );
    const totalCorners = lCornerHome + lCornerAway;
    const r = liga.cornR || 20;
    cornerProbs = {
      over7: stats.negBinOver(totalCorners, 7.5, r),
      over8: stats.negBinOver(totalCorners, 8.5, r),
      over9: stats.negBinOver(totalCorners, 9.5, r),
      over10: stats.negBinOver(totalCorners, 10.5, r),
      over11: stats.negBinOver(totalCorners, 11.5, r),
      porEquipo: {
        local: {
          esperado: lCornerHome,
          // Usa el mismo "r" de la liga aplicado a la porción de cada equipo
          // (aproximación: no hay un dato real de dispersión por equipo)
          over3: stats.negBinOver(lCornerHome, 3.5, r),
          over4: stats.negBinOver(lCornerHome, 4.5, r),
        },
        visitante: {
          esperado: lCornerAway,
          over3: stats.negBinOver(lCornerAway, 3.5, r),
          over4: stats.negBinOver(lCornerAway, 4.5, r),
        }
      }
    };
  }

  const calLocal = stats.plattCalibrate(resultProbs.home, 'resultado');
  const calEmpate = stats.plattCalibrate(resultProbs.draw, 'resultado');
  const calVisitante = stats.plattCalibrate(resultProbs.away, 'resultado');
  // Cada probabilidad se calibra por separado, así que ya no suman
  // exactamente 100 — se renormaliza manteniendo las proporciones.
  const sumaCal = calLocal + calEmpate + calVisitante;

  const ownResult = {
    liga: liga.name,
    homeTeam,
    awayTeam,
    resultProbs: {
      local: +(calLocal * 100 / sumaCal).toFixed(1),
      empate: +(calEmpate * 100 / sumaCal).toFixed(1),
      visitante: +(calVisitante * 100 / sumaCal).toFixed(1),
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
