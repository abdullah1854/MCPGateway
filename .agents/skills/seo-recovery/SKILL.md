---
name: seo-recovery
description: SEO traffic recovery protocol for diagnosing and fixing indexing drops, canonical mismatches, hreflang bugs, and toxic sitemaps. Integrates with Google Search Console via MCP Gateway. Includes Hostinger deployment awareness for OPcache/CDN friction. Activates for "SEO", "traffic drop", "indexing", "canonical", "hreflang", "sitemap", "search console", "GSC", "crawl errors", "deindexed", "organic traffic".
allowed-tools: [Bash, Read, Write, Edit, Grep, Glob]
---

# SEO Recovery Protocol

## When This Skill Activates
- "SEO traffic dropped", "organic traffic down", "lost rankings"
- "Indexing issues", "pages not indexed", "deindexed"
- "Canonical URL", "canonical mismatch", "wrong canonical"
- "Hreflang", "hreflang errors", "language tags"
- "Sitemap", "sitemap errors", "toxic sitemap", "missing sitemap"
- "Search Console", "GSC", "crawl errors", "coverage issues"
- "Robots.txt", "noindex", "blocked by robots"
- "Google not showing my pages"

## Anti-Hallucination Rules (NEVER violate)

| Rule | Description |
|------|-------------|
| **NEVER ASSUME INDEXING STATUS** | Always verify via GSC URL Inspection or `site:` search. Never say "this page is indexed" without checking |
| **GSC DATA BEFORE CONCLUSIONS** | Pull actual Search Analytics data before diagnosing. Traffic estimates, guesses, or assumptions are forbidden |
| **VERIFY CANONICAL TAGS IN SOURCE** | Always `curl` or read the actual HTML source. Do NOT trust CMS admin panels or visual page checks -- the rendered HTML is ground truth |
| **CHECK BOTH HTTP AND HTTPS** | Canonical mismatches often involve protocol differences. Always check both variants |
| **DISTINGUISH CRAWLED VS INDEXED** | A page being crawled does NOT mean it is indexed. These are separate states in GSC Coverage |
| **HOSTINGER CDN DISTRUST** | After deploying SEO fixes to Hostinger, verify at server level via `curl`. CDN may serve stale content for 5-15 minutes |
| **NO BULK CHANGES WITHOUT BACKUP** | Before modifying sitemaps, robots.txt, or canonical tags at scale, document the current state |
| **TIMESTAMP YOUR EVIDENCE** | GSC data has processing delays (24-72h). Always note when data was pulled vs when changes were made |

---

## Phase 0: Confirm Scope (MANDATORY - Do This First)

Before any investigation:
```
1. What is the domain? (exact URL, including protocol and www vs non-www)
2. When did the traffic drop start? (exact date or date range)
3. How severe is the drop? (percentage, from X to Y)
4. Is it site-wide or specific pages/sections?
5. Were any changes deployed around that time? (redesign, migration, CMS update, hosting change)
6. Which GSC property are we using? (domain property vs URL prefix?)
7. What is the hosting platform? (Hostinger? Other? -- affects deployment workflow)
```

**If the user cannot answer #2 and #3, start with GSC Search Analytics to establish the timeline.**

---

## Phase 1: SEO Diagnostic Protocol

### Step 1: Establish the Timeline (Search Analytics)

Pull traffic data to identify exactly when the drop occurred:

```
GSC MCP QUERY:
- Tool: google_searchconsole (via MCP Gateway)
- Metric: clicks, impressions, CTR, position
- Date range: 90 days (or wider if drop is older)
- Dimensions: date (for timeline), page (for affected URLs), query (for lost keywords)
```

**What to look for:**
- Sudden cliff (overnight) = algorithmic penalty or technical issue
- Gradual decline over weeks = content quality, competition, or slow technical degradation
- Specific pages/sections = localized issue (canonical, noindex on section)
- All pages equally = site-wide issue (robots.txt, domain-level penalty, DNS)

### Step 2: Check Indexing Status (Coverage Report)

Query GSC Coverage to understand indexing state:

