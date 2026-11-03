// Reference calculation for the bill splitter: exact cents with integer math, half-up only at display.
export function split(bill, tip, people) {
  const b = Number(bill), t = Number(tip), p = Number(people);
  if (!(b >= 0) || String(bill).trim() === '' || !Number.isInteger(p) || p < 1) return { tip: '$0.00', total: '$0.00', per: '$0.00', error: true };
  // work in hundred-thousandths of a dollar to avoid float drift, round half up at the end
  const billU = Math.round(b * 1e5), tipU = billU * t / 100, totalU = billU + tipU, perU = totalU / p;
  const fmt = u => '$' + (Math.floor(u / 1e3 + 0.5 + 1e-9) / 100).toFixed(2);
  return { tip: fmt(tipU), total: fmt(totalU), per: fmt(perU), error: false };
}
