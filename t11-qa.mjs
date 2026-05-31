import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as socketIO } from 'socket.io-client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3003;
const BASE = `http://localhost:${PORT}`;
const EVIDENCE = '.omo/evidence';
mkdirSync(EVIDENCE, { recursive: true });
const DB_FILE = pathResolve(__dirname, 'data/pingpong.sqlite');

let serverProc;

function startServer() {
  return new Promise((res, rej) => {
    serverProc = spawn('pnpm', ['exec', 'node', '--import', 'tsx', 'src/index.ts'], {
      cwd: 'packages/server',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TEST_AUTH_BYPASS: '1',
        DISCORD_CLIENT_ID: 'test_client_id',
        DISCORD_CLIENT_SECRET: 'test_client_secret',
        PORT: String(PORT),
        CLIENT_ORIGIN: 'http://localhost:5173',
        DB_PATH: DB_FILE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) rej(new Error('Server startup timeout'));
    }, 15000);

    serverProc.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(text);
      if (text.includes('listening') && !started) {
        started = true;
        clearTimeout(timeout);
        setTimeout(res, 500);
      }
    });

    serverProc.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    serverProc.on('exit', (code) => {
      if (!started) rej(new Error(`Server exited with code ${code}`));
    });
  });
}

async function waitForHealth(maxRetries = 15) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Health check failed');
}

function connect(claim, testUserId, ns = '') {
  return new Promise((res, rej) => {
    const url = ns ? `${BASE}${ns}` : BASE;
    const query = {};
    if (claim) query.claim = claim;
    const auth = {};
    if (testUserId) {
      auth.test_user_id = testUserId;
      auth.test_username = `user_${testUserId}`;
    }
    const socket = socketIO(url, { transports: ['websocket'], query, auth });
    const timer = setTimeout(() => {
      socket.disconnect();
      rej(new Error(`Connect timeout: ${url}`));
    }, 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      res(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      rej(err);
    });
  });
}

function once(socket, event, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      res(data);
    });
  });
}

function collect(socket, event, count, timeoutMs = 10000) {
  return new Promise((res) => {
    const msgs = [];
    const handler = (data) => {
      msgs.push(data);
      if (msgs.length >= count) {
        clearTimeout(timer);
        socket.off(event, handler);
        res(msgs);
      }
    };
    socket.on(event, handler);
    const timer = setTimeout(() => {
      socket.off(event, handler);
      res(msgs);
    }, timeoutMs);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function run() {
  console.log('Starting server...');
  await startServer();
  await waitForHealth();
  console.log('Server healthy.\n');

  let allPass = true;

  // ── Connect players to start a match ────────────────────────
  console.log('Connecting players...');
  const p1 = await connect('top', 'player_top', '/').catch((e) => {
    console.error('P1 fail:', e.message);
    throw e;
  });
  const p2 = await connect('bottom', 'player_bot', '/').catch((e) => {
    console.error('P2 fail:', e.message);
    throw e;
  });
  await sleep(2000);
  console.log('Players connected, match should be running.\n');

  // ── Scenario 1: Spectator rate ~15Hz ────────────────────────
  console.log('=== Scenario 1: Spectator receives ~15Hz throttled state ===');
  {
    const spec = await connect(null, 'spectator_1', '/spectate').catch((e) => {
      console.error('Spec1 fail:', e.message);
      throw e;
    });
    console.log(`  Spectator connected: id=${spec.id}`);

    const msgs = await collect(spec, 'SpectatorState', 999, 5000);
    const count = msgs.length;
    const hz = count / 5;
    const pass = count >= 60 && count <= 90;
    console.log(`  Messages in 5s: ${count} (${hz.toFixed(1)} Hz) — ${pass ? 'PASS' : 'FAIL'}`);
    writeFileSync(
      `${EVIDENCE}/task-11-spectator-rate.txt`,
      `SpectatorState messages in 5s: ${count}\nRate: ${hz.toFixed(2)} Hz\nExpected: 60-90 (12-18 Hz)\nResult: ${pass ? 'PASS' : 'FAIL'}\n`,
    );
    if (!pass) allPass = false;
    spec.disconnect();
  }

  // ── Scenario 2: Payload size < 500 bytes ────────────────────
  console.log('\n=== Scenario 2: Spectator payload size ===');
  {
    const spec = await connect(null, 'spectator_2', '/spectate');
    const msgs = await collect(spec, 'SpectatorState', 60, 8000);
    const sizes = msgs.map((m) => JSON.stringify(m).length);
    const med = median(sizes);
    const pass = med < 500;
    console.log(
      `  Samples: ${sizes.length}, Median: ${med} bytes, Min: ${Math.min(...sizes)}, Max: ${Math.max(...sizes)} — ${pass ? 'PASS' : 'FAIL'}`,
    );
    writeFileSync(
      `${EVIDENCE}/task-11-spectator-size.txt`,
      `Samples: ${sizes.length}\nMedian: ${med} bytes\nMin: ${Math.min(...sizes)} bytes\nMax: ${Math.max(...sizes)} bytes\nAll sizes: ${JSON.stringify(sizes)}\nResult: ${pass ? 'PASS' : 'FAIL'}\n`,
    );
    if (!pass) allPass = false;
    spec.disconnect();
  }

  // ── Scenario 3: Player cannot spectate ──────────────────────
  console.log('\n=== Scenario 3: Player cannot spectate ===');
  {
    let errorReceived = null;
    let disconnected = false;

    const spec = socketIO(`${BASE}/spectate`, {
      transports: ['websocket'],
      auth: { test_user_id: 'player_top', test_username: 'user_player_top' },
    });

    spec.on('Error', (data) => {
      console.log(`  Received Error: ${JSON.stringify(data)}`);
      errorReceived = data;
    });
    spec.on('connect', () => {
      console.log('  Spectator connected (unexpected!)');
    });
    spec.on('disconnect', (reason) => {
      console.log(`  Disconnected: ${reason}`);
      disconnected = true;
    });

    await sleep(3000);

    const pass = errorReceived?.code === 'PLAYER_CANNOT_SPECTATE' && disconnected;
    console.log(
      `  Error: ${errorReceived?.code ?? 'none'}, Disconnected: ${disconnected} — ${pass ? 'PASS' : 'FAIL'}`,
    );
    writeFileSync(
      `${EVIDENCE}/task-11-no-double-role.txt`,
      `Attempted spectate as active player (userId=player_top)\nError received: ${JSON.stringify(errorReceived)}\nDisconnected: ${disconnected}\nResult: ${pass ? 'PASS' : 'FAIL'}\n`,
    );
    if (!pass) allPass = false;
    spec.disconnect();
  }

  // ── Cleanup ─────────────────────────────────────────────────
  p1.disconnect();
  p2.disconnect();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`OVERALL: ${allPass ? 'ALL PASS ✓' : 'SOME FAILED ✗'}`);

  serverProc.kill('SIGTERM');
  process.exit(allPass ? 0 : 1);
}

run().catch((e) => {
  console.error('QA fatal:', e.message);
  if (serverProc) serverProc.kill('SIGTERM');
  process.exit(1);
});
