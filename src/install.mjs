import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tokenroomDir } from './util.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binPath = join(pkgRoot, 'bin', 'tokenroom.mjs');
const MARK = 'tokenroom.mjs'; // identifies commands we own in settings.json
// Pre-rename (≤0.5.x, when this package was named "headroom") artifacts. Install REPLACES
// them — the user must never end up with doubled hooks/stamps (ADR-23).
const OLD_MARK = 'headroom.mjs';
const OLD_STATE_DIR = () => join(homedir(), '.headroom');

/** npx runs from an evictable cache — absolute paths written from there break later. */
export const isEphemeralInstall = (p) => p.includes('/_npx/') || p.includes('\\_npx\\');

const cmd = (sub) => `"${process.execPath}" "${binPath}" ${sub}`;

const COMPACT_MARK_START = '<!-- tokenroom:compact-instructions:start -->';
const COMPACT_MARK_END = '<!-- tokenroom:compact-instructions:end -->';
const OLD_COMPACT_MARK_START = '<!-- headroom:compact-instructions:start -->';
const OLD_COMPACT_MARK_END = '<!-- headroom:compact-instructions:end -->';
const COMPACT_BLOCK = `${COMPACT_MARK_START}
## Compact Instructions

When compacting this conversation, preserve verbatim: exact file paths and symbol names;
commands that failed, with their exact error text; the user's constraints and corrections
word-for-word; and any \`[tokenroom]\` budget or pinned-fact lines. State budgets as
remaining ("X% left"), never as used.
${COMPACT_MARK_END}`;

function configDir(argv) {
  const i = argv.indexOf('--config-dir');
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1]);
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

const readSettings = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
};

/** True when the command string belongs to us — current name or the pre-rename one. */
const owned = (command) => !!command && (command.includes(MARK) || command.includes(OLD_MARK));

/**
 * One-time state migration (ADR-23): COPY the pre-rename ~/.headroom into ~/.tokenroom.
 * Copy, never move — other live sessions' hooks keep writing the old dir until their next
 * event picks up the rewritten settings, so the old dir must stay valid; it goes stale and
 * is deleted manually later (`doctor` hints while it remains). In-flight atomic-write temp
 * files (*.tmp) are skipped so a half-written file is never copied.
 */
export function migrateStateDir(oldDir = OLD_STATE_DIR(), newDir = tokenroomDir(), dry = false) {
  if (existsSync(newDir) || !existsSync(oldDir)) return null;
  if (!dry) cpSync(oldDir, newDir, { recursive: true, filter: (src) => !src.endsWith('.tmp') });
  return `state: ${dry ? 'would copy' : 'copied'} ${oldDir} → ${newDir} (old dir left in place for still-running pre-rename sessions; delete it once they are gone)`;
}

