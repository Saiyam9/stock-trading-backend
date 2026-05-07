export function daysBetween(dateA, dateB) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const a = typeof dateA === 'string' ? new Date(dateA) : dateA;
  const b = typeof dateB === 'string' ? new Date(dateB) : dateB;
  return Math.floor(Math.abs(b - a) / msPerDay);
}

export function formatINR(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

export function isMarketHours() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;

  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const timeInMinutes = hours * 60 + minutes;

  const marketOpen = 9 * 60 + 15;
  const marketClose = 15 * 60 + 30;

  return timeInMinutes >= marketOpen && timeInMinutes <= marketClose;
}

export function getISTTimeParts() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return {
    day: ist.getDay(),
    hour: ist.getHours(),
    minute: ist.getMinutes(),
    totalMinutes: ist.getHours() * 60 + ist.getMinutes(),
  };
}

export function isAfterISTTime(hour, minute) {
  const { totalMinutes } = getISTTimeParts();
  const target = hour * 60 + minute;
  return totalMinutes >= target;
}

export function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
