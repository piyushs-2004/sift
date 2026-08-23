# Setup — from this folder to a live site

Everything is ready. You need about 15 minutes and two accounts you probably
already have.

---

## 0. Before you start: the compliance question

You work at a financial firm. Publishing free open-source is usually fine;
**taking money for it is usually not** without pre-clearance, and some firms
require approval for public technical content too.

Check your Outside Business Activity policy before you push. Five minutes now
beats an awkward conversation later. Nothing below involves payment, but the
repo will carry your name publicly.

---

## 1. Personalise three placeholders

Search and replace across the folder:

| Placeholder | Replace with |
|---|---|
| `piyushs-2004` | your GitHub username |
| `YOUR NAME` | your name, in `LICENSE` |

```bash
cd sift
# macOS
grep -rl 'piyushs-2004' . --exclude-dir=.git | xargs sed -i '' 's/piyushs-2004/your-github-username/g'
sed -i '' 's/YOUR NAME/Your Name/' LICENSE

# Linux
grep -rl 'piyushs-2004' . --exclude-dir=.git | xargs sed -i 's/piyushs-2004/your-github-username/g'
sed -i 's/YOUR NAME/Your Name/' LICENSE
```

Verify nothing was missed:

```bash
grep -rn 'piyushs-2004\|YOUR NAME' . --exclude-dir=.git
```

---

## 2. Check it works locally

```bash
npm test
```

Expect `85 passed, 0 failed`. If anything fails, stop and fix it before pushing —
a repo whose CI badge is red on day one is worse than no repo.

```bash
node bin/sift.js --help
open docs/index.html          # macOS;  xdg-open on Linux;  start on Windows
```

---

## 3. Create the GitHub repo

Either through the website (New repository → name it `sift` → **don't** add a
README, licence, or .gitignore, since you already have them), or with the GitHub
CLI:

```bash
gh repo create sift --public --source=. --remote=origin
```

Then:

```bash
git init
git add .
git commit -m "Sift: streaming data quality gate for pipelines"
git branch -M main
git remote add origin https://github.com/your-github-username/sift.git
git push -u origin main
```

If you used `gh repo create --source=.` the remote is already set, so skip the
`git remote add` line.

---

## 4. Turn on GitHub Pages

1. Repo → **Settings** → **Pages**
2. Source: **GitHub Actions** (not "Deploy from a branch")
3. Push anything, or go to **Actions** → *pages* → **Run workflow**

Live at `https://your-github-username.github.io/sift/` within about two minutes.

The workflow only redeploys when `docs/` changes, so ordinary CLI commits won't
trigger it.

---

## 5. Confirm CI is green

**Actions** tab → the *ci* workflow runs the suite on Ubuntu, macOS and Windows
across Node 18, 20 and 22. Nine jobs. All should pass.

That matrix is worth more than it looks on a resume: it shows you thought about
platforms other than your own laptop.

---

## 6. Repo polish (five minutes, disproportionate payoff)

**About panel** (gear icon, top right of the repo page):
- Description: `Audit, clean and gate any spreadsheet — without uploading it anywhere. Streaming data quality CLI + browser tool.`
- Website: your Pages URL
- Topics: `data-engineering` `data-quality` `csv` `data-contracts` `pipeline` `etl` `cli` `pii` `javascript`

**Social preview image** (Settings → General → Social preview): a screenshot of
the audit tab with the health score visible. This is what renders when the link
is shared on LinkedIn, Reddit or HN — a repo without one looks abandoned.

**Pin it** on your GitHub profile.

---

## 7. npm (optional, and think first)

Publishing means every `npx sift-data` in your docs actually works, which matters
if you want people to try it. It also means the name is yours.

```bash
npm login
npm publish --access public
```

Check the name is free first: `npm view sift-data`. A 404 means available.

Two cautions. First, **npm publishes are effectively permanent** — you can only
unpublish within 72 hours, so make sure `npm test` passes and the README is right.
Second, this is publishing under your name publicly; see step 0.

Once published, tag a release on GitHub and the *publish* workflow handles future
versions automatically (add your npm token as the `NPM_TOKEN` repo secret).

---

## 8. First commits after launch

Don't push everything at once and then go quiet. A repo with one commit reads as
abandoned; five commits over two weeks reads as maintained.

Obvious next items, roughly in order of value:

- Excel support in the CLI (the browser half already does it)
- A `--parquet` reader
- `sift check` against a directory watched on a schedule
- Contract versioning, so you can see how a contract changed over time
- Better PII coverage — names and free text are the big gap

---

## Quick reference

```bash
npm test                                    # 85 tests
node bin/sift.js profile data.csv           # local run without installing
docker build -t sift . && docker run --rm -v "$PWD:/work" sift profile data.csv
```

| File | What it is |
|---|---|
| `bin/sift.js` | CLI entry point |
| `lib/core.js` | inference, contracts, enforcement |
| `lib/reader.js` | streaming multi-format parser |
| `lib/pipeline.js` | accumulator, row validation, hashing |
| `docs/index.html` | the whole browser app, single file |
| `test/test.js` | the suite |
| `.github/actions/sift/` | reusable GitHub Action |
