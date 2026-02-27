
const { title, changes, testPlan = ['Verify tests pass', 'Manual testing'], issues = [] } = inputs;

let pr = `## Summary\n${title}\n\n## Changes\n`;
for (const c of changes) pr += `- ${c}\n`;

pr += `\n## Test Plan\n`;
for (const t of testPlan) pr += `- [ ] ${t}\n`;

if (issues.length > 0) {
  pr += `\n## Related Issues\n`;
  for (const i of issues) pr += `- Closes #${i}\n`;
}

pr += `\n---\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

console.log(pr);