export function install(argv = []) {
  if (isEphemeralInstall(pkgRoot)) {
    console.error(
      'tokenroom install: refusing to install from the npx cache.\n' +
        'npx runs from an evictable cache directory; the absolute paths written into\n' +
        'settings.json would silently break when npm prunes it. Install persistently:\n' +
        '  npm install -g tokenroom && tokenroom install\n' +
        'or clone the repo and run: node bin/tokenroom.mjs install'
    );
    process.exitCode = 1;
    return;
  }
  const dry = argv.includes('--dry-run');
  const sandbox = argv.indexOf('--config-dir') !== -1; // test/sandbox mode: never touch $HOME state or the claude CLI
  const dir = configDir(argv);
  const settingsPath = join(dir, 'settings.json');
  const changes = [];
  if (process.platform === 'win32') {
    changes.push('note: Windows is currently UNTESTED — verify the quoted command paths in settings.json work, and please report results in an issue');
  }

  mkdirSync(dir, { recursive: true });
  const settings = readSettings(settingsPath);
  if (!dry && existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.tokenroom-bak');

  // pre-rename state dir → copy once into the new location (ADR-23)
  if (!sandbox) {
    const migrated = migrateStateDir(undefined, undefined, dry);
    if (migrated) changes.push(migrated);
  }

  // statusline
  const tapCmd = `${cmd('tap')}`;
  if (settings.statusLine?.command?.includes(MARK)) {
    changes.push('statusline: already installed');
  } else if (settings.statusLine?.command?.includes(OLD_MARK)) {
    settings.statusLine = { type: 'command', command: tapCmd };
    changes.push('statusline: replaced old headroom tap with the tokenroom one');
  } else {
    if (settings.statusLine) changes.push('statusline: REPLACED existing statusLine (original saved in settings.json.tokenroom-bak)');
    else changes.push('statusline: installed tokenroom tap');
    settings.statusLine = { type: 'command', command: tapCmd };
  }

  // hooks: stamp, compaction-survival snapshot, post-compaction/ready re-injection.
  // Any pre-rename entries are stripped FIRST so the user never gets doubled hooks.
  settings.hooks ??= {};
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((m) => !(m.hooks ?? []).some((h) => h.command?.includes(OLD_MARK)));
    if (settings.hooks[event].length !== before) changes.push(`hook ${event}: removed old headroom entry`);
  }
  const HOOK_EVENTS = [
    ['UserPromptSubmit', 'hook user-prompt-submit', 'budget stamp'],
    ['PreCompact', 'hook pre-compact', 'compaction-survival snapshot + transcript anchor'],
    ['SessionStart', 'hook session-start', 'post-compaction re-injection + pins + deferred-work readiness'],
    ['PostCompact', 'hook post-compact', 'compaction event log (observability)'],
    ['PostToolUse', 'hook post-tool-use', 'mid-turn band-crossing re-stamps + cost receipts'],
    ['PreToolUse', 'hook pre-tool-use', 'launch gate (opt-in via launch_gate config or a focused intent)', 'Task|Agent|Workflow'],
    ['Stop', 'hook stop', 'in-session auto-resume of an armed queue once the window resets (opt-in via a focused intent)'],
  ];
  for (const [event, sub, label, matcher] of HOOK_EVENTS) {
    settings.hooks[event] ??= [];
    const present = settings.hooks[event].some((m) => (m.hooks ?? []).some((h) => h.command?.includes(MARK)));
    if (present) {
      changes.push(`hook ${event}: already installed`);
    } else {
      const entry = { hooks: [{ type: 'command', command: cmd(sub), timeout: 10 }] };
      if (matcher) entry.matcher = matcher;
      settings.hooks[event].push(entry);
      changes.push(`hook ${event}: installed (${label})`);
    }
  }

  // skill — content-compared so upgrades propagate, not just first installs.
  // The pre-rename skills/headroom dir is removed so the model never sees two copies.
  const oldSkillDest = join(dir, 'skills', 'headroom');
  if (existsSync(oldSkillDest)) {
    if (!dry) rmSync(oldSkillDest, { recursive: true });
    changes.push(`skill: ${dry ? 'would remove' : 'removed'} old ${oldSkillDest}`);
  }
  const skillDest = join(dir, 'skills', 'tokenroom');
  const skillSrc = readFileSync(join(pkgRoot, 'skill', 'SKILL.md'), 'utf8');
  const skillFile = join(skillDest, 'SKILL.md');
  const skillCur = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null;
  if (skillCur === skillSrc) {
    changes.push('skill: already installed (current)');
  } else if (!dry) {
    mkdirSync(skillDest, { recursive: true });
    writeFileSync(skillFile, skillSrc);
    changes.push(skillCur === null ? `skill: installed to ${skillDest}` : 'skill: updated to this version');
  } else {
    changes.push(skillCur === null ? `skill: would install to ${skillDest}` : 'skill: would update to this version');
  }

  if (!dry) writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // Compact Instructions in the user's CLAUDE.md — the one official surface that shapes
  // WHAT the compactor preserves. Marked block, idempotent, removed by uninstall. A
  // pre-rename block is replaced IN PLACE; nothing outside the markers is ever touched.
  const claudeMdPath = join(dir, 'CLAUDE.md');
  const md = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';
  const oi = md.indexOf(OLD_COMPACT_MARK_START);
  const oj = md.indexOf(OLD_COMPACT_MARK_END);
  if (oi >= 0 && oj > oi) {
    if (!dry) writeFileSync(claudeMdPath, md.slice(0, oi) + COMPACT_BLOCK + md.slice(oj + OLD_COMPACT_MARK_END.length));
    changes.push(`CLAUDE.md: ${dry ? 'would replace' : 'replaced'} old headroom Compact Instructions block with the tokenroom one`);
  } else if (md.includes(COMPACT_MARK_START)) {
    changes.push('CLAUDE.md compact instructions: already installed');
  } else if (dry) {
    changes.push('CLAUDE.md: would append Compact Instructions block (shapes what compaction preserves)');
  } else {
    writeFileSync(claudeMdPath, (md ? md.replace(/\n*$/, '\n\n') : '') + COMPACT_BLOCK + '\n');
    changes.push('CLAUDE.md: appended Compact Instructions block (shapes what compaction preserves)');
  }

  // MCP server — via the claude CLI so registration lands in the right scope.
  // Skipped in test/sandbox mode (--config-dir) and with --no-mcp. The pre-rename
  // "headroom" registration is removed so the model never sees two servers.
  if (!argv.includes('--no-mcp') && !sandbox) {
    if (dry) {
      changes.push('mcp: would remove any old "headroom" registration and run `claude mcp add --scope user tokenroom ...`');
    } else {
      try {
        execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'headroom'], { stdio: 'pipe' });
        changes.push('mcp: removed old "headroom" registration');
      } catch {
        // no pre-rename registration — nothing to replace
      }
      try {
        execFileSync('claude', ['mcp', 'remove', '--scope', 'user', 'tokenroom'], { stdio: 'pipe' });
      } catch {
        // not previously registered — fine
      }
      try {
        execFileSync('claude', ['mcp', 'add', '--scope', 'user', 'tokenroom', process.execPath, binPath, 'mcp'], { stdio: 'pipe' });
        changes.push('mcp: registered server "tokenroom" (user scope)');
      } catch {
        changes.push(`mcp: could not run the claude CLI — register manually:\n       claude mcp add --scope user tokenroom ${process.execPath} ${binPath} mcp`);
      }
    }
  }

  console.log(`${dry ? '[dry-run] ' : ''}tokenroom install → ${dir}`);
  for (const c of changes) console.log('  - ' + c);
  if (!dry) console.log('\nDone. Open a new Claude Code session; the HUD appears after the first response, the stamp on your next prompt.');
}

