const logs = [];

// Intercept console.log
const originalLog = console.log;
console.log = function (...args) {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  logs.push({ type: 'log', message, timestamp: new Date().toISOString() });
  if (logs.length > 500) logs.shift(); // Limit to last 500 logs
  originalLog.apply(console, args);
};

// Intercept console.error
const originalError = console.error;
console.error = function (...args) {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  logs.push({ type: 'error', message, timestamp: new Date().toISOString() });
  if (logs.length > 500) logs.shift();
  originalError.apply(console, args);
};

// Intercept console.warn
const originalWarn = console.warn;
console.warn = function (...args) {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  logs.push({ type: 'warn', message, timestamp: new Date().toISOString() });
  if (logs.length > 500) logs.shift();
  originalWarn.apply(console, args);
};

function getLogs() {
  return logs;
}

module.exports = {
  getLogs
};
