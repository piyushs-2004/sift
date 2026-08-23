# Reddit posts for Sift

Replace `[LINK]` with your live URL. Post these **on different days** — same-day
cross-posting is the fastest way to get flagged as a spammer.

---

## 1. r/dataengineering

**Title options**
- I got tired of writing the same profiling notebook for every new client file, so I built it into a browser tool
- Built a client-side CSV/Excel profiler — would like criticism of one heuristic in particular

**Body**

Every time a new export lands on my desk the first hour is the same: nulls, dupes,
whitespace that breaks joins, a column that's `int` for 40k rows and then suddenly
isn't. I've rewritten some version of that pandas notebook more times than I want
to admit, so I finally built it as a browser tool. Runs entirely client-side — no
upload, no account, no backend at all — mostly because I was never comfortable
pasting client data into the online profilers that already exist.

It does the standard stuff (type inference, null rates, cardinality, candidate
keys, IQR outliers, DDL for Postgres/Snowflake/BigQuery, dbt model + schema.yml
with tests). Two bits I haven't seen elsewhere:

**Completeness strip.** For each column it buckets rows by file position and shows
where the nulls actually fall, rather than just a percentage. Nulls bunched at the
tail usually mean a truncated or interrupted export; nulls scattered evenly mean
genuinely missing data. Same 12% null rate, completely different conversation with
the source team.

**Schema drift compare.** Load yesterday's file and today's, get added/removed
columns, type shifts, and null rates that moved more than 5pp.

[LINK] — no signup, works offline once loaded.

The heuristic I'm least sure about: I flag a column as "likely truncated export"
when the last five buckets (12.5% of rows) are entirely null but the column is
under 90% null overall. That catches the real cases I've hit, but I suspect it
false-positives on legitimately time-ordered data where a field only started being
populated recently — which is the *opposite* problem. Anyone got a better rule for
separating those two? Genuinely stuck on it.

---

## 2. r/excel

**Title options**
- Made a free tool that finds duplicates, hidden spaces and inconsistent formats in a spreadsheet — runs in your browser, nothing gets uploaded
- The reason your VLOOKUP silently returns nothing is usually invisible trailing spaces. Built something that finds them.

**Body**

The single most common spreadsheet bug I see isn't a formula error — it's a value
that looks like `"Mumbai"` but is actually `"Mumbai "`. Excel shows them
identically. Your lookup returns nothing and you assume the data is missing.

I built a free tool that opens a .xlsx or .csv and tells you:

- how many values have leading/trailing spaces, and in which columns
- exact duplicate rows
- columns where the format is inconsistent (some dates as text, some as dates)
- columns that are mostly empty
- which columns look like personal data (emails, phone numbers, card numbers)

Then it lets you download a cleaned copy with those fixed.

The part that matters to me: it runs entirely inside your browser. Your file is
never uploaded anywhere — you can disconnect from the internet after the page
loads and it still works. I wasn't willing to paste real data into the existing
online cleaners and figured others feel the same.

[LINK] — free, no signup, no limits.

Happy to add things if there's an obvious gap. What's the cleanup step you find
yourself doing manually every single time?

---

## 3. r/analytics (or r/BusinessIntelligence)

**Title options**
- How do you check a client's data before you agree to a scope?
- Built a data quality scorer to stop under-quoting cleanup work

**Body**

I kept making the same estimating mistake: quote the dashboard, discover the data
is a mess, eat the cleanup hours. So I built something that scores a file before I
commit to anything.

Drop a CSV or Excel file in, get a health score out of 100 and a prioritised list
of what's wrong — duplicates, mixed formats, missing keys, whitespace, columns that
stop being populated partway through the export — each with a rough effort band in
hours. It totals up so you have a defensible number rather than a gut feel.

Entirely client-side, so you can run it on a prospect's sample file without a data
sharing agreement, which was the actual blocker for me.

[LINK]

Curious how others handle this. Do you charge for the discovery phase separately,
or fold it into the project and hope? I've done both badly.

---

## 4. r/developersIndia

**Title options**
- Built a DPDP-friendly data tool — the whole design constraint was "never send the file to a server"
- Weekend project: spreadsheet auditor that flags personal data before it reaches a shared drive

**Body**

With DPDP compliance landing on a lot of teams, I keep running into the same
awkward moment: someone wants to check a customer export for problems, and every
online tool that does it requires uploading the file. Which is exactly the thing
you're trying to be careful about.

So I built one that doesn't. Everything runs in the browser — parsing, profiling,
cleaning, the lot. No backend exists, so there's nothing to breach.

It flags columns that look like personal data (emails, mobile numbers, PAN-format
strings, 12-digit IDs, card numbers via Luhn check), scores overall data quality,
and lets you download a cleaned copy.

[LINK]

The PII matching is pattern-based, so it catches obvious cases and definitely misses
names and free-text notes. If anyone here has dealt with DPDP classification
seriously, I'd like to know what categories I should be flagging that I'm not.

---

## Posting rules that actually matter

**Before you post anywhere:** spend a week commenting normally in these subs. A brand
new account whose first post is a link gets auto-removed, and in some subs
shadow-removed without telling you. Check your post is visible in an incognito window
an hour later.

**Read each sub's rules on self-promotion.** r/dataengineering allows genuine
open-source/free tool posts; r/excel is fine with free tools; some BI subs require a
flair or restrict links to a weekly thread. Getting this wrong costs you the sub
permanently.

**Post timing:** weekday mornings US Eastern for the big subs, since that's where the
volume is. For r/developersIndia, evenings IST.

**Stay in the comments for the first three hours.** Reply to everything, including the
criticism. Thread engagement is most of what determines whether the post spreads, and
the critical comments are where your next feature comes from.

---

## Replies you will need

**"How is this different from pandas-profiling / ydata-profiling?"**
> It isn't, on the profiling side — those are more thorough and I use them too. The
> difference is you don't need a Python environment, and it does the parts those
> don't: the cleaned-file export, the drift compare, and effort estimates. If you're
> already in a notebook, ydata-profiling is the better tool.

**"Why should I trust that it doesn't upload my file?"**
> Fair question, and don't take my word for it. Open DevTools → Network, load a file,
> and you'll see no requests. Or load the page, turn off your wifi, and use it —
> it works fine offline. It's a single HTML file, so you can also just read the source.

**"Is this an ad?"**
> It's free with no signup and no paid tier, so there's nothing to sell you. I built
> it for my own work and posted it because the last three people I showed it to asked
> for the link.

**"You should add X"**
> Say yes or say why not, specifically. Then actually build the ones that come up
> twice — those are the real signal from the whole exercise.
