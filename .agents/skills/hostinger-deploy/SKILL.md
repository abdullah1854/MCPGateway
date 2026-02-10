---
name: hostinger-deploy
description: Hostinger-specific deployment protocol handling OPcache, CDN caching, and hPanel Git mechanism. Activates for "deploy to hostinger", "hostinger", "redeploy", "publish website", "push to production" when target is Hostinger.
allowed-tools: [Bash, Read, Write, Edit, Grep]
---

# Hostinger Deployment Protocol

## When This Skill Activates
- "Deploy to Hostinger", "publish website", "push to production"
- "Redeploy", "site not updating", "changes not showing"
- "OPcache", "CDN cache", "hPanel"
- Any deployment where target hosting is Hostinger

## Anti-Hallucination Rules (NEVER violate)

| Rule | Description |
|------|-------------|
| **NO SSH FILE CREATION** | Files created via SSH are INVISIBLE to the web server due to OPcache. Always use hPanel Git mechanism |
| **CDN DISTRUST** | NEVER verify deployment via browser or live URL alone. CDN caches aggressively. Verify at server level first |
| **GIT-FIRST** | All file changes MUST go through Git → hPanel Git deploy. Direct file uploads are unreliable |
| **OPCACHE LAG** | After deployment, wait for OPcache to clear before declaring success. Expect 30-60s lag minimum |
| **ASK BEFORE DEPLOYING** | NEVER deploy without explicit user consent |

## Deployment Types

### Static Sites (HTML/CSS/JS)
**Tool:** `hostinger_hosting_deployStaticWebsite`
```
1. Build locally (npm run build / equivalent)
2. Verify build output exists and is correct
3. Deploy via Hostinger MCP tool
4. Wait 60s for OPcache
5. Verify via curl at server level
```

### JavaScript Apps (Next.js, React)
**Tool:** `hostinger_hosting_deployJsApplication`
```
1. Build locally, verify no errors
2. Check package.json has correct start script
3. Deploy via Hostinger MCP tool
4. Wait 60s for OPcache
5. Verify via curl at server level
```

### WordPress
**Tools:** `hostinger_hosting_deployWordpressTheme` or `hostinger_hosting_importWordpressWebsite`
```
1. Build/compile theme assets
2. Deploy theme via Hostinger MCP tool
3. Clear WordPress cache (if applicable)
4. Wait 60s for OPcache
5. Verify via curl at server level
```

## Standard Workflow

### Phase 1: Pre-Deploy Checks
```bash
# 1. Verify build succeeds
npm run build  # or equivalent

# 2. Run tests if available
npm test || echo "No tests configured"

# 3. Check no secrets in code
grep -r "sk_live\|api_key\|password\|secret" --include="*.ts" --include="*.js" --include="*.env" || echo "Clean"

# 4. Verify correct branch
git status
git log --oneline -3
```

### Phase 2: Git Commit & Push
```bash
# Stage and commit changes
git add [specific files]
git commit -m "deploy: [description]"

# Push to remote (Hostinger tracks this branch)
git push origin main  # or the branch Hostinger monitors
```

### Phase 3: Trigger Hostinger Deploy
Use the appropriate Hostinger MCP tool:
- `hostinger_hosting_deployStaticWebsite` for static sites
- `hostinger_hosting_deployJsApplication` for JS apps
- `hostinger_hosting_deployWordpressTheme` for WordPress themes

### Phase 4: Verification (CRITICAL)
```bash
# Wait for OPcache to clear
sleep 60

# Verify at SERVER level (NOT browser/CDN)
curl -s -o /dev/null -w "%{http_code}" https://yourdomain.com
curl -s https://yourdomain.com | head -50

# Check specific file was updated (compare content)
curl -s https://yourdomain.com/path/to/changed-file

# If CDN is caching old content:
# 1. Confirm server-side fix is correct via curl
# 2. Inform user that CDN may take 5-15 min to propagate
# 3. Do NOT assume deployment failed just because browser shows old content
```

## Troubleshooting

### "Changes not showing after deploy"
1. **Check OPcache**: Wait 60s and retry
2. **Check CDN**: Use `curl` to verify server-side, not browser
3. **Check Git push**: Verify commit was pushed to correct branch
4. **Check hPanel**: Ensure auto-deploy is configured for the branch
5. **Re-trigger deploy**: Use Hostinger MCP tool to redeploy

### "Files created via SSH not visible"
This is a KNOWN Hostinger platform limitation:
- OPcache prevents SSH-created files from being served
- **Fix**: Commit files to Git and deploy through hPanel mechanism
- NEVER rely on SSH file creation for production changes

### "502/503 errors after deploy"
1. Check if the app process started correctly
2. Verify environment variables are set in hPanel
3. Check Node.js version compatibility
4. Review application logs via hPanel

## Verification Checklist
- [ ] Build succeeds locally with zero errors
- [ ] All changes committed and pushed to Git
- [ ] Deployed via Hostinger MCP tool (NOT SSH file creation)
- [ ] Waited for OPcache clear (60s minimum)
- [ ] Verified at server level via `curl` (NOT browser)
- [ ] If CDN lag detected, confirmed server-side is correct and informed user
- [ ] No secrets exposed in deployed code

## Key Principle
**Git-first, verify at server level, distrust the CDN.** Hostinger's OPcache and CDN caching are the #1 source of deployment confusion. Always verify fixes at the server level before concluding whether a deployment succeeded or failed.