```
KEY COVERAGE STATES:
- "Valid" = Indexed and serving in search
- "Valid with warnings" = Indexed but has issues
- "Excluded" = Not indexed (check reason!)
- "Error" = Crawl/index errors

COMMON EXCLUSION REASONS:
- "Alternate page with proper canonical tag" = Canonical pointing elsewhere
- "Duplicate without user-selected canonical" = Google chose a different canonical
- "Crawled - currently not indexed" = Google crawled but chose not to index
- "Discovered - currently not indexed" = Google knows about it but hasn't crawled
- "Page with redirect" = URL redirects to another page
- "Blocked by robots.txt" = robots.txt is blocking crawlers
- "Excluded by 'noindex' tag" = meta noindex or X-Robots-Tag
```

### Step 3: URL Inspection (Spot-Check Key Pages)

For affected pages, run URL Inspection to get Google's view:

```
CHECK THESE FOR EACH AFFECTED PAGE:
1. Is the page indexed?
2. What canonical does Google see? (vs what the page declares)
3. Is it mobile-friendly?
4. Are there any crawl issues?
5. Last crawl date -- is it recent or stale?
6. Does the rendered HTML match expectations?
```

### Step 4: Root Cause Analysis

Based on Phases 1-3, route to the appropriate diagnosis:

| Evidence Pattern | Likely Root Cause | Go To |
|------------------|-------------------|-------|
| Coverage shows "Alternate page with proper canonical" | Canonical URL mismatch | CANONICAL FIX |
| Coverage shows "Blocked by robots.txt" | robots.txt blocking | ROBOTS.TXT FIX |
| Coverage shows "Excluded by noindex" | Meta noindex tag | NOINDEX FIX |
| Many pages "Crawled - currently not indexed" | Quality/thin content or crawl budget | CRAWL BUDGET |
| Hreflang errors in Coverage or manual check | Hreflang implementation bugs | HREFLANG FIX |
| Sitemap errors in GSC Sitemaps report | Toxic or broken sitemaps | SITEMAP FIX |
| Sudden drop + manual action in GSC | Google penalty | MANUAL ACTION |
| Drop coincides with site migration/redesign | Migration issues | MIGRATION FIX |

---

## Phase 2: Common SEO Issues & Fixes

### CANONICAL FIX: Canonical URL Mismatches

**Diagnosis:**
```bash
# Check canonical tag in actual HTML source
curl -s "https://example.com/page" | grep -i 'rel="canonical"'
curl -s "https://example.com/page" | grep -i "rel='canonical'"

# Check HTTP vs HTTPS canonical
curl -s "http://example.com/page" | grep -i 'canonical'
curl -s "https://example.com/page" | grep -i 'canonical'

# Check www vs non-www
curl -s "https://www.example.com/page" | grep -i 'canonical'
curl -s "https://example.com/page" | grep -i 'canonical'

# Check for canonical in HTTP headers (X-Robots-Tag)
curl -sI "https://example.com/page" | grep -i 'link.*canonical'

# Bulk check across pages (sample 20 URLs from sitemap)
curl -s "https://example.com/sitemap.xml" | grep -oP '<loc>\K[^<]+' | head -20 | while read url; do
  canonical=$(curl -s "$url" | grep -oP 'rel="canonical"[^>]*href="[^"]*"' | grep -oP 'href="\K[^"]+')
  echo "$url -> $canonical"
done
```

**Common mismatch patterns:**
- HTTP canonical on HTTPS page (or vice versa)
- www canonical on non-www page (or vice versa)
- Trailing slash mismatch (`/page` vs `/page/`)
- Query parameter pollution (`/page?utm_source=...` as canonical)
- Relative URL instead of absolute URL in canonical tag
- CMS generating wrong canonical (pagination, filters, search pages)

**Fix approach:**
1. Identify the canonical URL pattern that Google should use
2. Update canonical tags in templates/CMS to use the correct absolute URL
3. Ensure consistency: canonical URL matches the URL in sitemaps, internal links, and hreflang
4. Submit affected URLs for re-inspection in GSC after deploying fix

### HREFLANG FIX: Language/Region Tag Bugs