export function uninstall(argv = []) {
  const dir = configDir(argv);
  const settingsPath = join(dir, 'settings.json');
  const changes = [];

  if (existsSync(settingsPath)) {
    const settings = readSettings(settingsPath);

    if (owned(settings.statusLine?.command)) {
      const bak = readSettings(settingsPath + '.tokenroom-bak');
      const oldBak = readSettings(settingsPath + '.headroom-bak');
      const restored = [bak.statusLine, oldBak.statusLine].find((s) => s && !owned(s.command));
      if (restored) {
        settings.statusLine = restored;
        changes.push('statusline: restored pre-tokenroom statusLine from backup');
      } else {
        delete settings.statusLine;
        changes.push('statusline: removed');
      }
    }

    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        const before = settings.hooks[event].length;
        settings.hooks[event] = settings.hooks[event].filter((m) => !(m.hooks ?? []).some((h) => owned(h.command)));
        if (settings.hooks[event].length !== before) changes.push(`hook ${event}: removed`);
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  for (const name of ['tokenroom', 'headroom']) {
    const skillDest = join(dir, 'skills', name);
    if (existsSync(skillDest)) {
      rmSync(skillDest, { recursive: true });
      changes.push(`skill: removed${name === 'headroom' ? ' pre-rename' : ''} ${skillDest}`);
    }
  }

  const claudeMdPath = join(dir, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    let md = readFileSync(claudeMdPath, 'utf8');
    let removed = false;
    for (const [start, end] of [
      [COMPACT_MARK_START, COMPACT_MARK_END],
      [OLD_COMPACT_MARK_START, OLD_COMPACT_MARK_END],
    ]) {
      const i = md.indexOf(start);
      const j = md.indexOf(end);
      if (i >= 0 && j > i) {
        md = (md.slice(0, i) + md.slice(j + end.length)).replace(/\n{3,}/g, '\n\n');
        removed = true;
      }
    }
    if (removed) {
      writeFileSync(claudeMdPath, md);
      changes.push('CLAUDE.md: removed Compact Instructions block');
    }
  }

  if (argv.indexOf('--config-dir') === -1) {
    let unregistered = false;
    for (const name of ['tokenroom', 'headroom']) {
      try {
        execFileSync('claude', ['mcp', 'remove', '--scope', 'user', name], { stdio: 'pipe' });
        unregistered = true;
      } catch {
        // that name was not registered — fine
      }
    }
    changes.push(unregistered ? 'mcp: unregistered' : 'mcp: not registered or claude CLI unavailable (run `claude mcp remove tokenroom` if needed)');
  }

  console.log(`tokenroom uninstall ← ${dir}`);
  for (const c of changes.length ? changes : ['nothing to remove']) console.log('  - ' + c);
  console.log('\nLocal data in ~/.tokenroom (and any pre-rename ~/.headroom) was kept; delete it manually if you want a clean slate.');
}
