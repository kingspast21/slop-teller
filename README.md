# Slop Teller

A Chrome extension that scores a web page for **AI tells**, marks each one on the page, and exports a Markdown fix list you can hand to an AI assistant. It also comes with a git commit hook that warns about the same tells before you commit.

![Slop Teller stepping through stock phrases on a test page](docs/screenshot.png)

It counts tells, not proof. Real writers use em dashes, and some brands choose gradients on purpose, so every point in the score comes with its reason.

## Install

It isn't in the Chrome Web Store, so it installs as an unpacked extension:

1. Download `slop-teller-v*.zip` from the [latest release](https://github.com/kingspast21/slop-teller/releases/latest) and unzip it (or clone this repo).
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the `slop-teller` folder (the one with `manifest.json`).
5. Pin the extension, open any site, and click the icon (or press **Alt+Shift+S**). Click again to close.

To scan local `file://` pages, open the extension's details and turn on **Allow access to file URLs**. Chrome doesn't allow extensions on `chrome://` pages or the Web Store.

## What it checks

| Layer | Examples | Max points |
|---|---|---|
| Fingerprints | AI builder scripts, badges, meta tags and preview images, builder hosting domains, editor attributes (`data-lov-id`), untouched starter titles and favicons | 40 |
| Copy | Em dashes, stock phrases, "not just X, it's Y", fragment lists, emoji bullets, generic headings, placeholder content | 35 (per 1,000 words) |
| Design | Gradient text, purple gradients, pill badge above the headline, centred two-button hero, identical icon cards, glass cards, default font | 25 |

Score bands: 0-14 Few tells, 15-39 Some, 40-69 Many, 70+ Heavy.

## Using the panel

- Click a tell's name to jump to the next one on the page. The counter (`‹ 3/20 ›`) shows where you are, the current mark turns red with a "3 of 20" pin, and it wraps around at the end. `‹ ›` step back and forward; **Alt+Up / Alt+Down** do the same from the keyboard. `+3` after the count means three more are in the page source (not on screen).
- Click **+** to see why a tell counts and the full list of places. Click a place to jump straight to it.
- Hover a mark on the page for its reason.
- Click a layer to show or hide its marks.
- **Keep as is** marks a tell as intentional. It stops counting, moves to the export's "Keep as is" list, and is remembered for that site.
- Tick tells to export only those, then **Export .md** (download) or **Copy .md** (clipboard).

## The Markdown export

The file opens with instructions for the assistant (find each item in the repo by its quoted text, fix in context, don't add new tells, leave kept items alone, design items are suggestions), then lists findings by layer with the matched text, its context and a CSS selector.

## Editing the rules

All patterns, weights, caps and the "why / how to fix" wording live in `src/rules.js`. Design detectors are in `src/scanner.js` under the same ids. The commit hook reads the same file (reinstall the hook to pick up rule changes).

## Commit hook (slop-hook)

The same rules, run on `git commit`. It checks only the lines you're adding, prints what it found, and **lets the commit through**. It's a warning, not a gate.

```
slop-hook: 3 AI tells in 2 files (commit continues)
  src/Hero.astro:14  em dash       "...fast — and simple"
  src/Hero.astro:22  stock phrase  "Our seamless platform..."
  README.md:8        stock phrase  "...elevate your workflow"
```

Install it in any repo (needs Node):

```bash
cd your-repo
node path/to/slop-teller/hook/install.mjs
```

It copies itself into `.git/slop-hook/` and adds one line to `.git/hooks/pre-commit`. An existing pre-commit hook is kept, and husky setups get the line in `.husky/pre-commit`.

**Keeping a tell on purpose**

- One line: put `slop-ok` in a comment on it (`<!-- slop-ok -->`, `// slop-ok`, `{/* slop-ok */}`).
- A whole tell or folder, in `.slophook.json` at the repo root:
  ```json
  { "off": ["em-dash"], "ignore": ["docs/legal/**"] }
  ```
- One commit: `git commit --no-verify`.

**Stricter, if you want it**

`--mode ask` asks "Commit anyway? [Y/n]" (Enter means yes). `--mode block` stops the commit. Both are saved to `.slophook.json`. When there's no terminal to ask in, such as an editor's commit button or an AI agent, `ask` warns and lets the commit through, so it never hangs.

What it checks: copy in `.html`, `.md`, `.astro`, `.vue`, `.svelte`, `.jsx`/`.tsx` text and strings, content JSON and templates, plus AI builder scripts in HTML. It skips code comments, class names, lockfiles, `node_modules` and build output. Design tells need a rendered page, so they stay in the extension.

Check a whole repo without committing:

```bash
node .git/slop-hook/slop-hook.mjs --all          # or --all --json
```

Remove it: `node path/to/slop-teller/hook/install.mjs --uninstall`

## Using AI agents to commit or push your repos?

Coding agents (Claude Code, Codex, Cursor, Copilot, Gemini) run `git commit` for you, see the hook's output, and often say nothing about it. Install with `--agents` and the hook adds a short note to the files those agents read:

```bash
node path/to/slop-teller/hook/install.mjs --agents
```

It adds the note to whichever of `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md` already exist, or creates `AGENTS.md` if none do. Pick files yourself with `--agent-files AGENTS.md,CLAUDE.md` (Claude Code reads `CLAUDE.md`).

The note tells the agent to:

- read the slop-hook output after each commit,
- **tell you** how many tells it found, with each `file:line`, and whether the commit went through,
- **not** fix them, add `slop-ok`, change `.slophook.json` or use `--no-verify` unless you ask.

You decide what stays. The note sits between `<!-- slop-hook:start -->` and `<!-- slop-hook:end -->`, so reinstalling updates it in place and `--uninstall` removes it cleanly. Those files are part of your repo, so commit the change if your team should get it too.

Even without the note, the hook adds a line addressed to AI agents whenever it runs without a terminal, which is how agents run it.

## Development

```bash
npm install          # Playwright, for tests only
npm test             # loads the real extension in Chromium against tests/fixtures
npm run test:hook    # slop-hook in throwaway git repos
node tests/run.mjs https://example.com   # also scan real sites
npm run icons        # redraw icons (needs uv)
npm run zip          # dist/slop-teller-v<version>.zip from the last commit
```

Test output (screenshots, exported .md, results.json) goes to `tests/out/`.

## Privacy

Nothing leaves the browser. The extension only runs on the tab you click it on (`activeTab`), has no host permissions and makes no network requests. "Keep as is" choices are stored locally per site.

## Credits

Most of the copy rules (the stock-phrase list, "not just X, it's Y" contrasts and similar patterns) are based on:

- [humanizer](https://github.com/blader/humanizer) by Siqi Chen ([@blader](https://github.com/blader)), MIT licensed.
- [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by WikiProject AI Cleanup, which humanizer is built on.

Slop Teller turns those patterns into page and commit checks; any mistakes in the rules are its own.



MIT. See [LICENSE](LICENSE).