**Diagnosis:**
```bash
# Check hreflang tags on page
curl -s "https://example.com/page" | grep -i 'hreflang'

# Check for return links (CRITICAL: hreflang must be reciprocal)
# If page-en links to page-fr via hreflang, page-fr MUST link back to page-en
curl -s "https://example.com/en/page" | grep -i 'hreflang'
curl -s "https://example.com/fr/page" | grep -i 'hreflang'

# Check hreflang in sitemap (alternative to on-page)
curl -s "https://example.com/sitemap.xml" | grep -i 'hreflang'

# Check x-default tag exists
curl -s "https://example.com/page" | grep -i 'x-default'
```

**Common hreflang errors:**
- Missing return links (non-reciprocal hreflang)
- Wrong language/region codes (`en-uk` instead of `en-GB`)
- Hreflang pointing to non-canonical URLs
- Missing `x-default` tag
- Hreflang on pages that are noindex
- Hreflang URL mismatch with canonical URL

**Fix approach:**
1. Map all language variants for each page
2. Ensure every hreflang annotation is reciprocal
3. Use correct ISO 639-1 (language) and ISO 3166-1 Alpha-2 (region) codes
4. Hreflang URLs must match canonical URLs exactly
5. Include `x-default` for fallback
6. Validate with hreflang testing tools or GSC International Targeting report

### SITEMAP FIX: Toxic or Broken Sitemaps

**Diagnosis:**
```bash
# Check robots.txt for sitemap declarations
curl -s "https://example.com/robots.txt"

# Fetch and validate sitemap
curl -s "https://example.com/sitemap.xml" | head -50

# Check for sitemap index (multiple sitemaps)
curl -s "https://example.com/sitemap_index.xml"

# Count URLs in sitemap
curl -s "https://example.com/sitemap.xml" | grep -c '<loc>'

# Check for HTTP status of sitemap
curl -sI "https://example.com/sitemap.xml" | head -5

# Check for URLs in sitemap that return non-200
curl -s "https://example.com/sitemap.xml" | grep -oP '<loc>\K[^<]+' | head -10 | while read url; do
  status=$(curl -sI "$url" -o /dev/null -w "%{http_code}")
  echo "$status $url"
done
```

**Toxic sitemap indicators:**
- Contains URLs that return 404, 410, or 301
- Contains noindex pages
- Contains non-canonical URLs
- Contains URLs blocked by robots.txt
- Sitemap itself returns non-200
- Over 50,000 URLs per sitemap file (exceeds limit)
- Over 50MB uncompressed (exceeds limit)
- Sitemap not declared in robots.txt
- Stale `<lastmod>` dates (or dates in the future)

**GSC Sitemap Management:**
```
SUBMIT MISSING SITEMAPS:
- Use GSC Sitemaps API/tool to submit each sitemap URL
- Common pattern: submit /sitemap.xml, /sitemap-posts.xml, /sitemap-pages.xml, etc.
- After submitting, monitor "Submitted" vs "Indexed" counts
- If big gap between submitted and indexed, investigate excluded URLs

CHECK FOR MISSING SITEMAPS:
- Compare sitemap_index.xml entries vs what's submitted in GSC
- Any sitemap in the index but not in GSC = submit it
- Any sitemap in GSC but returning 404 = remove it
```

**Fix approach:**
1. Audit all sitemaps for toxic URLs (4xx, 5xx, noindex, non-canonical)
2. Remove or fix problematic URLs
3. Ensure all valid, indexable URLs are in sitemaps
4. Submit any missing sitemaps to GSC
5. Remove any dead sitemaps from GSC
6. Verify sitemap is declared in robots.txt
7. Regenerate sitemaps if CMS-generated ones are toxic

### ROBOTS.TXT FIX: Crawler Blocking

**Diagnosis:**
```bash
# Fetch current robots.txt
curl -s "https://example.com/robots.txt"

# Check if specific path is blocked
# (manually parse Disallow rules against the target path)

# Check for overly broad Disallow rules
curl -s "https://example.com/robots.txt" | grep -i 'disallow'

# Check for noindex in robots.txt (NOT a valid directive but some sites use it)
curl -s "https://example.com/robots.txt" | grep -i 'noindex'
```

