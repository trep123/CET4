// 间隔复习调度（方案书 §6.2 初版规则）
export const RATINGS = [
  { value: 'again', label: '忘记了', key: '1' },
  { value: 'hard', label: '有点模糊', key: '2' },
  { value: 'good', label: '认识', key: '3' },
  { value: 'easy', label: '很熟悉', key: '4' },
];

const DAY_MS = 86400000;

export function schedule(state, rating, now = new Date()) {
  let r = state?.repetitions ?? 0;
  let I = state?.interval_days ?? 0;
  let EF = state?.ease_factor ?? 2.5;
  let lapses = state?.lapses ?? 0;

  switch (rating) {
    case 'again':
      r = 0;
      I = 10 / 1440;
      EF = Math.max(1.3, EF - 0.2);
      lapses += 1;
      break;
    case 'hard':
      I = I > 0 ? Math.max(1, I * 1.2) : 1;
      EF = Math.max(1.3, EF - 0.15);
      break;
    case 'good':
      if (r === 0) I = 1;
      else if (r === 1) I = 3;
      else I = Math.max(1, Math.round(I * EF));
      r += 1;
      break;
    case 'easy':
      if (r === 0) I = 3;
      else if (r === 1) I = 5;
      else I = Math.max(2, Math.round(I * EF * 1.3));
      EF = Math.min(3.0, EF + 0.15);
      r += 1;
      break;
    default:
      throw new Error('无效评级');
  }
  EF = Math.min(3.0, Math.max(1.3, EF));
  const due = new Date(now.getTime() + I * DAY_MS);
  return {
    repetitions: r,
    interval_days: I,
    ease_factor: Math.round(EF * 100) / 100,
    lapses,
    due_at: due.toISOString(),
  };
}
