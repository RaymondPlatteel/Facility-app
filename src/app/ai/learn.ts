// The learning part: a logistic regression that predicts the coach's decision (approve = 1, reject = 0) from the
// numbers the analysis measured. It is retrained from every labelled review, so each decision the coach makes teaches
// it, and it reports its accuracy honestly (each review is predicted by a model trained without it).

export interface Trained {
  weights: number[];   // bias first
  mean: number[];
  std: number[];
}

function sigmoid(z: number): number { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }

export function predict(m: Trained, x: number[]): number {
  let z = m.weights[0];
  for (let i = 0; i < x.length; i++) z += m.weights[i + 1] * ((x[i] - m.mean[i]) / m.std[i]);
  return sigmoid(z);
}

// Gradient descent with a little L2 regularisation, which keeps a model trained on few reviews from overreaching.
export function train(X: number[][], y: number[], epochs = 400, lr = 0.15, l2 = 0.05): Trained {
  const d = X[0]?.length ?? 0;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / X.length);
  const std = Array.from({ length: d }, (_, j) => {
    const v = X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / X.length;
    return Math.sqrt(v) || 1;
  });
  const Z = X.map(r => r.map((v, j) => (v - mean[j]) / std[j]));
  const w = new Array(d + 1).fill(0);
  // Start the bias at the base rate.
  const p0 = Math.min(0.98, Math.max(0.02, y.reduce((a, b) => a + b, 0) / y.length));
  w[0] = Math.log(p0 / (1 - p0));
  for (let e = 0; e < epochs; e++) {
    const g = new Array(d + 1).fill(0);
    for (let i = 0; i < Z.length; i++) {
      let z = w[0];
      for (let j = 0; j < d; j++) z += w[j + 1] * Z[i][j];
      const err = sigmoid(z) - y[i];
      g[0] += err;
      for (let j = 0; j < d; j++) g[j + 1] += err * Z[i][j];
    }
    w[0] -= (lr * g[0]) / Z.length;
    for (let j = 0; j < d; j++) w[j + 1] -= lr * (g[j + 1] / Z.length + l2 * w[j + 1]);
  }
  return { weights: w, mean, std };
}

// Held-out accuracy: every review is predicted by a model trained without it (one at a time up to 60 reviews, then in
// five folds, which keeps it quick as the reviews pile up).
export function looAccuracy(X: number[][], y: number[]): number {
  if (X.length < 4) return 0;
  if (X.length > 60) {
    const k = 5;
    let right = 0;
    for (let f = 0; f < k; f++) {
      const test = X.map((_, i) => i).filter(i => i % k === f);
      const Xt = X.filter((_, i) => i % k !== f), yt = y.filter((_, i) => i % k !== f);
      const m = train(Xt, yt, 250);
      for (const i of test) right += (predict(m, X[i]) >= 0.5 ? 1 : 0) === y[i] ? 1 : 0;
    }
    return right / X.length;
  }
  let right = 0;
  for (let i = 0; i < X.length; i++) {
    const Xt = X.filter((_, k) => k !== i), yt = y.filter((_, k) => k !== i);
    if (new Set(yt).size < 2) { right += (yt[0] === y[i]) ? 1 : 0; continue; }
    const m = train(Xt, yt, 250);
    right += (predict(m, X[i]) >= 0.5 ? 1 : 0) === y[i] ? 1 : 0;
  }
  return right / X.length;
}

// ---------- weight: a small ridge regression ----------
// Predicts what the bar held, as a share of the athlete's best verified result, from the bar speed (as a share of a max)
// and what the plates looked like. Trained on the weights the coach has confirmed. Solved exactly: (XtX + lambda I) w = Xt y.
export function trainRidge(X: number[][], y: number[], lambda = 0.5): Trained {
  const d = X[0]?.length ?? 0;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[j], 0) / X.length);
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mean[j]) ** 2, 0) / X.length) || 1);
  const Z = X.map(r => [1, ...r.map((v, j) => (v - mean[j]) / std[j])]);
  const n = d + 1;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j && i > 0 ? lambda : 0)));
  const b = Array.from({ length: n }, (_, i) => Z.reduce((s, r, k) => s + r[i] * y[k], 0));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    const div = A[c][c] || 1e-9;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / div;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const w = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * w[k];
    w[r] = s / (A[r][r] || 1e-9);
  }
  return { weights: w, mean, std };
}

export function predictRidge(m: Trained, x: number[]): number {
  let z = m.weights[0];
  for (let i = 0; i < x.length; i++) z += m.weights[i + 1] * ((x[i] - m.mean[i]) / m.std[i]);
  return z;
}

// Mean absolute error with each example predicted by a model trained without it.
export function looMae(X: number[][], y: number[]): number {
  if (X.length < 4) return Infinity;
  let err = 0;
  for (let i = 0; i < X.length; i++) {
    const m = trainRidge(X.filter((_, k) => k !== i), y.filter((_, k) => k !== i));
    err += Math.abs(predictRidge(m, X[i]) - y[i]);
  }
  return err / X.length;
}