**Common robots.txt mistakes:**
- `Disallow: /` blocking entire site
- Blocking CSS/JS files needed for rendering
- Blocking entire directories that contain indexable content
- Different rules for Googlebot vs other bots causing confusion
- `Noindex:` directive in robots.txt (Google ignores this since 2019)
- Missing `Allow:` for specific paths within a Disallowed directory
- Robots.txt returns non-200 (5xx = Google assumes full block temporarily)

**Fix approach:**
1. Review all Disallow rules against intended indexable content
2. Remove overly broad blocks
3. Add specific Allow rules where needed
4. Ensure CSS and JS files are not blocked (needed for mobile-first indexing)
5. Test with GSC robots.txt Tester
6. Deploy updated robots.txt and request re-crawl of affected URLs

### NOINDEX FIX: Accidental Noindex Tags

**Diagnosis:**
```bash
# Check meta robots tag
curl -s "https://example.com/page" | grep -i 'robots'

# Check X-Robots-Tag HTTP header
curl -sI "https://example.com/page" | grep -i 'x-robots'

# Bulk check for noindex across pages
curl -s "https://example.com/sitemap.xml" | grep -oP '<loc>\K[^<]+' | head -20 | while read url; do
  noindex_meta=$(curl -s "$url" | grep -i 'noindex' | head -1)
  noindex_header=$(curl -sI "$url" | grep -i 'noindex' | head -1)
  if [ -n "$noindex_meta" ] || [ -n "$noindex_header" ]; then
    echo "NOINDEX: $url"
    [ -n "$noindex_meta" ] && echo "  meta: $noindex_meta"
    [ -n "$noindex_header" ] && echo "  header: $noindex_header"
  fi
done
```

**Common noindex causes:**
- CMS "discourage search engines" setting left on from staging
- Meta robots tag added during development, never removed
- X-Robots-Tag header set in server config (.htaccess, nginx, Hostinger config)
- Plugin or middleware injecting noindex conditionally (e.g., on pagination)
- Conditional noindex based on query parameters

**Fix approach:**
1. Identify source of noindex (HTML meta tag vs HTTP header vs server config)
2. Remove the noindex directive at its source
3. If CMS setting, toggle it off and verify HTML output changes
4. If server config, update .htaccess/nginx config and restart
5. After fix, request re-indexing in GSC for affected pages

### CRAWL BUDGET: Pages Crawled But Not Indexed

When GSC shows many pages as "Crawled - currently not indexed":

**Diagnosis:**
- Are these thin/duplicate/low-quality pages?
- Is the site very large (100K+ pages)?
- Are important pages buried deep in site architecture?
- Is crawl budget being wasted on faceted navigation, infinite scrolls, or parameter URLs?

**Fix approach:**
1. Consolidate thin/duplicate content
2. Improve internal linking to important pages
3. Use `noindex` or `robots.txt` to prevent crawling of low-value pages (facets, filters, sorts)
4. Ensure important pages are within 3 clicks of homepage
5. Improve page quality signals (content depth, E-E-A-T)

---

## Phase 3: GSC MCP Integration

### Tool Discovery

```
STEP 1: Discover available GSC tools
gateway_search_tools: query = "google search console"
-- or --
gateway_search_tools: query = "searchconsole"

STEP 2: Get schema for specific tool
gateway_get_tool_schema: tool_name = "[tool_name_from_step_1]"
```

### Common GSC Operations via MCP

```
SEARCH ANALYTICS (Traffic Data):
- Query: clicks, impressions, CTR, position
- Dimensions: date, page, query, country, device
- Date range: specify start_date and end_date
- Filters: page contains/equals, query contains/equals

URL INSPECTION:
- Inspect specific URL for indexing status
- Get Google's canonical selection
- Check mobile usability
- See last crawl date

SITEMAP MANAGEMENT:
- List submitted sitemaps
- Submit new sitemap
- Delete sitemap
- Check sitemap status (submitted vs indexed counts)

COVERAGE REPORT (if available):
- Get indexing status breakdown
- See exclusion reasons and affected URLs
```

### Data Interpretation Guidelines

