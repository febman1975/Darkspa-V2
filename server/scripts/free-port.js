const { execSync } = require('child_process');

function getPortFromArgs() {
  const value = Number(process.argv[2] || 8080);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port: ${process.argv[2]}`);
  }
  return value;
}

function getPidsOnWindows(port) {
  try {
    const output = execSync(`netstat -ano -p tcp | findstr :${port}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    });

    return [...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(/\s+/).at(-1))
        .map((pid) => Number(pid))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    )];
  } catch {
    return [];
  }
}

function getPidsOnUnix(port) {
  try {
    const output = execSync(`lsof -ti tcp:${port}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    });

    return [...new Set(
      output
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    )];
  } catch {
    return [];
  }
}

function killPidWindows(pid) {
  execSync(`taskkill /PID ${pid} /F`, { stdio: ['ignore', 'ignore', 'ignore'] });
}

function killPidUnix(pid) {
  process.kill(pid, 'SIGTERM');
}

function main() {
  const port = getPortFromArgs();
  const isWindows = process.platform === 'win32';
  const pids = isWindows ? getPidsOnWindows(port) : getPidsOnUnix(port);

  if (pids.length === 0) {
    console.log(`[free-port] Port ${port} is already free.`);
    return;
  }

  for (const pid of pids) {
    try {
      if (isWindows) {
        killPidWindows(pid);
      } else {
        killPidUnix(pid);
      }
      console.log(`[free-port] Stopped PID ${pid} on port ${port}.`);
    } catch (error) {
      console.warn(`[free-port] Failed to stop PID ${pid}: ${error.message}`);
    }
  }
}

main();
