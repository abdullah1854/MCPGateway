
const { language = 'typescript', focus = 'all' } = inputs;

const checklists = {
  security: [
    'Check for hardcoded secrets, API keys, tokens',
    'Verify input validation and sanitization',
    'Check for SQL injection, XSS, command injection',
    'Verify authentication/authorization on endpoints',
    'Check for proper encryption of sensitive data'
  ],
  performance: [
    'Identify N+1 query problems',
    'Check for memory leaks in useEffect cleanup',
    'Verify pagination for large datasets',
    'Check for blocking operations on main thread',
    'Look for redundant computations'
  ],
  maintainability: [
    'Functions should be single-purpose, under 20 lines',
    'Check for DRY violations and duplicated logic',
    'Verify descriptive naming, no magic numbers',
    'Check proper TypeScript types, avoid any',
    'Ensure meaningful error messages'
  ]
};

const areas = focus === 'all' ? Object.keys(checklists) : [focus];
let result = `# Code Review Checklist (${language})\n\n`;

for (const area of areas) {
  if (checklists[area]) {
    result += `## ${area.charAt(0).toUpperCase() + area.slice(1)}\n`;
    for (const item of checklists[area]) {
      result += `- [ ] ${item}\n`;
    }
    result += '\n';
  }
}

console.log(result);
