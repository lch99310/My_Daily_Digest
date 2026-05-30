// CK Investment three-step fair-price formula.
//   Step 1: future value (5yr) = today × (1 + growth)^horizon
//   Step 2: future price        = future value × multiplier (PEG-derived)
//   Step 3: fair today          = future price ÷ (1 + requiredReturn)^horizon
// requiredReturn comes from CAPM: riskFree + beta × equityRiskPremium.

function _ckDiscount({ today, growth, multiplier, beta, riskFree, erp, horizon }) {
  const inputs = [today, growth, multiplier, beta, riskFree, erp, horizon];
  if (!inputs.every(Number.isFinite)) return null;
  if (today <= 0 || horizon <= 0) return null;

  const requiredReturn = riskFree + beta * erp;
  const futureValue    = today * Math.pow(1 + growth, horizon);
  const futurePrice    = futureValue * multiplier;
  const fairToday      = futurePrice / Math.pow(1 + requiredReturn, horizon);

  return { fairToday, requiredReturn, futureValue, futurePrice, multiplier };
}

// growth as decimal (0.35 = 35%). PEG-derived P/E = (growth * 100) * pegMult.
export function calcFairPriceEPS({ eps, growth, beta, riskFree, erp = 0.06, pegMult = 1.25, horizon = 5 }) {
  const multiplier = (growth * 100) * pegMult;
  return _ckDiscount({ today: eps, growth, multiplier, beta, riskFree, erp, horizon });
}

export function calcFairPriceFCF({ fcfPerShare, growth, beta, riskFree, erp = 0.06, pegMult = 1.25, horizon = 5 }) {
  const multiplier = (growth * 100) * pegMult;
  return _ckDiscount({ today: fcfPerShare, growth, multiplier, beta, riskFree, erp, horizon });
}
