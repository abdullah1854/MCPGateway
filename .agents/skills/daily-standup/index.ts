
const { accomplishments, planned, blockers = [] } = inputs;
const date = new Date().toISOString().split('T')[0];

let report = `# Daily Standup - ${date}\n\n## ✅ Yesterday\n`;
for (const a of accomplishments) report += `- ${a}\n`;

report += `\n## 📋 Today\n`;
for (const p of planned) report += `- ${p}\n`;

if (blockers.length > 0) {
  report += `\n## 🚧 Blockers\n`;
  for (const b of blockers) report += `- ${b}\n`;
}

console.log(report);
