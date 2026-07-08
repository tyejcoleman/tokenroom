#!/usr/bin/env node
import { tap } from '../src/tap.mjs';
import { hookUserPromptSubmit, hookPreCompact, hookSessionStart, hookPostCompact, hookPostToolUse, hookPreToolUse, hookStop } from '../src/hook.mjs';
import { addPin, listPins, removePins } from '../src/pins.mjs';
import { renderAudit } from '../src/events.mjs';
import { mcpServe } from '../src/mcp.mjs';
import { install, uninstall } from '../src/install.mjs';
import { readState } from '../src/state.mjs';
import { readResume, clearResume } from '../src/resume.mjs';
import { watchDashboard } from '../src/watch.mjs';
import { renderLine } from '../src/hud.mjs';

const [cmd, ...argv] = process.argv.slice(2);

switch (cmd) {
  case 'tap':
    await tap(argv);
    break;
  case 'watch':
    watchDashboard();
    break;
  case 'line':
    console.log(renderLine(readState(), readResume()));
    break;
  case 'hook': {
    // ADR-5 at the choke point: whatever a hook hits (hand-corrupted state files,
    // malformed stdin), it degrades to silence — a hook must never break the harness
    // or surface an error banner the user will misattribute to the wrong tool.
    try {
      if (argv[0] === 'user-prompt-submit') await hookUserPromptSubmit();
      else if (argv[0] === 'pre-compact') await hookPreCompact();
      else if (argv[0] === 'session-start') await hookSessionStart();
      else if (argv[0] === 'post-compact') await hookPostCompact();
      else if (argv[0] === 'pre-tool-use') await hookPreToolUse();
      else if (argv[0] === 'post-tool-use') await hookPostToolUse();
      else if (argv[0] === 'stop') await hookStop();
    } catch {
      process.exitCode = 0;
    }
    // unknown hook events exit silently — a hook must never break the harness
    break;
  }
  case 'pin': {
    let ttl;
    const words = [...argv];
    const ti = words.indexOf('--ttl-hours');
    if (ti >= 0) {
      ttl = Number(words[ti + 1]);
      words.splice(ti, 2);
    }
    const pin = addPin(words.join(' '), { ttl_hours: ttl });
    console.log(pin ? `pinned ${pin.id}: ${pin.text}` : 'usage: tokenroom pin "fact that must survive compaction" [--ttl-hours N]');
    break;
  }
  case 'pins': {
    const pins = listPins();
    console.log(pins.length ? pins.map((p) => `${p.id}  ${p.text}`).join('\n') : 'no pins');
    break;
  }
  case 'handoff': {
    const { latestContinuity } = await import('../src/continuity.mjs');
    const h = latestContinuity();
    if (!h) console.log('no handoff doc yet — the agent writes one via the tokenroom `handoff` MCP tool');
    else if (argv[0] === '--path') console.log(h.path);
    else console.log(h.markdown ?? `handoff doc at ${h.path} (unreadable)`);
    break;
  }
  case 'unpin': {
    const n = removePins(argv[0] === '--all' ? '--all' : argv[0]);
    console.log(n ? `removed ${n} pin${n > 1 ? 's' : ''}` : 'no matching pin (`tokenroom pins` to list)');
    break;
  }
  case 'resume': {
    if (argv.includes('--clear')) {
      console.log(clearResume() ? 'resume plan cleared' : 'no resume plan to clear');
    } else {
      const plan = readResume();
      console.log(plan ? JSON.stringify(plan, null, 2) : 'no resume plan recorded');
    }
    break;
  }
  case 'intent': {
    const { activeIntent, setIntent, clearIntent, renderIntent } = await import('../src/intent.mjs');
    const sub = argv[0];
    if (sub === 'clear') {
      console.log(clearIntent() ? 'work-intent cleared' : 'no work-intent to clear');
    } else if (['convergence', 'long_running', 'priority', 'default'].includes(sub)) {
      const note = argv.slice(1).join(' ') || null;
      const it = setIntent({ kind: sub, note });
      console.log(`work-intent set: ${it.kind}${it.note ? ` — ${it.note}` : ''} (burn to the 1% floor; queue arms for in-session resume)`);
    } else {
      console.log(renderIntent(activeIntent(null)));
    }
    break;
  }
  case 'account': {
    const { labelCurrent, foldKey, setProfileConfigDir, renderAccountList } = await import('../src/accounts.mjs');
    const sub = argv[0];
    if (sub === 'label') {
      const key = argv[1] ? labelCurrent(argv[1]) : null;
      console.log(
        key
          ? `labeled the current account ${key} as '${argv[1]}' (from the most recent active session)`
          : argv[1]
            ? 'no current account key to label — use Claude Code once (subscription auth), then retry; keys: tokenroom account list'
            : 'usage: tokenroom account label <name>   (letters/digits/._- only, ≤32 chars)'
      );
    } else if (sub === 'fold') {
      const ok = argv[1] && argv[2] ? foldKey(argv[1], argv[2]) : null;
      console.log(ok ? `folded bucket ${argv[1]} into profile '${argv[2]}'` : 'usage: tokenroom account fold <key> <name>   (keys: tokenroom account list)');
    } else if (sub === 'config-dir') {
      const ok = argv[1] && argv[2] ? setProfileConfigDir(argv[1], argv[2]) : null;
      console.log(ok ? `profile '${argv[1]}' config dir set to ${argv[2]} — \`tokenroom run --profile ${argv[1]}\` launches claude under it` : 'usage: tokenroom account config-dir <name> <path>');
    } else {
      console.log(renderAccountList());
    }
    break;
  }
  case 'switch': {
    console.log((await import('../src/accounts.mjs')).renderSwitch());
    break;
  }
  case 'run': {
    (await import('../src/accounts.mjs')).runProfile(argv);
    break;
  }
  case 'doctor': {
    (await import('../src/doctor.mjs')).doctor(argv);
    break;
  }
  case 'audit': {
    const i = argv.indexOf('--since');
    const hours = i >= 0 ? Number(argv[i + 1]) || 6 : 6;
    console.log(renderAudit(hours * 3600));
    break;
  }
  case 'mcp':
    mcpServe();
    break;
  case 'install':
    install(argv);
    break;
  case 'uninstall':
    uninstall(argv);
    break;
  case 'status': {
    const s = readState();
    console.log(s ? JSON.stringify(s, null, 2) : 'no state yet — install the tap and use Claude Code once (tokenroom install)');
    break;
  }
  default:
    console.log(`tokenroom — resource-aware layer for Claude Code

usage:
  tokenroom install [--dry-run] [--no-mcp] [--config-dir <dir>]   wire up statusline + hooks + skill + MCP
  tokenroom uninstall [--config-dir <dir>]                        remove everything install added
  tokenroom status                                                print the current ResourceState
  tokenroom watch                                                 LIVE dashboard (1s ticks) for a second pane
  tokenroom line                                                  one live line (countdowns at call time) for tmux/xbar/waybar
  tokenroom resume [--clear]                                      show or clear the deferred-work plan (queue + armed state)
  tokenroom intent [convergence|long_running|priority|default|clear] ["note"]   declare a focused run: burn to the 1% floor + arm the queue for in-session resume
  tokenroom account [list]                                        profiles + unlabeled account buckets, with last-known quota
  tokenroom account label <name>                                  name the account you are currently on (identity for phase buckets)
  tokenroom account fold <key> <name>                             fold a bucket into a profile (see list for hints)
  tokenroom account config-dir <name> <path>                      per-profile CLAUDE_CONFIG_DIR for launch-time selection
  tokenroom switch                                                decision table: which profile has headroom + how to switch
  tokenroom run [--profile <name>] [--dry-run]                    launch \`claude\` under the best (or named) profile's config dir
  tokenroom pin "<fact>" [--ttl-hours N]                          pin a fact to survive compaction verbatim
  tokenroom pins | unpin <id|--all>                               list / remove pins
  tokenroom handoff [--path]                                      print the canonical handoff doc (the agent writes it via the MCP tool)
  tokenroom audit [--since <hours>]                               timeline of the awareness loop (default 6h)
  tokenroom doctor                                                diagnose the install (wiring, freshness, conflicts)
  tokenroom tap [--capture]      (statusline command — wired by install)
  tokenroom hook <user-prompt-submit|pre-tool-use|post-tool-use|pre-compact|post-compact|session-start|stop>   (hook commands — wired by install)
  tokenroom mcp                                    (stdio MCP server — wired by install)`);
}