```
SEARCH ANALYTICS GOTCHAS:
- Data has 24-72 hour delay (recent days may be incomplete)
- "Position" is average -- a page can rank #3 for one query and #50 for another
- "Impressions" means the URL appeared in results, NOT that the user saw it
- Property type matters: domain property captures all variants, URL prefix only captures that prefix
- Anonymous queries (privacy threshold) are excluded from query-level data but included in totals

COVERAGE REPORT GOTCHAS:
- "Valid" count can include pages indexed but not receiving traffic
- Exclusion reasons can overlap (a page can be both noindex AND non-canonical)
- Coverage data is per-URL, not per-page (www and non-www are separate URLs)
```

---

## Phase 4: Hostinger Deployment Awareness

When deploying SEO fixes to a Hostinger-hosted site, follow this protocol to avoid the OPcache/CDN friction that has caused repeated deployment cycles in past sessions.

### Pre-Deploy SEO Fix Checklist

```
1. Document current state:
   - Save current robots.txt content
   - Save current sitemap URLs and structure
   - Note current canonical patterns
   - Screenshot GSC Coverage stats as baseline

2. Stage changes in Git:
   - All SEO-relevant files (robots.txt, sitemaps, templates with canonical/hreflang)
   - Commit with descriptive message: "fix(seo): correct canonical URLs for /section/"

3. Deploy via hPanel Git mechanism:
   - NEVER create/edit files via SSH (invisible to web server due to OPcache)
   - Push to tracked branch -> hPanel auto-deploys
   - Use hostinger_hosting_deploy* MCP tools if available
```

### Post-Deploy SEO Verification (CRITICAL)

```bash
# Wait for OPcache to clear (minimum 60 seconds)
sleep 60

# Verify at SERVER level -- NOT browser (CDN caches old content)
# Check canonical tag is updated
curl -s "https://example.com/fixed-page" | grep -i 'canonical'

# Check robots.txt is updated
curl -s "https://example.com/robots.txt"

# Check sitemap is accessible
curl -sI "https://example.com/sitemap.xml" | head -5

# Check meta robots tag is removed (if that was the fix)
curl -s "https://example.com/fixed-page" | grep -i 'noindex'

# Check hreflang tags are correct
curl -s "https://example.com/fixed-page" | grep -i 'hreflang'
```

### Hostinger-Specific Friction Points

| Friction | Impact | Mitigation |
|----------|--------|------------|
| **OPcache lag** | SEO fix deployed but old HTML still served for 30-60s | Wait 60s, then verify via `curl`. Do NOT redeploy thinking it failed |
| **CDN caching** | Googlebot may see old content for 5-15 min after deploy | Verify server-side is correct via `curl`. CDN will catch up. Note: Google's next crawl will see the fix |
| **SSH-created files invisible** | robots.txt or sitemap.xml created via SSH won't serve | Always commit to Git and deploy through hPanel mechanism |
| **Multiple deploy cycles** | Panic-redeploying because "fix isn't showing" wastes time | Deploy ONCE, wait 60s, `curl` to verify server-side, then wait for CDN. One deploy is enough if server-side is correct |

### After Deployment: GSC Follow-Up

```
1. REQUEST INDEXING for key fixed pages via GSC URL Inspection
   - Prioritize high-traffic pages first
   - Max ~10-20 URL inspection requests per day (soft limit)

2. SUBMIT/RESUBMIT sitemaps if sitemap was changed
   - Use GSC Sitemaps tool to submit updated sitemap
   - Monitor "Submitted" vs "Indexed" count over next 7 days

3. MONITOR Coverage Report daily for 7 days
   - Watch for "Valid" count to increase
   - Watch for exclusion reasons to decrease
   - Note: Full re-indexing can take 2-4 weeks for large sites

4. MONITOR Search Analytics after 3-5 days
   - Compare clicks/impressions to pre-fix baseline
   - Recovery is gradual -- don't expect overnight return to previous traffic
```

---

## Phase 5: Large-Scale SEO Audits

For sites with 10,000+ pages, standard page-by-page checking is impractical. Use this sampling and batching approach.

### Sampling Strategy

