
const { type = 'feat', scope, description, breaking = false } = inputs;

const validTypes = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'style', 'perf', 'ci', 'build'];
const t = validTypes.includes(type) ? type : 'feat';

let message = t;
if (scope) message += `(${scope})`;
if (breaking) message += '!';
message += `: ${description}`;

let body = '';
if (breaking) {
  body = '\n\nBREAKING CHANGE: Describe the breaking change here';
}

const footer = '\n\n🤖 Generated with Claude Code';

console.log(`# Commit Message\n\n\`\`\`\n${message}${body}${footer}\n\`\`\`\n\n## Conventional Commit Types\n- feat: New feature\n- fix: Bug fix\n- refactor: Code refactoring\n- docs: Documentation\n- test: Adding tests\n- chore: Maintenance`);
