#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * F3 Final QA — v5 (definitive)
 * Fixes: no paddle input to prevent score-based match ends, __test_dropSocket for clean disconnects
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5173';
const SERVER = 'http://localhost:3001';
const EVIDENCE = '.omo/evidence/final-f3';
mkdirSync(EVIDENCE, { recursive: true });
const results = [];
let browser;

const q = (id, name) => `?frame_id=mock&test_user_id=${id}&test_username=${name}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resetServer() {
  await fetch(`${SERVER}/api/_debug/reset`, { method: 'POST' });
  await sleep(1000);
  const s = await lobby();
  console.log(
    `   [reset] lobby=${s.phase} room=${s.roomPhase} disc=${s.disconnectedUsers?.length}`,
  );
}

async function lobby() {
  return (await fetch(`${SERVER}/api/_debug/lobby`)).json();
}

async function createCtx(id, name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(`${BASE}${q(id, name)}`);
  await page.waitForFunction(
    () => !!window.__orchestrator && window.__orchestrator.phase !== 'idle',
    { timeout: 20_000 },
  );
  await sleep(800);

  await page.evaluate(() => {
    window.__hbInterval = setInterval(
      () => window.__orchestrator?.socket?.emit('lobby_heartbeat'),
      3000,
    );
    window.__matchEndEvents = [];
    window.__pauseEvents = [];
    window.__resumeEvents = [];
    window.__stateSnaps = [];
    window.__serverErrors = [];
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__cspViolations.push({ v: e.violatedDirective, b: e.blockedURI }),
    );
    const s = window.__orchestrator?.socket;
    if (s) {
      s.on('matchEnd', (d) => window.__matchEndEvents.push(d));
      s.on('pause', (d) => window.__pauseEvents.push(d));
      s.on('resume', (d) => window.__resumeEvents.push(d));
      s.on('stateSnapshot', (d) => {
        if (window.__stateSnaps.length < 600)
          window.__stateSnaps.push({ x: d.ball.pos.x, y: d.ball.pos.y });
      });
      s.on('error', (d) => window.__serverErrors.push(d));
    }
  });
  return { ctx, page, id, name, errors };
}

async function cleanup(tc) {
  if (!tc) return;
  try {
    await tc.page.evaluate(() => clearInterval(window.__hbInterval));
    await tc.ctx.close();
  } catch {}
}

async function ready(tc) {
  return tc.page.evaluate(() => {
    window.__orchestrator?.socket?.emit('readyToggle');
    return true;
  });
}

async function dropSocket(tc) {
  return tc.page.evaluate(() => window.__test_dropSocket?.());
}

function ping(tc, x = 360) {
  const id = setInterval(() => {
    tc.page
      .evaluate(
        (px) => window.__orchestrator?.socket?.emit('paddleInput', { seq: Date.now(), x: px }),
        x,
      )
      .catch(() => {});
  }, 600);
  return () => clearInterval(id);
}

const phase = (tc) => tc.page.evaluate(() => window.__orchestrator?.phase ?? '?');
const role = (tc) => tc.page.evaluate(() => window.__orchestrator?.currentRole ?? '?');
const shot = (tc, name) =>
  tc.page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });

function record(name, pass, details) {
  results.push({ name, pass, details });
  console.log(`  ${pass ? '✅ PASS' : '❌ FAIL'}: ${name} — ${details}`);
}

async function waitPhase(tc, target, timeout = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await phase(tc)) === target) return true;
    await sleep(500);
  }
  console.log(`   ⏰ waitPhase(${target}) timeout`);
  return false;
}

async function waitMatchEnd(tc, timeout = 50_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const evts = await tc.page.evaluate(() => window.__matchEndEvents);
    if (evts.length > 0) return evts[0];
    await sleep(1000);
  }
  return null;
}

// ── S1: Full Match E2E ─────────────────────────────────────────────────────

async function scenario1() {
  console.log('\n━━━ S1: Full Match E2E ━━━');
  const A = await createCtx('alice', 'Alice');
  const B = await createCtx('bob', 'Bob');
  try {
    await shot(A, 's1-lobby');
    await ready(A);
    await ready(B);

    const cdOk = await waitPhase(A, 'countdown', 10_000);
    if (cdOk) await shot(A, 's1-countdown');

    const C = await createCtx('charlie', 'Charlie');
    await sleep(800);
    const cRole = await role(C);
    console.log(`   Charlie: ${cRole}`);
    await shot(C, 's1-spectator');
    const cReady = await C.page.evaluate(
      () => !!window.__pong_scene?.getLayers()?.uiLayer?.getChildByLabel?.('readyOverlay', true),
    );

    const playOk = await waitPhase(A, 'playing', 15_000);
    if (playOk) {
      await sleep(1500);
      await shot(A, 's1-playing');
    }

    const endData = await waitMatchEnd(A, 130_000);
    const endOk = !!endData?.end_reason;
    if (endOk) await shot(A, 's1-end');

    const pass = cRole === 'spectator' && !cReady && cdOk && playOk && endOk;
    record(
      'Full match E2E',
      pass,
      `spectator=${cRole === 'spectator'} noReady=${!cReady} cd=${cdOk} play=${playOk} end=${endOk} reason=${endData?.end_reason}`,
    );
    await cleanup(C);
  } catch (e) {
    record('Full match E2E', false, e.message);
  } finally {
    await cleanup(A);
    await cleanup(B);
  }
}

// ── S2: Lobby Race ─────────────────────────────────────────────────────────

async function scenario2() {
  console.log('\n━━━ S2: Lobby Race ━━━');
  const A = await createCtx('race_a', 'RA');
  const B = await createCtx('race_b', 'RB');
  const C = await createCtx('race_c', 'RC');
  try {
    await Promise.all([ready(A), ready(B), ready(C)]);
    await sleep(3000);
    const l = await lobby();
    const lfe = await Promise.all(
      [A, B, C].map((tc) =>
        tc.page.evaluate(
          () => (window.__serverErrors ?? []).filter((e) => e.code === 'LOBBY_FULL').length,
        ),
      ),
    );
    const slots = [l.slots?.top, l.slots?.bottom].filter(Boolean).length;
    await shot(A, 's2-race');
    const pass = slots === 2 && lfe.reduce((a, b) => a + b) >= 1;
    record('Lobby race (3→2P+1S)', pass, `slots=${slots} lobbyFull=${lfe.reduce((a, b) => a + b)}`);
  } catch (e) {
    record('Lobby race', false, e.message);
  } finally {
    await cleanup(A);
    await cleanup(B);
    await cleanup(C);
  }
}

// ── S3: Disconnect → forfeit_dc ────────────────────────────────────────────
// NO paddle input — ball bounces between centered paddles indefinitely

async function scenario3() {
  console.log('\n━━━ S3: Disconnect Mid-Rally ━━━');
  await resetServer();
  const A = await createCtx('dc_a', 'DcA');
  const B = await createCtx('dc_b', 'DcB');
  try {
    await ready(A);
    await ready(B);
    const playOk = await waitPhase(A, 'playing', 15_000);
    if (!playOk) {
      record('Disconnect → forfeit_dc', false, 'no playing');
      return;
    }

    await sleep(1000); // Let match stabilize

    // Drop Alice socket — no paddle input means ball bounces forever, no score
    await dropSocket(A);
    console.log('   Alice socket dropped');

    const endData = await waitMatchEnd(B, 50_000);
    await shot(B, 's3-forfeit');

    const pass = endData?.end_reason === 'forfeit_dc';
    record(
      'Disconnect → forfeit_dc',
      pass,
      `reason=${endData?.end_reason} winner=${endData?.winnerSlot}`,
    );
  } catch (e) {
    record('Disconnect → forfeit_dc', false, e.message);
  } finally {
    await cleanup(A);
    await cleanup(B);
  }
}

// ── S4: AFK forfeit ────────────────────────────────────────────────────────
// NO paddle input — both AFK, ball bounces forever

async function scenario4() {
  console.log('\n━━━ S4: AFK Forfeit ━━━');
  await resetServer();
  const A = await createCtx('afk_a', 'AfA');
  const B = await createCtx('afk_b', 'AfB');
  try {
    await ready(A);
    await ready(B);
    const playOk = await waitPhase(A, 'playing', 15_000);
    if (!playOk) {
      record('AFK forfeit', false, 'no playing');
      return;
    }

    // Neither sends input — both AFK. Ball bounces between centered paddles.
    console.log('   Both AFK, waiting for forfeit_afk...');

    const endData = await waitMatchEnd(A, 50_000);
    await shot(B, 's4-afk');

    const pass = endData?.end_reason === 'forfeit_afk';
    record(
      'AFK forfeit (30s)',
      pass,
      `reason=${endData?.end_reason} winner=${endData?.winnerSlot}`,
    );
  } catch (e) {
    record('AFK forfeit', false, e.message);
  } finally {
    await cleanup(A);
    await cleanup(B);
  }
}

// ── S5: Reconnection ───────────────────────────────────────────────────────

async function scenario5() {
  console.log('\n━━━ S5: Reconnection ━━━');
  await resetServer();
  const A = await createCtx('re_a', 'ReA');
  const B = await createCtx('re_b', 'ReB');
  try {
    await ready(A);
    await ready(B);
    const playOk = await waitPhase(A, 'playing', 15_000);
    if (!playOk) {
      record('Reconnect → resume', false, 'no playing');
      return;
    }

    // No paddle input — ball bounces forever
    await sleep(2000);

    // Track pause/resume on Bob
    await B.page.evaluate(() => {
      window.__pn = 0;
      window.__rn = 0;
      const s = window.__orchestrator?.socket;
      if (s) {
        s.on('pause', () => window.__pn++);
        s.on('resume', () => window.__rn++);
      }
    });

    // Drop Alice socket (clean disconnect)
    await dropSocket(A);
    console.log('   Alice socket dropped');

    await sleep(2000);
    const lBefore = await lobby();
    console.log(
      `   Lobby: phase=${lBefore.phase} disc=${JSON.stringify(lBefore.disconnectedUsers)}`,
    );
    await shot(B, 's5-paused');

    // Close Alice's context
    await A.ctx.close();
    await sleep(1000);

    // Recreate Alice with same userId (within 30s grace)
    const A2 = await createCtx('re_a', 'ReA');
    await sleep(3000);

    const r2 = await role(A2);
    const p2 = await phase(A2);
    const rn = await B.page.evaluate(() => window.__rn);
    const pn = await B.page.evaluate(() => window.__pn);
    await shot(A2, 's5-reconnected');
    await shot(B, 's5-bob-resumed');

    console.log(`   A2: role=${r2} phase=${p2} pauses=${pn} resumes=${rn}`);
    const pass = r2 === 'player' && rn > 0;
    record('Reconnect → resume', pass, `role=${r2} phase=${p2} pause=${pn} resume=${rn}`);
    await cleanup(A2);
  } catch (e) {
    record('Reconnect → resume', false, e.message);
  } finally {
    await cleanup(A);
    await cleanup(B);
  }
}

// ── S6: Tab-Hidden Resync ──────────────────────────────────────────────────

async function scenario6() {
  console.log('\n━━━ S6: Tab-Hidden Resync ━━━');
  await resetServer();
  const A = await createCtx('vis_a', 'ViA');
  const B = await createCtx('vis_b', 'ViB');
  try {
    await ready(A);
    await ready(B);
    await waitPhase(A, 'playing', 15_000);
    const stopA = ping(A, 300);
    const stopB = ping(B, 420);
    await sleep(3000);
    await A.page.evaluate(() => {
      window.__stateSnaps = [];
    });
    await sleep(500);

    await A.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(5000);
    await shot(A, 's6-hidden');

    await A.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(2000);
    stopA();
    stopB();

    const p = await phase(A);
    const after = await A.page.evaluate(() => {
      const s = window.__stateSnaps;
      return s.length ? s[s.length - 1] : null;
    });
    const snaps = await A.page.evaluate(() => window.__stateSnaps.length);
    await shot(A, 's6-resynced');

    const dist = after ? Math.sqrt((after.x - 360) ** 2 + (after.y - 640) ** 2) : 999;
    const pass = p === 'playing' && dist > 50 && snaps > 0;
    record(
      'Tab-hidden resync',
      pass,
      `phase=${p} noReset=${dist > 50} snaps=${snaps} dist=${dist.toFixed(0)}`,
    );
  } catch (e) {
    record('Tab-hidden resync', false, e.message);
  } finally {
    await cleanup(A);
    await cleanup(B);
  }
}

// ── S7: CSP Check ──────────────────────────────────────────────────────────

async function scenario7() {
  console.log('\n━━━ S7: CSP Check ━━━');
  await resetServer();
  const A = await createCtx('csp_a', 'CA');
  const B = await createCtx('csp_b', 'CB');
  const C = await createCtx('csp_c', 'CC');
  try {
    await ready(A);
    await ready(B);
    await waitPhase(A, 'playing', 15_000);
    const stopA = ping(A, 300);
    const stopB = ping(B, 420);
    await sleep(4000);
    stopA();
    stopB();

    const v = await Promise.all(
      [A, B, C].map((tc) => tc.page.evaluate(() => window.__cspViolations ?? [])),
    );
    const allV = v.flat();
    await shot(A, 's7-csp');
    const cspE = [...A.errors, ...B.errors, ...C.errors].filter(
      (e) => e.includes('Security Policy') || e.includes('Refused to'),
    );
    const pass = allV.length === 0 && cspE.length === 0;
    record('CSP zero violations', pass, `violations=${allV.length} cspErrors=${cspE.length}`);
  } catch (e) {
    record('CSP zero violations', false, e.message);
  } finally {
    await cleanup(A);
    await cleanup(B);
    await cleanup(C);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  F3 Final QA — discord-pingpong-activity v5  ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  try {
    const r = await fetch(`${SERVER}/api/_debug/lobby`);
    if (!r.ok) throw new Error();
    console.log('✓ Server OK\n');
  } catch {
    console.error('✗ Server down');
    process.exit(1);
  }

  browser = await chromium.launch({ headless: true });

  await resetServer();
  await scenario1();
  await resetServer();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();

  await browser.close();

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const edge = results.filter((r) =>
    ['Disconnect', 'AFK', 'Reconnect', 'Tab-hidden'].some((n) => r.name.includes(n)),
  );
  const edgePass = edge.filter((r) => r.pass).length;
  const csp = results.find((r) => r.name.includes('CSP'));
  const cross = results.filter((r) =>
    ['Full match', 'Lobby race', 'Reconnect'].some((n) => r.name.includes(n)),
  );
  const crossP = cross.filter((r) => r.pass).length;

  const v = passed === total ? 'ALL PASS' : `${total - passed} FAIL`;
  const summary = `Scenarios [${passed}/${total} pass] | Cross-task [${cross.length}/${crossP}] | Edge Cases [${edge.length} tested / ${edgePass} pass] | CSP [${csp?.pass ? 'clean' : 'violations'}] | VERDICT ${v}`;
  console.log(`\n${'═'.repeat(70)}\n${summary}\n${'═'.repeat(70)}`);

  const report = `# F3 Final QA Report

**Date**: ${new Date().toISOString()}

\`\`\`
${summary}
\`\`\`

| # | Scenario | Status | Details |
|---|----------|--------|---------|
${results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.pass ? '✅' : '❌'} | ${r.details} |`).join('\n')}

## Evidence
Screenshots in \`.omo/evidence/final-f3/\`

## Server Changes Made
- \`lobby.reset()\` now clears socket/user/heartbeat maps (prevents stale player interference)
- \`room.resetToWaiting()\` fully resets room physics state between scenarios
- \`finishMatch\` uses generation counter to cancel stale 5s reset timeouts
- Debug endpoint enhanced with room phase, score, and disconnect tracking
`;

  writeFileSync(join(EVIDENCE, 'report.md'), report);
  writeFileSync(
    join(EVIDENCE, 'results.json'),
    JSON.stringify({ results, summary, passed, total }, null, 2),
  );
  console.log(`\n📄 ${EVIDENCE}/report.md`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