```
1. Get full URL list from sitemap(s)
2. Categorize by section/template (e.g., /products/, /blog/, /categories/)
3. Sample 5-10 URLs per section for spot-checks
4. If a section has issues, then audit the full section
5. Focus effort on highest-traffic sections first (use Search Analytics to prioritize)
```

### Batch Analysis Scripts

```bash
# Extract all URLs from sitemap index
curl -s "https://example.com/sitemap_index.xml" | grep -oP '<loc>\K[^<]+' | while read sitemap_url; do
  echo "--- $sitemap_url ---"
  curl -s "$sitemap_url" | grep -c '<loc>'
done

# Batch canonical check (outputs mismatches only)
curl -s "https://example.com/sitemap.xml" | grep -oP '<loc>\K[^<]+' | while read url; do
  canonical=$(curl -s "$url" | grep -oP 'href="\K[^"]+(?="[^>]*rel="canonical")' | head -1)
  if [ -z "$canonical" ]; then
    canonical=$(curl -s "$url" | grep -oP 'rel="canonical"[^>]*href="\K[^"]+' | head -1)
  fi
  if [ -n "$canonical" ] && [ "$canonical" != "$url" ]; then
    echo "MISMATCH: $url -> $canonical"
  fi
done

# Batch HTTP status check
curl -s "https://example.com/sitemap.xml" | grep -oP '<loc>\K[^<]+' | while read url; do
  status=$(curl -sI -o /dev/null -w "%{http_code}" "$url")
  if [ "$status" != "200" ]; then
    echo "$status $url"
  fi
done
```

---

## Verification Checklist

After implementing fixes, verify each item:

- [ ] **Phase 0 completed**: Domain, timeline, severity, and scope confirmed with user
- [ ] **GSC data pulled**: Search Analytics and Coverage data retrieved (not assumed)
- [ ] **Root cause identified**: Specific technical issue pinpointed with evidence
- [ ] **Fix implemented**: Changes made to correct the issue
- [ ] **Fix deployed correctly**: Via Git/hPanel (NOT SSH file creation on Hostinger)
- [ ] **Server-side verified**: `curl` confirms fix is live (not relying on browser/CDN)
- [ ] **Canonical tags consistent**: Canonical URL matches sitemap URL, hreflang URL, and internal link URL
- [ ] **Sitemaps clean**: No 4xx/5xx/noindex/non-canonical URLs in sitemaps
- [ ] **robots.txt permissive**: Not blocking indexable content or CSS/JS
- [ ] **No accidental noindex**: Neither meta tag nor X-Robots-Tag header on indexable pages
- [ ] **Hreflang reciprocal**: Every hreflang link has a matching return link
- [ ] **GSC re-indexing requested**: URL Inspection used to request indexing for key pages
- [ ] **Sitemaps submitted**: Updated sitemaps submitted/resubmitted in GSC
- [ ] **Monitoring plan**: User knows to check GSC Coverage and Search Analytics over next 7-14 days
- [ ] **Current state documented**: Baseline metrics saved for comparison

---

## Recovery Timeline Expectations

Set correct expectations with the user:

| Action | Expected Timeline |
|--------|-------------------|
| GSC URL Inspection request processed | 24-48 hours |
| Robots.txt changes recognized by Google | 24-48 hours |
| Canonical tag changes recognized | 1-2 weeks (depends on crawl frequency) |
| Sitemap reprocessing | 1-3 days |
| Noindex removal -> re-indexing | 1-4 weeks |
| Traffic recovery after technical fix | 2-6 weeks (gradual) |
| Traffic recovery after manual action lift | 1-3 months |
| Full recovery for large site (50K+ pages) | 4-12 weeks |

**IMPORTANT:** SEO recovery is NEVER instant. A correctly deployed fix may take weeks to reflect in traffic. Do NOT keep changing things because traffic hasn't recovered after 2 days.

---

## Key Principle

**Data first, fix second, patience third.** Pull GSC data before diagnosing. Verify HTML source before assuming canonical/hreflang state. Deploy once via Git, verify via `curl`, then wait. SEO recovery takes weeks, not hours. The biggest mistake is panic-redeploying or making additional changes before the first fix has been crawled and processed by Google.
